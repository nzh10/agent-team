import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { onTestFinished } from "vitest";
import { HistoryService } from "../../../src/workspace/history-service";
import {
  closeHistory,
  historyFile,
  historyIndexFile,
  historyOf,
} from "../../../src/workspace/state";
import type { Message } from "../../../src/workspace/workspace";

export const historyMessage = (
  id: string,
  content: string,
  timestamp = 1,
  over: Partial<Message> = {},
): Message => ({
  id,
  kind: "agent",
  agentId: "a",
  content,
  timestamp,
  status: "done",
  ...over,
});

export function setupHistory() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-history-"));
  const history = new HistoryService(historyIndexFile(base), historyFile(base));
  onTestFinished(async () => {
    await history.close();
    closeHistory(base);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const save = (session: string, messages: Message[]) => {
    historyOf(base).save(session, messages, "all");
    history.changed();
  };
  return { base, history, save };
}
