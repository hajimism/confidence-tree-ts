// The copy of the project that ct breaks: its files as they are now, committed or not, in a
// temporary directory, with node_modules linked rather than copied. The project itself, and its
// .git, are never written to.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type Copy = {
  root: string;
  /** HEAD's commit, if the project is in a git repository. */
  commit?: string;
  /** Whether the files differ from that commit. */
  dirty: boolean;
  remove: () => void;
};

const SKIP = new Set(["node_modules", ".git", ".ct"]);

function git(cwd: string, args: string[]): string | undefined {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString() : undefined;
}

function walk(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

/** Directories whose node_modules a test may resolve from: the root and its workspaces. */
function moduleDirs(root: string): string[] {
  const dirs = [""];
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const ws: unknown = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    if (Array.isArray(ws))
      for (const w of ws)
        if (typeof w === "string")
          for (const d of new Bun.Glob(w).scanSync({ cwd: root, onlyFiles: false })) dirs.push(d);
  } catch {}
  return dirs;
}

const live = new Set<() => void>();
let hooked = false;
function removeOnExit(remove: () => void): void {
  live.add(remove);
  if (hooked) return;
  hooked = true;
  const all = () => {
    for (const f of live) f();
  };
  process.on("exit", all);
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      all();
      process.exit(130);
    });
}

export function makeCopy(root: string, opts: { keep?: boolean } = {}): Copy {
  const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  // A tracked file deleted in the working tree is listed too; it is skipped below.
  const files = listed === undefined ? walk(root) : listed.split("\0").filter(Boolean);
  const commit = git(root, ["rev-parse", "HEAD"])?.trim();
  const status = git(root, ["status", "--porcelain"]);
  const dir = mkdtempSync(join(tmpdir(), "ct-copy-"));
  const copy = join(dir, "project");
  for (const f of files) {
    const from = join(root, f);
    const to = join(copy, f);
    const st = lstatSync(from, { throwIfNoEntry: false });
    if (st === undefined || st.isDirectory()) continue;
    mkdirSync(dirname(to), { recursive: true });
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else cpSync(from, to);
  }
  for (const d of moduleDirs(root)) {
    const from = join(root, d, "node_modules");
    const to = join(copy, d, "node_modules");
    if (existsSync(from) && !existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true });
      symlinkSync(from, to, "dir");
    }
  }
  let removed = false;
  const remove = () => {
    if (removed || opts.keep) return;
    removed = true;
    live.delete(remove);
    rmSync(dir, { recursive: true, force: true });
  };
  removeOnExit(remove);
  return {
    root: copy,
    ...(commit ? { commit } : {}),
    dirty: commit === undefined || (status ?? "").trim() !== "",
    remove,
  };
}
