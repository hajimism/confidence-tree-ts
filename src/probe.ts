// Probes: what ct puts at a join, without breaking it, to learn whether a test runs it.
//
// A probe is one self-contained expression with no backtick, no `${` and no backslash, so it can go
// into browser code that a TypeScript file keeps as a template string. It writes its number to two
// sinks: a file (heard from Bun and Node processes, including ones a test spawns) and a local HTTP
// server (heard from a browser, where there is no file to write). A fetch from a Bun process that is
// about to exit may never be sent, which is why the file is written too.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Edit, isNode, type Node, type Span, scriptAt } from "./script.ts";

export type SinkTarget = { file: string; url: string };

const FORBIDDEN = /[`\\]|\$\{/;

export function probeExpression(id: number, target: SinkTarget): string {
  const file = JSON.stringify(target.file);
  const url = JSON.stringify(`${target.url}/${id}`);
  const flag = `globalThis.__ct_probe_${id}`;
  // process.getBuiltinModule keeps node:fs out of a bundler's sight, and is absent in a browser.
  const p =
    `(${flag} || (${flag} = 1, (() => { ` +
    `try { globalThis.process?.getBuiltinModule?.("node:fs")?.appendFileSync(${file}, "${id} "); } catch {} ` +
    `try { globalThis.fetch?.(${url}, { mode: "no-cors", keepalive: true })?.catch?.(() => {}); } catch {} ` +
    "})()))";
  if (FORBIDDEN.test(p))
    throw new Error(`プローブに置けない文字が入る（${target.file}、${target.url}）`);
  return p;
}

export function readHits(file: string): Set<number> {
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, "utf8").split(/\s+/).filter(Boolean).map(Number));
}

export function clearHits(file: string): void {
  writeFileSync(file, "");
}

export function startHttpSink(host = "127.0.0.1"): {
  url: string;
  hits: Set<number>;
  stop: () => void;
} {
  const hits = new Set<number>();
  const server = Bun.serve({
    hostname: host,
    port: 0,
    fetch(req) {
      const id = Number(new URL(req.url).pathname.split("/").pop());
      if (Number.isInteger(id)) hits.add(id);
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
    },
  });
  return { url: `http://${host}:${server.port}/p`, hits, stop: () => server.stop(true) };
}

const EXPRESSIONS = new Set([
  "CallExpression",
  "NewExpression",
  "MemberExpression",
  "Identifier",
  "Literal",
  "TemplateLiteral",
  "ArrayExpression",
  "ObjectExpression",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassExpression",
  "BinaryExpression",
  "LogicalExpression",
  "UnaryExpression",
  "UpdateExpression",
  "AssignmentExpression",
  "ConditionalExpression",
  "AwaitExpression",
  "YieldExpression",
  "SequenceExpression",
  "ParenthesizedExpression",
  "ChainExpression",
  "TaggedTemplateExpression",
  "ThisExpression",
  "ImportExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "JSXElement",
  "JSXFragment",
]);

/** Slots where `(probe, x)` in place of `x` would not parse or would change what the code does. */
function unsafeSlot(parent: Node | undefined, key: string, n: Node): boolean {
  if (parent === undefined) return true;
  const t = parent.type;
  if (t.endsWith("Pattern") || t === "VariableDeclarator" || t === "TemplateLiteral")
    return key !== "init";
  if ((t === "CallExpression" || t === "TaggedTemplateExpression") && key !== "arguments")
    return true;
  if (t === "AssignmentExpression" && key === "left") return true;
  if (t === "UpdateExpression" || (t === "UnaryExpression" && parent.operator === "delete"))
    return true;
  if (t === "MemberExpression" && key === "property") return true;
  if (t === "ChainExpression") return true;
  if ((t === "Property" || t.endsWith("Definition")) && key === "key") return true;
  // A method's or an accessor's value is the function itself, written without `function`.
  if (t === "Property" && key === "value" && (parent.method === true || parent.kind !== "init"))
    return true;
  if (t.endsWith("MethodDefinition") && key === "value") return true;
  if (t.startsWith("JSX") && key === "children") return true;
  if (t.startsWith("Function") || t === "ArrowFunctionExpression")
    return key === "params" || key === "id";
  if (t.startsWith("Class")) return key === "id" || key === "superClass";
  if (t.startsWith("Import") || t.startsWith("Export") || t.startsWith("TS"))
    return !t.endsWith("Expression");
  if (t === "LabeledStatement" || t === "BreakStatement" || t === "ContinueStatement") return true;
  if (t === "ExpressionStatement" && typeof parent.directive === "string") return true;
  // `x` alone in a slot that names something (a JSX attribute's name, a meta property).
  return n.type === "Identifier" && (t.startsWith("JSX") || t === "MetaProperty");
}

const isStatementList = (parent: Node | undefined, n: Node) =>
  parent !== undefined &&
  ((Array.isArray(parent.body) && (parent.body as unknown[]).includes(n)) ||
    (Array.isArray(parent.consequent) && (parent.consequent as unknown[]).includes(n)));

type Placement = { open: Edit; close?: Edit; span: Span };

/** Where the probe for the code at `loc` goes: around an expression, or before a statement. */
function placement(file: string, text: string, loc: Span, probe: string): Placement | string {
  const s = scriptAt(file, text, loc);
  if (s.error !== undefined) return `構文が通らない: ${s.error}`;
  const lo = loc.start - s.offset;
  const hi = loc.end - s.offset;
  let expr: Node | undefined;
  /** Set when `expr` is a shorthand property's value: it must be spelled out to be wrapped. */
  let shorthand: string | undefined;
  let stmt: Node | undefined;
  const go = (v: unknown, parent: Node | undefined, key: string) => {
    if (Array.isArray(v)) {
      for (const x of v) go(x, parent, key);
      return;
    }
    if (!isNode(v) || v.end <= lo || v.start >= hi) return;
    const inside = lo <= v.start && v.end <= hi;
    if (inside && expr === undefined && EXPRESSIONS.has(v.type) && !unsafeSlot(parent, key, v)) {
      expr = v;
      if (parent?.type === "Property" && parent.shorthand === true)
        shorthand = s.text.slice(v.start, v.end);
      return;
    }
    if (inside && stmt === undefined && v.type.endsWith("Statement") && isStatementList(parent, v))
      stmt = v;
    for (const [k, child] of Object.entries(v))
      if (
        k !== "type" &&
        k !== "start" &&
        k !== "end" &&
        typeof child === "object" &&
        child !== null
      )
        go(child, v, k);
  };
  go(s.program, undefined, "");
  const at = (p: number) => p + s.offset;
  if (expr !== undefined)
    return {
      open: {
        start: at(expr.start),
        end: at(expr.start),
        text: `${shorthand === undefined ? "" : `${shorthand}: `}(${probe}, `,
      },
      close: { start: at(expr.end), end: at(expr.end), text: ")" },
      span: { start: at(expr.start), end: at(expr.end) },
    };
  if (stmt !== undefined)
    return {
      open: { start: at(stmt.start), end: at(stmt.start), text: `${probe};` },
      span: { start: at(stmt.start), end: at(stmt.end) },
    };
  return "組み立て点のコードに、プローブを置ける式も文もない";
}

export type Probe = { id: number; loc: Span };

/** `text` with every probe in place, checked to still parse. */
export function placeProbes(
  file: string,
  text: string,
  probes: Probe[],
  target: SinkTarget,
): { ok: true; text: string } | { ok: false; id: number; error: string } {
  type Insert = { pos: number; text: string; closing: boolean; span: Span; id: number };
  const inserts: Insert[] = [];
  for (const p of probes) {
    const pl = placement(file, text, p.loc, probeExpression(p.id, target));
    if (typeof pl === "string") return { ok: false, id: p.id, error: pl };
    inserts.push({
      pos: pl.open.start,
      text: pl.open.text,
      closing: false,
      span: pl.span,
      id: p.id,
    });
    if (pl.close)
      inserts.push({
        pos: pl.close.start,
        text: pl.close.text,
        closing: true,
        span: pl.span,
        id: p.id,
      });
  }
  // Left to right; at one position, closings before openings, the inner closing first and the
  // outer opening first, so nested probes nest.
  inserts.sort(
    (a, b) =>
      a.pos - b.pos ||
      Number(b.closing) - Number(a.closing) ||
      (a.closing ? b.span.start - a.span.start : b.span.end - a.span.end) ||
      a.id - b.id,
  );
  let out = "";
  let from = 0;
  const openedAt = new Map<number, number>();
  for (const i of inserts) {
    out += text.slice(from, i.pos);
    if (!i.closing) openedAt.set(i.id, out.length);
    out += i.text;
    from = i.pos;
  }
  out += text.slice(from);
  const bad = brokenProbe(file, text, out, probes, openedAt);
  if (bad === undefined) return { ok: true, text: out };
  // Together they do not parse. Name a probe that does not parse on its own, so a caller that
  // drops it drops the one at fault; if each parses alone, the last one.
  if (probes.length > 1)
    for (const p of probes) {
      const alone = placeProbes(file, text, [p], target);
      if (!alone.ok) return alone;
    }
  return bad;
}

function brokenProbe(
  file: string,
  text: string,
  out: string,
  probes: Probe[],
  openedAt: Map<number, number>,
): { ok: false; id: number; error: string } | undefined {
  for (const p of probes) {
    // The probe's own text must sit in a script that still parses: the file, and the template
    // string's script when the join is in one.
    const was = scriptAt(file, text, p.loc);
    const at = (openedAt.get(p.id) ?? 0) + 1;
    const now = scriptAt(file, out, { start: at, end: at });
    if (now.error !== undefined)
      return { ok: false, id: p.id, error: `プローブを入れると構文が通らない: ${now.error}` };
    if (was.template !== undefined && now.template === undefined)
      return {
        ok: false,
        id: p.id,
        error: "プローブを入れると、テンプレート文字列の中のコードの構文が通らない",
      };
  }
  return undefined;
}
