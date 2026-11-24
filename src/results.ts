// What prove prints, and .ct/results.json: the latest result of each claim, updated claim by claim.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Claim } from "./ledger.ts";
import { type ClaimResult, type ClaimState, type Proof, sha256 } from "./prove.ts";

export const RESULTS = ".ct/results.json";

export type SavedClaim = {
  state: ClaimState;
  at: string;
  commit?: string;
  dirty: boolean;
  /** sha256 of each test file, so a changed test can be told apart. */
  tests: Record<string, string>;
  result: ClaimResult;
};

export type Results = { version: 1; claims: Record<string, SavedClaim> };

export function readResults(root: string): Results {
  const f = join(root, RESULTS);
  if (!existsSync(f)) return { version: 1, claims: {} };
  const r = JSON.parse(readFileSync(f, "utf8")) as Results;
  return r.version === 1 ? r : { version: 1, claims: {} };
}

/** Only the claims in `p` are replaced; the others keep their last result. */
export function saveResults(root: string, p: Proof, claims: Claim[]): void {
  const saved = readResults(root);
  for (const r of p.claims) {
    const c = claims.find((x) => x.id === r.id);
    const tests: Record<string, string> = {};
    for (const f of new Set(c?.tests.map((t) => t.file) ?? [])) {
      const path = join(root, f);
      tests[f] = existsSync(path) ? sha256(readFileSync(path, "utf8")) : "missing";
    }
    saved.claims[r.id] = {
      state: r.state,
      at: p.startedAt,
      ...(p.commit ? { commit: p.commit } : {}),
      dirty: p.dirty,
      tests,
      result: r,
    };
  }
  const sorted: Results = { version: 1, claims: {} };
  for (const k of Object.keys(saved.claims).sort())
    sorted.claims[k] = saved.claims[k] as SavedClaim;
  mkdirSync(join(root, ".ct"), { recursive: true });
  writeFileSync(join(root, RESULTS), `${JSON.stringify(sorted, null, 2)}\n`);
}

export const MARK: Record<ClaimState, string> = {
  held: "●",
  survived: "◍",
  unreached: "◌",
  untested: "○",
  undetermined: "?",
};

const width = (s: string) =>
  [...s].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0);
const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - width(s)));
const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
};

export function formatProof(p: Proof): string {
  const w = Math.max(0, ...p.claims.map((c) => width(c.id))) + 2;
  const indent = " ".repeat(w + 3);
  const lines: string[] = [];
  for (const c of p.claims) {
    const breaks = c.joins.flatMap((j) => j.breaks).filter((b) => b.outcome !== "invalid");
    const detected = breaks.filter((b) => b.outcome === "detected").length;
    let detail: string;
    const more: string[] = [];
    if (c.state === "untested") detail = "テストがない";
    else if (c.state === "unreached")
      detail = `${c.joins
        .filter((j) => !j.reached)
        .map((j) => j.in)
        .join("、")} に到達なし`;
    else if (c.state === "held") detail = `検出 ${detected}/${breaks.length}`;
    else if (c.state === "survived") {
      const surv = breaks.filter((b) => b.outcome === "survived");
      detail = `生存 ${surv.length}/${breaks.length}`;
      for (const b of surv)
        more.push(`「${oneLine(b.replaces)}」→「${oneLine(b.with) || "（消す）"}」でも落ちない`);
    } else {
      detail = c.reason ?? "判定不能";
      for (const f of c.failing ?? []) more.push(`落ちたテスト: ${f.test}`);
      for (const b of breaks.filter((x) => x.outcome !== "detected" && x.outcome !== "survived"))
        more.push(
          `${b.outcome}: 「${oneLine(b.replaces)}」→「${oneLine(b.with) || "（消す）"}」 ${b.note ?? ""}`.trimEnd(),
        );
    }
    lines.push(`${pad(c.id, w)}${MARK[c.state]}  ${detail}`);
    for (const m of more) lines.push(`${indent}${m}`);
  }
  const s = Math.round(p.ms / 1000);
  lines.push(
    "",
    `主張 ${p.claims.length} 件、テストの実行 ${p.testRuns} 回、${Math.floor(s / 60)}分${s % 60}秒`,
  );
  return lines.join("\n");
}
