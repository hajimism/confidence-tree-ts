#!/usr/bin/env bun
// ct: the command. Each subcommand the README describes is added here as it is built.
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { check, formatCheck, UsageError } from "./check.ts";
import { find, formatFind, type Target, TargetError } from "./find.ts";
import { hotspots } from "./hotspots.ts";
import { loadLedger } from "./ledger.ts";
import { prove, selectClaims } from "./prove.ts";
import { formatProof, saveResults } from "./results.ts";

const USAGE = `使い方: ct <コマンド>

  check [--base <ref>] [--json]   台帳が壊れていないかを確かめる
  prove [<主張>...] [--json] [--timeout 120s] [--keep]
                                  組み立て点を壊して、テストが落ちるかを確かめる
  find <ファイル>#<シンボル>... [--json] [--timeout 120s]
  find --hotspots [--top 5] [--since "12 months ago"] [--list] [--json]
                                  関数の中を壊して、どのテストも気づかない場所を探す
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

async function findCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      timeout: { type: "string", default: "120s" },
      keep: { type: "boolean", default: false },
      hotspots: { type: "boolean", default: false },
      top: { type: "string", default: "5" },
      since: { type: "string", default: "12 months ago" },
      list: { type: "boolean", default: false },
    },
  });
  let targets: Target[];
  if (values.hotspots) {
    if (positionals.length) throw new UsageError("--hotspots と関数の指定は、どちらか一方");
    const top = Number(values.top);
    if (!Number.isInteger(top) || top < 1)
      throw new UsageError(`--top ${values.top} は 1 以上の整数でない`);
    const ranked = hotspots(root, { since: values.since });
    if (values.list) {
      const shown = ranked.slice(0, top);
      if (values.json) console.log(JSON.stringify({ version: 1, hotspots: shown }, null, 2));
      else
        for (const h of shown)
          console.log(`${`${h.file}#${h.symbol}`.padEnd(48)} fix ${h.fixes} 件`);
      return 0;
    }
    targets = ranked.slice(0, top);
    if (targets.length === 0) {
      console.error(`ct find: ${values.since} 以降に、関数に触れた fix コミットがない`);
      return 0;
    }
  } else {
    if (positionals.length === 0)
      throw new UsageError("<ファイル>#<シンボル> か --hotspots を指定する");
    targets = positionals.map((p) => {
      const at = p.indexOf("#");
      if (at <= 0 || at === p.length - 1)
        throw new UsageError(`${p} は <ファイル>#<シンボル> の形でない`);
      return { file: p.slice(0, at), symbol: p.slice(at + 1) };
    });
  }
  try {
    const r = await find(root, targets, {
      timeoutMs: parseDuration(values.timeout),
      keep: values.keep,
      log: (l) => console.error(l),
    });
    console.log(values.json ? JSON.stringify(r, null, 2) : formatFind(r));
    return 0;
  } catch (e) {
    if (e instanceof TargetError) throw new UsageError(e.message);
    throw e;
  }
}

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  check: checkCommand,
  prove: proveCommand,
  find: findCommand,
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
