// The breaks ct generates for a join's code (README, 壊し方). Each is an edit to the file.
//
//   call made for its effect   delete it              delete-call
//   assignment statement       delete it              delete-assignment
//   value passed in an object  delete the property    delete-property
//   return of a value          return nothing         return-early
//   && || ?? chain             drop one term          drop-term
//   condition                  make it false / true   false, true
//
// Only nodes that lie inside the join's code are broken, and a condition when its test does.
import { type Edit, isNode, type Node, type Span, scriptAt, walk } from "./script.ts";

export { applyEdit, validity } from "./script.ts";

export type BreakKind =
  | "delete-call"
  | "delete-assignment"
  | "delete-property"
  | "return-early"
  | "drop-term"
  | "false"
  | "true"
  | "ledger";

export type Break = { kind: BreakKind; edit: Edit };

const ORDER: BreakKind[] = [
  "delete-call",
  "delete-assignment",
  "delete-property",
  "return-early",
  "drop-term",
  "false",
  "true",
];

const unwrap = (n: Node): Node =>
  n.type === "AwaitExpression" ||
  n.type === "ChainExpression" ||
  n.type === "ParenthesizedExpression"
    ? unwrap((n.argument ?? n.expression) as Node)
    : n;

const LOGICAL = new Set(["&&", "||", "??"]);
const CONDITIONAL = new Set([
  "IfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "ForStatement",
  "ConditionalExpression",
]);

/** The breaks ct generates for the code at `loc` in `text`. */
export function generateBreaks(file: string, text: string, loc: Span): Break[] {
  const s = scriptAt(file, text, loc);
  if (s.error !== undefined) return [];
  const lo = loc.start - s.offset;
  const hi = loc.end - s.offset;
  const inside = (n: Span) => lo <= n.start && n.end <= hi;
  const out: { kind: BreakKind; start: number; end: number; text: string }[] = [];
  const add = (kind: BreakKind, n: Span, replacement: string) =>
    out.push({ kind, start: n.start, end: n.end, text: replacement });

  walk(s.program, (n, parent) => {
    if (inside(n)) {
      if (n.type === "ExpressionStatement" && isNode(n.expression)) {
        const e = unwrap(n.expression);
        if (e.type === "CallExpression" || e.type === "NewExpression") add("delete-call", n, "");
        if (e.type === "AssignmentExpression") add("delete-assignment", n, "");
      }
      if (
        (n.type === "Property" || n.type === "SpreadElement") &&
        parent?.type === "ObjectExpression"
      ) {
        const comma = /^\s*,/.exec(s.text.slice(n.end));
        add("delete-property", { start: n.start, end: n.end + (comma?.[0].length ?? 0) }, "");
      }
      if (n.type === "ReturnStatement" && n.argument != null) add("return-early", n, "return;");
      if (
        n.type === "LogicalExpression" &&
        LOGICAL.has(n.operator as string) &&
        !(parent?.type === "LogicalExpression" && parent.operator === n.operator)
      ) {
        const terms: Node[] = [];
        const flat = (x: Node) => {
          if (x.type === "LogicalExpression" && x.operator === n.operator) {
            flat(x.left as Node);
            flat(x.right as Node);
          } else terms.push(x);
        };
        flat(n);
        for (const t of terms)
          add(
            "drop-term",
            n,
            terms
              .filter((x) => x !== t)
              .map((x) => s.text.slice(x.start, x.end))
              .join(` ${n.operator} `),
          );
      }
    }
    if (CONDITIONAL.has(n.type) && isNode(n.test) && inside(n.test)) {
      add("false", n.test, "false");
      add("true", n.test, "true");
    }
  });

  const seen = new Set<string>();
  return out
    .map((b, i) => ({ b, i }))
    .sort((x, y) => ORDER.indexOf(x.b.kind) - ORDER.indexOf(y.b.kind) || x.i - y.i)
    .map(({ b }) => ({
      kind: b.kind,
      edit: { start: b.start + s.offset, end: b.end + s.offset, text: b.text },
    }))
    .filter(({ edit }) => {
      const key = `${edit.start}:${edit.end}:${edit.text}`;
      if (seen.has(key) || text.slice(edit.start, edit.end) === edit.text) return false;
      seen.add(key);
      return true;
    });
}

/** A hand-written break: it replaces the join's code. */
export const ledgerBreak = (loc: Span, replacement: string): Break => ({
  kind: "ledger",
  edit: { start: loc.start, end: loc.end, text: replacement },
});
