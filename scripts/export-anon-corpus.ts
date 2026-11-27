import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { TELEMETRY_ACTIONS, TELEMETRY_LAYOUTS, TELEMETRY_OUTCOMES } from "../shared/telemetry";
import { jsonLine } from "./capture-io";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Row = { [key: string]: Json };
export interface AnonCorpus {
  workspaces: { metadata: Row; messages: Row[] }[];
  telemetry: Row[];
}

// Only public field names, public enum values and declared structural numbers pass through.
// Unknown object keys can themselves contain paths, IDs or credentials.
const enums = new Map<string, readonly string[]>([
  ["action", TELEMETRY_ACTIONS],
  ["layout", TELEMETRY_LAYOUTS],
  ["outcome", TELEMETRY_OUTCOMES],
  ["backend", ["pi", "codex"]],
  ["role", ["lead", "worker", "user", "assistant", "toolResult"]],
  ["lastResult", ["done", "failed"]],
  [
    "status",
    [
      "queued",
      "starting",
      "dispatching",
      "streaming",
      "done",
      "failed",
      "pending",
      "running",
      "completed",
      "stopped",
      "cancelled",
      "error",
    ],
  ],
  [
    "kind",
    [
      "user",
      "agent",
      "system",
      "text",
      "text_delta",
      "thinking",
      "thinking_delta",
      "tool_use",
      "tool_result",
      "notice",
      "subagent_start",
      "subagent_progress",
      "subagent_done",
    ],
  ],
]);
const numbers = new Set(
  `ts timestamp createdAt lastActivityAt archivedAt startedAt endedAt updatedAt
  durationMs contentOffset unread minEntryCount inputTokens outputTokens cacheReadTokens
  cacheWriteTokens totalTokens toolCount turnCount width height size count`.split(/\s+/),
);
const identities = new Set(
  `id taskId toolUseId messageId workspaceId projectId agentId hostId sessionId
  parentId runId tab_run_id cwd normalizedCwd project name`.split(/\s+/),
);
const keys = new Set([
  ...enums.keys(),
  ...numbers,
  ...identities,
  ...`workspaces metadata messages telemetry agents session config usage sessionFile expectedLeafAnchorId
    persistedSessionAnchor hasUnanchoredInput hasConfirmedTurns desiredModel desiredEffort effort delivered
    activeAsyncRuns settledAsyncRuns piExcludePackages dataDir uploadsDir model avatar color isDefault
    projectLink attention awaitsUser content events subagent transcript summary toolName toolResult
    thinking text title label description type level error images mimeType data`.split(/\s+/),
]);
const containers = new Set(
  `workspaces metadata messages telemetry agents session config usage attention projectLink delivered
   persistedSessionAnchor activeAsyncRuns settledAsyncRuns events subagent transcript images`.split(
    /\s+/,
  ),
);
const masked = /^[~\t \r\n]*$/;
const alias = /^[\uE100-\uE1FF]+$/;
const unknownKey = /^[\uE200-\uE2FF]+$/;

function tokenMap(start: number) {
  const assigned = new Map<string, string>();
  const counts = new Map<number, number>();
  return (source: string): string => {
    if (!source.length) return "";
    const existing = assigned.get(source);
    if (existing !== undefined) return existing;
    // Ordinal aliases avoid storing a reversible hash of low-entropy names. Assign
    // ordinals separately by UTF-16 length so even one-character keys keep shape.
    let n = counts.get(source.length) ?? 0;
    counts.set(source.length, n + 1);
    let out = "";
    for (let i = 0; i < source.length; i++) {
      out += String.fromCharCode(start + (n % 256));
      n = Math.floor(n / 256);
    }
    if (n !== 0) throw new Error("Corpus alias capacity exceeded; select a smaller slice");
    assigned.set(source, out);
    return out;
  };
}

function publicString(key: string, value: string): boolean {
  return enums.get(key)?.includes(value) ?? false;
}

