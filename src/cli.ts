#!/usr/bin/env bun
// ct: the command. Each subcommand the README describes is added here as it is built.
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { check, formatCheck, UsageError } from "./check.ts";
import { loadLedger } from "./ledger.ts";
import { prove, selectClaims } from "./prove.ts";
import { formatProof, saveResults } from "./results.ts";

const USAGE = `使い方: ct <コマンド>

  check [--base <ref>] [--json]   台帳が壊れていないかを確かめる
  prove [<主張>...] [--json] [--timeout 120s] [--keep]
                                  組み立て点を壊して、テストが落ちるかを確かめる
  --version                       版を表示する
  --help                          この使い方を表示する

設計は README.md にあります。`;

const root = process.cwd();

async function checkCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { base: { type: "string" }, json: { type: "boolean", default: false } },
  });
  const r = await check(root, values.base === undefined ? {} : { base: values.base });
  const ok = !r.problems.some((p) => p.level === "error");
  if (values.json)
    console.log(
      JSON.stringify({ version: 1, ok, claims: r.claims, problems: r.problems }, null, 2),
    );
  else console.log(formatCheck(r));
  return ok ? 0 : 1;
}

export function parseDuration(v: string): number {
  const m = /^(\d+)(ms|s|m)$/.exec(v);
  if (!m) throw new UsageError(`${v} は 120s の形の時間でない`);
  const n = Number(m[1]);
  return m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : n * 60_000;
}

async function proveCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      timeout: { type: "string", default: "120s" },
      keep: { type: "boolean", default: false },
    },
  });
  const ledger = await loadLedger(root);
  const broken = ledger.problems.filter((p) => p.code === "E100");
  if (broken.length)
    throw new UsageError(`台帳が読めない（ct check を見る）: ${broken[0]?.message}`);
  const claims = selectClaims(ledger.claims, positionals);
  if (typeof claims === "string") throw new UsageError(`${claims} に合う主張がない`);
  const p = await prove(root, claims, {
    timeoutMs: parseDuration(values.timeout),
    keep: values.keep,
    log: (l) => console.error(l),
  });
  saveResults(root, p, claims);
  console.log(values.json ? JSON.stringify(p, null, 2) : formatProof(p));
  return p.claims.every((c) => c.state === "held") ? 0 : 1;
}

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  check: checkCommand,
  prove: proveCommand,
};

const [command, ...rest] = process.argv.slice(2);

if (command === "--version") {
  console.log(pkg.version);
} else if (command === "--help") {
  console.log(USAGE);
} else {
  const run = command === undefined ? undefined : COMMANDS[command];
  if (run === undefined) {
    if (command !== undefined) console.error(`ct: ${command} というコマンドはありません\n`);
    console.error(USAGE);
    process.exit(2);
  }
  try {
    process.exit(await run(rest));
  } catch (e) {
    // 1 is kept for "ran, and found something"; anything that kept ct from running is 2.
    if (!(e instanceof UsageError) && !(e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS"))
      console.error((e as Error).stack);
    console.error(`ct ${command}: ${(e as Error).message}`);
    process.exit(2);
  }
}
