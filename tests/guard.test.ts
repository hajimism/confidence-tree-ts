import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git, project, write } from "./helpers.ts";

// Each test proves the project two or three times.
setDefaultTimeout(120_000);

const CLI = join(import.meta.dir, "../src/cli.ts");

function ct(cwd: string, env: Record<string, string>, ...args: string[]) {
  const r = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const APP = `export function save(store: { set(k: string, v: number): void }, log: (v: number) => void, v: number) {
  store.set("k", v);
  log(v);
}
`;
const GREET = `export function greet(name: string) {
  return "hi " + name;
}
`;
const APP_TEST = `import { expect, test } from "bun:test";
import { save } from "../src/app.ts";
test("stores the value under k", () => {
  const got: Record<string, number> = {};
  save({ set: (k, v) => { got[k] = v; } }, () => {}, 3);
  expect(got).toEqual({ k: 3 });
});
`;
const LEDGER = `area: app
claims:
  save#stores:
    text: 保存すると、値を k に入れる
    source: impl
    joins:
      - in: src/app.ts#save
        code: store.set("k", v);
    tests: [tests/app.test.ts > stores the value under k]
  save#logs:
    text: 保存すると、値を記録する
    source: impl
    joins:
      - in: src/app.ts#save
        code: log(v);
    tests: [tests/app.test.ts > stores the value under k]
  greet#hi:
    text: 名前で挨拶する
    source: impl
    joins:
      - in: src/greet.ts#greet
        code: return "hi " + name;
    tests: [tests/greet.test.ts > greets]
`;
const FILES = {
  "src/app.ts": APP,
  "src/greet.ts": GREET,
  "tests/app.test.ts": APP_TEST,
  "tests/greet.test.ts": `import { expect, test } from "bun:test";
import { greet } from "../src/greet.ts";
test("greets", () => expect(greet("bob")).toBe("hi bob"));
`,
  "confidence/app.yaml": LEDGER,
  ".gitignore": ".ct/\n",
};

const SEED = { CT_SEED: "test-seed" };

type Guard = {
  ok: boolean;
  /** Not printed: read from the --out file. */
  changes: { id: string; change: string; from?: string; to?: string; reasons: string[] }[];
  disclosed: { claim: string; doing: string }[];
  result: {
    claims: Record<
      string,
      {
        state: string;
        carried: boolean;
        result: { joins: { breaks: { from: string; outcome: string; runs: number }[] }[] };
      }
    >;
  };
};

/** What guard wrote to --out (its default), as the `result` of the report. */
const outFile = (root: string) =>
  ({ result: JSON.parse(readFileSync(join(root, ".ct/guard.json"), "utf8")) }) as Pick<
    Guard,
    "result"
  >;

/** A project with a baseline: the guard result of its first commit. */
function withBaseline() {
  const root = project(FILES, { commit: true });
  const first = ct(root, SEED, "guard", "--out", ".ct/baseline.json");
  return { root, first };
}

describe("ct guard", () => {
  test("with no baseline, proves everything, passes, and writes the result to be the next baseline", () => {
    const { root, first } = withBaseline();
    expect(first.code).toBe(0);
    expect(first.out).toContain("基準がない");
    const saved = JSON.parse(readFileSync(join(root, ".ct/baseline.json"), "utf8"));
    expect(Object.keys(saved.claims).sort()).toEqual([
      "app/greet#hi",
      "app/save#logs",
      "app/save#stores",
    ]);
    expect(saved.seeded).toBe(true);
  });

  test("applies at most two hidden breaks a join, the same ones for the same seed and code", () => {
    const { root } = withBaseline();
    const a = JSON.parse(readFileSync(join(root, ".ct/baseline.json"), "utf8"));
    const hidden = (g: Guard["result"], id: string) =>
      g.claims[id]?.result.joins.flatMap((j) => j.breaks).filter((b) => b.from === "hidden") ?? [];
    expect(hidden(a, "app/save#stores").length).toBeGreaterThan(0);
    expect(hidden(a, "app/save#stores").length).toBeLessThanOrEqual(2);
    ct(root, SEED, "guard", "--all", "--baseline", ".ct/none.json", "--out", ".ct/again.json");
    const b = JSON.parse(readFileSync(join(root, ".ct/again.json"), "utf8"));
    expect(
      JSON.stringify(hidden(b, "app/save#stores").map((x) => (x as { with?: string }).with)),
    ).toBe(JSON.stringify(hidden(a, "app/save#stores").map((x) => (x as { with?: string }).with)));
  });

  test("the hidden breaks are never printed, only written to --out", () => {
    const root = project(FILES, { commit: true });
    const r = ct(root, SEED, "guard", "--json");
    const hidden = Object.values(outFile(root).result.claims).flatMap((c) =>
      c.result.joins.flatMap((j) => j.breaks).filter((b) => b.from === "hidden"),
    );
    expect(hidden.length).toBeGreaterThan(0);
    expect(r.out).not.toContain('"hidden"');
    expect(r.err).toContain("（隠した壊し方）");
    expect(r.err).not.toContain("undefined  ");
  });

  test("without CT_SEED, applies no hidden break and says so", () => {
    const root = project(FILES, { commit: true });
    const r = ct(root, {}, "guard", "--json");
    expect(r.err).toContain("CT_SEED");
    const g = outFile(root);
    const all = Object.values(g.result.claims).flatMap((c) =>
      c.result.joins.flatMap((j) => j.breaks),
    );
    expect(all.some((b) => b.from === "hidden")).toBe(false);
  });

  test("a break the baseline detected that now survives twice is a regression, and stops CI", () => {
    const { root } = withBaseline();
    write(root, {
      "tests/app.test.ts": APP_TEST.replace(
        "expect(got).toEqual({ k: 3 });",
        "expect(got).toBeDefined();",
      ),
    });
    const r = ct(root, SEED, "guard", "--json");
    expect(r.code).toBe(1);
    const g = { ...(JSON.parse(r.out) as Guard), ...outFile(root) };
    expect(g.ok).toBe(false);
    const stores = g.changes.find((c) => c.id === "app/save#stores");
    expect(stores).toMatchObject({ change: "regressed", from: "held" });
    expect(stores?.reasons.join("\n")).toContain(
      "基準で検出されていた壊し方が、検出されなくなった",
    );
    const generated = g.result.claims["app/save#stores"]?.result.joins[0]?.breaks.find(
      (b) => b.from === "generated",
    );
    expect(generated).toMatchObject({ outcome: "survived", runs: 2 });
    const text = ct(root, SEED, "guard");
    expect(text.out).toContain("- app/save#stores");
    expect(text.out).toContain("● → ◍");
  });

  test("only claims whose join or tests changed are proved again; the rest are carried", () => {
    const { root } = withBaseline();
    write(root, { "tests/app.test.ts": `${APP_TEST}\n// touched\n` });
    const g = { ...(JSON.parse(ct(root, SEED, "guard", "--json").out) as Guard), ...outFile(root) };
    expect(g.result.claims["app/greet#hi"]?.carried).toBe(true);
    expect(g.result.claims["app/save#stores"]?.carried).toBe(false);
    expect(g.ok).toBe(true);
  });

  test("a claim that gets held is an improvement and does not stop CI", () => {
    const { root } = withBaseline();
    write(root, {
      "tests/app.test.ts": APP_TEST.replace(
        "() => {}, 3);",
        "(v) => { logged.push(v); }, 3);\n  expect(logged).toEqual([3]);",
      ).replace(
        "const got: Record<string, number> = {};",
        "const got: Record<string, number> = {};\n  const logged: number[] = [];",
      ),
    });
    const r = ct(root, SEED, "guard", "--json");
    const g = JSON.parse(r.out) as Guard;
    const logs = g.changes.find((c) => c.id === "app/save#logs");
    expect(logs?.from).toBe("survived");
    expect(["improved", "redone"]).toContain(logs?.change ?? "");
    expect(r.code).toBe(0);
  });

  test("a claim gone without a reason in retired stops CI; with one, it does not", () => {
    const { root } = withBaseline();
    const without = LEDGER.replace(/ {2}greet#hi:\n(?: {4}.*\n|\s{6}.*\n)+/, "");
    write(root, { "confidence/app.yaml": without });
    const r = ct(root, SEED, "guard", "--json");
    expect(r.code).toBe(1);
    const g = JSON.parse(r.out) as Guard;
    expect(g.changes.find((c) => c.id === "app/greet#hi")).toMatchObject({ change: "removed" });
    write(root, {
      "confidence/app.yaml": `${without}retired:\n  greet#hi:\n    reason: 挨拶はやめた\n`,
    });
    expect(ct(root, SEED, "guard").code).toBe(0);
  });

  test("--base also finds claims gone since that commit", () => {
    const root = project(FILES, { commit: true });
    const base = git(root, "rev-parse", "HEAD").trim();
    write(root, {
      "confidence/app.yaml": LEDGER.replace(/ {2}greet#hi:\n(?: {4}.*\n|\s{6}.*\n)+/, ""),
    });
    const r = ct(root, SEED, "guard", "--base", base, "--baseline", ".ct/none.json");
    expect(r.code).toBe(1);
    expect(r.out).toContain("app/greet#hi");
    expect(r.out).toContain("retired");
  });

  test("--comment writes the PR comment, with the hidden breaks that survived disclosed", () => {
    const { root } = withBaseline();
    const r = ct(root, SEED, "guard", "--comment", ".ct/comment.md", "--json");
    const g = JSON.parse(r.out) as Guard;
    expect(existsSync(join(root, ".ct/comment.md"))).toBe(true);
    const md = readFileSync(join(root, ".ct/comment.md"), "utf8");
    expect(md).toContain("確信の変化");
    // No test looks at what is logged, so log(v)'s hidden breaks survive.
    const logs = g.disclosed.find((d) => d.claim === "app/save#logs");
    expect(logs).toBeDefined();
    expect(md).toContain("隠した壊し方で生き残ったもの（開示）");
    expect(md).toContain(`${logs?.doing ?? "?"}も落ちない`);
  });
});
