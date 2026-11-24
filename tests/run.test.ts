import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseTest } from "../src/ledger.ts";
import { failureKind, invocations, parseJunit, runTests } from "../src/run.ts";
import { project } from "./helpers.ts";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5">
  <testsuite name="tests/a.test.ts" file="tests/a.test.ts" tests="5">
    <testsuite name="outer" file="tests/a.test.ts" line="2" tests="5">
      <testsuite name="inner" file="tests/a.test.ts" line="3" tests="1">
        <testcase name="asserts" classname="inner &gt; outer" time="0.000673" file="tests/a.test.ts" line="4" assertions="1">
          <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;">AssertionError: expect(received).toBe(expected)</failure>
        </testcase>
      </testsuite>
      <testcase name="throws" classname="outer" time="0.001058" file="tests/a.test.ts" line="6" assertions="0">
        <failure type="TypeError" message="live is not a function">TypeError: live is not a function</failure>
      </testcase>
      <testcase name="times out" classname="outer" time="0.05" file="tests/a.test.ts" line="7" assertions="0">
        <failure type="TimeoutError" message="test timed out" />
      </testcase>
      <testcase name="waits" classname="outer" time="0.003" file="tests/a.test.ts" line="8" assertions="0">
        <failure type="Error" message="waitForFunction: Timeout 10000ms exceeded.">Error: waitForFunction: Timeout 10000ms exceeded.</failure>
      </testcase>
      <testcase name="passes" classname="outer" time="0.000008" file="tests/a.test.ts" line="9" assertions="0" />
    </testsuite>
  </testsuite>
</testsuites>`;

describe("parseJunit", () => {
  test("reads each test's describes, status, and why it failed", () => {
    expect(parseJunit(XML)).toEqual([
      {
        file: "tests/a.test.ts",
        path: ["outer", "inner", "asserts"],
        status: "fail",
        kind: "assertion",
        message: "expect(received).toBe(expected)\n\nExpected: 2\nReceived: 1",
        ms: 1,
      },
      {
        file: "tests/a.test.ts",
        path: ["outer", "throws"],
        status: "fail",
        kind: "exception",
        message: "TypeError: live is not a function",
        ms: 1,
      },
      {
        file: "tests/a.test.ts",
        path: ["outer", "times out"],
        status: "fail",
        kind: "timeout",
        message: "TimeoutError: test timed out",
        ms: 50,
      },
      {
        file: "tests/a.test.ts",
        path: ["outer", "waits"],
        status: "fail",
        kind: "timeout",
        message: "Error: waitForFunction: Timeout 10000ms exceeded.",
        ms: 3,
      },
      { file: "tests/a.test.ts", path: ["outer", "passes"], status: "pass", ms: 0 },
    ]);
  });
});

describe("failureKind", () => {
  test("tells an assertion from an exception from a wait that ran out", () => {
    expect(failureKind("AssertionError", "expect(x).toBe(y)")).toBe("assertion");
    expect(failureKind("TypeError", "x is not a function")).toBe("exception");
    expect(failureKind("TimeoutError", "test timed out")).toBe("timeout");
    expect(failureKind("Error", "page.waitForSelector: Timeout 5000ms exceeded")).toBe("timeout");
    expect(failureKind("Error", "timed out waiting for the server")).toBe("timeout");
  });
});

describe("invocations", () => {
  test("named tests and whole files run apart, so the names still narrow the named ones", () => {
    const refs = ["a.test.ts > d > one", "./a.test.ts > d > two", "b.test.ts", "c.test.ts > x"].map(
      parseTest,
    );
    expect(invocations(refs)).toEqual([
      { files: ["./a.test.ts", "./c.test.ts"], pattern: "^(?:d one|d two|x)( |$)" },
      { files: ["./b.test.ts"] },
    ]);
  });

  test("a file named whole and by test runs whole", () => {
    const refs = ["a.test.ts > d > one", "a.test.ts"].map(parseTest);
    expect(invocations(refs)).toEqual([{ files: ["./a.test.ts"] }]);
  });

  test("regex characters in names are escaped", () => {
    expect(invocations([parseTest("a.test.ts > f(x) [ok]?")])[0]?.pattern).toBe(
      "^(?:f\\(x\\) \\[ok\\]\\?)( |$)",
    );
  });
});

describe("runTests", () => {
  const root = project({
    "tests/a.test.ts": `import { describe, expect, test } from "bun:test";
describe("d", () => {
  test("one", () => expect(1).toBe(1));
  test("two", () => expect(1).toBe(2));
  test("other", () => expect(1).toBe(1));
});
`,
    "tests/broken.test.ts": `import "../nope.ts";\nimport { test } from "bun:test";\ntest("x", () => {});\n`,
  });
  const opts = { timeoutMs: 60_000, env: {}, scratch: join(root, ".scratch") };

  test("only the named tests are selected", async () => {
    const r = await runTests(root, [parseTest("tests/a.test.ts > d > one")], opts);
    expect(r.cases.map((c) => c.path.join(" > "))).toEqual(["d > one"]);
    expect(r.cases[0]?.status).toBe("pass");
  });

  test("a describe's name selects every test under it", async () => {
    const r = await runTests(root, [parseTest("tests/a.test.ts > d")], opts);
    expect(r.cases.map((c) => [c.path.at(-1), c.status])).toEqual([
      ["one", "pass"],
      ["two", "fail"],
      ["other", "pass"],
    ]);
  });

  test("a test file that fails to load is reported as such", async () => {
    const r = await runTests(root, [parseTest("tests/broken.test.ts > x")], opts);
    expect(r.cases).toEqual([]);
    expect(r.unloaded).toEqual(["tests/broken.test.ts"]);
  });
});
