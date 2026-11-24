import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placeProbes, probeExpression, readHits, startHttpSink } from "../src/probe.ts";
import { scriptAt } from "../src/script.ts";
import { syntaxError } from "../src/symbols.ts";

const target = (file = "/tmp/ct-hits") => ({ file, url: "http://127.0.0.1:9/p" });

function probed(text: string, codes: string[], file = "src/x.ts") {
  const probes = codes.map((code, i) => {
    const start = text.indexOf(code);
    return { id: i + 1, loc: { start, end: start + code.length } };
  });
  const r = placeProbes(file, text, probes, target());
  if (!r.ok) throw new Error(r.error);
  return r.text;
}

describe("probeExpression", () => {
  test("is one expression with no backtick, ${ or backslash", () => {
    const p = probeExpression(7, target());
    expect(p).not.toMatch(/[`\\]|\$\{/);
    expect(syntaxError("p.js", `(${p});`)).toBeUndefined();
  });

  test("writes its number to the file sink, once per process", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ct-probe-")), "hits");
    const p = probeExpression(7, { file, url: "http://127.0.0.1:9/p" });
    new Function(`${p}; ${p};`)();
    expect(readFileSync(file, "utf8")).toBe("7 ");
    expect(readHits(file)).toEqual(new Set([7]));
  });

  test("where there is no process, as in a browser, it reaches the http sink", async () => {
    const sink = startHttpSink();
    try {
      const p = probeExpression(9, { file: "/nonexistent/hits", url: sink.url });
      const page = { fetch: globalThis.fetch.bind(globalThis) };
      new Function("globalThis", `${p};`)(page);
      for (let i = 0; i < 50 && !sink.hits.has(9); i++) await Bun.sleep(10);
      expect(sink.hits).toEqual(new Set([9]));
    } finally {
      sink.stop();
    }
  });

  test("refuses a sink path it could not write without a backslash", () => {
    expect(() => probeExpression(1, target("C:\\tmp\\hits"))).toThrow();
  });
});

describe("placeProbes", () => {
  test("wraps the outermost expression of the join's code", () => {
    const text = "function f(rooms) {\n  rooms.reclamp();\n}\n";
    const out = probed(text, ["rooms.reclamp();"]);
    expect(out).toContain(`(${probeExpression(1, target())}, rooms.reclamp());`);
  });

  test("in an if's head, wraps the condition; in a property, wraps the value", () => {
    const text =
      "function f(a, b, flags) {\n  if (!a || b) {\n    return go({\n      sheet: flags.sheet,\n    });\n  }\n}\n";
    const out = probed(text, ["if (!a || b) {", "sheet: flags.sheet,"]);
    expect(out).toContain(`if ((${probeExpression(1, target())}, !a || b)) {`);
    expect(out).toContain(`sheet: (${probeExpression(2, target())}, flags.sheet),`);
    expect(syntaxError("src/x.ts", out)).toBeUndefined();
  });

  test("a shorthand property is spelled out so its value can be wrapped", () => {
    const text = "function f(project, deck) {\n  return check({ project, deck });\n}\n";
    const out = probed(text, ["{ project", "deck }"]);
    expect(out).toContain(`{ project: (${probeExpression(1, target())}, project), deck: (`);
    expect(syntaxError("src/x.ts", out)).toBeUndefined();
  });

  test("never wraps a method's or a getter's function, which would not parse", () => {
    const text =
      "export const o = {\n  run() {\n    return 1;\n  },\n  get x() {\n    return 2;\n  },\n};\nexport class C {\n  m() {\n    return 3;\n  }\n}\n";
    const out = probed(text, ["run() {\n    return 1;\n  }", "m() {\n    return 3;\n  }"]);
    expect(syntaxError("src/x.ts", out)).toBeUndefined();
    expect(out).toContain(`return (${probeExpression(1, target())}, 1);`);
  });

  test("never wraps a JSX child, which would render the probe as text", () => {
    const text = "export function A() {\n  return <div>{x}<B /></div>;\n}\n";
    const start = text.indexOf("<B />");
    const r = placeProbes("src/x.tsx", text, [{ id: 1, loc: { start, end: start + 5 } }], target());
    expect(r.ok && r.text.includes(", <B />)")).toBe(false);
  });

  test("never wraps a callee, which would lose its this", () => {
    const text = "function f(o) {\n  o.m(1);\n}\n";
    const out = probed(text, ["o.m"]);
    expect(out).not.toContain(", o.m)");
    expect(syntaxError("src/x.ts", out)).toBeUndefined();
  });

  test("puts a statement probe before a statement with no expression to wrap", () => {
    const text = "function f(xs) {\n  for (const x of xs) {\n    continue;\n  }\n}\n";
    const out = probed(text, ["continue;"]);
    expect(out).toContain(`${probeExpression(1, target())};continue;`);
  });

  test("nested joins wrap inside one another", () => {
    const text = "function f(a, b) {\n  return g(a, h(b));\n}\n";
    const out = probed(text, ["g(a, h(b))", "h(b)"]);
    expect(out).toContain(
      `return (${probeExpression(1, target())}, g(a, (${probeExpression(2, target())}, h(b))));`,
    );
  });

  test("inside a template string, the probe goes into the script and the script still parses", () => {
    const text =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the file under test holds a template string.
      'export function s(): string {\n  return `(() => {\n  const x = ${JSON.stringify(1)};\n  if (typeof live === "function") {\n    live(x);\n  }\n})();`;\n}\n';
    const out = probed(text, ['if (typeof live === "function") {']);
    expect(syntaxError("src/x.ts", out)).toBeUndefined();
    const start = out.indexOf("if ((");
    const inner = scriptAt("src/x.ts", out, { start, end: start + 1 });
    expect(inner.template).toBeDefined();
  });

  test("code with nothing to put a probe on is an error", () => {
    const text = "function f(a) {\n  if (a) {\n  } else {\n  }\n}\n";
    const start = text.indexOf("} else {");
    const r = placeProbes("src/x.ts", text, [{ id: 1, loc: { start, end: start + 8 } }], target());
    expect(r.ok).toBe(false);
  });
});
