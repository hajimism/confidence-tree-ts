// ct guard: whether a change loses a confidence once won (README, 守る). It stops only on a loss.
//
//   a break the baseline detected is no longer detected (twice in a row)   stop
//   a claim the baseline held is no longer held                            stop
//   a claim is gone without a reason in retired                            stop
//   a claim not held yet, a new break not detected                         shown only
//   a join or its tests changed                                            proved again, and judged
//
// Claims whose joins and tests are as the baseline saw them are carried over, not proved again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ledgerAt } from "./check.ts";
import { hiddenCandidates, pickHidden } from "./hidden.ts";
import { type Claim, type Join, loadLedger } from "./ledger.ts";
import {
  type BreakResult,
  type ClaimResult,
  type ClaimState,
  type JoinResult,
  prove,
  sha256,
} from "./prove.ts";
import { MARK } from "./results.ts";
import { applyEdit, type Span } from "./script.ts";
import { findSymbol, parseSource } from "./symbols.ts";

export const BASELINE = ".ct/baseline.json";
export const GUARD_OUT = ".ct/guard.json";

export type GuardClaim = {
  state: ClaimState;
  /** True when this run took the claim from the baseline instead of proving it. */
  carried: boolean;
  /** What the claim was proved against: its ledger entry, each join's symbol, each test file. */
  entry: string;
  joins: string[];
  tests: Record<string, string>;
  result: ClaimResult;
};

export type GuardFile = {
  version: 1;
  commit?: string;
  at: string;
  /** Whether hidden breaks were applied (CT_SEED was set). */
  seeded: boolean;
  claims: Record<string, GuardClaim>;
};

export type Change = {
  id: string;
  change: "regressed" | "improved" | "redone" | "new" | "removed" | "unchanged";
  from?: ClaimState;
  to?: ClaimState;
  reasons: string[];
};

export type Disclosed = {
  claim: string;
  in: string;
  /** The join's code the break was applied in. */
  code: string;
  kind: string;
  replaces: string;
  with: string;
  doing: string;
};

export type GuardReport = {
  version: 1;
  ok: boolean;
  /** The baseline file read, or null when there was none. */
  baseline: string | null;
  base?: string;
  changes: Change[];
  disclosed: Disclosed[];
  testRuns: number;
  ms: number;
  result: GuardFile;
};

export type GuardOptions = {
  baseline: string;
  out: string;
  base?: string;
  all: boolean;
  seed?: string;
  timeoutMs: number;
  log?: (line: string) => void;
};

/** A break's identity across runs: the same join, the same code, the same edit. */
/** A join's identity across runs: where it is, its code, and the symbol's text around it. */
export const joinKey = (j: Pick<JoinResult, "in" | "code" | "symbolHash">) =>
  [j.in, j.code, j.symbolHash].join("\0");

export const breakKey = (j: Pick<JoinResult, "in" | "code">, b: BreakResult) =>
  [j.in, j.code, b.from, b.kind, b.replaces, b.with].join("\0");

function readFile(root: string, path: string): string | undefined {
  const f = join(root, path);
  return existsSync(f) ? readFileSync(f, "utf8") : undefined;
}

/** The fingerprint a claim is proved against: its joins' symbols and its test files, as they are. */
function fingerprint(
  root: string,
  c: Claim,
): { entry: string; joins: string[]; tests: Record<string, string> } {
  // The claim as the ledger writes it: its joins (with breaks and generate) and its test refs.
  const entry = sha256(JSON.stringify({ joins: c.joins, tests: c.tests.map((t) => t.raw) }));
  const joins = c.joins.map((j: Join) => {
    const text = readFile(root, j.file);
    if (text === undefined) return "missing";
    const s = findSymbol(parseSource(j.file, text), j.symbol);
    if (!s.ok) return "missing";
    return `${sha256(text.slice(s.symbol.start, s.symbol.end))} ${sha256(j.code ?? "")}`;
  });
  const tests: Record<string, string> = {};
  for (const f of new Set(c.tests.map((t) => t.file))) {
    const text = readFile(root, f);
    tests[f] = text === undefined ? "missing" : sha256(text);
  }
  return { entry, joins, tests };
}

