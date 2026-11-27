import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import type { AgentState } from "../../../src/workspace/workspace";

export function serverDirectories(prefix: string, register: (base: string) => void) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  register(base);
  const root = path.join(base, "repo");
  const web = path.join(base, "web");
  const home = path.join(base, "home");
  for (const dir of [root, web, home]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(web, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(base, "config.toml"), "");
  process.env.HOME = home;
  return { base, root, web };
}

export function savedAgent(id: string, name: string, cwd: string): AgentState {
  const model = "gpt-6-astra";
  return {
    id,
    name,
    model,
    avatar: "A",
    color: "#fff",
    isDefault: true,
    session: {
      sessionId: null,
      config: { cwd, backend: "codex", model },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turns: 0,
        duration_ms: 0,
      },
    },
  };
}

export async function watchClient(
  ws: WebSocket,
  until: (ready: () => boolean, what: string) => Promise<void>,
) {
  const frames: Array<Record<string, unknown>> = [];
  ws.on("message", (raw: Buffer) =>
    frames.push(JSON.parse(raw.toString()) as Record<string, unknown>),
  );
  await once(ws, "open");
  await until(() => frames.some((frame) => frame.type === "init"), "init");
  return { frames, send: (message: Record<string, unknown>) => ws.send(JSON.stringify(message)) };
}