export function redactCorpus(input: AnonCorpus): AnonCorpus {
  const encodeKey = tokenMap(0xe200);
  const encodeId = tokenMap(0xe100);
  function visit(value: Json, key = "", trusted = true): Json {
    if (typeof value === "string") {
      if (publicString(key, value)) return value;
      if (identities.has(key)) return encodeId(value);
      return value.replace(/[^\t \r\n]/g, "~");
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Non-finite corpus number");
      return numbers.has(key) ? value : 0;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, "", trusted));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => {
          // Unknown subtrees may be arbitrary tool input/output. A string named
          // `status` or a number named `timestamp` is public only in a known branch.
          const safe = trusted && keys.has(k);
          return [safe ? k : encodeKey(k), visit(v, safe ? k : "", safe && containers.has(k))];
        }),
      );
    }
    return value;
  }
  const output = visit(input as unknown as Json) as unknown as AnonCorpus;
  assertRedactedCorpus(output);
  return output;
}

// Validate the serialized artifact too. Deny by default: a new input field, enum,
// encoded secret or text format cannot bypass this gate by missing a regex detector.
export function assertRedactedCorpus(value: unknown): void {
  audit(value);
}

function audit(value: unknown, key = "", trusted = true): void {
  if (typeof value === "string") {
    if (
      publicString(key, value) ||
      (identities.has(key) ? value === "" || alias.test(value) : masked.test(value))
    )
      return;
    throw new Error("Corpus contains unredacted string");
  }
  if (typeof value === "number") {
    if (Number.isFinite(value) && (numbers.has(key) || value === 0)) return;
    throw new Error("Corpus contains unredacted number");
  }
  if (Array.isArray(value)) {
    value.forEach((item) => audit(item, "", trusted));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (trusted && keys.has(k)) audit(v, k, containers.has(k));
      else if (k === "" || unknownKey.test(k)) audit(v, "", false);
      else throw new Error("Corpus contains unredacted object key");
    }
  } else if (value !== null && typeof value !== "boolean") {
    throw new Error("Corpus contains non-JSON value");
  }
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected cache object");
  return value as Row;
}

export function exportCorpus(
  base: string,
  indices: number[],
  messages: [number, number][] = [],
): string {
  if (
    !indices.length ||
    indices.length > 20 ||
    new Set(indices).size !== indices.length ||
    messages.length > 20
  ) {
    throw new Error("Select 1–20 distinct workspace ordinals and at most 20 message rows");
  }
  const cache = join(base, ".agent-team", "cache");
  const { workspaceIds } = object(readJson(join(cache, "index.json")));
  if (!Array.isArray(workspaceIds)) throw new Error("Invalid cache index");
  const ids = new Map<number, string>();
  const workspaces = indices.map((index) => {
    const id = workspaceIds[index];
    if (!Number.isSafeInteger(index) || typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error("Invalid workspace ordinal or cache identifier");
    }
    ids.set(index, id);
    const metadata = object(readJson(join(cache, "workspaces", `${id}.json`)));
    if (metadata.id !== id || !Array.isArray(metadata.agents))
      throw new Error("Invalid workspace cache row");
    return { metadata, messages: [] as Row[] };
  });
  if (messages.length) {
    const db = new DatabaseSync(join(cache, "history.db"), { readOnly: true });
    try {
      const select = db.prepare(
        "SELECT body FROM messages WHERE session = ? AND seq = ? AND length(body) <= 262144",
      );
      const sorted = [...messages].sort(([x, a], [y, b]) => x - y || a - b);
      for (const [index, seq] of sorted) {
        const id = ids.get(index);
        if (!id || !Number.isSafeInteger(seq) || seq < 0)
          throw new Error("Invalid message selection");
        const row = select.get(id, seq);
        if (typeof row?.body !== "string")
          throw new Error("Selected message missing or larger than 256 Ki characters");
        workspaces[indices.indexOf(index)].messages.push(object(JSON.parse(row.body)));
      }
    } finally {
      db.close();
    }
  }
  const db = new DatabaseSync(join(base, "telemetry.db"), { readOnly: true });
  let telemetry: Row[];
  try {
    // Keep a contiguous recent action sequence from the most active tab which
    // performed both actions. No joins on workspace or prompt content exist.
    telemetry = db
      .prepare(
        `
      SELECT ts, tab_run_id, layout, action, outcome FROM ui_events
      WHERE tab_run_id = (
        SELECT tab_run_id FROM ui_events GROUP BY tab_run_id
        HAVING count(CASE WHEN action = 'workspace.switch' THEN 1 END) > 0
           AND count(CASE WHEN action = 'chat.send' THEN 1 END) > 0
        ORDER BY count(*) DESC, max(id) DESC LIMIT 1
      ) ORDER BY ts DESC, id DESC LIMIT 32
    `,
      )
      .all()
      .reverse()
      .map(object);
  } finally {
    db.close();
  }
  const serialized = jsonLine(redactCorpus({ workspaces, telemetry }));
  if (Buffer.byteLength(serialized) - 1 > 1024 * 1024)
    throw new Error("Corpus exceeds 1 MiB; select a smaller slice");
  assertRedactedCorpus(JSON.parse(serialized));
  return serialized;
}

