# 11. ct guard: command, flags and the ratchet

Date: 2026-11-24

## Status

Accepted

## Context

The README describes `ct guard` (守る) as a ratchet: CI stops only when a confidence once won is lost, compared with a baseline that is main's latest guard result. It shows `ct guard --base origin/main --comment`, and says that on a PR only the claims whose joins or tests the PR touched are proved again. It does not say how "touched" is told, what `--base` is for when the baseline is a file, or what `--comment` does. Pitfall 4 from the prototype: under load, a test can fail or pass by chance, so a single survival is not enough to call a regression.

## Decision

`ct guard [--base <ref>] [--baseline <file>] [--out <file>] [--all] [--comment <file>] [--json] [--timeout <duration>]`

- **Which claims are proved**: a claim is proved again when it is not in the baseline, or when its fingerprint differs from the baseline's.
  - The fingerprint is a sha256 of the claim's ledger entry (its joins, with `breaks` and `generate`, and its test refs), a sha256 of each join's symbol text and code, and a sha256 of each test file.
  - Every other claim is carried over from the baseline as it was (`carried: true`).
  - `--all` proves every claim; this is the nightly run.
- **Ratchet**: CI stops (exit 1) when one of these happens:
  - A break that the baseline detected survives now. A break is the same when its join, the join's code, its source, its kind and its edit are the same.
  - A claim the baseline held is no longer held, and the reason is one of these:
    - one of its joins is no longer reached;
    - a break survives that the baseline also had;
    - a break survives on a join whose code or symbol changed (↻: proved again and judged by the new result).
  - A claim in the baseline, or in the ledger at `--base`, is gone and has no `retired` entry with a reason.
- **Two survivals in a row**: every survival that would stop CI is run once more first (`recheck` in `ct prove`). If it is detected the second time, it is `unstable`, not a regression.
- **The user's choice where two README rows meet**: "保持でなくなった → 止める" and "新しい壊し方が検出されなかった → 表示するだけ" conflict when a held claim gets a new break. A held claim stops CI only on lost reach or on a survival as above. These are shown and do not stop CI:
  - a new break on an unchanged join that survives;
  - a baseline-detected break that now runs out of time, is slow, or is unstable.
- **Shown only**:
  - claims that are not held
  - new claims
  - breaks that survived and were not detected before
  - hidden breaks that survived (disclosed, adr/0012), for carried claims too, until a test notices them
- **`--base <ref>`** compares the ledger with the one at that commit, so a claim removed in the PR is caught even when the baseline never saw it.
- **`--comment <file>`** writes the README's PR comment, in Markdown, to the file. Posting is left to CI (`gh pr comment --body-file`); ct does not touch GitHub tokens.
- Without `CT_SEED`, guard warns on stderr and applies no hidden break. The result records `seeded: false`.
- Exit code: 0 with no regression, 1 with one, 2 when ct could not run.
- Human decisions in the comment (`ct ask`/`ct decide`) are not built.

## Consequences

A PR that touches nothing in the ledger costs nothing to guard. A PR that touches a join proves only the claims on it. A regression rests on two survivals in a row, and an improvement or a new failure that is not a loss never stops CI. A claim carried over keeps its baseline result even if code it does not name changed. Code that the joins' symbols and the claim's test files do not include is not fingerprinted. That is what the nightly `--all` run is for.
