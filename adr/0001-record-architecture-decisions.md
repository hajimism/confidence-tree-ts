# 1. Record architecture decisions

Date: 2026-11-24

## Status

Accepted

## Context

confidence-tree-ts starts as a design in `README.md`, written from the experiments with the prototype `ctp` on dek. The README says what the tool is; it does not keep why one option won over another, or which choices were made after the README was written. Much of the tool will be written with agents, and an agent that cannot see why a choice was made reopens it or undoes it.

## Decision

Every design decision that bears on a release is recorded as an Architecture Decision Record in `adr/`, in the form Michael Nygard describes in [Documenting Architecture Decisions](https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions), and kept with [adrs](https://github.com/joshrotenberg/adrs), pinned in `mise.toml`.

A decision bears on a release when it changes what ships or how it ships: the commands, their flags and `--json` shapes; the ledger's fields and the files ct reads and writes; the config; the supported runtimes, test runners, and dependencies; the release pipeline; and anything breaking.

The record lands in the same commit or pull request as the change. Write it with `mise exec -- adrs new "<title>"`, fill every section, and run `mise exec -- adrs doctor`. An accepted record is not rewritten when the decision changes: a new one supersedes it with `adrs new --supersedes <n>`. Records are written in English.

## Consequences

Each record costs a few minutes per decision. In exchange, why the code is the way it is can be read in one place, and a decision is changed by superseding it in the open rather than by drift. The README stays the statement of what the tool is; a record that changes the design changes the README in the same commit.
