import { join } from "node:path";
import { appendFileSync, writeFileSync } from "node:fs";

const jsonl = (records: unknown[]) =>
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
export const writeJsonl = (file: string, records: unknown[]) => writeFileSync(file, jsonl(records));
export const appendJsonl = (file: string, records: unknown[]) =>
  appendFileSync(file, jsonl(records));

export const textBlocks = (text: string) => [{ type: "text", text }];
export const assistantText = (text: string) => ({ role: "assistant", content: textBlocks(text) });

export const transcriptMessage = (role: string, message: object) => ({
  recordType: "message",
  role,
  message,
});

export const writeStatusJson = (dir: string, status: object) =>
  writeFileSync(join(dir, "status.json"), JSON.stringify(status));

export const sessionMessage = (id: string, parentId: string | null, message: object) => ({
  type: "message",
  id,
  parentId,
  message,
});
