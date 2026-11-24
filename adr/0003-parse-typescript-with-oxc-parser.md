# 3. Parse TypeScript with oxc-parser

Date: 2026-11-24

## Status

Accepted

## Context

A join is written as `<file>#<symbol>` with a `code` fragment unique inside the symbol (README, 台帳). To check it, ct has to find the symbol in the file's syntax tree; to generate breaks (`ct prove`, `ct find`), it has to find the calls, conditions, assignments, properties and returns inside it; and to throw out a break that does not parse, it has to tell a syntax error from valid code.

The prototype could not use the TypeScript the target project had: dek is on TypeScript 7, which has no JavaScript API for parsing. Its break generator loaded TypeScript 5.9.3 straight out of bun's cache. That is not something a released tool can do.

The candidates were `typescript@5` and `oxc-parser`. This repository's own `typescript` is `^7` (for `tsc`), so `typescript@5` as a dependency would have to be installed under an alias, and it is about 9 MB of JavaScript. `oxc-parser` is a native parser with prebuilt bindings per platform (about 2 MB each), gives an ESTree tree for TS, TSX, JS and JSX, and reports syntax errors without throwing.

## Decision

ct depends on `oxc-parser`, pinned to an exact version (0.x releases may break). It is used for three things: finding symbols (`src/symbols.ts`), finding the nodes to break, and deciding whether a broken or probed file still parses. Bun's transpiler is not used for the syntax check, so one parser decides both what a node is and whether a file is valid.

oxc-parser's `start` and `end` are indexes into the JavaScript string (UTF-16), not bytes. A test (`tests/symbols.test.ts`, Japanese text and an emoji before a join) holds this, because every offset ct writes at depends on it.

## Consequences

Parsing is fast and does not depend on the TypeScript the target project uses. ct now ships a native dependency: a platform without a prebuilt binding cannot run it, and an upgrade of oxc-parser can change the tree's shape, so each upgrade has to pass the symbol and break tests. The parser is syntax only; ct never type-checks a break, which matches the README (a break that does not type-check still runs).
