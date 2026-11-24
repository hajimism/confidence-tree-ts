# confidence-tree-ts

A confidence ledger for TypeScript: it breaks how a project's parts are put together, finds where no test notices, and keeps a confidence once it is won. Written in TypeScript on Bun, run as `ct`.

`README.md` is the design, stated as what the tool is. Nothing in it is built yet unless this file or the code says so.

## Built so far

- `ct check`: the ledger's rules 1–3 and 6, with `--base` and `--json`.
- `ct prove`: reach, break and confirm, with generated and ledger breaks, `--json`, and `.ct/results.json`.
- `ct find <file#symbol>` and `ct find --hotspots`: candidates, a reach map by test file, and breaks of what was reached (`--propose` is not built).

## Layout

- `src/`: the CLI (`src/cli.ts`) and everything it runs.
- `tests/`: `bun test`.
- `adr/`: decision records.
- `acceptance/`: the acceptance runs against real projects (`acceptance/dek/` is dek `b5db9910`).

## Rules

- **Test first.** Write the failing test, then the code. A behaviour the README describes is done when a test shows it.
- **The README is the spec.** If the code and the README disagree, say which one is wrong; change the README in the same commit as the code when the design moves.
- **Only claim what was shown.** `README.md#ここまでにわかっていること` separates what experiments showed from what was only observed. Keep it that way.
- **Commits are Conventional Commits**, `!` for a breaking change.
- **Decisions go in `adr/`**: the command and its flags, `--json` shapes, the ledger's fields, the config, runtimes and dependencies, and anything breaking. Write one with `mise exec -- adrs new "Title"`, fill every section, and run `mise exec -- adrs doctor`. Never rewrite an accepted record; supersede it.

## Prior work

The prototype `ctp` and the experiments behind the design are on the `exp/ctp` branch of hajimism/dek, under `tools/ctp/` (`experiments/*.md` are the records). Read them before redoing a measurement; do not copy the prototype's code without a test for it.

## Before you report work as done

Run what CI runs: `bunx biome ci .`, `bun run typecheck`, `bun test`, and `mise exec -- adrs doctor`.
