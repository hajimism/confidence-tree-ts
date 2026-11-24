// What one break did to the tests: run them, and if they fail, run them again to confirm.
// Shared by ct prove and ct find. The rules are in adr/0006.
import type { Case, FailureKind, RunResult } from "./run.ts";

export type BreakOutcome =
  | "detected"
  | "survived"
  | "invalid"
  | "timeout"
  | "slow"
  | "unstable"
  | "error";

export type Failure = { test: string; kind: FailureKind; message: string };

export type Judgement = {
  outcome: Exclude<BreakOutcome, "invalid">;
  note?: string;
  /** The tests that failed, and why: what a detection rests on. */
  failures: Failure[];
  ms: number;
  runs: number;
};

/** A detection that took this much longer than the unbroken run is not trusted. */
export const slowLimit = (baselineMs: number) => baselineMs * 3 + 2000;

const testName = (c: Case) => c.path.join(" > ");

export function failuresOf(r: RunResult): Failure[] {
  const out: Failure[] = r.cases
    .filter((c) => c.status === "fail")
    .map((c) => ({ test: testName(c), kind: c.kind ?? "exception", message: c.message ?? "" }));
  for (const f of r.unloaded)
    out.push({ test: `${f}（読み込み）`, kind: "exception", message: r.tail.slice(-1000) });
  return out;
}

export const failed = (r: RunResult) =>
  r.killed || r.unloaded.length > 0 || r.cases.some((c) => c.status === "fail") || r.exitCode !== 0;

/** One run's outcome, before confirmation: "detected" here means only that it failed as it should. */
function outcomeOf(
  r: RunResult,
  baselineMs: number,
): { outcome: Judgement["outcome"]; note?: string } {
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
    return { outcome: "slow", note: `落ちるまでに ${r.ms}ms。壊す前は ${baselineMs}ms` };
  return { outcome: "detected" };
}

const signature = (f: Failure[]) =>
  f
    .filter((x) => x.kind !== "timeout")
    .map((x) => x.test)
    .sort()
    .join("\n");

/** Runs the tests with the break in place (`run`), and once more if they failed as they should. */
export async function judge(run: () => Promise<RunResult>, baselineMs: number): Promise<Judgement> {
  const first = await run();
  let o = outcomeOf(first, baselineMs);
  let failures = failuresOf(first);
  let runs = 1;
  if (o.outcome === "detected") {
    const again = await run();
    runs = 2;
    const o2 = outcomeOf(again, baselineMs);
    const f2 = failuresOf(again);
    if (o2.outcome !== "detected")
      o = {
        outcome: o2.outcome === "survived" ? "unstable" : o2.outcome,
        note: `2 回目: ${o2.note ?? o2.outcome}`,
      };
    else if (signature(failures) !== signature(f2))
      o = { outcome: "unstable", note: "2 回で、落ちたテストが違う" };
    if (o.outcome !== "detected") failures = f2;
  }
  return { ...o, failures, ms: first.ms, runs };
}
