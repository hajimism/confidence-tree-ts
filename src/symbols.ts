// Symbols in a TypeScript or JavaScript file, by the names that enclose them, and code inside one.
//
// A symbol's path is the names from the outside in: functions, classes, variables, methods, and the
// keys of object literals, so `COMMANDS.shot.run` is the `run` property of the object passed to the
// call held by the `shot` key of `const COMMANDS`. A path may leave out outer names; it must then
// match one symbol only.
import { parseSync } from "oxc-parser";

export type SymbolSpan = { path: string; start: number; end: number };

export type Parsed = {
  file: string;
  /** The first syntax error, if the file does not parse. */
  error?: string;
  symbols: SymbolSpan[];
};

export type Found =
  | { ok: true; symbol: SymbolSpan }
  | { ok: false; reason: "missing" | "ambiguous" | "unparsable"; candidates: string[] };

export type Located =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: "missing" | "repeated"; count: number };

type Node = { type: string; start: number; end: number; [key: string]: unknown };

const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof (v as Node).type === "string";

function keyName(key: unknown, computed: unknown): string | undefined {
  if (computed || !isNode(key)) return undefined;
  if (key.type === "Identifier" || key.type === "PrivateIdentifier") return key.name as string;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

/** The name a node gives the code inside it, if it gives one. */
function nameOf(n: Node): string | undefined {
  switch (n.type) {
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "TSEnumDeclaration":
      return isNode(n.id) ? (n.id.name as string) : undefined;
    case "VariableDeclarator":
      return isNode(n.id) && n.id.type === "Identifier" ? (n.id.name as string) : undefined;
    case "MethodDefinition":
    case "PropertyDefinition":
    case "Property":
      return keyName(n.key, n.computed);
    default:
      return undefined;
  }
}

export function loaderFor(file: string): "ts" | "tsx" | "js" | "jsx" {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".jsx")) return "jsx";
  if (/\.[mc]?js$/.test(file)) return "js";
  return "ts";
}

/** The first syntax error in `text`, read as the file `file` would be. */
export function syntaxError(file: string, text: string): string | undefined {
  const r = parseSync(file, text, { lang: loaderFor(file) });
  const e = r.errors.find((x) => x.severity === "Error");
  return e?.message;
}

export function parseSource(file: string, text: string): Parsed {
  const r = parseSync(file, text, { lang: loaderFor(file) });
  const err = r.errors.find((x) => x.severity === "Error");
  if (err) return { file, error: err.message, symbols: [] };
  const symbols: SymbolSpan[] = [];
  const walk = (v: unknown, outer: string[]) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, outer);
      return;
    }
    if (!isNode(v)) return;
    const name = nameOf(v);
    const chain = name === undefined ? outer : [...outer, name];
    if (name !== undefined) symbols.push({ path: chain.join("."), start: v.start, end: v.end });
    for (const [k, child] of Object.entries(v)) {
      if (k === "type" || k === "start" || k === "end") continue;
      if (typeof child === "object" && child !== null) walk(child, chain);
    }
  };
  walk(r.program, []);
  return { file, symbols };
}

export function findSymbol(parsed: Parsed, path: string): Found {
  if (parsed.error !== undefined) return { ok: false, reason: "unparsable", candidates: [] };
  const want = path.split(".");
  const hits = parsed.symbols.filter((s) => {
    const have = s.path.split(".");
    return (
      want.length <= have.length && want.every((w, i) => have[have.length - want.length + i] === w)
    );
  });
  if (hits.length === 1) return { ok: true, symbol: hits[0] as SymbolSpan };
  if (hits.length > 1)
    return { ok: false, reason: "ambiguous", candidates: hits.map((s) => s.path) };
  return {
    ok: false,
    reason: "missing",
    candidates: [...new Set(parsed.symbols.map((s) => s.path))],
  };
}

/** `code` inside the symbol: it must be there exactly once. Offsets are into the whole file. */
export function locateCode(text: string, symbol: SymbolSpan, code: string): Located {
  const body = text.slice(symbol.start, symbol.end);
  const first = body.indexOf(code);
  if (first < 0 || code === "") return { ok: false, reason: "missing", count: 0 };
  let count = 0;
  for (let i = first; i >= 0; i = body.indexOf(code, i + 1)) count++;
  if (count > 1) return { ok: false, reason: "repeated", count };
  return { ok: true, start: symbol.start + first, end: symbol.start + first + code.length };
}
