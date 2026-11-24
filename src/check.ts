// ct check: whether the ledger is sound. Each problem comes with how to fix it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Claim,
  type Join,
  LEDGER_DIR,
  type Ledger,
  ledgerFiles,
  loadLedger,
  mergeLedgers,
  type Problem,
  parseLedger,
  SOURCE_KINDS,
} from "./ledger.ts";
import { findSymbol, locateCode, parseSource } from "./symbols.ts";

export type CheckResult = { claims: number; ledgers: number; problems: Problem[] };

export class UsageError extends Error {}

const shown = (code: string) =>
  code !== code.trim() || code.includes("\n") ? JSON.stringify(code) : code;

/** Rule 1: every claim has a source of a kind the ledger knows. */
function sources(c: Claim): Problem[] {
  const base = { level: "error" as const, ledger: c.ledger, claim: c.id, code: "E101" };
  if (c.source === undefined)
    return [
      {
        ...base,
        message: "出どころがない",
        fix: `source に根拠を書く（${SOURCE_KINDS.join("、")} のどれかで始める）。仕様の根拠が見つからないなら impl と書く`,
      },
    ];
  const kind = c.source.split(/\s+/)[0] as string;
  if (!SOURCE_KINDS.includes(kind))
    return [
      {
        ...base,
        message: `出どころの種類 ${kind} は使えない`,
        fields: { source: c.source },
        fix: `source は ${SOURCE_KINDS.join("、")} のどれかで始める`,
      },
    ];
  return [];
}

/** Rule 2: glue and boundary claims name their joins. */
function joinsNamed(c: Claim): Problem[] {
  if ((c.kind !== "glue" && c.kind !== "boundary") || c.joins.length > 0) return [];
  return [
    {
      code: "E102",
      level: "error",
      ledger: c.ledger,
      claim: c.id,
      message: "組み立て点がない",
      fix: "joins に組み立て点を書く（in: <ファイル>#<シンボル>、code: そのシンボルの中で一意なコード片）。組み立て点のない振る舞いなら kind: unit にする",
    },
  ];
}

/** Rule 3: every join's code is in its symbol, once. */
function joinFound(root: string, c: Claim, j: Join, texts: Map<string, string | null>): Problem[] {
  const fields: Record<string, string> = { in: j.in };
  if (j.code !== undefined) fields.code = shown(j.code);
  const p = (message: string, fix: string, code = "E103", level: Problem["level"] = "error") => [
    { code, level, ledger: c.ledger, claim: c.id, message, fields, fix },
  ];
  if (!texts.has(j.file)) {
    const path = join(root, j.file);
    texts.set(j.file, existsSync(path) ? readFileSync(path, "utf8") : null);
  }
  const text = texts.get(j.file);
  if (text == null)
    return p(
      "ファイルがない",
      "ファイルが移ったなら in を直す。組み立て点ごと消えたなら、主張を retired に移す",
    );
  const parsed = parseSource(j.file, text);
  const found = findSymbol(parsed, j.symbol);
  if (!found.ok) {
    if (found.reason === "unparsable")
      return p("ファイルの構文が通らない", `${j.file} を直す（${parsed.error}）`);
    if (found.reason === "ambiguous")
      return p(
        "シンボルが一意でない",
        `次のどれかの名前で in を書く: ${found.candidates.join("、")}`,
      );
    const near = found.candidates.slice(0, 12).join("、");
    return p(
      "シンボルがない",
      `改名されたなら in を直す。${j.file} にあるシンボル: ${near}${found.candidates.length > 12 ? "、…" : ""}`,
    );
  }
  if (j.code === undefined)
    return p(
      "order は、まだ確かめられない",
      "組み立て点を確かめるには、code: <シンボルの中で一意なコード片> を書く",
      "W202",
      "warning",
    );
  const loc = locateCode(text, found.symbol, j.code);
  if (loc.ok) return [];
  const name = j.symbol.split(".").pop();
  if (loc.reason === "repeated")
    return p(
      "組み立て点が一意でない",
      `${name} の中に ${loc.count} か所ある。code を前後に伸ばして、1 か所に絞る`,
    );
  return p(
    "組み立て点が見つからない",
    `${name} の中の該当箇所を探して code を直す。組み立て方が変わったなら、主張の文も見直す`,
  );
}

/** Not a rule but the README's warning: outside unit claims, a test names the test, not the file. */
function wholeFileTests(c: Claim): Problem[] {
  if (c.kind === "unit") return [];
  return c.tests
    .filter((t) => t.name === undefined)
    .map((t) => ({
      code: "W201",
      level: "warning" as const,
      ledger: c.ledger,
      claim: c.id,
      message: "テストがファイル全体の指定",
      fields: { test: t.raw },
      fix: "<ファイル> > <テスト名> の形で、組み立て点を確かめるテストだけを書く。ファイルのほかのテストの到達まで数えてしまう",
    }));
}

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
}

