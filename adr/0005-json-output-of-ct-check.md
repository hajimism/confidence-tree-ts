# 5. JSON output of ct check

Date: 2026-11-24

## Status

Accepted

## Context

Agents read ct's results, and the README lists `ct check --json` among the MCP tools. The text form is for people; an agent that parses it would break whenever the wording changes.

## Decision

`ct check --json` prints one JSON object on stdout:

```json
{
  "version": 1,
  "ok": false,
  "claims": 2,
  "problems": [
    {
      "code": "E103",
      "level": "error",
      "ledger": "confidence/signup.yaml",
      "claim": "signup/validation#clear-on-fix",
      "message": "組み立て点が見つからない",
      "fields": { "in": "src/form.ts#onChange", "code": "validate(field)" },
      "fix": "onChange の中の該当箇所を探して code を直す。組み立て方が変わったなら、主張の文も見直す"
    }
  ]
}
```

- `version` is the shape's version. It goes up only when a field is removed or changes meaning; adding a field does not change it.
- `ok` is false when any problem has `level: "error"`. Warnings do not make it false.
- `claim` and `fields` are left out when they do not apply. `message` and `fix` are the same Japanese text the text form prints.

The exit code is the same with or without `--json`: 0 when `ok`, 1 when not, 2 when ct could not run (a bad flag, a `--base` that is not a commit).

## Consequences

An agent can act on `code`, `claim` and `fields` without reading Japanese prose, and still show the person the same `fix` text the terminal shows. The other commands' `--json` shapes get their own records, with their own `version`.
