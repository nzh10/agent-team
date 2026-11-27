import { PassThrough, Writable, type WritableOptions } from "node:stream";
import type { PanelReadyReport } from "../../../src/session/panel-http";
import type { PiRpcSessionState, PiRpcSpawnOptions } from "../../../src/session/pi-rpc";
import { piReply } from "../../snap/pi-wire";

export function piPanelConnection({ env }: PiRpcSpawnOptions) {
  return {
    headers: {
      authorization: `Bearer ${env?.YAAT_PANEL_TOKEN ?? ""}`,
      "content-type": "application/json",
    },
    endpoint: `${env?.YAAT_PANEL_URL ?? ""}/v1/sessions/${env?.YAAT_PANEL_KEY ?? ""}`,
  };
}

export function piReadyReport(
  proof: Omit<PanelReadyReport["sessionProof"], "anchorOnActiveBranch" | "anchorExistsInFile">,
): PanelReadyReport {
  return {
    sessionProof: { ...proof, anchorOnActiveBranch: true, anchorExistsInFile: true },
    ownerToolNames: ["write_note"],
    requiredExtensionsRegistered: true,
    subagentsRpcReady: true,
    subagentsSessionId: proof.sessionId,
  };
}

export function piIdleState(
  sessionId: PiRpcSessionState["sessionId"],
  sessionFile: PiRpcSessionState["sessionFile"],
  model = { provider: "mock", id: "test" },
) {
  return {
    sessionId,
    sessionFile,
    thinkingLevel: "low",
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    model,
  };
}

export function piRpcResponse(frame: { type: string; id: string }, data?: unknown, error?: string) {
  return {
    ...piReply(frame.type),
    command: frame.type,
    id: frame.id,
    success: error === undefined,
    data,
    ...(error !== undefined && { error }),
  };
}

export function createPiWireTransport(stdinOptions: WritableOptions) {
  const stdout = new PassThrough();
  const stdin = new Writable(stdinOptions);
  // Multiple frames supplied together arrive in a single stdout write.
  const emit = (...frames: object[]) =>
    stdout.write(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
  return { stdin, stdout, emit };
}
