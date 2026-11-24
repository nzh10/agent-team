import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { extractPiToolResultText, formatPiToolUse } from "./pi-tool-format";
import type { ActiveAsyncChildRecord, ActiveAsyncRunRecord, StreamEvent } from "./types";

export const SUBAGENT_MODES = ["single", "parallel", "chain", "workflow"] as const;

export type TrackableSubagentMode = (typeof SUBAGENT_MODES)[number];

export function isTrackableSubagentMode(mode: unknown): mode is TrackableSubagentMode {
  return typeof mode === "string" && (SUBAGENT_MODES as readonly string[]).includes(mode);
}

export function makeSyntheticSubagentTaskId(toolCallId: string, childIndex: number): string {
  return `${toolCallId}:${childIndex}`;
}

export interface SubagentStepIdentity {
  childId?: unknown;
  workflowKey?: unknown;
  runId?: unknown;
}

export function resolveCanonicalChildId(step: SubagentStepIdentity, childIndex: number): string {
  return [step.childId, step.workflowKey, step.runId, "step:" + childIndex].find(
    (value) => typeof value === "string" && value.length > 0,
  )! as string;
}

export interface SubagentNotifyChild extends SubagentStepIdentity {
  transcriptPath?: string;
  sessionFile?: string;
  outputTruncated?: boolean;
  transcriptError?: string;
  summary?: string;
  usage?: Record<string, unknown>;
  canonicalChildId: string;
  stepIndex: number;
  status?: string;
}

