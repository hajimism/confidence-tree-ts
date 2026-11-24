# 14. JSON output of ct guard

Date: 2026-11-24

## Status

Accepted

## Context

CI and agents need guard's verdict as data: which claims regressed and why, and which hidden breaks were disclosed. The file guard writes (`--out`) has to be readable as the next baseline.

## Decision

`ct guard --json` prints:

```json
{
  "version": 1,
  "ok": false,
  "baseline": ".ct/baseline.json",
  "base": "origin/main",
  "changes": [
    { "id": "app/save#stores", "change": "regressed", "from": "held", "to": "survived",
      "reasons": ["基準で検出されていた壊し方が、検出されなくなった: …"] }
  ],
  "disclosed": [
    { "claim": "app/save#logs", "in": "src/app.ts#save", "code": "log(v);", "kind": "undefined-arg",
      "replaces": "v", "with": "undefined", "doing": "引数「v」を undefined にして" }
  ],
  "testRuns": 12,
  "ms": 4100
}
```

- `change` is one of `regressed`, `removed`, `improved`, `redone`, `new` or `unchanged`. `ok` is false when any change is `regressed` or `removed`.
- `baseline` is null when there was none. `base` is there only with `--base`.
- The result itself is not printed. It is written to `--out` (adr/0013), where it becomes the next baseline:

  ```json
  {
    "version": 1, "commit": "…", "at": "…", "seeded": true,
    "claims": {
      "app/save#stores": { "state": "survived", "carried": false, "joins": ["sha256:… sha256:…"],
        "tests": { "tests/app.test.ts": "sha256:…" }, "result": { "…": "ct prove --json's claim" } }
    }
  }
  ```

  Hidden breaks are in it with `from: "hidden"`, so the baseline knows which ones were detected. That is also why it is not printed: CI logs are where agents can read. For the same reason, ct prove's progress lines on stderr print a hidden break as （隠した壊し方）, without its edit.
- `version` goes up only when a field is removed or changes meaning.

## Consequences

A CI step can fail, comment, or archive on `ok` and `changes` without reading the text. The baseline holds the hidden breaks' edits in plain text, so the cached file must not be shown to agents, and it must not be uploaded as a public artifact. It stays in CI's cache, which is where the README puts it.
