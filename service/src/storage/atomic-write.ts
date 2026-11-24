import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function writeAtomicText(file: string, text: string, beforeRename?: () => void): void {
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    beforeRename?.();
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

export function writeAtomicJson(file: string, value: unknown, beforeRename?: () => void): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomicText(file, `${JSON.stringify(value, null, 2)}\n`, beforeRename);
}
