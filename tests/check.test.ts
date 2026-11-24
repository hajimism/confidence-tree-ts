import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { ct, git, project, write } from "./helpers.ts";

// Tests here run ct and git several times; on a loaded machine that takes more than 5 s.
setDefaultTimeout(60_000);

const SRC = {
  "src/form.ts": `// 入力欄のフォーム
export function onChange(field: string, v: string) {
  setValue(field, v);
  validateField(field);
}
export function onBlur(field: string) {
  validateField(field);
}
function setValue(_f: string, _v: string) {}
function validateField(_f: string) {}
`,
  "tests/form.test.ts": "",
};

const GOOD = `area: signup
claims:
  validation#clear-on-fix:
    text: 直したら、その欄のエラーを消す
    source: defect "#412"
    joins:
      - in: src/form.ts#onChange
        code: validateField(field)
    tests:
      - tests/form.test.ts > メールを直すと、メール欄のエラーだけが消える
  rules#required:
    kind: unit
    text: 必須の欄が空なら、その欄を不正にする
    source: spec docs/signup.md#検証
    tests: [tests/form.test.ts]
`;

const ledger = (yaml: string) => ({ ...SRC, "confidence/signup.yaml": yaml });

describe("ct check", () => {
  test("a ledger with no problem exits 0 and says how many claims it read", () => {
    const r = ct(project(ledger(GOOD)), "check");
    expect(r.err).toBe("");
    expect(r.out).toContain("主張 2 件");
    expect(r.code).toBe(0);
  });

  test("1: a claim without a source fails, with how to fix it", () => {
    const r = ct(project(ledger(GOOD.replace('    source: defect "#412"\n', ""))), "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ E101 signup/validation#clear-on-fix: 出どころがない");
    expect(r.out).toContain("直し方:");
  });

  test("1: a source of a kind the ledger does not know fails", () => {
    const r = ct(project(ledger(GOOD.replace('defect "#412"', "hunch"))), "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "✗ E101 signup/validation#clear-on-fix: 出どころの種類 hunch は使えない",
    );
  });

  test("2: a glue or boundary claim without a join fails; a unit claim does not", () => {
    const noJoin = GOOD.replace(/ {4}joins:\n(?: {6}.*\n)+/, "");
    const r = ct(project(ledger(noJoin)), "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ E102 signup/validation#clear-on-fix: 組み立て点がない");
    expect(r.out).not.toContain("E102 signup/rules#required");
  });

  test("3: code the symbol no longer holds fails in the README's form", () => {
    const r = ct(project(ledger(GOOD.replace("validateField(field)", "validate(field)"))), "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      [
        "✗ E103 signup/validation#clear-on-fix: 組み立て点が見つからない",
        "  in:   src/form.ts#onChange",
        "  code: validate(field)",
        "  直し方: onChange の中の該当箇所を探して code を直す。組み立て方が変わったなら、主張の文も見直す",
      ].join("\n"),
    );
  });

  test("3: code in the file twice but in the symbol once is found", () => {
    // validateField(field) is in onChange and in onBlur.
    expect(ct(project(ledger(GOOD)), "check").code).toBe(0);
  });

  test("3: code twice in the symbol fails and says to lengthen it", () => {
    const twice = {
      ...SRC,
      "src/form.ts": SRC["src/form.ts"].replace(
        "  setValue(field, v);\n",
        "  validateField(field);\n",
      ),
    };
    const r = ct(project({ ...twice, "confidence/signup.yaml": GOOD }), "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ E103 signup/validation#clear-on-fix: 組み立て点が一意でない");
    expect(r.out).toContain("2 か所");
  });

  test("3: a missing file, a missing symbol, and an ambiguous symbol each fail", () => {
    const missingFile = ct(project(ledger(GOOD.replace("src/form.ts#", "src/gone.ts#"))), "check");
    expect(missingFile.out).toContain("✗ E103 signup/validation#clear-on-fix: ファイルがない");
    const missingSymbol = ct(project(ledger(GOOD.replace("#onChange", "#onInput"))), "check");
    expect(missingSymbol.out).toContain("✗ E103 signup/validation#clear-on-fix: シンボルがない");
    expect(missingSymbol.out).toContain("onChange");
    const dup = {
      ...SRC,
      "src/form.ts": `${SRC["src/form.ts"]}export const handlers = { onChange: () => validateField("x") };\n`,
    };
    const ambiguous = ct(project({ ...dup, "confidence/signup.yaml": GOOD }), "check");
    expect(ambiguous.out).toContain("✗ E103 signup/validation#clear-on-fix: シンボルが一意でない");
    expect(ambiguous.out).toContain("handlers.onChange");
  });

  test("an order-only join is not counted as found: it is a warning that it was not checked", () => {
    const order = GOOD.replace("code: validateField(field)", "order: [setValue, validateField]");
    const r = ct(project(ledger(order)), "check");
    expect(r.code).toBe(0);
    expect(r.out).toContain("! W202 signup/validation#clear-on-fix: order は、まだ確かめられない");
  });

  test("a test given as a whole file is a warning outside unit claims", () => {
    const whole = GOOD.replace(" > メールを直すと、メール欄のエラーだけが消える", "");
    const r = ct(project(ledger(whole)), "check");
    expect(r.code).toBe(0);
    expect(r.out).toContain("! W201 signup/validation#clear-on-fix: テストがファイル全体の指定");
    expect(r.out).not.toContain("W201 signup/rules#required");
  });

  test("6: a claim gone since HEAD without a retired entry fails", () => {
    const root = project(ledger(GOOD), { commit: true });
    write(root, {
      "confidence/signup.yaml": GOOD.replace(/ {2}rules#required:\n(?: {4}.*\n)+/, ""),
    });
    const r = ct(root, "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ E106 signup/rules#required: 主張が消えたのに、retired にない");
    expect(r.out).toContain("HEAD");
  });

  test("6: a claim gone with a reason in retired passes", () => {
    const root = project(ledger(GOOD), { commit: true });
    const without = GOOD.replace(/ {2}rules#required:\n(?: {4}.*\n)+/, "");
    write(root, {
      "confidence/signup.yaml": `${without}retired:\n  rules#required:\n    reason: 必須の検証はサーバーに移った\n`,
    });
    expect(ct(root, "check").code).toBe(0);
  });

  test("6: a retired entry needs a reason, and replaced-by must name a claim", () => {
    const r = ct(
      project(ledger(`${GOOD}retired:\n  rules#old:\n    replaced-by: rules#nope\n`)),
      "check",
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ E106 signup/rules#old: retired に理由がない");
    expect(r.out).toContain("✗ E106 signup/rules#old: replaced-by の signup/rules#nope がない");
  });

  test("6: --base compares with another commit", () => {
    const root = project(ledger(GOOD), { commit: true });
    const base = git(root, "rev-parse", "HEAD").trim();
    write(root, {
      "confidence/signup.yaml": GOOD.replace(/ {2}rules#required:\n(?: {4}.*\n)+/, ""),
    });
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
      "drop",
    );
    expect(ct(root, "check").code).toBe(0);
    const r = ct(root, "check", "--base", base);
    expect(r.code).toBe(1);
    expect(r.out).toContain("E106 signup/rules#required");
  });

  test("6: outside a git repository, removal is not checked and says so", () => {
    const r = ct(project(ledger(GOOD)), "check");
    expect(r.code).toBe(0);
    expect(r.out).toContain("! W206");
  });

  test("--json gives the problems as data", () => {
    const r = ct(
      project(ledger(GOOD.replace("validateField(field)", "validate(field)"))),
      "check",
      "--json",
    );
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ version: 1, ok: false, claims: 2 });
    expect(j.problems).toContainEqual({
      code: "E103",
      level: "error",
      ledger: "confidence/signup.yaml",
      claim: "signup/validation#clear-on-fix",
      message: "組み立て点が見つからない",
      fields: { in: "src/form.ts#onChange", code: "validate(field)" },
      fix: "onChange の中の該当箇所を探して code を直す。組み立て方が変わったなら、主張の文も見直す",
    });
  });

  test("with no ledger, says where it looked and exits 1", () => {
    const r = ct(project({ "src/x.ts": "" }), "check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("confidence/");
  });
});