/** The join's hidden breaks: picked from the candidates that are not one of its own `breaks`. */
function hiddenFor(seed: string, j: Join, text: string, loc: Span) {
  if (j.code === undefined) return [];
  const own = new Set(
    j.breaks.map((b) => applyEdit(text, { start: loc.start, end: loc.end, text: b })),
  );
  const candidates = hiddenCandidates(j.file, text, loc).filter(
    (h) => !own.has(applyEdit(text, h.edit)),
  );
  return pickHidden(candidates, { seed, join: { in: j.in, code: j.code }, loc });
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export async function guard(root: string, opts: GuardOptions): Promise<GuardReport> {
  const t0 = performance.now();
  const ledger = await loadLedger(root);
  const text = readFile(root, opts.baseline);
  const baseline = text === undefined ? undefined : (JSON.parse(text) as GuardFile);
  const before = baseline?.claims ?? {};

  const prints = new Map(ledger.claims.map((c) => [c.id, fingerprint(root, c)]));
  const redo = ledger.claims.filter((c) => {
    const b = before[c.id];
    const p = prints.get(c.id);
    return (
      opts.all ||
      b === undefined ||
      b.entry !== p?.entry ||
      !same(b.joins, p?.joins) ||
      !same(b.tests, p?.tests)
    );
  });

  // What the baseline knew, by claim: the breaks it detected, every break it had, and its joins.
  const detectedBefore = new Set<string>();
  const hadBefore = new Set<string>();
  const joinsBefore = new Set<string>();
  for (const b of Object.values(before))
    for (const j of b.result.joins) {
      joinsBefore.add(`${b.result.id}\0${joinKey(j)}`);
      for (const br of j.breaks) {
        hadBefore.add(`${b.result.id}\0${breakKey(j, br)}`);
        if (br.outcome === "detected") detectedBefore.add(`${b.result.id}\0${breakKey(j, br)}`);
      }
    }
  const heldBefore = (id: string) => before[id]?.state === "held";
  /**
   * A survival that makes a held claim lose its hold: of a break the baseline had, or of any break
   * of a join whose code changed. A new break on an unchanged join that survives is shown only.
   */
  const losesHold = (id: string, j: JoinResult, br: BreakResult) =>
    heldBefore(id) &&
    (hadBefore.has(`${id}\0${breakKey(j, br)}`) || !joinsBefore.has(`${id}\0${joinKey(j)}`));

  const seed = opts.seed;
  const proof = await prove(root, redo, {
    timeoutMs: opts.timeoutMs,
    ...(opts.log ? { log: opts.log } : {}),
    ...(seed
      ? { extraBreaks: (_c: Claim, j: Join, t: string, loc: Span) => hiddenFor(seed, j, t, loc) }
      : {}),
    recheck: (c, j, br) =>
      detectedBefore.has(`${c.id}\0${breakKey(j, br)}`) || losesHold(c.id, j, br),
  });

  const result: GuardFile = {
    version: 1,
    ...(proof.commit ? { commit: proof.commit } : {}),
    at: proof.startedAt,
    seeded: seed !== undefined,
    claims: {},
  };
  for (const c of ledger.claims) {
    const p = prints.get(c.id) as ReturnType<typeof fingerprint>;
    const fresh = proof.claims.find((x) => x.id === c.id);
    if (fresh) result.claims[c.id] = { state: fresh.state, carried: false, ...p, result: fresh };
    else result.claims[c.id] = { ...(before[c.id] as GuardClaim), carried: true };
  }

  // What changed against the baseline.
  const changes: Change[] = [];
  const retired = new Map(ledger.retired.map((r) => [r.id, r]));
  const live = new Set(ledger.claims.map((c) => c.id));
  const gone = new Set(Object.keys(before).filter((id) => !live.has(id)));
  if (opts.base !== undefined) {
    const then = ledgerAt(root, opts.base);
    if (then === undefined) throw new Error(`--base ${opts.base} というコミットがない`);
    for (const c of then.claims) if (!live.has(c.id)) gone.add(c.id);
  }
  for (const id of [...gone].sort()) {
    const r = retired.get(id);
    if (r?.reason === undefined)
      changes.push({
        id,
        change: "removed",
        ...(before[id] ? { from: before[id].state } : {}),
        reasons: ["主張が、retired に理由を書かずに消えた"],
      });
  }
  for (const c of ledger.claims) {
    const now = result.claims[c.id] as GuardClaim;
    const was = before[c.id];
    if (was === undefined) {
      changes.push({ id: c.id, change: "new", to: now.state, reasons: [] });
      continue;
    }
    const reasons: string[] = [];
    for (const j of now.result.joins)
      for (const br of j.breaks)
        if (br.outcome === "survived" && detectedBefore.has(`${c.id}\0${breakKey(j, br)}`))
          reasons.push(
            `基準で検出されていた壊し方が、検出されなくなった: ${j.in} 「${oneLine(j.code)}」: ${br.doing}も落ちない`,
          );
    // A held claim stops CI when it loses its reach, or when a break survives twice that the
    // baseline had or that is on a changed join. Timeouts, slow runs and unstable ones are shown.
    if (was.state === "held" && !now.carried) {
      for (const j of now.result.joins)
        if (!j.reached)
          reasons.push(
            `基準で保持していた主張が、保持でなくなった: ${j.in} にテストが到達しなくなった`,
          );
      for (const j of now.result.joins)
        for (const br of j.breaks)
          if (
            br.outcome === "survived" &&
            !detectedBefore.has(`${c.id}\0${breakKey(j, br)}`) &&
            losesHold(c.id, j, br)
          )
            reasons.push(
              `基準で保持していた主張が、保持でなくなった: ${j.in} 「${oneLine(j.code)}」: ${br.doing}も落ちない`,
            );
    }
    const change: Change["change"] = reasons.length
      ? "regressed"
      : now.carried
        ? "unchanged"
        : was.state !== "held" && now.state === "held"
          ? "improved"
          : "redone";
    changes.push({ id: c.id, change, from: was.state, to: now.state, reasons });
  }

  const disclosed: Disclosed[] = [];
  for (const c of ledger.claims) {
    // Carried claims too: a hidden break that survives stays disclosed until a test notices it.
    const now = result.claims[c.id] as GuardClaim;
    for (const j of now.result.joins)
      for (const br of j.breaks)
        if (br.from === "hidden" && br.outcome === "survived")
          disclosed.push({
            claim: c.id,
            in: j.in,
            code: j.code,
            kind: br.kind,
            replaces: br.replaces,
            with: br.with,
            doing: br.doing,
          });
  }

  mkdirSync(dirname(join(root, opts.out)), { recursive: true });
  writeFileSync(join(root, opts.out), `${JSON.stringify(result, null, 2)}\n`);
  return {
    version: 1,
    ok: !changes.some((c) => c.change === "regressed" || c.change === "removed"),
    baseline: baseline === undefined ? null : opts.baseline,
    ...(opts.base !== undefined ? { base: opts.base } : {}),
    changes,
    disclosed,
    testRuns: proof.testRuns,
    ms: Math.round(performance.now() - t0),
    result,
  };
}

const width = (s: string) =>
  [...s].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0);
