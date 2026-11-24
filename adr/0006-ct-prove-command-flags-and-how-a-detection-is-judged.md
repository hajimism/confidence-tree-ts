# 6. ct prove: command, flags and how a detection is judged

Date: 2026-11-24

## Status

Accepted

## Context

The README describes `ct prove` (判定の仕組み): reach is measured with probes only, breaking with breaks only, and a detection is confirmed by breaking again. It leaves open the flags, the exit code, what counts as "much slower", and some cases the prototype `ctp` ran into: tests that run out of time but are reported as ordinary failures (a `waitFor…` that gives up), a test file that fails to load, refs to whole files mixed with refs to named tests, and where in the code a probe goes now that the ledger has no `probe` field.

## Decision

`ct prove [<claim>…] [--json] [--timeout <duration>] [--keep]`

- A claim is named by its area (`signup`), its full ID, or the part after the area (`validation#clear-on-fix`). With none, every claim is proved. A name that matches nothing is a usage error.
- `--timeout` (default `120s`) is how long one run of a claim's tests may take before ct kills it. `--keep` keeps the copy ct broke, and prints where it is.
- Exit code: 0 when every proved claim is held, 1 when one is not, 2 when ct could not run.

How it works:

- ct copies the project, with its committed and uncommitted files, to a temporary directory, links `node_modules` instead of copying it, and breaks the copy. The project and its `.git` are never written to.
- Breaks: the generated ones (`delete-call`, `delete-assignment`, `delete-property`, `return-early` (`return expr;` becomes `return;`), `drop-term`, `false`, `true`), applied only to nodes inside the join's code, and then the join's `breaks`. `generate: false` leaves out the generated ones. When the join is inside a template string that holds a script, the script is parsed on its own and broken as code; a break that leaves that script unparsable is invalid even if the TypeScript file still parses.
- Probes wrap the outermost expression in the join's code that can be wrapped safely (`(probe, expr)`; never a callee, an assignment target or a key), or go before a statement when there is no such expression. A probe writes to the file named by `CT_PROBE` (also written into the probe, since a test may spawn a child with a clean environment) and to a local HTTP sink, once per process, and the result records which one heard it (`via`).
- A claim's refs are run as at most two `bun test` invocations: one for the files named by test, narrowed by `--test-name-pattern`, and one for files named whole. Mixed in one invocation, the pattern could not narrow the named ones.
- Reach: the claim's tests run once with every probe in place. If they fail, they run again with nothing in place; failing then too makes the claim undetermined, with the failing tests named. A join no test reaches is unreached and is not broken.
- A failing test's reason is read from bun's JUnit report: `timeout` when the failure's type is `TimeoutError` or its message says a time ran out (`timed out`, `Timeout … exceeded`), `assertion` for `AssertionError`, `exception` otherwise. A test file that reports no test is a failure to load and counts as an exception.
- A break whose failures are all timeouts is `timeout`, not a detection. A break whose run took more than three times the unbroken run plus 2 s is `slow`, not a detection. Otherwise a failing break is run again, and is `detected` only if the same tests fail the second time for a reason other than running out of time; else it is `unstable`.
- A join is held when every valid break is detected, survived when any break survived, and undetermined otherwise (including when it has no valid break). A claim takes its worst join: unreached, then survived, then undetermined, then held. A claim with no tests is `untested`.
- Breaks run one at a time. There is no `--batch` in this version: in the prototype it was slower than one at a time.

## Consequences

A detection rests on two runs that fail for the same named tests, and each break's failures (test, kind, message) are kept in the result, so a hold can be checked against what actually failed. That costs one more run per detected break. The 3× + 2 s limit is a first guess, not measured; it is in one place (`slowLimit` in `src/prove.ts`) so it can be changed by a superseding record. Wrapping an expression in a comma expression can change a function's inferred `name` when the expression is the function itself; ct accepts this.
