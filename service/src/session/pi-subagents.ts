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

function* jsonlObjects(lines: Iterable<string>): Generator<Record<string, unknown>> {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = objectValue(JSON.parse(line));
      if (row) yield row;
    } catch {
      // One malformed record does not invalidate the surrounding artifact.
    }
  }
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
  // Workflow notices may separate execution identity from output metadata; the
  // output array is not necessarily in roster order. Only join explicit keys.
  const outputs =
    Array.isArray(run.childOutputs) && rawChildren !== run.childOutputs
      ? run.childOutputs.map(objectValue)
      : [];
  const children = rawChildren.flatMap((child, index) => {
    const row = objectValue(child);
    const matches = outputs.filter(
      (output) =>
        row &&
        output &&
        (typeof row.runId === "string" && typeof output.runId === "string"
          ? row.runId === output.runId
          : typeof row.workflowKey === "string" && row.workflowKey === output.workflowKey),
    );
    const decoded = decodeNotifyChild(
      matches.length === 1 ? { ...matches[0], ...row } : child,
      index,
    );
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
  seenToolUses?: Set<string>,
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
      const id = stringValue(block.id);
      if (id && seenToolUses?.has(id)) continue;
      if (id) seenToolUses?.add(id);
      const formatted = formatPiToolUse(block.name, objectValue(block.arguments), bridgeOwnedTools);
      events.push({
        kind: "tool_use",
        ...formatted,
        // Complete session artifacts retain even an explicitly empty id.
        ...(id !== undefined && (id || !seenToolUses) ? { toolUseId: id } : {}),
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

  const byId = new Map<string, Record<string, unknown>>();
  let leaf: Record<string, unknown> | undefined;
  for (const entry of jsonlObjects(lines.slice(1))) {
    if (typeof entry.id !== "string") continue;
    byId.set(entry.id, entry);
    leaf = entry;
  }
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

  for (const record of jsonlObjects(source.split(/\r?\n/))) {
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

export interface IncrementalJsonlCursor {
  filePath: string;
  offset: number;
  carry: Buffer;
}

export function createIncrementalJsonlCursor(
  filePath: string,
  initialOffset = 0,
): IncrementalJsonlCursor {
  return {
    filePath,
    offset: Number.isFinite(initialOffset) && initialOffset > 0 ? Math.floor(initialOffset) : 0,
    carry: Buffer.alloc(0),
  };
}

/** Byte offset up to the last newline-delimited record consumed from the cursor. */
export function consumedJsonlOffset(cursor: IncrementalJsonlCursor): number {
  return Math.max(0, cursor.offset - cursor.carry.length);
}

/** Read newly appended complete JSONL object records without failing on partial trailing lines. */
export function readIncrementalJsonlRecords(
  cursor: IncrementalJsonlCursor,
): Record<string, unknown>[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cursor.filePath);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];
  if (stat.size < cursor.offset) {
    cursor.offset = 0;
    cursor.carry = Buffer.alloc(0);
  }
  const delta = stat.size - cursor.offset;
  if (delta <= 0) return [];

  let fd: number | undefined;
  let bytesRead = 0;
  const buf = Buffer.allocUnsafe(delta);
  try {
    fd = fs.openSync(cursor.filePath, "r");
    while (bytesRead < delta) {
      const n = fs.readSync(fd, buf, bytesRead, delta - bytesRead, cursor.offset + bytesRead);
      if (n <= 0) break;
      bytesRead += n;
    }
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore close errors */
      }
    }
  }
  if (bytesRead <= 0) return [];
  cursor.offset += bytesRead;
  const chunk = bytesRead < delta ? buf.subarray(0, bytesRead) : buf;
  const combined = cursor.carry.length ? Buffer.concat([cursor.carry, chunk]) : chunk;
  const lastNewline = combined.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    cursor.carry = Buffer.from(combined);
    return [];
  }
  const complete = combined.subarray(0, lastNewline);
  cursor.carry = Buffer.from(combined.subarray(lastNewline + 1));

  return [...jsonlObjects(complete.toString("utf8").split(/\r?\n/))];
}

