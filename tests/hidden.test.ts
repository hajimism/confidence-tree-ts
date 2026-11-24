import { describe, expect, test } from "bun:test";
import { applyEdit, generateBreaks } from "../src/breaks.ts";
import { hiddenCandidates, pickHidden } from "../src/hidden.ts";
import { findSymbol, locateCode, parseSource } from "../src/symbols.ts";

function region(text: string, symbol: string, code: string) {
  const s = findSymbol(parseSource("src/x.ts", text), symbol);
  if (!s.ok) throw new Error(s.reason);
  const loc = locateCode(text, s.symbol, code);
  if (!loc.ok) throw new Error(loc.reason);
  return loc;
}

/** What each candidate leaves in place of the join's code. */
function shown(text: string, symbol: string, code: string) {
  const loc = region(text, symbol, code);
  return hiddenCandidates("src/x.ts", text, loc).map((b) => {
    const out = applyEdit(text, b.edit);
    return out.slice(loc.start, out.length - (text.length - loc.end));
  });
}

describe("hiddenCandidates", () => {
  test("a call loses each argument, or has it made undefined", () => {
    const text = "function f(v, field) {\n  validate(field, v);\n}\n";
    expect(shown(text, "f", "validate(field, v);")).toEqual([
      "validate(v);",
      "validate(undefined, v);",
      "validate(field);",
      "validate(field, undefined);",
    ]);
  });

  test("a condition is negated, its chain's operator swapped, and a comparison flipped", () => {
    const text = "function f(a, b, n) {\n  if (a && n === 1) {\n    b();\n  }\n}\n";
    expect(shown(text, "f", "if (a && n === 1) {")).toEqual([
      "if (!(a && n === 1)) {",
      "if (a || n === 1) {",
      "if (a && n !== 1) {",
    ]);
  });

  test("a property's value and an assignment's value are made undefined", () => {
    const text =
      "function f(flags, p, d) {\n  run({ sheet: flags.sheet, d });\n  p.hungOn = d.name;\n}\n";
    expect(shown(text, "f", "sheet: flags.sheet, d }")).toEqual([
      "sheet: undefined, d }",
      "sheet: flags.sheet, d: undefined }",
    ]);
    expect(shown(text, "f", "p.hungOn = d.name;")).toEqual(["p.hungOn = undefined;"]);
  });

  test("never one that ct prove already shows", () => {
    const text = "function f(a, b) {\n  if (a || b) {\n    return 1;\n  }\n}\n";
    const loc = region(text, "f", "if (a || b) {");
    const visible = new Set(
      generateBreaks("src/x.ts", text, loc).map((b) => applyEdit(text, b.edit)),
    );
    for (const h of hiddenCandidates("src/x.ts", text, loc))
      expect(visible.has(applyEdit(text, h.edit))).toBe(false);
  });
});

describe("pickHidden", () => {
  const text = "function f(v, field, x) {\n  validate(field, v, x);\n}\n";
  const loc = region(text, "f", "validate(field, v, x);");
  const join = { in: "src/x.ts#f", code: "validate(field, v, x);" };
  const all = hiddenCandidates("src/x.ts", text, loc);
  const pick = (seed: string) =>
    pickHidden(all, { seed, join, loc }).map((b) => applyEdit(text, b.edit));

  test("takes at most two", () => {
    expect(all.length).toBe(6);
    expect(pick("s1")).toHaveLength(2);
  });

  test("the same seed and the same code give the same breaks", () => {
    expect(pick("s1")).toEqual(pick("s1"));
  });

  test("another seed gives, over a few seeds, other breaks", () => {
    const sets = new Set(["s1", "s2", "s3", "s4", "s5"].map((s) => pick(s).join("|")));
    expect(sets.size).toBeGreaterThan(1);
  });

  test("the code around the join does not change which breaks are picked", () => {
    const moved = `// a comment above\n${text}`;
    const loc2 = region(moved, "f", "validate(field, v, x);");
    const again = pickHidden(hiddenCandidates("src/x.ts", moved, loc2), {
      seed: "s1",
      join,
      loc: loc2,
    });
    expect(again.map((b) => b.edit.text)).toEqual(
      pickHidden(all, { seed: "s1", join, loc }).map((b) => b.edit.text),
    );
  });
});
