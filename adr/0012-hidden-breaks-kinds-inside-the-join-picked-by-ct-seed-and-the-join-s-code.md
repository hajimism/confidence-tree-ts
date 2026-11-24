# 12. Hidden breaks: kinds inside the join, picked by CT_SEED and the join's code

Date: 2026-11-24

## Status

Accepted

## Context

The README says `ct guard` applies hidden breaks: ones the agent never saw, so that tests are not written to the shown breaks alone. Their seed comes from the join's code and `CT_SEED`, which only CI has. The same breaks must apply while the join's code is unchanged, so nothing fails out of the blue. The README does not say which breaks are candidates. Stage 3 drew them from the whole enclosing function. There, many had nothing to do with the claim, and some were held at the base because of unrelated failures (the calibration in `stage3.md`). The user chose kinds of break inside the join's own code.

## Decision

A join's hidden breaks come from kinds `ct prove` never generates, applied only to nodes inside the join's `code`:

| node | hidden break | kind |
| --- | --- | --- |
| call | drop one argument; make one argument `undefined` | `drop-arg`, `undefined-arg` |
| condition | negate it, `!(…)` | `negate` |
| `&&` / `\|\|` chain | swap the operator | `swap-op` |
| comparison | flip it: `===`↔`!==`, `==`↔`!=`, `<`→`<=`, `<=`→`<`, `>`→`>=`, `>=`→`>` | `flip-compare` |
| property, assignment | make the value `undefined` (a shorthand is spelled out) | `undefined-value` |

Candidates whose result is the same as a shown break (generated or in the join's `breaks`) are dropped, and so are those that do not parse.

From the rest, guard applies the two (`HIDDEN_PER_JOIN`) with the smallest `sha256(CT_SEED, join.in, join.code, kind, edit start and end relative to the code, edit text)`. The edit is taken relative to the join's code, so code moving around the join does not change the pick, and nothing else in the file does either. Without `CT_SEED` the order could be worked out from the repository, so guard then applies none.

## Consequences

Hidden breaks stay close to what the claim is about, and they are stable while the join's code is. An agent cannot see which two apply without `CT_SEED`. It can see the candidate kinds, since they are in this record and in the code. Some joins have no candidate (a statement with no call argument, condition, value or assignment); they get no hidden break.

A disclosed break is shown in every guard comment until a test notices it. `ct prove` does not yet apply disclosed breaks. The README's "以後は見える壊し方として扱います" is met only through the comment, and the README says so.
