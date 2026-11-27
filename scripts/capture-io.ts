import { readFileSync, writeFileSync, type WriteFileOptions } from "node:fs";

export function parseJsonLine<T = unknown>(line: string): T {
  try {
    return JSON.parse(line) as T;
  } catch {
    // SyntaxError can quote private frame data.
    throw new Error("Invalid JSON in capture input");
  }
}

export const jsonLine = (value: unknown): string => JSON.stringify(value) + "\n";

export function parseJsonl<T = unknown>(text: string): T[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map(parseJsonLine<T>);
}

export function readJsonl<T = unknown>(file: string): T[] {
  return parseJsonl<T>(readFileSync(file, "utf8"));
}

export function writeJsonl(
  file: string,
  entries: readonly unknown[],
  options?: WriteFileOptions,
): void {
  writeFileSync(file, entries.map(jsonLine).join(""), options);
}