export interface SubagentProjectionState {
  seenToolUses: Set<string>;
  seenToolResults: Set<string>;
  execution: SubagentExecution;
}

export interface ProjectedRecordBatch {
  events: StreamEvent[];
  executionChanged: boolean;
}

export function createSubagentProjectionState(
  initialExecution?: SubagentExecution,
): SubagentProjectionState {
  return {
    seenToolUses: new Set<string>(),
    seenToolResults: new Set<string>(),
    execution: { ...initialExecution },
  };
}

function mergeProjectionExecution(
  state: SubagentProjectionState,
  next: SubagentExecution,
): boolean {
  const merged: SubagentExecution = {
    ...((next.model ?? state.execution.model)
      ? { model: next.model ?? state.execution.model }
      : {}),
    ...((next.effort ?? state.execution.effort)
      ? { effort: next.effort ?? state.execution.effort }
      : {}),
  };
  const changed =
    merged.model !== state.execution.model || merged.effort !== state.execution.effort;
  state.execution = merged;
  return changed;
}

// Both native session entries and runner message_end frames carry a Pi message.
function projectLivePiMessage(
  raw: unknown,
  state: SubagentProjectionState,
  bridgeOwnedTools?: ReadonlySet<string>,
): ProjectedRecordBatch {
  const message = objectValue(raw);
  if (message?.role === "assistant") {
    const executionChanged = mergeProjectionExecution(state, assistantExecution(message));
    const events = projectAssistantMessage(message, bridgeOwnedTools, true, state.seenToolUses);
    return { events, executionChanged };
  }
  if (message?.role === "toolResult" || message?.role === "tool_result") {
    const id = stringValue(message.toolCallId);
    if (!id || !state.seenToolResults.has(id)) {
      if (id) state.seenToolResults.add(id);
      return { events: [projectToolResult(message)], executionChanged: false };
    }
  }
  return { events: [], executionChanged: false };
}

/** Project one line from an async runner `events.jsonl` incrementally without duplicates. */
export function projectAsyncEventRecord(
  record: Record<string, unknown>,
  state: SubagentProjectionState,
  bridgeOwnedTools?: ReadonlySet<string>,
): ProjectedRecordBatch {
  const type = stringValue(record.type);
  if (type === "message_end") {
    return projectLivePiMessage(record.message, state, bridgeOwnedTools);
  }
  if (type === "tool_execution_start") {
    const toolName = stringValue(record.toolName);
    if (!toolName) return { events: [], executionChanged: false };
    const toolUseId = stringValue(record.toolCallId);
    if (toolUseId && state.seenToolUses.has(toolUseId)) {
      return { events: [], executionChanged: false };
    }
    if (toolUseId) state.seenToolUses.add(toolUseId);
    const formatted = formatPiToolUse(toolName, objectValue(record.args), bridgeOwnedTools);
    return {
      events: [
        {
          kind: "tool_use",
          ...formatted,
          ...(toolUseId ? { toolUseId } : {}),
        },
      ],
      executionChanged: false,
    };
  }
  if (type === "tool_execution_end") {
    const toolUseId = stringValue(record.toolCallId);
    if (toolUseId && state.seenToolResults.has(toolUseId)) {
      return { events: [], executionChanged: false };
    }
    const resultObj = objectValue(record.result);
    const rawContent = resultObj?.content ?? record.result;
    if (rawContent === undefined && record.isError !== true) {
      return { events: [], executionChanged: false };
    }
    if (toolUseId) state.seenToolResults.add(toolUseId);
    const toolName = stringValue(record.toolName);
    return {
      events: [
        {
          kind: "tool_result",
          content: extractPiToolResultText(rawContent),
          ...(toolUseId ? { toolUseId } : {}),
          ...(toolName ? { toolName } : {}),
          ...(record.isError === true ? { isError: true } : {}),
          ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
        },
      ],
      executionChanged: false,
    };
  }
  return { events: [], executionChanged: false };
}

