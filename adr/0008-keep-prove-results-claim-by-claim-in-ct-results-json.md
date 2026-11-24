# 8. Keep prove results claim by claim in .ct/results.json

Date: 2026-11-24

## Status

Accepted

## Context

The README says a claim's state is not written in the ledger but derived from prove's results. The prototype kept them in `confidence/proofs.lock`, committed, and rewrote the whole file on every run, so proving one claim dropped the others (pitfall 6). The README also says the guard's baseline is kept by CI, not committed.

## Decision

`ct prove` writes `.ct/results.json` in the project root:

```json
{
  "version": 1,
  "claims": {
    "<claim ID>": {
      "state": "held",
      "at": "<startedAt of the run>",
      "commit": "<HEAD>",
      "dirty": false,
      "tests": { "<test file>": "sha256:…" },
      "result": { "…": "the claim's entry from ct prove --json" }
    }
  }
}
```

Only the claims a run proved are replaced; the rest keep their last result. Claims are sorted by ID. `.ct/` is local state: it is not committed, and projects should ignore it (this repository's `.gitignore` does). The guard's own files will live under `.ct/` too, decided with `ct guard`.

## Consequences

Proving one claim no longer loses the others, and later commands (`ct show`, `ct gaps`, the `↻` state) have the hashes they need to tell when a claim must be proved again. The results are per machine; two people get two files, which is what local state should be.