export interface SubagentNotifyRun {
  runId: string;
  mode?: string;
  status?: string;
  asyncDir?: string;
  children: SubagentNotifyChild[];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function decodeNotifyChild(value: unknown, index: number): SubagentNotifyChild | undefined {
  const child = objectValue(value);
  if (!child) return;
  const stepIndex =
    typeof child.stepIndex === "number" && Number.isInteger(child.stepIndex)
      ? child.stepIndex
      : typeof child.index === "number" && Number.isInteger(child.index)
        ? child.index
        : index;
  const usage = objectValue(child.usage);
  return {
    ...child,
    ...(stringValue(child.transcriptPath)
      ? { transcriptPath: child.transcriptPath as string }
      : {}),
    ...(stringValue(child.sessionFile ?? child.sessionPath)
      ? { sessionFile: stringValue(child.sessionFile ?? child.sessionPath) }
      : {}),
    ...(child.outputTruncated === true || child.outputPartial === true
      ? { outputTruncated: true }
      : {}),
    ...(stringValue(child.transcriptError)
      ? { transcriptError: child.transcriptError as string }
      : {}),
    ...(stringValue(child.summary ?? child.output ?? child.preview)
      ? { summary: stringValue(child.summary ?? child.output ?? child.preview) }
      : {}),
    ...(usage ? { usage } : {}),
    canonicalChildId: resolveCanonicalChildId(child, stepIndex),
    stepIndex,
    ...(stringValue(child.status ?? child.state)
      ? { status: stringValue(child.status ?? child.state) }
      : {}),
  };
}

function decodeNotifyRun(value: unknown): SubagentNotifyRun | undefined {
  const run = objectValue(value);
  const runId = stringValue(run?.runId ?? run?.id ?? run?.asyncId);
  if (!run || !runId) return;
  const rawChildren = Array.isArray(run.children)
    ? run.children
    : Array.isArray(run.results)
      ? run.results
      : Array.isArray(run.childRuns)
        ? run.childRuns
        : Array.isArray(run.childOutputs)
          ? run.childOutputs
          : [];
  const children = rawChildren.flatMap((child, index) => {
    const decoded = decodeNotifyChild(child, index);
    if (
      decoded &&
      !decoded.sessionFile &&
      rawChildren.length === 1 &&
      run.sessionLabel === "Session file" &&
      stringValue(run.sessionValue)
    ) {
      decoded.sessionFile = stringValue(run.sessionValue);
    }
    return decoded ? [decoded] : [];
  });
  return {
    runId,
    ...(stringValue(run.mode) ? { mode: run.mode as string } : {}),
    ...(stringValue(run.status ?? run.state)
      ? { status: stringValue(run.status ?? run.state) }
      : {}),
    ...(stringValue(run.asyncDir) ? { asyncDir: run.asyncDir as string } : {}),
    children,
  };
}

/** Decode only subagent-notify wire messages, never Session or transcript records. */
export function decodeSubagentNotifyWire(message: unknown): SubagentNotifyRun[] {
  const wire = objectValue(message);
  if (wire?.role !== "custom" || wire.customType !== "subagent-notify") return [];
  const details = objectValue(wire.details);
  if (!details) return [];
  const rawRuns = Array.isArray(details.runs) ? details.runs : [details];
  return rawRuns.flatMap((run) => {
    const decoded = decodeNotifyRun(run);
    return decoded ? [decoded] : [];
  });
}

interface SubagentExecution {
  model?: string;
  effort?: string;
}

/** Project only execution fields, never request overrides or plugin state. */
export function projectSubagentExecution(
  ...sources: (Record<string, unknown> | undefined)[]
): SubagentExecution {
  const model = sources.map((source) => stringValue(source?.model)?.trim()).find(Boolean);
  const effort = sources.map((source) => stringValue(source?.thinking)?.trim()).find(Boolean);
  return { ...(model && { model }), ...(effort && { effort }) };
}

interface ChildExecution extends SubagentExecution {
  events: StreamEvent[];
}

export type DecodePiSessionResult =
  ({ ok: true } & ChildExecution) | { ok: false; reason: "not_session_v3"; events: [] };

export function observedStatusExecution(
  step: Record<string, unknown> | undefined,
): SubagentExecution {
  const state = step?.status ?? step?.state;
  if (state === "pending" || state === "queued") return {};
  const resolved = objectValue(step?.resolvedModel);
  const model = sessionModel(resolved?.provider, resolved?.model);
  return model ? { ...projectSubagentExecution(step), model } : {};
}

export function assistantExecution(message: Record<string, unknown>): SubagentExecution {
  const model = sessionModel(message.provider, message.model);
  const effort = stringValue(message.thinkingLevel)?.trim();
  return { ...(model && { model }), ...(effort && { effort }) };
}

function sessionModel(provider: unknown, id: unknown): string | undefined {
  const model = stringValue(id)?.trim();
  const prefix = stringValue(provider)?.trim();
  if (!model) return;
  return prefix && !model.startsWith(`${prefix}/`) ? `${prefix}/${model}` : model;
}

function projectAssistantMessage(
  message: Record<string, unknown>,
  bridgeOwnedTools: ReadonlySet<string> | undefined,
  includeToolCalls: boolean,
): StreamEvent[] {
  const content = message.content;
  if (typeof content === "string") return content ? [{ kind: "text", content }] : [];
  if (!Array.isArray(content)) return [];
  const events: StreamEvent[] = [];
  for (const rawBlock of content) {
    const block = objectValue(rawBlock);
    if (!block) continue;
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      events.push({ kind: "thinking", content: block.thinking });
    } else if (block.type === "text" && typeof block.text === "string" && block.text) {
      events.push({ kind: "text", content: block.text });
    } else if (includeToolCalls && block.type === "toolCall" && typeof block.name === "string") {
      const formatted = formatPiToolUse(block.name, objectValue(block.arguments), bridgeOwnedTools);
      events.push({
        kind: "tool_use",
        ...formatted,
        ...(typeof block.id === "string" ? { toolUseId: block.id } : {}),
      });
    }
  }
  return events;
}

function projectToolResult(
  message: Record<string, unknown>,
  contentOverride?: unknown,
): StreamEvent {
  return {
    kind: "tool_result",
    content: extractPiToolResultText(
      contentOverride === undefined ? message.content : contentOverride,
    ),
    ...(typeof message.toolCallId === "string" ? { toolUseId: message.toolCallId } : {}),
    ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
    ...(message.isError === true ? { isError: true } : {}),
    ...(message.isMarkdown === true ? { isMarkdown: true } : {}),
    ...(typeof message.durationMs === "number" ? { durationMs: message.durationMs } : {}),
  };
}

function foldChildToolResults(events: StreamEvent[]): StreamEvent[] {
  const calls = new Map<string, StreamEvent>();
  // Only earlier calls can own a result, as in the live transcript.
  return events.filter((event) => {
    const id = event.toolUseId;
    if (!id) return true;
    if (event.kind === "tool_use" && !calls.has(id)) calls.set(id, event);
    if (event.kind !== "tool_result") return true;
    const call = calls.get(id);
    if (!call) return true;
    call.toolResult = event.content;
    // Artifacts can report failure in tool_end but omit it in toolResult.
    if (event.isError || call.isError) call.toolResultIsError = true;
    if (event.isMarkdown) call.toolResultIsMarkdown = true;
    if (event.durationMs != null) call.durationMs = event.durationMs;
    return false;
  });
}

