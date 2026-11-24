#!/usr/bin/env bun
// Compares `ct prove --json` with a truth file written before ct ran (claim ID: state).
//
//   bun acceptance/compare.ts <prove.json> <truth.yaml>
//
// Prints the table of truth against judgement, the false holds, and every claim that differs, with
// each break's outcome so the difference can be explained. Exits 1 if there is a false hold.
import { readFileSync } from "node:fs";
import type { Proof } from "../src/prove.ts";

const STATES = ["held", "unreached", "survived", "undetermined", "untested"] as const;

const [proofFile, truthFile] = process.argv.slice(2);
if (!proofFile || !truthFile) {
  console.error("使い方: bun acceptance/compare.ts <prove.json> <truth.yaml>");
  process.exit(2);
}
const proof = JSON.parse(readFileSync(proofFile, "utf8")) as Proof;
const truth = Bun.YAML.parse(readFileSync(truthFile, "utf8")) as Record<string, string>;

const pad = (s: string, n: number) => s.padEnd(n);
const counts = new Map<string, number>();
let falseHeld = 0;
const differs: string[] = [];
for (const [id, want] of Object.entries(truth)) {
  const c = proof.claims.find((x) => x.id === id);
  const got = c?.state ?? "missing";
  counts.set(`${want}/${got}`, (counts.get(`${want}/${got}`) ?? 0) + 1);
  if (got === "held" && want !== "held") falseHeld++;
  if (got === want) continue;
  differs.push(`${id}: 正解 ${want}、判定 ${got}${c?.reason ? `（${c.reason}）` : ""}`);
  for (const j of c?.joins ?? []) {
    differs.push(
      `  ${j.in}  到達 ${j.reached ? `あり（${j.via.join("、")}）` : "なし"}  ${j.state}`,
    );
    for (const b of j.breaks) {
      const f = (b.failures ?? []).map((x) => `${x.test} [${x.kind}] ${x.message.split("\n")[0]}`);
      differs.push(
        `    ${b.from} ${b.kind}: ${JSON.stringify(b.with)}  ${b.outcome}${b.note ? ` ${b.note}` : ""}`,
      );
      for (const x of f) differs.push(`      ${x}`);
    }
  }
}
const cols = STATES.filter(
  (g) => [...counts.keys()].some((k) => k.endsWith(`/${g}`)) || g !== "untested",
);
console.log(`${pad("", 22)}${cols.map((g) => pad(`判定: ${g}`, 18)).join("")}`);
for (const w of STATES.filter((s) => Object.values(truth).includes(s)))
  console.log(
    `${pad(`正解: ${w}`, 22)}${cols.map((g) => pad(String(counts.get(`${w}/${g}`) ?? 0), 18)).join("")}`,
  );
console.log(`\n偽の保持: ${falseHeld} 件`);
console.log(differs.length ? `食い違い:\n${differs.join("\n")}` : "食い違い: なし");
const untracked = proof.claims.filter((c) => !(c.id in truth));
for (const c of untracked)
  console.log(
    `正解のない主張: ${c.id} ${c.state}  ${c.joins.map((j) => `${j.in} 到達 ${j.reached ? j.via.join("、") : "なし"}`).join("  ")}`,
  );
process.exit(falseHeld ? 1 : 0);
