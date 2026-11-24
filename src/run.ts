// Runs a claim's tests with bun test and reads, from its JUnit report, what each named test did.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TestRef } from "./ledger.ts";

export type FailureKind = "assertion" | "exception" | "timeout";

export type Case = {
  file: string;
  /** The describes, outside in, then the test's own name. */
  path: string[];
  status: "pass" | "fail" | "skip";
  kind?: FailureKind;
  message?: string;
  ms: number;
};

export type RunResult = {
  /** The named tests that ran (skipped ones left out). */
  cases: Case[];
  /** Named test files that reported no test at all: they failed to load. */
  unloaded: string[];
  exitCode: number | null;
  /** ct stopped the run: it went past the time allowed. */
  killed: boolean;
  ms: number;
  /** The last lines bun printed. */
  tail: string;
};

const TIMEOUT = /timed? ?out|timeout\b.*exceeded|exceeded.*timeout/i;

export function failureKind(type: string, message: string): FailureKind {
  if (type === "TimeoutError" || TIMEOUT.test(message)) return "timeout";
  if (type === "AssertionError") return "assertion";
  return "exception";
}

const unxml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unxml(m[1] as string) : undefined;
};

/** Bun's report nests a testsuite per describe under one per file. */
export function parseJunit(xml: string): Case[] {
  const cases: Case[] = [];
  const stack: string[] = [];
  const re =
    /<testsuite\b[^>]*?>|<\/testsuite>|<testcase\b[^>]*?\/>|<testcase\b[^>]*?>[\s\S]*?<\/testcase>/g;
  for (const m of xml.matchAll(re)) {
    const t = m[0];
    if (t.startsWith("</testsuite")) stack.pop();
    else if (t.startsWith("<testsuite")) stack.push(attr(t, "name") ?? "");
    else {
      const open = /^<testcase\b[^>]*?>/.exec(t)?.[0] ?? t;
      const c: Case = {
        file: attr(open, "file") ?? "",
        path: [...stack.slice(1), attr(open, "name") ?? ""],
        status: "pass",
        ms: Math.round(Number(attr(open, "time") ?? 0) * 1000),
      };
      const failure = /<failure\b[^>]*>/.exec(t)?.[0];
      if (/<skipped\b/.test(t)) c.status = "skip";
      else if (failure) {
        const type = attr(failure, "type") ?? "Error";
        const message = (attr(failure, "message") ?? "").trim();
        c.status = "fail";
        c.kind = failureKind(type, message);
        c.message = (c.kind === "assertion" ? message : `${type}: ${message}`).slice(0, 1000);
      }
      cases.push(c);
    }
  }
  return cases;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const norm = (f: string) => f.replace(/^\.\//, "");
const arg = (f: string) => (f.startsWith("/") ? f : `./${norm(f)}`);
const parts = (t: TestRef) =>
  t.name === undefined ? [] : t.name.split(" > ").map((s) => s.trim());

export type Invocation = { files: string[]; pattern?: string };

/**
 * One bun test run per kind of ref: one for the files named by test, narrowed by a name pattern,
 * and one for the files named whole. Mixed in one run, the pattern could not be applied.
 */
export function invocations(tests: TestRef[]): Invocation[] {
  const whole = [...new Set(tests.filter((t) => t.name === undefined).map((t) => norm(t.file)))];
  const named = tests.filter((t) => t.name !== undefined && !whole.includes(norm(t.file)));
  const out: Invocation[] = [];
  if (named.length) {
    const names = [...new Set(named.map((t) => parts(t).join(" ")))];
    out.push({
      files: [...new Set(named.map((t) => arg(t.file)))],
      pattern: `^(?:${names.map(escapeRegex).join("|")})( |$)`,
    });
  }
  if (whole.length) out.push({ files: whole.map(arg) });
  return out;
}

/** The cases a ref names: the whole file, or the tests at or under its describe path. */
export function selects(t: TestRef, c: Case): boolean {
  if (norm(c.file) !== norm(t.file)) return false;
  const want = parts(t);
  return want.every((w, i) => c.path[i] === w);
}

export type RunOptions = { timeoutMs: number; env: Record<string, string>; scratch: string };

let reports = 0;

export async function runTests(
  cwd: string,
  tests: TestRef[],
  opts: RunOptions,
): Promise<RunResult> {
  mkdirSync(opts.scratch, { recursive: true });
  const started = performance.now();
  const all: Case[] = [];
  let exitCode: number | null = 0;
  let killed = false;
  const tails: string[] = [];
  for (const inv of invocations(tests)) {
    const report = join(opts.scratch, `report-${process.pid}-${reports++}.xml`);
    rmSync(report, { force: true });
    const cmd = ["bun", "test", ...inv.files];
    if (inv.pattern !== undefined) cmd.push("--test-name-pattern", inv.pattern);
    cmd.push("--reporter=junit", `--reporter-outfile=${report}`);
    const proc = Bun.spawn(cmd, {
      cwd,
      env: { ...process.env, ...opts.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, opts.timeoutMs);
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) exitCode = code;
    tails.push(`${out}\n${err}`.trim());
    if (existsSync(report)) all.push(...parseJunit(readFileSync(report, "utf8")));
  }
  const cases = all.filter((c) => c.status !== "skip" && tests.some((t) => selects(t, c)));
  const files = [...new Set(tests.map((t) => norm(t.file)))];
  const unloaded = killed
    ? []
    : files.filter((f) => exitCode !== 0 && !all.some((c) => norm(c.file) === f));
  return {
    cases,
    unloaded,
    exitCode,
    killed,
    ms: Math.round(performance.now() - started),
    tail: tails.join("\n").split("\n").slice(-20).join("\n"),
  };
}
