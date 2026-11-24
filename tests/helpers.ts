// Throwaway projects for the tests: a directory of files, optionally a git repository.

import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");
const made: string[] = [];

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

export function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** A new directory holding `files`. With `commit`, a git repository with them committed. */
export function project(files: Record<string, string>, opts: { commit?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ct-test-"));
  made.push(root);
  write(root, files);
  if (opts.commit) {
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "add", "-A");
    git(
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "base",
    );
  }
  return root;
}

export function ct(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
