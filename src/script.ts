// The code a join's code is part of: the file itself, or the script that a template string in it holds
// (browser code kept as a string, like dek's live-reload.ts). Breaks and probes are worked out in that
// script's own syntax tree, so a join inside a template string is broken as code, not as text.
import { parseSync } from "oxc-parser";
import { loaderFor } from "./symbols.ts";

export type Node = { type: string; start: number; end: number; [key: string]: unknown };
export type Span = { start: number; end: number };
export type Edit = { start: number; end: number; text: string };

export type Script = {
  /** Where `text` starts in the file. */
  offset: number;
  text: string;
  program: Node;
  /** The template string's span in the file, when the script is one. */
  template?: Span;
};

export const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof (v as Node).type === "string";

/** Every node under `root`, parents before children, with its parent. */
export function walk(root: Node, visit: (n: Node, parent: Node | undefined) => void): void {
  const go = (v: unknown, parent: Node | undefined) => {
    if (Array.isArray(v)) {
      for (const x of v) go(x, parent);
      return;
    }
    if (!isNode(v)) return;
    visit(v, parent);
    for (const [k, child] of Object.entries(v)) {
      if (k === "type" || k === "start" || k === "end") continue;
      if (typeof child === "object" && child !== null) go(child, v);
    }
  };
  go(root, undefined);
}

function parse(file: string, text: string): { program: Node; error?: string } {
  const r = parseSync(file, text, { lang: loaderFor(file) });
  const e = r.errors.find((x) => x.severity === "Error");
  return { program: r.program as unknown as Node, ...(e ? { error: e.message } : {}) };
}

/** The template string's contents with each `${…}` blanked to underscores, so offsets hold. */
function templateScript(text: string, t: Node): string {
  const start = t.start + 1;
  let js = text.slice(start, t.end - 1);
  for (const e of (t.expressions as Node[]) ?? []) {
    const a = text.lastIndexOf("${", e.start) - start;
    const b = text.indexOf("}", e.end) + 1 - start;
    js = js.slice(0, a) + "_".repeat(b - a) + js.slice(b);
  }
  return js;
}

/**
 * The script `span` is in. If the innermost template string around it holds code that parses as
 * JavaScript, that code; otherwise the file. `error` is set when the file itself does not parse.
 */
export function scriptAt(file: string, text: string, span: Span): Script & { error?: string } {
  const top = parse(file, text);
  if (top.error !== undefined) return { offset: 0, text, program: top.program, error: top.error };
  let tpl: Node | undefined;
  walk(top.program, (n) => {
    if (n.type === "TemplateLiteral" && n.start < span.start && span.end < n.end) tpl = n;
  });
  if (tpl !== undefined) {
    const js = templateScript(text, tpl);
    const inner = parse("script.js", js);
    if (inner.error === undefined)
      return {
        offset: tpl.start + 1,
        text: js,
        program: inner.program,
        template: { start: tpl.start, end: tpl.end },
      };
  }
  return { offset: 0, text, program: top.program };
}

export const applyEdit = (text: string, e: Edit) =>
  text.slice(0, e.start) + e.text + text.slice(e.end);

/**
 * Why the file would not parse after `edit`, or undefined if it would. When the edit is inside a
 * template string that holds a script, that script must still parse too: TypeScript reads any text
 * inside a template string as valid.
 */
export function validity(file: string, text: string, edit: Edit): string | undefined {
  const before = scriptAt(file, text, { start: edit.start, end: edit.end });
  const out = applyEdit(text, edit);
  const after = scriptAt(file, out, { start: edit.start, end: edit.start + edit.text.length });
  if (after.error !== undefined) return after.error;
  if (before.template !== undefined && after.template === undefined)
    return "テンプレート文字列の中のコードが、構文として通らない";
  return undefined;
}
