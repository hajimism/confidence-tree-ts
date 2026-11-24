import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLedger } from "../src/ledger.ts";

const README = readFileSync(join(import.meta.dir, "../README.md"), "utf8");
const SAMPLE = /```yaml\n(# confidence\/signup\.yaml\n[\s\S]*?)```/.exec(README)?.[1] ?? "";

describe("parseLedger", () => {
  test("reads the README's sample ledger without a problem", () => {
    const l = parseLedger(SAMPLE, "confidence/signup.yaml");
    expect(l.problems).toEqual([]);
    expect(l.claims.map((c) => c.id)).toEqual([
      "signup/validation#clear-on-fix",
      "signup/validation#revalidate-on-change",
      "signup/api#returns-user",
      "signup/api#fake-keeps-contract",
      "signup/rules#required",
    ]);
    expect(l.retired).toEqual([
      {
        id: "signup/validation#validate-on-blur",
        ledger: "confidence/signup.yaml",
        reason: "仕様変更で、検証は入力ごとに行うことになった",
        replacedBy: "signup/validation#revalidate-on-change",
      },
    ]);
  });

  test("reads a claim's fields, with glue as the default kind", () => {
    const l = parseLedger(SAMPLE, "confidence/signup.yaml");
    const [fix, order, boundary, , unit] = l.claims;
    expect(fix).toMatchObject({
      kind: "glue",
      text: "直したら、その欄のエラーを消す",
      source: 'defect "#412"',
      assumes: ["signup/rules#required", "signup/rules#format"],
      tests: [
        {
          file: "src/features/signup/useSignupForm.test.ts",
          name: "メールを直すと、メール欄のエラーだけが消える",
        },
      ],
    });
    expect(fix?.joins).toEqual([
      {
        in: "src/features/signup/useSignupForm.ts#onChange",
        file: "src/features/signup/useSignupForm.ts",
        symbol: "onChange",
        code: "validateField(field)",
        breaks: [],
        generate: true,
      },
    ]);
    expect(order?.joins[0]?.order).toEqual(["setValue", "validateField"]);
    expect(order?.joins[0]?.code).toBeUndefined();
    expect(boundary?.kind).toBe("boundary");
    expect(boundary?.fakes).toEqual(["apps/web/test/fakes/signup-server.ts"]);
    expect(unit).toMatchObject({
      kind: "unit",
      tests: [{ file: "src/features/signup/rules.test.ts" }],
    });
    expect(unit?.tests[0]?.name).toBeUndefined();
  });

  test("reads a join's breaks and generate: false", () => {
    const l = parseLedger(
      `area: a
claims:
  n#c:
    text: t
    source: impl
    joins:
      - in: src/x.ts#f
        code: g()
        breaks: ["", "h()"]
        generate: false
    tests: [tests/x.test.ts > f > calls g]
`,
      "confidence/a.yaml",
    );
    expect(l.problems).toEqual([]);
    expect(l.claims[0]?.joins[0]).toMatchObject({ breaks: ["", "h()"], generate: false });
    expect(l.claims[0]?.tests[0]).toEqual({
      file: "tests/x.test.ts",
      name: "f > calls g",
      raw: "tests/x.test.ts > f > calls g",
    });
  });

  test("a ledger that is not well formed is a problem, not a crash", () => {
    const bad = (text: string) => parseLedger(text, "confidence/bad.yaml").problems;
    expect(bad("claims: [")[0]).toMatchObject({ code: "E100", level: "error" });
    expect(bad("claims: {}\n")[0]).toMatchObject({
      code: "E100",
      message: expect.stringContaining("area"),
    });
    expect(bad("area: a\nclaims:\n  nohash:\n    text: t\n")[0]).toMatchObject({
      code: "E100",
      claim: "a/nohash",
    });
    expect(
      bad("area: a\nclaims:\n  n#c:\n    joins:\n      - in: src/x.ts\n        code: g()\n")[0],
    ).toMatchObject({ code: "E100", message: expect.stringContaining("#") });
    expect(bad("area: a\nclaims:\n  n#c:\n    kind: part\n")[0]).toMatchObject({ code: "E100" });
  });

  test("a field the ledger does not know is a warning", () => {
    const p = parseLedger(
      "area: a\nclaims:\n  n#c:\n    source: impl\n    colour: red\n",
      "f.yaml",
    );
    expect(p.problems).toMatchObject([{ code: "W203", level: "warning", claim: "a/n#c" }]);
  });
});
