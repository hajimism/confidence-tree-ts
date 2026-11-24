// ct find: break a function's joins without a ledger, and list where no test notices.
//
//   1. candidates  every call, condition, assignment, return and value passed in an object in the
//                  function, each with the breaks ct generates for it
//   2. reach map   a probe at every candidate; each test file runs on its own, and its probes tell
//                  which candidates it reached
//   3. unreached   candidates no test file reached are not broken
//   4. break       a reached candidate's breaks run against the test files that reached it only
//   5. list        by function, unreached and survived first
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Break, generateBreaks, validity } from "./breaks.ts";
import { makeCopy } from "./copy.ts";
import { type Failure, failed, failuresOf, judge } from "./judge.ts";
import { parseTest } from "./ledger.ts";
import { clearHits, placeProbes, readHits, startHttpSink } from "./probe.ts";
import type { BreakResult } from "./prove.ts";
import { runTests } from "./run.ts";
import { applyEdit, type Span } from "./script.ts";
import { findSymbol, parseSource, type SymbolSpan } from "./symbols.ts";

export type CandidateState = "detected" | "survived" | "unreached" | "undetermined";

export type Candidate = {
  line: number;
  /** The candidate as the list shows it: the condition's line, or the node's code. */
  code: string;
  site: Span;
  breaks: Break[];
};

export type CandidateResult = {
  line: number;
  code: string;
  state: CandidateState;
  reachedBy: string[];
  note?: string;
  breaks: (BreakResult & { doing: string })[];
};

export type TargetResult = {
  in: string;
  /** Fix commits that touched the function (with --hotspots). */
  fixes?: number;
  candidates: CandidateResult[];
};

export type FindResult = {
  version: 1;
  commit?: string;
  dirty: boolean;
  ms: number;
  testFiles: number;
  testRuns: number;
  /** Test files that fail with nothing broken: they reach nothing and break nothing. */
  failingFiles: { file: string; failing: Failure[] }[];
  targets: TargetResult[];
};

export type Target = { file: string; symbol: string; fixes?: number };

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const lineAt = (text: string, pos: number) => text.slice(0, pos).split("\n").length;
const lineText = (text: string, pos: number) => {
  const a = text.lastIndexOf("\n", pos - 1) + 1;
  const b = text.indexOf("\n", pos);
  return text.slice(a, b === -1 ? text.length : b).trim();
};

/** The candidates in `symbol`: its generated breaks, grouped by the node each is about. */
export function candidatesIn(file: string, text: string, symbol: SymbolSpan): Candidate[] {
  const by = new Map<string, Candidate>();
  for (const b of generateBreaks(file, text, symbol)) {
    const key = `${b.site.start}:${b.site.end}`;
    let c = by.get(key);
    if (c === undefined) {
      c = { line: lineAt(text, b.site.start), code: "", site: b.site, breaks: [] };
      by.set(key, c);
    }
    c.breaks.push(b);
  }
  const out = [...by.values()].sort(
    (a, b) => a.site.start - b.site.start || b.site.end - a.site.end,
  );
  for (const c of out) {
    const condition = c.breaks.some((b) => ["drop-term", "false", "true"].includes(b.kind));
    c.code = condition
      ? lineText(text, c.site.start)
      : oneLine(text.slice(c.site.start, c.site.end));
  }
  return out;
}

/** The test files bun test would find: *.test, *_test, *.spec, *_spec, outside node_modules. */
export function testFiles(root: string): string[] {
  const glob = new Bun.Glob("**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}");
  return [...glob.scanSync({ cwd: root, followSymlinks: false })]
    .filter((f) => !f.split("/").includes("node_modules"))
    .sort();
}

export class TargetError extends Error {}

export type FindOptions = { timeoutMs: number; keep?: boolean; log?: (line: string) => void };

