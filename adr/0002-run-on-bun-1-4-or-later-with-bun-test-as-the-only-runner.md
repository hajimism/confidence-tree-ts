# 2. Run on Bun 1.4 or later, with bun test as the only runner

Date: 2026-11-24

## Status

Accepted

## Context

ct runs a project's own tests many times: once per probe run and once per break. It needs a runtime to run itself on and a test runner whose results it can read test by test. The README's config lists four runners (`bun`, `vitest`, `jest`, `playwright`), but the prototype `ctp` and every experiment behind the design used only Bun and `bun test`, on dek. Nothing about the other runners has been tried.

## Decision

ct is written in TypeScript and runs on Bun 1.4 or later (`engines.bun` is `>=1.4.0`; CI pins 1.4.0, the oldest supported). It uses Bun's own APIs where they save a dependency: `Bun.YAML` for the ledger, `Bun.spawn` for test runs, `Bun.serve` for the HTTP probe sink, and `Bun.CryptoHasher` for hashes.

The first version supports one test runner, `bun test`, and reads its JUnit report (`--reporter=junit`) to know which named tests passed, failed, or ran out of time. vitest, jest, playwright and workspaces are left for later; each will get its own record.

## Consequences

ct cannot run on Node alone, and a project whose tests run under another runner cannot use it yet. In exchange, the first version is the setup that was measured, and every Bun API it depends on is in the version CI pins. Code that wants an API newer than 1.4.0 has to raise `engines.bun` and the CI pin together, in a record that supersedes this one.
