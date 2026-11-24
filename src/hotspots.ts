// Hotspots: the functions that fix commits touched most, by the git history.
//
// A commit is a fix when its subject matches FIX (the README's default). For each one, the lines its
// diff changed are mapped to the innermost function around them, in the file as it was at that
// commit. A function counts once per commit, and only if its path still names one function now.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findSymbol, parseSource, type SymbolSpan } from "./symbols.ts";

export const FIX = /^(fix|bugfix)(\(.+\))?!?:/;
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST = /(\.|_)(test|spec)\.[^/]+$/;

export type Hotspot = { file: string; symbol: string; fixes: number };

function git(root: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

/** The new-side line ranges each file's hunks touch, from a `git show -U0` diff. */
export function changedLines(diff: string): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  let file: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? undefined : line.slice(6);
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && file !== undefined) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      const ranges = out.get(file) ?? [];
      // A pure deletion touches the line it follows.
      ranges.push([Math.max(1, start), Math.max(1, start + count - 1)]);
      out.set(file, ranges);
    }
  }
  return out;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** The innermost function around each changed line. */
function functionsTouched(file: string, text: string, ranges: [number, number][]): Set<string> {
  const parsed = parseSource(file, text);
  const fns = parsed.symbols.filter((s) => s.fn);
  const starts = lineStarts(text);
  const out = new Set<string>();
  for (const [a, b] of ranges)
    for (let line = a; line <= b; line++) {
      const from = starts[line - 1];
      if (from === undefined) continue;
      const to = (starts[line] ?? text.length + 1) - 1;
      const around = fns
        .filter((s: SymbolSpan) => s.start <= to && from < s.end)
        .sort((x, y) => x.end - x.start - (y.end - y.start))[0];
      if (around) out.add(around.path);
    }
  return out;
}

export function hotspots(root: string, opts: { since: string }): Hotspot[] {
  const prefix = git(root, ["rev-parse", "--show-prefix"]).trim();
  const log = git(root, ["log", "--no-merges", `--since=${opts.since}`, "--format=%H%x00%s"]);
  const counts = new Map<string, number>();
  for (const entry of log.split("\n").filter(Boolean)) {
    const [sha, subject] = entry.split("\0") as [string, string];
    if (!FIX.test(subject)) continue;
    const diff = git(root, ["show", "--format=", "-U0", "--no-renames", "--no-color", sha]);
    const touched = new Set<string>();
    for (const [path, ranges] of changedLines(diff)) {
      if (!path.startsWith(prefix)) continue;
      const file = path.slice(prefix.length);
      if (!SOURCE.test(file) || TEST.test(file) || file.split("/").includes("node_modules"))
        continue;
      const text = git(root, ["show", `${sha}:./${file}`]);
      for (const fn of functionsTouched(file, text, ranges)) touched.add(`${file}#${fn}`);
    }
    for (const t of touched) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const out: Hotspot[] = [];
  for (const [key, fixes] of counts) {
    const at = key.indexOf("#");
    const file = key.slice(0, at);
    const symbol = key.slice(at + 1);
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    const s = findSymbol(parseSource(file, text), symbol);
    if (s.ok && s.symbol.path === symbol && s.symbol.fn) out.push({ file, symbol, fixes });
  }
  return out.sort(
    (a, b) => b.fixes - a.fixes || `${a.file}#${a.symbol}`.localeCompare(`${b.file}#${b.symbol}`),
  );
}
