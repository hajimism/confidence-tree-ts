# 4. Ledger file shape

Date: 2026-11-24

## Status

Accepted

## Context

The README describes the ledger by example and a field table, and leaves some of its shape open. Three points had to be settled before `ct check` could read it:

- The field table lists `breaks` as a claim's field, but a hand-written break replaces one join's `code`, and a claim can have several joins.
- `in` is "a file and a symbol", but nothing says how to name a symbol that is not top-level, such as the `run` function of one entry of an object of commands (dek's `COMMANDS.shot.run`).
- The README applies generated breaks to every join. The acceptance test against dek keeps a control whose only break is invalid on purpose, and would turn held once generated breaks apply to its code.

The prototype's tree had a different shape again (`nodes:` with `claims:` under each, `probe:` placement per join). The README's shape replaces it.

## Decision

A ledger is every `confidence/*.yaml`. Each file is one area:

- `area`: required. A claim's ID is `<area>/<key>`.
- `claims`: a map from `<node>#<name>` to a claim, with the fields `text`, `source`, `kind` (`glue` by default, or `boundary`, `contract`, `unit`), `joins`, `assumes`, `fakes`, `tests`, and, for contract claims, `contract` and `against`. `assumes` and `replaced-by` may leave out the area.
- `retired`: a map from `<node>#<name>` to `reason` and `replaced-by`.

A join has:

- `in`: `<file>#<symbol>`, required. The symbol is a dotted path of the names that enclose it, from the outside in: functions, classes, variables, methods, and the keys of object literals. Call arguments and other unnamed nodes are passed through, so `COMMANDS.shot.run` names the `run` key of the object passed to the call under `COMMANDS`'s `shot` key. Outer names may be left out while the rest matches one symbol only (`shot.run`).
- `code`: a fragment that occurs exactly once inside the symbol. It need not be a whole node, and it may sit inside a template string.
- `order`: read but not yet checked; `ct check` warns that it was not checked.
- `breaks`: hand-written breaks, each a string that replaces `code`. Under the join, not the claim.
- `generate`: `false` applies only `breaks`, with no generated breaks. The default is `true`.

There is no `probe` field: where a probe goes is ct's job, worked out from the syntax tree.

`ct check`'s problems are numbered by the README's rules: `E101` to `E107` for rules 1 to 7, `E100` for a ledger it cannot read, and `W2xx` for warnings (`W201` a test given as a whole file outside a unit claim, `W202` an unchecked `order`, `W203` an unknown field, `W206` no commit to compare removals with). Rule 6 compares the ledger with the one at `HEAD`, or at `--base <ref>`.

## Consequences

The README's sample ledger loads as it is (a test reads it out of the README), and the README's field table now puts `breaks` and `generate` under `joins`. Symbol paths survive moving code around inside a file, but not renaming an enclosing name; `ct check` names the paths that are there when one goes missing. A ledger written for the prototype has to be rewritten by hand.
