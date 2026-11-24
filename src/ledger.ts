// The ledger: confidence/*.yaml, each file one area of claims, and the claims it has retired.
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const SOURCE_KINDS = ["spec", "ticket", "defect", "commit", "type", "impl", "decision"];
export const KINDS = ["glue", "boundary", "contract", "unit"] as const;
export type Kind = (typeof KINDS)[number];

export type TestRef = { file: string; name?: string; raw: string };

export type Join = {
  /** As written: `<file>#<symbol>`. */
  in: string;
  file: string;
  symbol: string;
  code?: string;
  order?: string[];
  /** Hand-written breaks: each replaces `code`. */
  breaks: string[];
  /** false: only `breaks` are applied, no generated ones. */
  generate: boolean;
};

export type Claim = {
  id: string;
  ledger: string;
  kind: Kind;
  text?: string;
  source?: string;
  joins: Join[];
  tests: TestRef[];
  assumes: string[];
  fakes: string[];
};

export type Retired = { id: string; ledger: string; reason?: string; replacedBy?: string };

export type Problem = {
  code: string;
  level: "error" | "warning";
  ledger: string;
  claim?: string;
  message: string;
  /** What the problem is about, by field, shown under the message. */
  fields?: Record<string, string>;
  fix: string;
};

export type Ledger = { claims: Claim[]; retired: Retired[]; problems: Problem[] };

const CLAIM_FIELDS = new Set([
  "text",
  "source",
  "kind",
  "joins",
  "assumes",
  "fakes",
  "tests",
  "contract",
  "against",
]);
const JOIN_FIELDS = new Set(["in", "code", "order", "breaks", "generate"]);
const RETIRED_FIELDS = new Set(["reason", "replaced-by"]);
const KEY = /^[\w.-]+#[\w.-]+$/;

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function parseTest(raw: string): TestRef {
  const [file, ...name] = raw.split(" > ");
  const ref: TestRef = { file: (file as string).trim(), raw };
  if (name.length) ref.name = name.join(" > ").trim();
  return ref;
}

/** A claim named inside an area may leave the area out. */
const qualify = (area: string, id: string) => (id.includes("/") ? id : `${area}/${id}`);

