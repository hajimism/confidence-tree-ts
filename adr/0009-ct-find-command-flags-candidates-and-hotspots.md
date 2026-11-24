# 9. ct find: command, flags, candidates and hotspots

Date: 2026-11-24

## Status

Accepted

## Context

The README describes `ct find` (探す): it works without a ledger, collects candidates in a function, maps reach by test file from real runs, breaks only what was reached, and lists unreached and survived candidates first. `--hotspots` starts from the functions that fix commits touch most. The README's config (`ct.config.ts`, `hotspots.fixCommits`, `hotspots.since`) is not built yet, and the README does not say what a candidate is when one node gets several breaks, how many hotspots to take, or which files count as test files.

## Decision

`ct find <file>#<symbol>… [--json] [--timeout <duration>] [--keep]`
`ct find --hotspots [--top <n>] [--since <git date>] [--list] [--json] [--timeout <duration>] [--keep]`

- **Candidates**: the breaks `ct prove` generates (adr/0006), applied to the whole symbol, grouped by the node each break is about. A condition is one candidate with its dropped terms, false and true. The list shows a condition by its line, and anything else by its code.
- **Test files**: what `bun test` would find: `*.test`, `*_test`, `*.spec`, `*_spec` with a JS or TS extension, outside `node_modules`.
- **Reach map**: every candidate gets a probe. Each test file then runs alone, whole, with every probe in place.
  - A file that fails is run again with nothing in place. If it fails then too, it is listed under `failingFiles` and plays no part: its reach is not counted and it breaks nothing.
  - A file that passes unprobed but fails probed is a ct error. It is logged and left out.
- **Breaking**: only reached candidates are broken. Each break runs the test files that reached its candidate, and is judged as in `ct prove`: confirmed by a second run, and timeouts and slow runs are not detections.
- **States**: `unreached` (◌ 空回り), `survived` (◍ 素通り) when any break survived, `detected` (● 検出) when every valid break was detected, and `undetermined` (? 判定不能) otherwise. Each function lists unreached first, then survived, then undetermined, then detected; ties go in line order.
- **Hotspots**:
  - A fix commit is a non-merge commit whose subject matches `^(fix|bugfix)(\(.+\))?!?:`.
  - A commit counts once for each function its diff touched. The function is the innermost one around a changed line, read in the file as it was at that commit.
  - Test files and files outside the project directory are left out.
  - A function counts only if its full path still names one function now.
  - `--since` defaults to `12 months ago` and `--top` to 5.
  - `--list` prints the ranking without breaking anything.
- Exit code 0 when `ct find` ran, whatever it found; 2 when it could not run (a symbol that is not there, a bad flag).
- `--propose` is not built yet.
- **Probes, in addition to adr/0006**: running `find` on dek's `lintCommand` showed probes that did not parse. ct now handles three slots:
  - A shorthand property is spelled out so its value can be wrapped: `{ project }` becomes `{ project: (probe, project) }`.
  - A method's or an accessor's function (`run() {}`, `get x() {}`, a class method) is never wrapped.
  - A JSX child is never wrapped, since it would render the probe as text.

  When several probes in one file together fail to parse, ct names a probe that fails on its own, so the caller drops the one at fault rather than the first it checked.

## Consequences

Finding needs no ledger and no test names, and the reach map comes from real runs. Code a test spawns or runs in a browser is counted like any other code. The cost is one run per test file, plus two runs per detected break, against the files that reached it. A function with many candidates and a big suite is slow.

The candidates are mechanical. Most of them have nothing to do with any one claim (pitfall 9: in dek's `lintCommand`, 12 of 50 bore on `hung-on`). This version only orders them as the README says. What to do about the noise is left open in the README's 未解決の設計.

The fix pattern and the period are flags until the config exists. When `ct.config.ts` lands, its `hotspots` settings should become their defaults, in a record that supersedes this part.