const journeyActions = new Set([
  "workspace.switch",
  "chat.send",
  "chat.stop",
  "chat.cancel_queued",
  "chat.quote_jump",
  "chat.history_page",
  "chat.diagram_preview",
]);
const journeyKinds = ["user", "agent", "system"] as const;
type JourneyKind = (typeof journeyKinds)[number];
type JourneyCorpus = { actions: string[]; history: JourneyKind[][] };
const isJourneyKind = (value: unknown): value is JourneyKind =>
  journeyKinds.some((kind) => value === kind);

// The published journey needs order and row kinds, not timestamps, text lengths,
// identifiers (even aliases), or any other metadata from the structural export.
export function projectJourney(corpus: AnonCorpus): JourneyCorpus {
  return {
    actions: corpus.telemetry.flatMap(({ action }) =>
      typeof action === "string" && journeyActions.has(action) ? [action] : [],
    ),
    history: corpus.workspaces.map(({ messages }) =>
      messages.flatMap(({ kind }) => (isJourneyKind(kind) ? [kind] : [])),
    ),
  };
}

export function assertJourneyCorpus(value: unknown): asserts value is JourneyCorpus {
  const row = object(value);
  if (
    Object.keys(row).sort().join(",") !== "actions,history" ||
    !Array.isArray(row.actions) ||
    row.actions.length > 32 ||
    !row.actions.every((v) => typeof v === "string" && journeyActions.has(v)) ||
    !Array.isArray(row.history) ||
    row.history.length < 1 ||
    row.history.length > 20 ||
    !row.history.every((v) => Array.isArray(v) && v.length <= 20 && v.every(isJourneyKind))
  ) {
    throw new Error("Invalid journey corpus: only approved actions and history kinds are allowed");
  }
}

function run(args: string[]): void {
  const journey = args[0] === "--journey";
  if (journey) args.shift();
  const [base, output, selection, ...rows] = args;
  if (
    !base ||
    !output ||
    !/^\d+(,\d+)*$/.test(selection ?? "") ||
    rows.some((row) => !/^\d+:\d+$/.test(row))
  ) {
    throw new Error(
      "Usage: tsx scripts/export-anon-corpus.ts [--journey] BASE NEW_OUTPUT WORKSPACE_ORDINAL[,ORDINAL...] [ORDINAL:MESSAGE_SEQ ...]",
    );
  }
  const corpus = exportCorpus(
    base,
    selection.split(",").map(Number),
    rows.map((row) => row.split(":").map(Number) as [number, number]),
  );
  const projected = journey ? projectJourney(JSON.parse(corpus) as AnonCorpus) : undefined;
  if (projected) assertJourneyCorpus(projected);
  writeFileSync(output, projected ? jsonLine(projected) : corpus, {
    flag: "wx",
    mode: 0o600,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    run(process.argv.slice(2));
  } catch {
    // Never print raw SQLite, JSON parse exceptions or operator paths.
    console.error(
      "Corpus export rejected. Check source databases, ordinal/sequence selections, size limit and that the output path does not exist.",
    );
    process.exitCode = 1;
  }
}
