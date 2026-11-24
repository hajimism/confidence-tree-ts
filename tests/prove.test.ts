import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ct, project } from "./helpers.ts";

// Tests here run ct, which runs bun test many times; under load that takes more than 5 s.
setDefaultTimeout(120_000);

const FILES = {
  "src/app.ts": `export function save(store: { set(v: number): void }, log: (v: number) => void, v: number) {
  store.set(v);
  log(v);
}

export function unused(x: number) {
  return x * 2;
}

export function either(a: boolean, b: boolean) {
  if (a || b) {
    return 1;
  }
  return 0;
}

export async function ready(signal: { resolve(): void }) {
  signal.resolve();
}

export function script(): string {
  return \`(() => {
  const go = globalThis["go"];
  if (typeof go === "function") {
    go();
  }
})();\`;
}
`,
  "src/greet.ts": `export function greet(name: string) {
  return "hi " + name;
}
`,
  "src/cli.ts": `import { greet } from "./greet.ts";
console.log(greet(process.argv[2] ?? ""));
`,
  "tests/app.test.ts": `import { describe, expect, test } from "bun:test";
import { either, ready, save, script } from "../src/app.ts";

describe("save", () => {
  test("stores the value", () => {
    let got = 0;
    save({ set: (v) => { got = v; } }, () => {}, 3);
    expect(got).toBe(3);
  });
});

describe("either", () => {
  test("is 1 when a is true and 0 when both are false", () => {
    expect(either(true, false)).toBe(1);
    expect(either(false, false)).toBe(0);
  });
});

test("ready resolves", async () => {
  await new Promise<void>((resolve) => ready({ resolve }));
}, 300);

test("the script calls go when there is one", () => {
  let called = false;
  (globalThis as Record<string, unknown>).go = () => { called = true; };
  new Function(script())();
  expect(called).toBe(true);
});

test("is broken already", () => {
  expect(1).toBe(2);
});
`,
  "tests/cli.test.ts": `import { expect, test } from "bun:test";
test("greets by name", () => {
  const r = Bun.spawnSync(["bun", "src/cli.ts", "bob"]);
  expect(r.stdout.toString().trim()).toBe("hi bob");
});
`,
  "confidence/app.yaml": `area: app
claims:
  save#stores:
    text: 保存すると、値を入れ物に入れる
    source: impl
    joins:
      - in: src/app.ts#save
        code: store.set(v);
    tests: [tests/app.test.ts > save > stores the value]
  save#logs:
    text: 保存すると、値を記録する
    source: impl
    joins:
      - in: src/app.ts#save
        code: log(v);
    tests: [tests/app.test.ts > save > stores the value]
  unused#doubles:
    text: 2 倍にする
    source: impl
    joins:
      - in: src/app.ts#unused
        code: return x * 2;
    tests: [tests/app.test.ts > save > stores the value]
  either#both:
    text: どちらかが真なら 1
    source: impl
    joins:
      - in: src/app.ts#either
        code: if (a || b) {
    tests: [tests/app.test.ts > either]
  greet#cli:
    text: CLI は名前で挨拶する
    source: impl
    joins:
      - in: src/greet.ts#greet
        code: return "hi " + name;
    tests: [tests/cli.test.ts > greets by name]
  script#calls-go:
    text: ページに go があれば呼ぶ
    source: impl
    joins:
      - in: src/app.ts#script
        code: "    go();\\n"
    tests: [tests/app.test.ts > the script calls go when there is one]
  ready#resolves:
    text: 用意ができたら知らせる
    source: impl
    joins:
      - in: src/app.ts#ready
        code: signal.resolve();
    tests: [tests/app.test.ts > ready resolves]
  broken#already:
    text: 落ちるテスト
    source: impl
    joins:
      - in: src/app.ts#save
        code: store.set(v);
    tests: [tests/app.test.ts > is broken already]
  none#untested:
    text: テストがない
    source: impl
    joins:
      - in: src/app.ts#save
        code: store.set(v);
  invalid#only:
    text: 構文の通らない壊し方だけ
    source: impl
    joins:
      - in: src/app.ts#save
        code: store.set(v);
        generate: false
        breaks: ["store.set(v;"]
    tests: [tests/app.test.ts > save > stores the value]
`,
};

type Json = {
  version: number;
  claims: {
    id: string;
    state: string;
    reason?: string;
    failing?: { test: string; message: string }[];
    joins: {
      in: string;
      reached: boolean;
      via: string[];
      state: string;
      breaks: {
        kind: string;
        replaces: string;
        with: string;
        from: string;
        doing: string;
        ms: number;
        runs: number;
        outcome: string;
        failures?: { test: string; kind: string; message: string }[];
      }[];
    }[];
  }[];
};