/** Project one line from a foreground `transcriptPath` JSONL incrementally. */
export function projectTranscriptArtifactRecord(
  record: Record<string, unknown>,
  state: SubagentProjectionState,
  bridgeOwnedTools?: ReadonlySet<string>,
): ProjectedRecordBatch {
  if (record.recordType === "truncated") {
    return {
      events: [
        transcriptWarning(
          stringValue(record.message) ??
            "Child transcript was truncated; later records are missing.",
        ),
      ],
      executionChanged: false,
    };
  }
  if (record.recordType === "tool_start" && typeof record.toolName === "string") {
    const toolUseId = stringValue(record.toolCallId);
    if (toolUseId && state.seenToolUses.has(toolUseId)) {
      return { events: [], executionChanged: false };
    }
    if (toolUseId) state.seenToolUses.add(toolUseId);
    const formatted = formatPiToolUse(
      record.toolName,
      parseToolArguments(record),
      bridgeOwnedTools,
    );
    return {
      events: [
        {
          kind: "tool_use",
          ...formatted,
          ...(toolUseId ? { toolUseId } : {}),
        },
      ],
      executionChanged: false,
    };
  }
  if (record.recordType !== "message") return { events: [], executionChanged: false };
  const message = objectValue(record.message);
  if (!message) return { events: [], executionChanged: false };
  const role = record.role ?? message.role;
  if (role === "assistant") {
    const executionChanged = mergeProjectionExecution(state, assistantExecution(message));
    const events = projectAssistantMessage(message, bridgeOwnedTools, false);
    return { events, executionChanged };
  }
  if (role === "toolResult" || role === "tool_result") {
    const events: StreamEvent[] = [];
    const toolUseId = stringValue(message.toolCallId);
    if (!(toolUseId && state.seenToolResults.has(toolUseId))) {
      if (toolUseId) state.seenToolResults.add(toolUseId);
      events.push(projectToolResult(message, record.text));
    }
    if (record.outputTruncated === true) {
      events.push(
        transcriptWarning("A child tool result was truncated; its output is incomplete."),
      );
    }
    return { events, executionChanged: false };
  }
  return { events: [], executionChanged: false };
}

/** Project one entry from a native Pi Session v3 JSONL incrementally. */
export function projectSessionV3Record(
  record: Record<string, unknown>,
  state: SubagentProjectionState,
  bridgeOwnedTools?: ReadonlySet<string>,
): ProjectedRecordBatch {
  if (record.type === "model_change") {
    const model = sessionModel(record.provider, record.modelId);
    return {
      events: [],
      executionChanged: model ? mergeProjectionExecution(state, { model }) : false,
    };
  }
  if (record.type === "thinking_level_change") {
    const effort = stringValue(record.thinkingLevel)?.trim();
    return {
      events: [],
      executionChanged: effort ? mergeProjectionExecution(state, { effort }) : false,
    };
  }
  if (record.type !== "message") return { events: [], executionChanged: false };
  return projectLivePiMessage(record.message, state, bridgeOwnedTools);
}

export function resolveWorkflowStepIndex(
  row: Record<string, unknown>,
  childCount: number,
  fallbackIndex?: number,
): number | undefined {
  if (
    typeof row.stepIndex === "number" &&
    Number.isInteger(row.stepIndex) &&
    row.stepIndex >= 0 &&
    row.stepIndex < childCount
  ) {
    return row.stepIndex;
  }
  const key = stringValue(row.childId) ?? stringValue(row.workflowKey);
  if (key) {
    const m = /^(?:task|step)-(\d+)$/.exec(key);
    if (m) {
      const idx = Number(m[1]) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < childCount) return idx;
    }
  }
  if (
    fallbackIndex !== undefined &&
    Number.isInteger(fallbackIndex) &&
    fallbackIndex >= 0 &&
    fallbackIndex < childCount
  ) {
    return fallbackIndex;
  }
  return undefined;
}

export function isSafeChildRunId(value: string): boolean {
  return isSafeSingleSegment(value);
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
