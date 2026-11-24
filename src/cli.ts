#!/usr/bin/env bun
// ct: the command. Each subcommand the README describes is added here as it is built.
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { check, formatCheck, UsageError } from "./check.ts";

const USAGE = `使い方: ct <コマンド>

  check [--base <ref>] [--json]   台帳が壊れていないかを確かめる
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

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  check: checkCommand,
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