describe("ct prove", () => {
  const root = project(FILES, { commit: true });
  const r = ct(root, "prove", "--json");
  const out = JSON.parse(r.out) as Json;
  const claim = (id: string) => {
    const c = out.claims.find((x) => x.id === `app/${id}`);
    if (!c) throw new Error(`${id}: not in ${r.out}\n${r.err}`);
    return c;
  };

  test("runs, and exits 1 because not every claim is held", () => {
    expect(r.code).toBe(1);
    expect(out.version).toBe(1);
  });

  test("a break the test notices, twice, is a detection, with the test and why it failed", () => {
    const c = claim("save#stores");
    expect(c.state).toBe("held");
    expect(c.joins[0]?.via).toContain("file");
    expect(c.joins[0]?.breaks).toEqual([
      {
        kind: "delete-call",
        replaces: "store.set(v);",
        with: "",
        from: "generated",
        doing: "消して",
        outcome: "detected",
        ms: expect.any(Number),
        runs: 2,
        failures: [
          {
            test: "save > stores the value",
            kind: "assertion",
            message: expect.stringContaining("Expected: 3"),
          },
        ],
      },
    ]);
  });

  test("a reached join whose break no test notices survives", () => {
    const c = claim("save#logs");
    expect(c.state).toBe("survived");
    expect(c.joins[0]?.reached).toBe(true);
    expect(c.joins[0]?.breaks.map((b) => b.outcome)).toEqual(["survived"]);
  });

  test("a join no test reaches is unreached, and is not broken", () => {
    const c = claim("unused#doubles");
    expect(c.state).toBe("unreached");
    expect(c.joins[0]?.breaks).toEqual([]);
  });

  test("a condition with a term no test needs survives", () => {
    const c = claim("either#both");
    expect(c.state).toBe("survived");
    const byOutcome = c.joins[0]?.breaks.map((b) => `${b.kind}:${b.outcome}`);
    expect(byOutcome).toContain("drop-term:survived");
    expect(byOutcome).toContain("false:detected");
  });

  test("code in a CLI the test spawns is reached through the file sink", () => {
    const c = claim("greet#cli");
    expect(c.joins[0]?.via).toContain("file");
    expect(c.state).toBe("held");
  });

  test("code in a template string is probed and broken as the script it is", () => {
    expect(claim("script#calls-go").state).toBe("held");
  });

  test("a break that only makes a test run out of time is not a detection", () => {
    const c = claim("ready#resolves");
    expect(c.state).toBe("undetermined");
    expect(c.joins[0]?.breaks[0]?.outcome).toBe("timeout");
  });

  test("tests that fail with nothing broken leave the claim undetermined, naming them", () => {
    const c = claim("broken#already");
    expect(c.state).toBe("undetermined");
    expect(c.reason).toContain("変更前のコードでも");
    expect(c.failing?.map((f) => f.test)).toEqual(["is broken already"]);
  });

  test("a claim with no test is untested", () => {
    expect(claim("none#untested").state).toBe("untested");
  });

  test("with generate: false and only an invalid break, there is no valid break", () => {
    const c = claim("invalid#only");
    expect(c.state).toBe("undetermined");
    expect(c.joins[0]?.breaks.map((b) => b.outcome)).toEqual(["invalid"]);
  });

  test("leaves the project as it was", () => {
    expect(readFileSync(join(root, "src/app.ts"), "utf8")).toBe(FILES["src/app.ts"]);
  });

  test("keeps the results by claim in .ct/results.json", () => {
    const saved = JSON.parse(readFileSync(join(root, ".ct/results.json"), "utf8"));
    expect(saved.version).toBe(1);
    expect(Object.keys(saved.claims)).toHaveLength(10);
    expect(saved.claims["app/save#stores"]).toMatchObject({ state: "held" });
  });
});

describe("ct prove, narrowed", () => {
  test("proving one claim updates that claim's result and keeps the others", () => {
    const root = project(FILES, { commit: true });
    expect(ct(root, "prove", "save#logs", "--json").code).toBe(1);
    const r = ct(root, "prove", "app/save#stores");
    expect(r.code).toBe(0);
    expect(r.out).toContain("app/save#stores");
    expect(r.out).toContain("●");
    expect(r.out).not.toContain("save#logs");
    const saved = JSON.parse(readFileSync(join(root, ".ct/results.json"), "utf8"));
    expect(Object.keys(saved.claims).sort()).toEqual(["app/save#logs", "app/save#stores"]);
  });

  test("a name that matches no claim is a usage error", () => {
    const root = project(FILES, { commit: true });
    const r = ct(root, "prove", "nope#nothing");
    expect(r.code).toBe(2);
    expect(r.err).toContain("nope#nothing");
  });
});