const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - width(s)));

/** The README's PR comment, as text. */
export function formatGuard(r: GuardReport): string {
  const lines: string[] = [];
  lines.push(
    r.baseline === null
      ? "基準がない。この結果が、次の基準になる"
      : `確信の変化（基準との比較: ${r.baseline}${r.base ? `、台帳は ${r.base} とも比較` : ""}）`,
    "",
  );
  const w = Math.max(0, ...r.changes.map((c) => width(c.id))) + 2;
  const sign = {
    regressed: "-",
    removed: "-",
    improved: "+",
    redone: "~",
    new: "+",
    unchanged: " ",
  };
  const shown = r.changes.filter((c) => c.change !== "unchanged" && c.change !== "new");
  for (const c of shown) {
    const from = c.from ? MARK[c.from] : "";
    const to = c.to ? MARK[c.to] : "";
    const move =
      c.change === "removed"
        ? `${from} → 消えた`
        : c.change === "redone"
          ? `↻ やり直し → ${to}`
          : `${from} → ${to}`;
    lines.push(
      `  ${sign[c.change]} ${pad(c.id, w)}${pad(move, 16)}${c.reasons.length ? "後退" : ""}`.trimEnd(),
    );
    for (const why of c.reasons) lines.push(`      ${why}`);
  }
  if (shown.length === 0) lines.push("  変化なし");
  const added = r.changes.filter((c) => c.change === "new");
  if (added.length) {
    lines.push("", "新しい主張");
    for (const c of added) lines.push(`  ${pad(c.id, w)}${c.to ? MARK[c.to] : ""}`);
  }
  const waiting = Object.entries(r.result.claims).filter(([, c]) => c.state !== "held");
  if (waiting.length) {
    lines.push("", "まだ保持していない主張（表示だけ）");
    for (const [id, c] of waiting)
      lines.push(`  ${pad(id, w)}${MARK[c.state]}  ${c.result.reason ?? ""}`.trimEnd());
  }
  if (r.disclosed.length) {
    lines.push("", "隠した壊し方で生き残ったもの（開示）");
    for (const d of r.disclosed)
      lines.push(`  ${pad(d.claim, w)}${d.in}  「${oneLine(d.code)}」: ${d.doing}も落ちない`);
  }
  if (!r.result.seeded) lines.push("", "CT_SEED がないので、隠した壊し方は当てていない");
  const regressed = r.changes.filter(
    (c) => c.change === "regressed" || c.change === "removed",
  ).length;
  lines.push("", regressed ? `後退 ${regressed} 件。CI を止める` : "後退なし");
  return lines.join("\n");
}

export const formatComment = (r: GuardReport) =>
  `### confidence-tree\n\n\`\`\`\n${formatGuard(r)}\n\`\`\`\n`;
