import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const REPO_ROOT = dirname(import.meta.dirname);

export function isScriptMain(name) {
  const entry = process.argv[1];
  if (!entry) return false;
  const file = join(import.meta.dirname, name);
  try {
    return realpathSync(entry) === realpathSync(file);
  } catch {
    return resolve(entry) === file;
  }
}
