// Hidden breaks: ones ct guard applies and ct prove never shows, so tests cannot be written to the
// shown breaks alone (README, 隠した壊し方).
//
// They are other kinds of break, inside the join's own code only:
//
//   call         drop an argument, or make it undefined     drop-arg, undefined-arg
//   condition    negate it                                  negate
//   && || chain  swap the operator                          swap-op
//   comparison   flip it (=== to !==, < to <=, …)           flip-compare
//   property     make its value undefined                   undefined-value
//   assignment   make the assigned value undefined          undefined-value
//
// Which ones apply is decided by a hash of CT_SEED, the join, and the break: the same while the
// join's code does not change, and not predictable without CT_SEED.
import { type Break, generateBreaks } from "./breaks.ts";
import { applyEdit, isNode, type Node, type Span, scriptAt, validity, walk } from "./script.ts";

export const HIDDEN_PER_JOIN = 2;

const FLIP: Record<string, string> = {
  "===": "!==",
  "!==": "===",
  "==": "!=",
  "!=": "==",
  "<": "<=",
  "<=": "<",
  ">": ">=",
  ">=": ">",
};
const SWAP: Record<string, string> = { "&&": "||", "||": "&&" };
const CONDITIONAL = new Set([
  "IfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "ForStatement",
  "ConditionalExpression",
]);

/** Every hidden break that could apply to the code at `loc`, valid and not one prove shows. */
export function hiddenCandidates(file: string, text: string, loc: Span): Break[] {
  const s = scriptAt(file, text, loc);
  if (s.error !== undefined) return [];
  const lo = loc.start - s.offset;
  const hi = loc.end - s.offset;
  const inside = (n: Span) => lo <= n.start && n.end <= hi;
  const src = (n: Span) => s.text.slice(n.start, n.end);
  const out: Break[] = [];
  const add = (
    kind: Break["kind"],
    at: Span,
    replacement: string,
    doing: string,
    site: Span = at,
  ) =>
    out.push({
      kind,
      edit: { start: at.start + s.offset, end: at.end + s.offset, text: replacement },
      site: { start: site.start + s.offset, end: site.end + s.offset },
      doing,
    });

  walk(s.program, (n, parent) => {
    if (CONDITIONAL.has(n.type) && isNode(n.test) && inside(n.test))
      add("negate", n.test, `!(${src(n.test)})`, "条件を反転して");
    if (!inside(n)) return;
    if ((n.type === "CallExpression" || n.type === "NewExpression") && Array.isArray(n.arguments)) {
      const args = n.arguments as Node[];
      for (const [i, a] of args.entries()) {
        const next = args[i + 1];
        const prev = args[i - 1];
        const cut = next
          ? { start: a.start, end: next.start }
          : prev
            ? { start: prev.end, end: a.end }
            : a;
        add("drop-arg", cut, "", `引数「${src(a)}」を渡さなくて`, n);
        if (a.type !== "SpreadElement")
          add("undefined-arg", a, "undefined", `引数「${src(a)}」を undefined にして`, n);
      }
    }
    if (n.type === "LogicalExpression" && SWAP[n.operator as string] !== undefined) {
      const op = n.operator as string;
      const top = !(parent?.type === "LogicalExpression" && parent.operator === op);
      if (top) {
        const terms: Node[] = [];
        const flat = (x: Node) => {
          if (x.type === "LogicalExpression" && x.operator === op) {
            flat(x.left as Node);
            flat(x.right as Node);
          } else terms.push(x);
        };
        flat(n);
        add("swap-op", n, terms.map(src).join(` ${SWAP[op]} `), `「${op}」を「${SWAP[op]}」にして`);
      }
    }
    if (n.type === "BinaryExpression" && FLIP[n.operator as string] !== undefined) {
      const l = n.left as Node;
      const r = n.right as Node;
      const between = s.text
        .slice(l.end, r.start)
        .replace(n.operator as string, FLIP[n.operator as string] as string);
      add(
        "flip-compare",
        n,
        `${src(l)}${between}${src(r)}`,
        `「${n.operator}」を「${FLIP[n.operator as string]}」にして`,
      );
    }
    if (
      n.type === "Property" &&
      parent?.type === "ObjectExpression" &&
      n.kind === "init" &&
      !n.method
    ) {
      const v = n.value as Node;
      if (n.shorthand)
        add("undefined-value", n, `${src(v)}: undefined`, `「${src(v)}」を undefined にして`);
      else
        add(
          "undefined-value",
          v,
          "undefined",
          `「${src(n.key as Node)}」の値を undefined にして`,
          n,
        );
    }
    if (n.type === "AssignmentExpression" && isNode(n.right))
      add("undefined-value", n.right, "undefined", "代入する値を undefined にして", n);
  });

  const visible = new Set(generateBreaks(file, text, loc).map((b) => applyEdit(text, b.edit)));
  const seen = new Set<string>();
  return out.filter((b) => {
    const result = applyEdit(text, b.edit);
    if (result === text || visible.has(result) || seen.has(result)) return false;
    seen.add(result);
    return validity(file, text, b.edit) === undefined;
  });
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/**
 * The hidden breaks that apply: the HIDDEN_PER_JOIN candidates with the smallest hash of the seed,
 * the join, and the break, the break written relative to the join's code so that code moving
 * around it does not change the pick.
 */
export function pickHidden(
  candidates: Break[],
  opts: { seed: string; join: { in: string; code: string }; loc: Span },
): Break[] {
  const key = (b: Break) =>
    sha256(
      [
        opts.seed,
        opts.join.in,
        opts.join.code,
        b.kind,
        b.edit.start - opts.loc.start,
        b.edit.end - opts.loc.start,
        b.edit.text,
      ].join("\0"),
    );
  return candidates
    .map((b) => ({ b, k: key(b) }))
    .sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0))
    .slice(0, HIDDEN_PER_JOIN)
    .map((x) => x.b);
}
