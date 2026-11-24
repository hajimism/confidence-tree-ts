#!/usr/bin/env bun
// ct: the command. Each subcommand the README describes is added here as it is built.
import pkg from "../package.json";

const USAGE = `使い方: ct <コマンド>

  --version   版を表示する
  --help      この使い方を表示する

コマンドはまだありません。設計は README.md にあります。`;

const [command] = process.argv.slice(2);

if (command === "--version") {
  console.log(pkg.version);
} else if (command === "--help") {
  console.log(USAGE);
} else {
  if (command !== undefined) console.error(`ct: ${command} というコマンドはありません\n`);
  console.error(USAGE);
  process.exit(2);
}