export function parseLedger(text: string, ledger: string): Ledger {
  const out: Ledger = { claims: [], retired: [], problems: [] };
  const problem = (p: Omit<Problem, "ledger">) => out.problems.push({ ledger, ...p });
  const malformed = (message: string, fix: string, claim?: string) =>
    problem({ code: "E100", level: "error", message, fix, ...(claim ? { claim } : {}) });

  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (e) {
    malformed(`YAML として読めない: ${(e as Error).message}`, "YAML の構文を直す");
    return out;
  }
  if (!isMap(doc) || typeof doc.area !== "string" || doc.area === "") {
    malformed("area がない", "ファイルの先頭に area: <名前> を書く");
    return out;
  }
  const area = doc.area;
  if (doc.claims !== undefined && !isMap(doc.claims)) {
    malformed("claims が対応表でない", "claims の下に <ノード>#<名前>: を並べる");
    return out;
  }

  for (const [key, body] of Object.entries(doc.claims ?? {})) {
    const id = `${area}/${key}`;
    if (!KEY.test(key)) {
      malformed(
        `主張の名前 ${key} が <ノード>#<名前> の形でない`,
        "validation#clear-on-fix の形にする",
        id,
      );
      continue;
    }
    const r = isMap(body) ? body : {};
    for (const f of Object.keys(r))
      if (!CLAIM_FIELDS.has(f))
        problem({
          code: "W203",
          level: "warning",
          claim: id,
          message: `知らないフィールド ${f}`,
          fix: `綴りを確かめる。使えるのは ${[...CLAIM_FIELDS].join("、")}`,
        });
    const kind = r.kind ?? "glue";
    if (!KINDS.includes(kind as Kind)) {
      malformed(`kind ${String(kind)} は使えない`, `kind は ${KINDS.join("、")} のどれか`, id);
      continue;
    }
    const joins: Join[] = [];
    let bad = false;
    for (const [i, j] of list(r.joins).entries()) {
      const where = `joins[${i}]`;
      if (!isMap(j) || typeof j.in !== "string") {
        malformed(`${where} に in がない`, "in: <ファイル>#<シンボル> を書く", id);
        bad = true;
        continue;
      }
      const hash = j.in.indexOf("#");
      if (hash <= 0 || hash === j.in.length - 1) {
        malformed(
          `${where} の in ${j.in} に #<シンボル> がない`,
          "組み立て点を含む関数の名前を in: <ファイル>#<シンボル> の形で書く",
          id,
        );
        bad = true;
        continue;
      }
      for (const f of Object.keys(j))
        if (!JOIN_FIELDS.has(f))
          problem({
            code: "W203",
            level: "warning",
            claim: id,
            message: `${where} の知らないフィールド ${f}`,
            fix: `綴りを確かめる。使えるのは ${[...JOIN_FIELDS].join("、")}`,
          });
      const code = typeof j.code === "string" ? j.code : undefined;
      const order = Array.isArray(j.order) ? j.order.map(String) : undefined;
      if (code === undefined && order === undefined) {
        malformed(
          `${where} に code も order もない`,
          "code: <シンボルの中で一意なコード片> を書く",
          id,
        );
        bad = true;
        continue;
      }
      const breaks = list(j.breaks);
      if (breaks.some((b) => typeof b !== "string") || (breaks.length && code === undefined)) {
        malformed(
          `${where} の breaks が code を置き換える文字列の列でない`,
          'breaks: ["", "…"] の形にする',
          id,
        );
        bad = true;
        continue;
      }
      if (j.generate !== undefined && typeof j.generate !== "boolean") {
        malformed(`${where} の generate が true か false でない`, "generate: false と書く", id);
        bad = true;
        continue;
      }
      const join: Join = {
        in: j.in,
        file: j.in.slice(0, hash),
        symbol: j.in.slice(hash + 1),
        breaks: breaks as string[],
        generate: j.generate !== false,
      };
      if (code !== undefined) join.code = code;
      if (order !== undefined) join.order = order;
      joins.push(join);
    }
    const tests = list(r.tests);
    if (tests.some((t) => typeof t !== "string" || t.trim() === "")) {
      malformed("tests が文字列の列でない", "tests: [<ファイル> > <テスト名>] の形にする", id);
      bad = true;
    }
    if (bad) continue;
    const claim: Claim = {
      id,
      ledger,
      kind: kind as Kind,
      joins,
      tests: (tests as string[]).map(parseTest),
      assumes: list(r.assumes).map((a) => qualify(area, String(a))),
      fakes: list(r.fakes).map(String),
    };
    if (typeof r.text === "string") claim.text = r.text;
    if (typeof r.source === "string" && r.source.trim() !== "") claim.source = r.source.trim();
    out.claims.push(claim);
  }

  if (doc.retired !== undefined && !isMap(doc.retired)) {
    malformed("retired が対応表でない", "retired の下に <ノード>#<名前>: と reason: を並べる");
    return out;
  }
  for (const [key, body] of Object.entries(doc.retired ?? {})) {
    const id = `${area}/${key}`;
    const r = isMap(body) ? body : {};
    for (const f of Object.keys(r))
      if (!RETIRED_FIELDS.has(f))
        problem({
          code: "W203",
          level: "warning",
          claim: id,
          message: `retired の知らないフィールド ${f}`,
          fix: "使えるのは reason、replaced-by",
        });
    const ret: Retired = { id, ledger };
    if (typeof r.reason === "string" && r.reason.trim() !== "") ret.reason = r.reason.trim();
    if (typeof r["replaced-by"] === "string") ret.replacedBy = qualify(area, r["replaced-by"]);
    out.retired.push(ret);
  }
  return out;
}

export const LEDGER_DIR = "confidence";

/** The ledger files under `root`, relative to it, in a stable order. */
export function ledgerFiles(root: string): string[] {
  try {
    return readdirSync(join(root, LEDGER_DIR))
      .filter((n) => n.endsWith(".yaml"))
      .sort()
      .map((n) => `${LEDGER_DIR}/${n}`);
  } catch {
    return [];
  }
}

/** Every ledger file together. A claim defined twice is a problem. */
export function mergeLedgers(parts: Ledger[]): Ledger {
  const all: Ledger = {
    claims: parts.flatMap((p) => p.claims),
    retired: parts.flatMap((p) => p.retired),
    problems: parts.flatMap((p) => p.problems),
  };
  const seen = new Map<string, string>();
  for (const c of all.claims) {
    const first = seen.get(c.id);
    if (first !== undefined)
      all.problems.push({
        code: "E100",
        level: "error",
        ledger: c.ledger,
        claim: c.id,
        message: `主張 ${c.id} が 2 回書かれている（${first} にもある）`,
        fix: "どちらかの名前を変えるか、1 つにまとめる",
      });
    else seen.set(c.id, c.ledger);
  }
  return all;
}

export async function loadLedger(root: string): Promise<Ledger> {
  const parts: Ledger[] = [];
  for (const f of ledgerFiles(root))
    parts.push(parseLedger(await Bun.file(join(root, f)).text(), f));
  return mergeLedgers(parts);
}
