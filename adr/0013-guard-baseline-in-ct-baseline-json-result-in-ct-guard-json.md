# 13. Guard baseline in .ct/baseline.json, result in .ct/guard.json

Date: 2026-11-24

## Status

Accepted

## Context

The README says the baseline is main's latest guard result, kept by CI as a cache and not committed. ct needs a place to read the baseline from and to write its own result to, and CI needs to know which file to cache.

## Decision

- `ct guard` reads the baseline from `.ct/baseline.json` (`--baseline` to change it) and writes its own result to `.ct/guard.json` (`--out`). Both are in the shape of adr/0014's `result`.
- With no baseline file, guard proves every claim, reports that there is no baseline, and passes. Its result becomes the next baseline.
- CI on main saves `.ct/guard.json` to its cache. CI on a PR restores it as `.ct/baseline.json` before running guard.
- `.ct/` is local state and is not committed (adr/0008).

## Consequences

The ratchet works without committing results, as the README wants, and a missing cache only means one full run. A cache that is lost or expires drops the ratchet's memory until main runs again. A baseline older than its cache key could compare against a stale main; CI should key the cache by main's commit.