export async function find(
  root: string,
  targets: Target[],
  opts: FindOptions,
): Promise<FindResult> {
  const log = opts.log ?? (() => {});
  const t0 = performance.now();
  const copy = makeCopy(root, opts.keep ? { keep: true } : {});
  if (opts.keep) log(`複製: ${copy.root}`);
  const scratch = mkdtempSync(join(tmpdir(), "ct-find-"));
  const hitsFile = join(scratch, "hits");
  const http = startHttpSink();
  const target = { file: hitsFile, url: http.url };
  let testRuns = 0;
  const run = (files: string[]) => {
    testRuns++;
    return runTests(copy.root, files.map(parseTest), {
      timeoutMs: opts.timeoutMs,
      env: { CT_PROBE: hitsFile },
      scratch,
    });
  };
  const write = (file: string, text: string) => writeFileSync(join(copy.root, file), text);

  try {
    // 1. Candidates, each with a probe number.
    type Planned = { target: Target; candidate: Candidate; probe: number; result: CandidateResult };
    const original = new Map<string, string>();
    const planned: Planned[] = [];
    const results: TargetResult[] = [];
    for (const t of targets) {
      let text = original.get(t.file);
      if (text === undefined) {
        try {
          text = readFileSync(join(copy.root, t.file), "utf8");
        } catch {
          throw new TargetError(`${t.file} がない`);
        }
        original.set(t.file, text);
      }
      const s = findSymbol(parseSource(t.file, text), t.symbol);
      if (!s.ok)
        throw new TargetError(
          `${t.file}#${t.symbol}: シンボルが${s.reason === "ambiguous" ? `一意でない（${s.candidates.join("、")}）` : "ない"}`,
        );
      const tr: TargetResult = {
        in: `${t.file}#${s.symbol.path}`,
        ...(t.fixes !== undefined ? { fixes: t.fixes } : {}),
        candidates: [],
      };
      results.push(tr);
      for (const c of candidatesIn(t.file, text, s.symbol)) {
        const result: CandidateResult = {
          line: c.line,
          code: c.code,
          state: "unreached",
          reachedBy: [],
          breaks: [],
        };
        tr.candidates.push(result);
        planned.push({ target: t, candidate: c, probe: planned.length + 1, result });
      }
    }

    // Probes in place; a candidate whose probe cannot go in is left undetermined.
    const probed = new Map<string, string>();
    const live = new Set(planned);
    for (const [file, text] of original) {
      for (;;) {
        const here = [...live].filter((p) => p.target.file === file);
        const r = placeProbes(
          file,
          text,
          here.map((p) => ({ id: p.probe, loc: p.candidate.site })),
          target,
        );
        if (r.ok) {
          probed.set(file, r.text);
          break;
        }
        const p = here.find((x) => x.probe === r.id) as Planned;
        p.result.state = "undetermined";
        p.result.note = `プローブを置けない: ${r.error}`;
        live.delete(p);
      }
    }

    // 2. The reach map, one test file at a time.
    const files = testFiles(copy.root);
    const reachedBy = new Map<number, string[]>();
    const baseline = new Map<string, number>();
    const failingFiles: FindResult["failingFiles"] = [];
    for (const f of files) {
      for (const [file, text] of probed) write(file, text);
      clearHits(hitsFile);
      http.hits.clear();
      const r = await run([f]);
      await Bun.sleep(150);
      for (const [file, text] of original) write(file, text);
      if (failed(r)) {
        const clean = await run([f]);
        if (failed(clean)) {
          failingFiles.push({ file: f, failing: failuresOf(clean) });
          log(`到達  ${f}  変更前のコードでも落ちる`);
        } else log(`到達  ${f}  プローブを入れると落ちる（ct の誤り）`);
        continue;
      }
      baseline.set(f, r.ms);
      const hits = readHits(hitsFile);
      let n = 0;
      for (const p of live)
        if (hits.has(p.probe) || http.hits.has(p.probe)) {
          reachedBy.set(p.probe, [...(reachedBy.get(p.probe) ?? []), f]);
          n++;
        }
      log(`到達  ${f}  候補 ${n} 件`);
    }

    // 3 and 4. Break what was reached, against the files that reached it.
    for (const p of live) {
      const by = reachedBy.get(p.probe) ?? [];
      p.result.reachedBy = by;
      if (by.length === 0) continue;
      const text = original.get(p.target.file) as string;
      const base = by.reduce((ms, f) => ms + (baseline.get(f) ?? 0), 0);
      for (const b of p.candidate.breaks) {
        const br: CandidateResult["breaks"][number] = {
          kind: b.kind,
          from: "generated",
          replaces: text.slice(b.edit.start, b.edit.end),
          with: b.edit.text,
          doing: b.doing,
          outcome: "invalid",
          ms: 0,
          runs: 0,
        };
        p.result.breaks.push(br);
        const bad = validity(p.target.file, text, b.edit);
        if (bad !== undefined) {
          br.note = bad;
          continue;
        }
        write(p.target.file, applyEdit(text, b.edit));
        const j = await judge(() => run(by), base);
        write(p.target.file, text);
        br.outcome = j.outcome;
        br.ms = j.ms;
        br.runs = j.runs;
        if (j.note !== undefined) br.note = j.note;
        if (j.failures.length) br.failures = j.failures;
        log(`破壊  ${p.target.file}:${p.candidate.line}  ${b.kind}  ${br.outcome}`);
      }
      const valid = p.result.breaks.filter((b) => b.outcome !== "invalid");
      p.result.state = valid.some((b) => b.outcome === "survived")
        ? "survived"
        : valid.length > 0 && valid.every((b) => b.outcome === "detected")
          ? "detected"
          : "undetermined";
      if (p.result.state === "undetermined" && p.result.note === undefined)
        p.result.note = valid.length ? "確かめられなかった壊し方がある" : "有効な壊し方がない";
    }

    return {
      version: 1,
      ...(copy.commit ? { commit: copy.commit } : {}),
      dirty: copy.dirty,
      ms: Math.round(performance.now() - t0),
      testFiles: files.length,
      testRuns,
      failingFiles,
      targets: results,
    };
  } finally {
    http.stop();
    rmSync(scratch, { recursive: true, force: true });
    copy.remove();
  }
}

