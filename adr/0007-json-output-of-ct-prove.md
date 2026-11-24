# 7. JSON output of ct prove

Date: 2026-11-24

## Status

Accepted

## Context

Agents use `ct prove` after writing a test and need to know, per break, what happened and why. Pitfall 3 from the prototype: a detection is not always evidence that the join was checked (deleting dek's `return shotCommand(…)` failed the old test because the `--json` output broke the contract, not because `--sheet` was checked). The test that failed and its message have to be in the result.

## Decision

`ct prove --json` prints one object:

```json
{
  "version": 1,
  "commit": "<HEAD, if in git>",
  "dirty": false,
  "startedAt": "2026-11-24T03:00:00.000Z",
  "ms": 6123,
  "testRuns": 25,
  "claims": [
    {
      "id": "app/save#stores",
      "state": "held",
      "tests": ["tests/app.test.ts > save > stores the value"],
      "joins": [
        {
          "in": "src/app.ts#save",
          "code": "store.set(v);",
          "symbolHash": "sha256:…",
          "reached": true,
          "via": ["file"],
          "state": "held",
          "breaks": [
            {
              "kind": "delete-call",
              "from": "generated",
              "replaces": "store.set(v);",
              "with": "",
              "outcome": "detected",
              "ms": 210,
              "runs": 2,
              "failures": [
                { "test": "save > stores the value", "kind": "assertion", "message": "…" }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

- `state` of a claim: `held`, `survived`, `unreached`, `undetermined`, `untested`. Of a join: the same but `untested`.
- `reason` on a claim says why it is undetermined; `failing` lists the tests that fail with nothing broken.
- A break's `outcome`: `detected`, `survived`, `invalid`, `timeout`, `slow`, `unstable`, `error`; `note` says more where there is more to say. `failures` is kept on every outcome where tests failed.
- `version` goes up only when a field is removed or changes meaning.

## Consequences

Every hold can be traced to the tests that failed and their messages. The output is long for a big ledger, but it is meant to be read by a program. Human judgement (`◐` and the rest) is not in it yet, since `ct ask`/`ct decide` are not built.
