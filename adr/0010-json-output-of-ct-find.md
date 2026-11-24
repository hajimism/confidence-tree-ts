# 10. JSON output of ct find

Date: 2026-11-24

## Status

Accepted

## Context

`ct find --json` is what an agent reads to turn candidates into claims (README クイックスタート, step 1), and the README lists it among the MCP tools.

## Decision

`ct find --json` prints one object:

```json
{
  "version": 1,
  "commit": "<HEAD, if in git>",
  "dirty": false,
  "ms": 3012,
  "testFiles": 2,
  "testRuns": 16,
  "failingFiles": [{ "file": "tests/x.test.ts", "failing": [{ "test": "…", "kind": "assertion", "message": "…" }] }],
  "targets": [
    {
      "in": "src/record.ts#record",
      "fixes": 2,
      "candidates": [
        {
          "line": 7,
          "code": "after: flags.after",
          "state": "survived",
          "reachedBy": ["tests/record.test.ts"],
          "breaks": [
            {
              "kind": "delete-property",
              "from": "generated",
              "replaces": "after: flags.after,",
              "with": "",
              "doing": "消して",
              "outcome": "survived",
              "ms": 120,
              "runs": 1
            }
          ]
        }
      ]
    }
  ]
}
```

- A candidate's `breaks` have the fields of `ct prove`'s breaks (adr/0007), plus `doing`, which describes the break (「…ても落ちない」 reads as `doing` + 「も落ちない」).
- `fixes` is there only with `--hotspots`. `note` on a candidate says why it is undetermined.
- `ct find --hotspots --list --json` prints `{ "version": 1, "hotspots": [{ "file", "symbol", "fixes" }] }`.
- `version` goes up only when a field is removed or changes meaning.

## Consequences

An agent can take each `unreached` and `survived` candidate, with its `in`, `line` and `code`, straight into a draft claim. It can also see which test files already reach the candidate. The shape shares its break fields with `ct prove`, so one reader handles both.
