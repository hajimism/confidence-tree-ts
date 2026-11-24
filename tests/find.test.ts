import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { candidatesIn } from "../src/find.ts";
import { findSymbol, parseSource } from "../src/symbols.ts";
import { ct, git, project, write } from "./helpers.ts";

// Tests here run ct, which runs bun test many times; under load that takes more than 5 s.
setDefaultTimeout(120_000);

const RECORD = `export function record(
  flags: { after?: number; sheet?: boolean; out: string },
  rail: { available(): boolean; toggle(): void },
  presenter: { isOpen(): boolean },
) {
  const opts = run({
    after: flags.after,
    outDir: flags.out,
  });
  if (flags.after !== undefined) {
    log(flags.after);
  }
  if (!rail.available() || presenter.isOpen()) {
    return opts;
  }
  rail.toggle();
  return opts;
}

function run<T>(o: T): T {
  return o;
}

function log(_v: unknown) {}
`;

const FILES = {
  "src/record.ts": RECORD,
  "src/other.ts": "export const one = () => 1;\n",
  "tests/record.test.ts": `import { expect, test } from "bun:test";
import { record } from "../src/record.ts";

test("records into the out dir and toggles the rail", () => {
  let toggled = false;
  const rail = { available: () => true, toggle: () => { toggled = true; } };
  const r = record({ out: "x" }, rail, { isOpen: () => false });
  expect(r.outDir).toBe("x");
  expect(toggled).toBe(true);
});
`,
  "tests/other.test.ts": `import { expect, test } from "bun:test";
import { one } from "../src/other.ts";
test("one", () => expect(one()).toBe(1));
`,
};

describe("candidatesIn", () => {
  test("collects calls, conditions, assignments, returns and values passed in objects", () => {
    const s = findSymbol(parseSource("src/record.ts", RECORD), "record");
    if (!s.ok) throw new Error(s.reason);
    const cs = candidatesIn("src/record.ts", RECORD, s.symbol);
    expect(cs.map((c) => [c.line, c.code, c.breaks.length])).toEqual([
      [7, "after: flags.after", 1],
      [8, "outDir: flags.out", 1],
      [10, "if (flags.after !== undefined) {", 2],
      [11, "log(flags.after);", 1],
      [13, "if (!rail.available() || presenter.isOpen()) {", 4],
      [14, "return opts;", 1],
      [16, "rail.toggle();", 1],
      [17, "return opts;", 1],
    ]);
  });
});

type Json = {
  version: number;
  testFiles: number;
  targets: {
    in: string;
    fixes?: number;
    candidates: {
      line: number;
      code: string;
      state: string;
      reachedBy: string[];
      breaks: { kind: string; outcome: string; doing: string }[];
    }[];
  }[];
};

describe("ct find <file#symbol>", () => {
  const root = project(FILES, { commit: true });
  const r = ct(root, "find", "src/record.ts#record", "--json");
  const out = JSON.parse(r.out) as Json;
  const at = (line: number) => out.targets[0]?.candidates.find((c) => c.line === line);

  test("maps reach by test file: only the file that runs the function reaches it", () => {
    expect(r.code).toBe(0);
    expect(out.testFiles).toBe(2);
    expect(at(16)?.reachedBy).toEqual(["tests/record.test.ts"]);
  });

  test("a candidate no test file reaches is unreached and not broken", () => {
    expect(at(11)).toMatchObject({ state: "unreached", reachedBy: [] });
    expect(at(11)?.breaks.map((b) => b.outcome)).toEqual([]);
    expect(at(14)?.state).toBe("unreached");
  });

  test("a reached candidate whose break no test notices survives", () => {
    expect(at(7)?.state).toBe("survived");
    const cond = at(13);
    expect(cond?.state).toBe("survived");
    expect(cond?.breaks.map((b) => `${b.kind}:${b.outcome}`)).toEqual([
      "drop-term:survived",
      "drop-term:survived",
      "false:survived",
      "true:detected",
    ]);
    expect(cond?.breaks[1]?.doing).toBe("「|| presenter.isOpen()」を落として");
  });

  test("a reached candidate whose breaks are all noticed is detected", () => {
    expect(at(8)?.state).toBe("detected");
    expect(at(16)?.state).toBe("detected");
    expect(at(17)?.state).toBe("detected");
  });

  test("the text lists unreached and survived candidates first", () => {
    const t = ct(root, "find", "src/record.ts#record");
    const lines = t.out.split("\n").filter((l) => /^ {2}[◌◍●?]/.test(l));
    const marks = lines.map((l) => l.trim()[0]);
    expect(marks).toEqual(["◌", "◌", "◍", "◍", "◍", "●", "●", "●"]);
    expect(t.out).toContain("src/record.ts#record");
    expect(t.out).toContain("どのテストも到達しない");
    expect(t.out).toContain("到達: tests/record.test.ts · 消しても落ちない");
    expect(t.out).toContain("「|| presenter.isOpen()」を落としても落ちない");
  });

  test("a symbol that is not there is a usage error", () => {
    const bad = ct(root, "find", "src/record.ts#nope");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("nope");
  });
});

describe("ct find --hotspots", () => {
  test("ranks functions by the fix commits that touched them, and finds in the top ones", () => {
    const root = project(FILES, { commit: true });
    const commit = (msg: string) => {
      git(root, "add", "-A");
      git(
        root,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@e",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        msg,
      );
    };
    write(root, { "src/record.ts": RECORD.replace("rail.toggle();", "rail.toggle(); // 1") });
    commit("fix: toggle the rail");
    write(root, { "src/record.ts": RECORD.replace("rail.toggle();", "rail.toggle(); // 2") });
    commit("fix(record): toggle it again");
    write(root, { "src/other.ts": "export const one = () => 1; // a\n" });
    commit("fix: one");
    write(root, { "src/record.ts": RECORD.replace("return o;", "return o; // x") });
    commit("feat: run differently");

    const r = ct(root, "find", "--hotspots", "--top", "1", "--json");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out) as Json;
    expect(out.targets.map((t) => [t.in, t.fixes])).toEqual([["src/record.ts#record", 2]]);

    const list = ct(root, "find", "--hotspots", "--list");
    expect(list.out).toContain("src/record.ts#record");
    expect(list.out).toContain("fix 2 件");
    expect(list.out).toContain("src/other.ts#one");
    expect(list.out).not.toContain("#run");
  }, 60_000);
});
