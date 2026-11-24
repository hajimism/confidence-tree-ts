import { describe, expect, test } from "bun:test";
import { applyEdit, generateBreaks, ledgerBreak, validity } from "../src/breaks.ts";
import { findSymbol, locateCode, parseSource } from "../src/symbols.ts";

function region(text: string, symbol: string, code: string) {
  const s = findSymbol(parseSource("src/x.ts", text), symbol);
  if (!s.ok) throw new Error(s.reason);
  const loc = locateCode(text, s.symbol, code);
  if (!loc.ok) throw new Error(loc.reason);
  return loc;
}

/** Every generated break of `code`, as the code it leaves in place of the join's code. */
function broken(text: string, symbol: string, code: string) {
  const loc = region(text, symbol, code);
  return generateBreaks("src/x.ts", text, loc).map((b) => {
    const out = applyEdit(text, b.edit);
    return { kind: b.kind, code: out.slice(loc.start, out.length - (text.length - loc.end)) };
  });
}

describe("generateBreaks", () => {
  test("a call made for its effect is deleted", () => {
    const text = "function f(rooms) {\n  rooms.reclamp();\n  done();\n}\n";
    expect(broken(text, "f", "rooms.reclamp();")).toEqual([{ kind: "delete-call", code: "" }]);
  });

  test("an awaited call made for its effect is deleted", () => {
    const text = "async function f(live, e) {\n  await live(e);\n}\n";
    expect(broken(text, "f", "await live(e);")).toEqual([{ kind: "delete-call", code: "" }]);
  });

  test("a condition loses each term, and is made false and true", () => {
    const text =
      "function f(rail, p) {\n  if (!rail.available() || p.isOpen()) {\n    return;\n  }\n}\n";
    expect(broken(text, "f", "if (!rail.available() || p.isOpen()) {")).toEqual([
      { kind: "drop-term", code: "if (p.isOpen()) {" },
      { kind: "drop-term", code: "if (!rail.available()) {" },
      { kind: "false", code: "if (false) {" },
      { kind: "true", code: "if (true) {" },
    ]);
  });

  test("an assignment statement is deleted", () => {
    const text = "function f(plugin, deck) {\n  plugin.hungOn = deck.name;\n}\n";
    expect(broken(text, "f", "plugin.hungOn = deck.name;")).toEqual([
      { kind: "delete-assignment", code: "" },
    ]);
  });

  test("a value passed in an object loses its property, comma and all", () => {
    const text =
      "function f(flags) {\n  return run({\n    sheet: flags.sheet,\n    at: 1,\n  });\n}\n";
    expect(broken(text, "f", "sheet: flags.sheet,")).toEqual([
      { kind: "delete-property", code: "" },
    ]);
  });

  test("a return gives back nothing", () => {
    const text = 'function isKey(event) {\n  return isLetterKey(event, "s");\n}\n';
    expect(broken(text, "isKey", 'return isLetterKey(event, "s");')).toEqual([
      { kind: "return-early", code: "return;" },
    ]);
  });

  test("a declaration and a plain expression give no break", () => {
    const text = "function f(u) {\n  const es = new EventSource(u);\n  return es;\n}\n";
    expect(broken(text, "f", "const es = new EventSource(u);")).toEqual([]);
  });

  test("code inside a template string is broken as the script the string holds", () => {
    const text = `export function script(): string {
  return \`(() => {
  const go = \${JSON.stringify("x")};
  const live = window["dekLive"];
  if (typeof live === "function") {
    live(go);
  }
})();\`;
}
`;
    expect(broken(text, "script", 'if (typeof live === "function") {')).toEqual([
      { kind: "false", code: "if (false) {" },
      { kind: "true", code: "if (true) {" },
    ]);
    expect(broken(text, "script", "    live(go);\n")).toEqual([
      { kind: "delete-call", code: "    \n" },
    ]);
  });
});

describe("validity", () => {
  test("a ledger break that does not parse is invalid", () => {
    const text = 'function f(e) {\n  return isLetterKey(e, "s");\n}\n';
    const loc = region(text, "f", 'return isLetterKey(e, "s");');
    const b = ledgerBreak(loc, "return isLetterKey(e,;");
    expect(validity("src/x.ts", text, b.edit)).toBeString();
    expect(validity("src/x.ts", text, ledgerBreak(loc, "").edit)).toBeUndefined();
  });

  test("a break that leaves the TS file valid but the script in its template string broken is invalid", () => {
    const text =
      "export function script(): string {\n  return `(() => {\n  if (ok) {\n    go();\n  }\n})();`;\n}\n";
    const loc = region(text, "script", "if (ok) {");
    expect(validity("src/x.ts", text, ledgerBreak(loc, "if (ok {").edit)).toBeString();
    expect(validity("src/x.ts", text, ledgerBreak(loc, "if (!ok) {").edit)).toBeUndefined();
  });
});
