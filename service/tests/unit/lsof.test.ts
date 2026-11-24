import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lsofBinary } from "../lsof";

describe.skipIf(process.platform === "win32")("lsofBinary", () => {
  const dirs: string[] = [];
  const origPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = origPath;
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("ignores directories named lsof in PATH and falls back to system locations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaat-lsof-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "lsof"), { mode: 0o755 });
    process.env.PATH = dir;

    const resolved = lsofBinary();
    expect(resolved).not.toBe(path.join(dir, "lsof"));
    expect(fs.statSync(resolved).isFile()).toBe(true);
  });
});
