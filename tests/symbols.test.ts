import { describe, expect, test } from "bun:test";
import { findSymbol, locateCode, parseSource } from "../src/symbols.ts";

const COMMANDS = `import { result } from "./result.ts";

export const COMMANDS = {
  shot: result({
    flags: ["sheet"],
    run: async ({ flags }) => {
      return shotCommand({
        sheet: flags.sheet,
      });
    },
  }),
  mv: result({
    run: async ({ flags }) => {
      return mvCommand({
        after: flags.after,
        sheet: flags.sheet,
      });
    },
  }),
};

export class Rail {
  toggle(open: boolean) {
    if (!this.available() || open) {
      return;
    }
  }
}

function liveReloadScript(): string {
  return \`(() => {
  const live = window["dekLive"];
  if (typeof live === "function") {
    live();
  }
})();\`;
}
`;

const at = (text: string, path: string) => {
  const r = findSymbol(parseSource("src/commands.ts", text), path);
  if (!r.ok) throw new Error(`${path}: ${r.reason}`);
  return r.symbol;
};

describe("findSymbol", () => {
  test("finds a path that runs through a call's argument", () => {
    const s = at(COMMANDS, "COMMANDS.shot.run");
    expect(COMMANDS.slice(s.start, s.end)).toStartWith("run: async ({ flags }) => {");
    expect(COMMANDS.slice(s.start, s.end)).toContain("shotCommand");
    expect(s.path).toBe("COMMANDS.shot.run");
  });

  test("a path may leave out its outer names when the rest is unique", () => {
    expect(at(COMMANDS, "shot.run").path).toBe("COMMANDS.shot.run");
    expect(at(COMMANDS, "Rail.toggle").path).toBe("Rail.toggle");
    expect(at(COMMANDS, "liveReloadScript").path).toBe("liveReloadScript");
  });

  test("a name that matches more than one symbol is ambiguous, with every full path", () => {
    const r = findSymbol(parseSource("src/commands.ts", COMMANDS), "run");
    expect(r).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: ["COMMANDS.shot.run", "COMMANDS.mv.run"],
    });
  });

  test("a name that matches nothing is missing, with the names that are there", () => {
    const r = findSymbol(parseSource("src/commands.ts", COMMANDS), "COMMANDS.video.run");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("missing");
    expect(r.candidates).toContain("COMMANDS.shot.run");
    expect(r.candidates).toContain("Rail.toggle");
  });

  test("a file that does not parse names its first error", () => {
    const parsed = parseSource("src/bad.ts", "export const x = ;\n");
    expect(parsed.error).toBeString();
    expect(findSymbol(parsed, "x")).toMatchObject({ ok: false, reason: "unparsable" });
  });
});

describe("locateCode", () => {
  const locate = (text: string, path: string, code: string) =>
    locateCode(text, at(text, path), code);

  test("code that is in the file twice but in the symbol once is found", () => {
    const r = locate(COMMANDS, "shot.run", "sheet: flags.sheet,");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(COMMANDS.slice(r.start, r.end)).toBe("sheet: flags.sheet,");
    expect(r.start).toBe(COMMANDS.indexOf("sheet: flags.sheet,"));
  });

  test("code that is in the symbol twice is not unique", () => {
    const text = "function f(a) {\n  g(a);\n  g(a);\n}\n";
    expect(locate(text, "f", "g(a);")).toEqual({ ok: false, reason: "repeated", count: 2 });
  });

  test("code that is not in the symbol is missing, even if it is elsewhere in the file", () => {
    expect(locate(COMMANDS, "mv.run", "return shotCommand")).toEqual({
      ok: false,
      reason: "missing",
      count: 0,
    });
  });

  test("code may be a fragment that is not a whole node", () => {
    const r = locate(COMMANDS, "Rail.toggle", "if (!this.available() || open) {");
    expect(r.ok).toBe(true);
  });

  test("code inside a template string is found in the function that holds the string", () => {
    const r = locate(COMMANDS, "liveReloadScript", 'if (typeof live === "function") {');
    expect(r.ok).toBe(true);
  });

  test("offsets are JavaScript string indexes, also after Japanese text and emoji", () => {
    const text = `// 日本語のコメント🎉、ここは組み立て点の前\nexport function onChange(field: string) {\n  validateField(field);\n}\n`;
    const r = locate(text, "onChange", "validateField(field)");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.start).toBe(text.indexOf("validateField(field)"));
    expect(text.slice(r.start, r.end)).toBe("validateField(field)");
  });
});
