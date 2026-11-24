// ct prove: reach with probes only, then break with breaks only, then confirm each detection.
//
//   reach    probes in, the claim's tests run once
//              they fail without probes too   -> undetermined, naming the tests
//              the join is not reached         -> unreached
//   break    one break in, no probe, the claim's tests run
//              does not parse                  -> invalid (not counted)
//              fails                           -> a detection, if confirmed
//              passes                          -> survived
//   confirm  the same break again: the same tests must fail for a reason that is not running out of
//            time, and not much slower than with nothing broken; otherwise undetermined
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Break, type BreakKind, generateBreaks, ledgerBreak, validity } from "./breaks.ts";
import { makeCopy } from "./copy.ts";
import type { Claim, Join } from "./ledger.ts";
import { clearHits, placeProbes, readHits, startHttpSink } from "./probe.ts";
import { type Case, type FailureKind, type RunResult, runTests } from "./run.ts";
import { applyEdit, type Span } from "./script.ts";
import { findSymbol, locateCode, parseSource } from "./symbols.ts";

export type JoinState = "held" | "survived" | "unreached" | "undetermined";
export type ClaimState = JoinState | "untested";

export type BreakOutcome =
  | "detected"
  | "survived"
  | "invalid"
  | "timeout"
  | "slow"
  | "unstable"
  | "error";

export type Failure = { test: string; kind: FailureKind; message: string };

export type BreakResult = {
  kind: BreakKind;
  from: "generated" | "ledger";
  /** The code the break replaces, and what it puts there. */
  replaces: string;
  with: string;
  outcome: BreakOutcome;
  ms: number;
  /** How many times the tests ran with this break. */
  runs: number;
  /** The tests that failed, and why: what the detection rests on. */
  failures?: Failure[];
  note?: string;
};

export type JoinResult = {
  in: string;
  code: string;
  /** sha256 of the symbol's text when proved; a change means the claim needs proving again. */
  symbolHash: string;
  reached: boolean;
  /** Which sink heard the probe. */
  via: ("file" | "http")[];
  state: JoinState;
  breaks: BreakResult[];
};

export type ClaimResult = {
  id: string;
  state: ClaimState;
  reason?: string;
  /** When the tests fail with nothing broken: which ones. */
  failing?: Failure[];
  tests: string[];
  joins: JoinResult[];
};

export type Proof = {
  version: 1;
  commit?: string;
  dirty: boolean;
  startedAt: string;
  ms: number;
  testRuns: number;
  claims: ClaimResult[];
};

export type ProveOptions = {
  timeoutMs: number;
  keep?: boolean;
  log?: (line: string) => void;
};

/** A detection that took this much longer than the unbroken run is not trusted. */
export const slowLimit = (baselineMs: number) => baselineMs * 3 + 2000;

const RANK: Record<JoinState, number> = { held: 0, undetermined: 1, survived: 2, unreached: 3 };