const RANK: Record<CandidateState, number> = {
  unreached: 0,
  survived: 1,
  undetermined: 2,
  detected: 3,
};
const MARK: Record<CandidateState, string> = {
  unreached: "◌ 空回り",
  survived: "◍ 素通り",
  undetermined: "? 判定不能",
  detected: "● 検出",
};

const width = (s: string) =>
  [...s].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0);
const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - width(s)));

export function formatFind(r: FindResult): string {
  const lines: string[] = [];
  const counts: Record<CandidateState, number> = {
    unreached: 0,
    survived: 0,
    undetermined: 0,
    detected: 0,
  };
  for (const t of r.targets) {
    lines.push(t.fixes === undefined ? t.in : `${pad(t.in, 48)}fix ${t.fixes} 件`);
    const sorted = [...t.candidates].sort(
      (a, b) => RANK[a.state] - RANK[b.state] || a.line - b.line,
    );
    for (const c of sorted) {
      counts[c.state]++;
      let detail = "";
      if (c.state === "unreached") detail = "どのテストも到達しない";
      else if (c.state === "survived") {
        const by =
          c.reachedBy.slice(0, 3).join(", ") +
          (c.reachedBy.length > 3 ? ` ほか ${c.reachedBy.length - 3}` : "");
        const surv = c.breaks
          .filter((b) => b.outcome === "survived")
          .map((b) => `${b.doing}も落ちない`);
        detail = `到達: ${by} · ${surv.join("、")}`;
      } else if (c.state === "undetermined") detail = c.note ?? "";
      const head = `  ${pad(MARK[c.state], 11)}`;
      const code = c.code.length > 60 ? `${c.code.slice(0, 57)}…` : c.code;
      if (detail === "") lines.push(`${head}${code}`);
      else if (width(code) <= 28) lines.push(`${head}${pad(code, 30)}${detail}`);
      else lines.push(`${head}${code}`, `${" ".repeat(13)}${detail}`);
    }
    lines.push("");
  }
  for (const f of r.failingFiles)
    lines.push(`! 変更前のコードでも落ちるので、使わなかったテストファイル: ${f.file}`);
  const total = r.targets.reduce((n, t) => n + t.candidates.length, 0);
  const s = Math.round(r.ms / 1000);
  lines.push(
    `候補 ${total} 件: 空回り ${counts.unreached}、素通り ${counts.survived}、検出 ${counts.detected}、判定不能 ${counts.undetermined}`,
    `テストファイル ${r.testFiles} 個、テストの実行 ${r.testRuns} 回、${Math.floor(s / 60)}分${s % 60}秒`,
  );
  return lines.join("\n");
}