/** The ledger as it was at `ref`, or undefined if there is no such commit. */
export function ledgerAt(root: string, ref: string): Ledger | undefined {
  if (!git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok) return undefined;
  const files = git(root, ["ls-tree", "--name-only", ref, `${LEDGER_DIR}/`])
    .out.split("\n")
    .filter((f) => f.endsWith(".yaml"));
  return mergeLedgers(files.map((f) => parseLedger(git(root, ["show", `${ref}:./${f}`]).out, f)));
}

/** Rule 6: a claim that is gone has a reason in retired. */
function retirements(root: string, now: Ledger, base: string | undefined): Problem[] {
  const out: Problem[] = [];
  const live = new Set(now.claims.map((c) => c.id));
  for (const r of now.retired) {
    const p = { code: "E106", level: "error" as const, ledger: r.ledger, claim: r.id };
    if (r.reason === undefined)
      out.push({
        ...p,
        message: "retired に理由がない",
        fix: "reason: に、主張をやめた理由を 1 文で書く",
      });
    if (r.replacedBy !== undefined && !live.has(r.replacedBy))
      out.push({
        ...p,
        message: `replaced-by の ${r.replacedBy} がない`,
        fix: "replaced-by には、いまの台帳にある主張の ID を書く",
      });
    if (live.has(r.id))
      out.push({
        ...p,
        message: "retired にあるのに、まだ claims にもある",
        fix: "claims と retired のどちらかから消す",
      });
  }
  const ref = base ?? "HEAD";
  const then = ledgerAt(root, ref);
  if (then === undefined) {
    if (base !== undefined) throw new UsageError(`--base ${base} というコミットがない`);
    out.push({
      code: "W206",
      level: "warning",
      ledger: LEDGER_DIR,
      message: "git のコミットがないので、消えた主張は確かめていない",
      fix: "台帳をコミットするか、--base <ref> で比べる相手を指す",
    });
    return out;
  }
  const retired = new Set(now.retired.map((r) => r.id));
  for (const c of then.claims)
    if (!live.has(c.id) && !retired.has(c.id))
      out.push({
        code: "E106",
        level: "error",
        ledger: c.ledger,
        claim: c.id,
        message: `主張が消えたのに、retired にない（${ref} にはあった）`,
        fix: `retired に ${c.id.slice(c.id.indexOf("/") + 1)}: と reason: を書く。消すつもりがなかったなら、主張を戻す`,
      });
  return out;
}

export async function check(root: string, opts: { base?: string } = {}): Promise<CheckResult> {
  const ledger = await loadLedger(root);
  const files = ledgerFiles(root);
  const problems = [...ledger.problems];
  if (files.length === 0)
    problems.push({
      code: "E100",
      level: "error",
      ledger: LEDGER_DIR,
      message: `台帳がない（${LEDGER_DIR}/*.yaml を探した）`,
      fix: `${LEDGER_DIR}/<領域>.yaml に area: と claims: を書く`,
    });
  const texts = new Map<string, string | null>();
  for (const c of ledger.claims) {
    problems.push(...sources(c), ...joinsNamed(c));
    for (const j of c.joins) problems.push(...joinFound(root, c, j, texts));
    problems.push(...wholeFileTests(c));
  }
  problems.push(...retirements(root, ledger, opts.base));
  return { claims: ledger.claims.length, ledgers: files.length, problems };
}

export function formatCheck(r: CheckResult): string {
  const lines: string[] = [];
  for (const p of r.problems) {
    lines.push(`${p.level === "error" ? "✗" : "!"} ${p.code} ${p.claim ?? p.ledger}: ${p.message}`);
    const fields = Object.entries(p.fields ?? {});
    const w = Math.max(0, ...fields.map(([k]) => k.length)) + 1;
    for (const [k, v] of fields) lines.push(`  ${`${k}:`.padEnd(w + 1)}${v}`);
    lines.push(`  直し方: ${p.fix}`);
  }
  const errors = r.problems.filter((p) => p.level === "error").length;
  const warnings = r.problems.length - errors;
  if (lines.length) lines.push("");
  lines.push(
    errors || warnings
      ? `主張 ${r.claims} 件: 誤り ${errors} 件、警告 ${warnings} 件`
      : `主張 ${r.claims} 件、問題なし`,
  );
  return lines.join("\n");
}