/** Decode the active branch of a native Pi Session v3 JSONL tree. */
export function decodePiSessionV3Tree(
  sessionFilePath: string,
  bridgeOwnedTools?: ReadonlySet<string>,
): DecodePiSessionResult {
  let lines: string[];
  try {
    lines = fs.readFileSync(sessionFilePath, "utf8").split(/\r?\n/);
  } catch {
    return { ok: false, reason: "not_session_v3", events: [] };
  }
  try {
    const header = objectValue(JSON.parse(lines[0] ?? ""));
    if (header?.type !== "session") return { ok: false, reason: "not_session_v3", events: [] };
  } catch {
    return { ok: false, reason: "not_session_v3", events: [] };
  }

  const entries: Record<string, unknown>[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    try {
      const entry = objectValue(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      // A malformed entry cannot contribute to the active branch, but valid
      // preceding entries remain useful artifact data.
    }
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const leaf = [...entries].reverse().find((entry) => typeof entry.id === "string");
  const branch: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let current = leaf;
  while (current && typeof current.id === "string" && !visited.has(current.id)) {
    visited.add(current.id);
    branch.push(current);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  branch.reverse();

  const events: StreamEvent[] = [];
  let settings: SubagentExecution = {};
  let execution: SubagentExecution | undefined;
  for (const entry of branch) {
    if (entry.type === "model_change")
      settings.model = sessionModel(entry.provider, entry.modelId) ?? settings.model;
    if (entry.type === "thinking_level_change")
      settings.effort = stringValue(entry.thinkingLevel)?.trim() || settings.effort;
    if (entry.type !== "message") continue;
    const message = objectValue(entry.message);
    if (!message) continue;
    if (message.role === "assistant") {
      // Snapshot settings at the reply, not a change made after it ran.
      settings = { ...settings, ...assistantExecution(message) };
      execution = { ...settings };
      events.push(...projectAssistantMessage(message, bridgeOwnedTools, true));
    } else if (message.role === "toolResult" || message.role === "tool_result") {
      events.push(projectToolResult(message));
    }
  }
  const { model, effort } = execution ?? {};
  return {
    ok: true,
    events: foldChildToolResults(events),
    ...(model && { model }),
    ...(effort && { effort }),
  };
}

export interface ChildTranscriptMeta {
  outputTruncated?: boolean;
  transcriptError?: string;
}

export interface SubagentChildRef extends ChildTranscriptMeta, SubagentStepIdentity {
  sessionFile?: string;
  transcriptPath?: string;
}

function transcriptWarning(content: string): StreamEvent {
  return { kind: "notice", level: "warning", content };
}

function parseToolArguments(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof record.argsPayload !== "string") return objectValue(record.args);
  try {
    return objectValue(JSON.parse(record.argsPayload));
  } catch {
    return undefined;
  }
}

/** Decode the bounded child-transcript artifact protocol, including gap notices. */
export function decodeChildTranscriptArtifact(
  transcriptPath: string,
  bridgeOwnedTools?: ReadonlySet<string>,
  meta?: ChildTranscriptMeta,
): ChildExecution {
  let source: string;
  try {
    source = fs.readFileSync(transcriptPath, "utf8");
  } catch (error) {
    return {
      events: [
        transcriptWarning(
          `Child transcript unavailable at ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }

  const events: StreamEvent[] = [];
  const warnings: StreamEvent[] = [];
  let execution: SubagentExecution = {};
  const toolCalls = new Map<string, StreamEvent>();
  if (meta?.outputTruncated) {
    warnings.push(
      transcriptWarning("Child output was truncated; the transcript may be incomplete."),
    );
  }
  if (meta?.transcriptError) {
    warnings.push(transcriptWarning(`Child transcript error: ${meta.transcriptError}`));
  }

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: Record<string, unknown> | undefined;
    try {
      record = objectValue(JSON.parse(line));
    } catch {
      continue;
    }
    if (!record) continue;
    if (record.recordType === "truncated") {
      warnings.push(
        transcriptWarning(
          stringValue(record.message) ??
            "Child transcript was truncated; later records are missing.",
        ),
      );
      continue;
    }
    if (record.recordType === "tool_start" && typeof record.toolName === "string") {
      const formatted = formatPiToolUse(
        record.toolName,
        parseToolArguments(record),
        bridgeOwnedTools,
      );
      const event: StreamEvent = {
        kind: "tool_use",
        ...formatted,
        ...(typeof record.toolCallId === "string" ? { toolUseId: record.toolCallId } : {}),
      };
      events.push(event);
      if (typeof record.toolCallId === "string") toolCalls.set(record.toolCallId, event);
      continue;
    }
    if (record.recordType === "tool_end") {
      const call =
        typeof record.toolCallId === "string" ? toolCalls.get(record.toolCallId) : undefined;
      if (call && record.isError === true) call.isError = true;
      continue;
    }
    if (record.recordType !== "message") continue;
    const message = objectValue(record.message);
    if (!message) continue;
    const role = record.role ?? message.role;
    if (role === "assistant") {
      // Tool calls are projected from tool_start records; projecting the copy
      // embedded in message_end as well would duplicate every call.
      execution = { ...execution, ...assistantExecution(message) };
      events.push(...projectAssistantMessage(message, bridgeOwnedTools, false));
    } else if (role === "toolResult" || role === "tool_result") {
      events.push(projectToolResult(message, record.text));
      if (record.outputTruncated === true) {
        warnings.push(
          transcriptWarning("A child tool result was truncated; its output is incomplete."),
        );
      }
    }
  }
  events.push(...warnings);
  return { events: foldChildToolResults(events), ...execution };
}

export function reconstructSubagentChild(
  childRef: SubagentChildRef,
  bridgeOwnedTools?: ReadonlySet<string>,
): ChildExecution {
  if (childRef.sessionFile) {
    const decoded = decodePiSessionV3Tree(childRef.sessionFile, bridgeOwnedTools);
    if (decoded.ok) {
      const { events, model, effort } = decoded;
      const fallback =
        childRef.transcriptPath && (!model || !effort)
          ? decodeChildTranscriptArtifact(childRef.transcriptPath, bridgeOwnedTools, childRef)
          : undefined;
      return { events, model: model ?? fallback?.model, effort: effort ?? fallback?.effort };
    }
  }
  if (childRef.transcriptPath) {
    return decodeChildTranscriptArtifact(childRef.transcriptPath, bridgeOwnedTools, childRef);
  }
  return {
    events: [
      transcriptWarning(
        `No valid session file or child transcript is available for ${childRef.sessionFile ?? "this subagent child"}.`,
      ),
    ],
  };
}

export type StopTarget =
  | { scope: "run"; run: ActiveAsyncRunRecord }
  | { scope: "child"; run: ActiveAsyncRunRecord; child: ActiveAsyncChildRecord };

export function resolveStopTarget(
  activeRuns: readonly ActiveAsyncRunRecord[],
  requestedId: string,
): StopTarget | undefined {
  const runMatches = activeRuns.filter((run) => run.runId === requestedId);
  if (runMatches.length === 1) return { scope: "run", run: runMatches[0] };
  if (runMatches.length > 1) return;

  const childMatches = activeRuns.flatMap((run) =>
    run.children.flatMap((child) =>
      child.taskId === requestedId || child.canonicalChildId === requestedId
        ? [{ run, child }]
        : [],
    ),
  );
  if (childMatches.length !== 1) return;
  const [{ run, child }] = childMatches;
  return run.mode === "single" ? { scope: "run", run } : { scope: "child", run, child };
}

export interface FallbackAsyncStopOptions {
  piSubagentsRoot: string;
  ownsSession: (sessionId: string | undefined) => boolean;
  requestAsyncStopImpl?: (
    asyncDir: string,
    payload: { source: string; targetIndex?: number; childId?: string },
  ) => string | Promise<string>;
}

export type FallbackAsyncStopResult =
  { ok: true; requestPath: string } | { ok: false; error: string };

function stopInboxClosed(asyncDir: string): boolean {
  return fs.existsSync(path.join(asyncDir, "control", "stop-inbox-closed.json"));
}

function childIdentityCandidates(step: SubagentStepIdentity, index: number): string[] {
  return [...new Set([step.childId, step.workflowKey, step.runId, `step:${index}`])].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function isSafeSingleSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[/\\]/.test(value);
}

/** Validate on-disk ownership and exact target scope before writing a stop request. */
export async function executeFallbackAsyncStop(
  target: StopTarget,
  opts: FallbackAsyncStopOptions,
): Promise<FallbackAsyncStopResult> {
  const unavailable =
    target.scope === "child"
      ? "child_stop_unavailable_bridge_disconnected"
      : "run_stop_unavailable_bridge_disconnected";
  let status: Record<string, unknown>;
  try {
    const parsed = objectValue(
      JSON.parse(fs.readFileSync(path.join(target.run.asyncDir, "status.json"), "utf8")),
    );
    if (!parsed) return { ok: false, error: unavailable };
    status = parsed;
  } catch {
    return { ok: false, error: unavailable };
  }

  const workflow = status.mode === "workflow";
  if (
    status.runId !== target.run.runId ||
    !opts.ownsSession(stringValue(status.sessionId)) ||
    status.state === "paused" ||
    (status.state !== "running" && status.state !== "queued") ||
    (workflow && target.scope !== "child")
  ) {
    return { ok: false, error: unavailable };
  }
  if (!workflow && stopInboxClosed(target.run.asyncDir)) {
    return { ok: false, error: unavailable };
  }

  let stopDir = target.run.asyncDir;
  let payload: { source: string; targetIndex?: number; childId?: string } = {
    source: "panel-host-fallback",
  };
  if (target.scope === "child") {
    const targetIndex = target.child.stepIndex;
    if (!Number.isInteger(targetIndex) || targetIndex < 0) return { ok: false, error: unavailable };
    const steps = Array.isArray(status.steps) ? status.steps : [];
    const matches = steps.flatMap((rawStep, index) => {
      const step = objectValue(rawStep);
      return step && childIdentityCandidates(step, index).includes(target.child.canonicalChildId)
        ? [{ step, index }]
        : [];
    });
    if (
      matches.length !== 1 ||
      matches[0].index !== targetIndex ||
      (matches[0].step.status !== "pending" && matches[0].step.status !== "running")
    ) {
      return { ok: false, error: unavailable };
    }
    if (workflow) {
      // Async workflow controllers live in-process in Pi, while each async child
      // step runs in its own sibling detached runner directory with a control inbox.
      const childRunId = stringValue(matches[0].step.runId);
      if (!childRunId || !isSafeSingleSegment(childRunId)) return { ok: false, error: unavailable };
      const childAsyncDir = path.join(path.dirname(target.run.asyncDir), childRunId);
      let childStatus: Record<string, unknown> | undefined;
      try {
        childStatus = objectValue(
          JSON.parse(fs.readFileSync(path.join(childAsyncDir, "status.json"), "utf8")),
        );
      } catch {
        return { ok: false, error: unavailable };
      }
      if (
        !childStatus ||
        childStatus.runId !== childRunId ||
        (childStatus.parentWorkflowRunId !== undefined &&
          childStatus.parentWorkflowRunId !== status.runId) ||
        !opts.ownsSession(stringValue(childStatus.sessionId)) ||
        childStatus.mode === "workflow" ||
        childStatus.state === "paused" ||
        (childStatus.state !== "running" && childStatus.state !== "queued") ||
        stopInboxClosed(childAsyncDir)
      ) {
        return { ok: false, error: unavailable };
      }
      stopDir = childAsyncDir;
      payload = { source: "panel-host-fallback" };
    } else {
      payload = {
        targetIndex,
        childId: target.child.canonicalChildId,
        source: "panel-host-fallback",
      };
    }
  }

  try {
    const requestAsyncStop =
      opts.requestAsyncStopImpl ??
      (
        (await import(
          pathToFileURL(path.join(opts.piSubagentsRoot, "bundle/control-channel.js")).href
        )) as {
          requestAsyncStop: NonNullable<FallbackAsyncStopOptions["requestAsyncStopImpl"]>;
        }
      ).requestAsyncStop;
    const requestPath = await requestAsyncStop(stopDir, payload);
    return { ok: true, requestPath };
  } catch (error) {
    return {
      ok: false,
      error:
        target.scope === "child"
          ? unavailable
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}
