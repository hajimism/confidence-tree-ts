import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../package.json";

const CLI = join(import.meta.dir, "../src/cli.ts");

function ct(...args: string[]) {
  const r = Bun.spawnSync(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("ct", () => {
  test("--version prints the package's version", () => {
    const r = ct("--version");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(pkg.version);
  });

  test("--help prints the usage and exits 0", () => {
    const r = ct("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("使い方: ct");
  });

  test("with no command, prints the usage on stderr and exits 2", () => {
    const r = ct();
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("使い方: ct");
  });

  test("an unknown command is named, with the usage, and exits 2", () => {
    const r = ct("nope");
    expect(r.code).toBe(2);
    expect(r.err).toContain("ct: nope というコマンドはありません");
    expect(r.err).toContain("使い方: ct");
  });
});