export const sha256 = (text: string) =>
  `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;

type Resolved = { join: Join; code: string; loc: Span; symbolText: string; probe: number };

function resolve(root: string, j: Join): Omit<Resolved, "probe"> | string {
  if (j.code === undefined) return `${j.in}: order は、まだ判定できない`;
  let text: string;
  try {
    text = readFileSync(join(root, j.file), "utf8");
  } catch {
    return `${j.in}: ファイルがない（ct check を見る）`;
  }
  const s = findSymbol(parseSource(j.file, text), j.symbol);
  if (!s.ok) return `${j.in}: シンボルが見つからないか一意でない（ct check を見る）`;
  const loc = locateCode(text, s.symbol, j.code);
  if (!loc.ok) return `${j.in}: 組み立て点が見つからないか一意でない（ct check を見る）`;
  return { join: j, code: j.code, loc, symbolText: text.slice(s.symbol.start, s.symbol.end) };
}

const testName = (c: Case) => c.path.join(" > ");

function failuresOf(r: RunResult): Failure[] {
  const out: Failure[] = r.cases
    .filter((c) => c.status === "fail")
    .map((c) => ({ test: testName(c), kind: c.kind ?? "exception", message: c.message ?? "" }));
  for (const f of r.unloaded)
    out.push({ test: `${f}（読み込み）`, kind: "exception", message: r.tail.slice(-1000) });
  return out;
}

const failed = (r: RunResult) =>
  r.killed || r.unloaded.length > 0 || r.cases.some((c) => c.status === "fail") || r.exitCode !== 0;

/** One run's outcome, before confirmation: "detected" here means only that it failed as it should. */
function outcomeOf(r: RunResult, baselineMs: number): { outcome: BreakOutcome; note?: string } {
  if (r.killed) return { outcome: "timeout", note: "ct が打ち切った" };
  if (r.cases.length === 0 && r.unloaded.length === 0)
    return { outcome: "error", note: "名前に合うテストが 1 つも動かなかった" };
  const f = failuresOf(r);
  if (f.length === 0)
    return r.exitCode === 0
      ? { outcome: "survived" }
      : { outcome: "error", note: `テストはすべて通ったが、終了コードが ${r.exitCode}` };
  if (f.every((x) => x.kind === "timeout"))
    return { outcome: "timeout", note: "落ちたテストがすべて時間切れ" };
  if (r.ms > slowLimit(baselineMs))
    return {
      outcome: "slow",
      note: `落ちるまでに ${r.ms}ms。壊す前は ${baselineMs}ms`,
    };
  return { outcome: "detected" };
}

const signature = (f: Failure[]) =>
  f
    .filter((x) => x.kind !== "timeout")
    .map((x) => x.test)
    .sort()
    .join("\n");

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export async function prove(root: string, claims: Claim[], opts: ProveOptions): Promise<Proof> {
  const log = opts.log ?? (() => {});
  const t0 = performance.now();
  const startedAt = new Date().toISOString();
  const copy = makeCopy(root, opts.keep ? { keep: true } : {});
  if (opts.keep) log(`複製: ${copy.root}`);
  const scratch = mkdtempSync(join(tmpdir(), "ct-run-"));
  const hitsFile = join(scratch, "hits");
  const http = startHttpSink();
  const target = { file: hitsFile, url: http.url };
  let testRuns = 0;
  const run = (c: Claim) => {
    testRuns++;
    return runTests(copy.root, c.tests, {
      timeoutMs: opts.timeoutMs,
      env: { CT_PROBE: hitsFile },
      scratch,
    });
  };

  try {
    const results = new Map<string, ClaimResult>();
    const resolved = new Map<string, Resolved[]>();
    let probeId = 0;
    for (const c of claims) {
      const base: ClaimResult = {
        id: c.id,
        state: "undetermined",
        tests: c.tests.map((t) => t.raw),
        joins: [],
      };
      results.set(c.id, base);
      if (c.tests.length === 0) {
        base.state = "untested";
        continue;
      }
      if (c.joins.length === 0) {
        base.reason = "組み立て点がない";
        continue;
      }
      const rs: Resolved[] = [];
      for (const j of c.joins) {
        const r = resolve(copy.root, j);
        if (typeof r === "string") {
          base.reason = r;
          break;
        }
        rs.push({ ...r, probe: ++probeId });
      }
      if (base.reason === undefined) resolved.set(c.id, rs);
    }

    // The files as they are, and with every remaining claim's probes in them.
    const original = new Map<string, string>();
    for (const rs of resolved.values())
      for (const r of rs)
        if (!original.has(r.join.file))
          original.set(r.join.file, readFileSync(join(copy.root, r.join.file), "utf8"));
    const write = (file: string, text: string) => writeFileSync(join(copy.root, file), text);
    const restore = () => {
      for (const [f, t] of original) write(f, t);
    };
    const probed = new Map<string, string>();
    for (;;) {
      probed.clear();
      let retry = false;
      for (const [file, text] of original) {
        const here = [...resolved.values()].flat().filter((r) => r.join.file === file);
        const p = placeProbes(
          file,
          text,
          here.map((r) => ({ id: r.probe, loc: r.loc })),
          target,
        );
        if (p.ok) {
          probed.set(file, p.text);
          continue;
        }
        const [id] = [...resolved].find(([, rs]) => rs.some((r) => r.probe === p.id)) ?? [];
        if (id === undefined) throw new Error(p.error);
        (results.get(id) as ClaimResult).reason = `プローブを置けない: ${p.error}`;
        resolved.delete(id);
        retry = true;
        break;
      }
      if (!retry) break;
    }

    // 1. Reach.
    const baseline = new Map<string, number>();
    const reached = new Map<number, Set<"file" | "http">>();
    for (const c of claims) {
      const rs = resolved.get(c.id);
      if (rs === undefined) continue;
      const res = results.get(c.id) as ClaimResult;
      for (const [f, t] of probed) write(f, t);
      clearHits(hitsFile);
      http.hits.clear();
      const r = await run(c);
      // A fetch from a page may land a moment after the test ends.
      await Bun.sleep(150);
      restore();
      if (r.cases.length === 0 && r.unloaded.length === 0 && !r.killed) {
        res.reason = `名前に合うテストが 1 つも動かなかった: ${res.tests.join("、")}`;
        resolved.delete(c.id);
        log(`到達  ${c.id}  判定不能`);
        continue;
      }
      if (failed(r)) {
        const clean = await run(c);
        if (failed(clean)) {
          res.reason = "変更前のコードでもテストが落ちる";
          res.failing = failuresOf(clean);
        } else res.reason = "プローブを入れるとテストが落ちる（ct の誤り）";
        resolved.delete(c.id);
        log(`到達  ${c.id}  判定不能`);
        continue;
      }
      baseline.set(c.id, r.ms);
      const file = readHits(hitsFile);
      for (const x of rs) {
        const via = new Set<"file" | "http">();
        if (file.has(x.probe)) via.add("file");
        if (http.hits.has(x.probe)) via.add("http");
        reached.set(x.probe, via);
      }
      log(
        `到達  ${c.id}  ${rs.map((x) => (reached.get(x.probe)?.size ? "到達" : "未到達")).join(" ")}`,
      );
    }

    // 2. Break, and 3. confirm.
    for (const c of claims) {
      const rs = resolved.get(c.id);
      if (rs === undefined) continue;
      const res = results.get(c.id) as ClaimResult;
      const base = baseline.get(c.id) ?? 0;
      for (const x of rs) {
        const text = original.get(x.join.file) as string;
        const via = reached.get(x.probe) ?? new Set();
        const jr: JoinResult = {
          in: x.join.in,
          code: x.code,
          symbolHash: sha256(x.symbolText),
          reached: via.size > 0,
          via: [...via].sort(),
          state: "unreached",
          breaks: [],
        };
        res.joins.push(jr);
        if (!jr.reached) continue;
        const all: (Break & { from: "generated" | "ledger" })[] = [
          ...(x.join.generate ? generateBreaks(x.join.file, text, x.loc) : []).map((b) => ({
            ...b,
            from: "generated" as const,
          })),
          ...x.join.breaks.map((b) => ({ ...ledgerBreak(x.loc, b), from: "ledger" as const })),
        ];
        const seen = new Set<string>();
        for (const b of all) {
          const out = applyEdit(text, b.edit);
          if (seen.has(out)) continue;
          seen.add(out);
          const br: BreakResult = {
            kind: b.kind,
            replaces: text.slice(b.edit.start, b.edit.end),
            with: b.edit.text,
            from: b.from,
            outcome: "invalid",
            ms: 0,
            runs: 0,
          };
          jr.breaks.push(br);
          const bad = validity(x.join.file, text, b.edit);
          if (bad !== undefined) {
            br.note = bad;
            continue;
          }
          write(x.join.file, out);
          const first = await run(c);
          br.runs = 1;
          br.ms = first.ms;
          let o = outcomeOf(first, base);
          let failures = failuresOf(first);
          if (o.outcome === "detected") {
            const again = await run(c);
            br.runs = 2;
            const o2 = outcomeOf(again, base);
            const f2 = failuresOf(again);
            if (o2.outcome !== "detected")
              o = {
                outcome: o2.outcome === "survived" ? "unstable" : o2.outcome,
                note: `2 回目: ${o2.note ?? o2.outcome}`,
              };
            else if (signature(failures) !== signature(f2))
              o = { outcome: "unstable", note: "2 回で、落ちたテストが違う" };
            failures = o.outcome === "detected" ? failures : f2;
          }
          write(x.join.file, text);
          br.outcome = o.outcome;
          if (o.note !== undefined) br.note = o.note;
          if (failures.length) br.failures = failures;
          log(
            `破壊  ${c.id}  ${oneLine(br.replaces).slice(0, 40)} → ${oneLine(br.with).slice(0, 30) || "（消す）"}  ${br.outcome}`,
          );
        }
        const valid = jr.breaks.filter((b) => b.outcome !== "invalid");
        if (valid.some((b) => b.outcome === "survived")) jr.state = "survived";
        else if (valid.length > 0 && valid.every((b) => b.outcome === "detected"))
          jr.state = "held";
        else jr.state = "undetermined";
      }
      res.state = res.joins.reduce<JoinState>(
        (a, j) => (RANK[j.state] > RANK[a] ? j.state : a),
        "held",
      );
      if (res.state === "undetermined" && res.reason === undefined) {
        const j = res.joins.find((x) => x.state === "undetermined");
        res.reason = j?.breaks.some((b) => b.outcome !== "invalid")
          ? "確かめられなかった壊し方がある"
          : "有効な壊し方がない";
      }
    }
    restore();

    return {
      version: 1,
      ...(copy.commit ? { commit: copy.commit } : {}),
      dirty: copy.dirty,
      startedAt,
      ms: Math.round(performance.now() - t0),
      testRuns,
      claims: claims.map((c) => results.get(c.id) as ClaimResult),
    };
  } finally {
    http.stop();
    rmSync(scratch, { recursive: true, force: true });
    copy.remove();
  }
}

/** The claims a command's arguments name: an area, a whole ID, or the part after the area. */
export function selectClaims(all: Claim[], names: string[]): Claim[] | string {
  if (names.length === 0) return all;
  const out = new Set<Claim>();
  for (const n of names) {
    const hit = all.filter((c) => c.id === n || c.id.startsWith(`${n}/`) || c.id.endsWith(`/${n}`));
    if (hit.length === 0) return n;
    for (const c of hit) out.add(c);
  }
  return all.filter((c) => out.has(c));
}
