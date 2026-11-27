import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  type AnonCorpus,
  assertJourneyCorpus,
  assertRedactedCorpus,
  exportCorpus,
  projectJourney,
  redactCorpus,
} from "../../../scripts/export-anon-corpus";

it("masks unknown keys, opaque strings and numbers while preserving aliases, lengths and absence", () => {
  const id = "private-repo";
  const secret = "Alice 😀 /home/alice email@private.example 192.168.1.7 bearer-token";
  const input = {
    workspaces: [
      {
        metadata: {
          id,
          name: id,
          attention: { unread: 3 },
          cwd: "C:\\Users\\Alice\\secret",
          archivedAt: 1234,
          agents: [{ workspaceId: id, nested: { [secret]: [null, true, 12_345, secret] } }],
        },
        messages: [{ content: `row 1\r\n${secret}`, kind: "user", status: "done" }],
      },
    ],
    telemetry: [{ ts: 1234, action: "workspace.switch", tab_run_id: "0123456789abcdef" }],
  };
  const output = redactCorpus(input);
  const [{ metadata, messages }] = output.workspaces;
  expect(redactCorpus(input)).toEqual(output);
  expect(metadata.id).toBe(metadata.name);
  expect(metadata.id).toHaveLength(id.length);
  expect(metadata.cwd).toHaveLength(input.workspaces[0].metadata.cwd.length);
  const [agent] = metadata.agents as [{ workspaceId: string }];
  expect(agent.workspaceId).toBe(metadata.id);
  const opaque = Object.entries(agent).find(([key]) => key !== "workspaceId")!;
  expect(opaque[0]).toHaveLength("nested".length);
  const [privateKey, values] = Object.entries(opaque[1])[0];
  expect(privateKey).toHaveLength(secret.length);
  expect(values).toEqual([null, true, 0, expect.any(String)]);
  expect(values[3]).toHaveLength(secret.length);
  expect(metadata.attention).toEqual({ unread: 3 });
  expect(metadata.archivedAt).toBe(1234);
  expect(messages[0]).toMatchObject({ kind: "user", status: "done" });
  expect(messages[0].content).toHaveLength(input.workspaces[0].messages[0].content.length);
  expect(messages[0].content).toEqual(expect.stringContaining("\r\n"));
  expect(output.telemetry[0]).toMatchObject({ ts: 1234, action: "workspace.switch" });
  expect(JSON.stringify(output)).not.toMatch(
    /Alice|alice|private|bearer|192\.168|0123456789|12345/,
  );
});

it("does not trust public field names inside an opaque payload", () => {
  const output = redactCorpus({
    workspaces: [{ metadata: { data: { timestamp: 123_456_789, status: "done" } }, messages: [] }],
    telemetry: [],
  });
  expect(JSON.stringify(output)).not.toMatch(/123456789|timestamp|status|done/);
  expect(() => assertRedactedCorpus({ data: { timestamp: 123_456_789 } })).toThrow(
    /unredacted object key/,
  );
});

it.each([
  { arbitrary: "~~~" },
  { content: "opaque-base64-XEyfU" },
  { action: "Alice's chat" },
  { id: "an-absolute/path" },
  { content: 12345 },
  { events: [undefined] },
])("rejects unredacted serialized shapes", (leak) => {
  expect(() => assertRedactedCorpus({ messages: [leak] })).toThrow(/Corpus contains/);
});

it("reads cache and SQLite rows without rewriting them and validates the committed slice", () => {
  const base = mkdtempSync(join(tmpdir(), "yaat 语料-"));
  try {
    const cache = join(base, ".agent-team", "cache");
    mkdirSync(join(cache, "workspaces"), { recursive: true });
    writeFileSync(join(cache, "index.json"), '{"workspaceIds":["ws-secret"]}');
    const metadataFile = join(cache, "workspaces", "ws-secret.json");
    const metadata = '{"id":"ws-secret","agents":[],"attention":{},"createdAt":5}';
    writeFileSync(metadataFile, metadata);
    using history = new DatabaseSync(join(cache, "history.db"));
    history.exec("CREATE TABLE messages (session, seq, body)");
    history
      .prepare("INSERT INTO messages VALUES (?, ?, ?)")
      .run("ws-secret", 0, '{"content":"private prompt","kind":"agent"}');
    using telemetry = new DatabaseSync(join(base, "telemetry.db"));
    telemetry.exec(`CREATE TABLE ui_events (id, ts, tab_run_id, layout, action, outcome);
      INSERT INTO ui_events VALUES (1, 10, 'tab-secret', 'wide', 'workspace.switch', 'trigger'),
        (2, 20, 'tab-secret', 'wide', 'chat.send', 'trigger'),
        (3, 30, 'tab-secret', 'wide', 'chat.quote_jump', 'trigger'),
        (4, 40, 'tab-secret', 'wide', 'chat.history_page', 'trigger'),
        (5, 50, 'tab-secret', 'wide', 'chat.diagram_preview', 'trigger'),
        (6, 60, 'different-secret', 'wide', 'chat.send', 'trigger');`);
    const output = exportCorpus(base, [0], [[0, 0]]);
    expect(output).not.toContain("secret");
    expect(JSON.parse(output)).toMatchObject({
      workspaces: [{ metadata: { attention: {}, createdAt: 5 }, messages: [{ kind: "agent" }] }],
      telemetry: [
        { ts: 10, action: "workspace.switch" },
        { ts: 20, action: "chat.send" },
        { ts: 30, action: "chat.quote_jump" },
        { ts: 40, action: "chat.history_page" },
        { ts: 50, action: "chat.diagram_preview" },
      ],
    });
    const journey = projectJourney(JSON.parse(output) as AnonCorpus);
    expect(journey).toEqual({
      actions: [
        "workspace.switch",
        "chat.send",
        "chat.quote_jump",
        "chat.history_page",
        "chat.diagram_preview",
      ],
      history: [["agent"]],
    });
    assertJourneyCorpus(JSON.parse(JSON.stringify(journey)));
    expect(readFileSync(metadataFile, "utf8")).toBe(metadata);
    expect(() => exportCorpus(base, [0], [[0, 9]])).toThrow("Selected message missing");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const fixture: unknown = JSON.parse(
    readFileSync(new URL("../corpus/anon-pilot.jsonl", import.meta.url), "utf8"),
  );
  expect(() => assertRedactedCorpus(fixture)).not.toThrow();
});

it("allows only ordered action and row enums in the published journey", () => {
  const jsonl = readFileSync(new URL("../corpus/anon-journey.jsonl", import.meta.url), "utf8");
  const fixture: unknown = JSON.parse(jsonl);
  assertJourneyCorpus(fixture);
  // Reject extra serialized material, including duplicate keys ignored by JSON.parse.
  expect(jsonl).toBe(JSON.stringify(fixture) + "\n");
  expect(fixture.actions).toHaveLength(31);
  expect(fixture.history.map((rows) => rows.length)).toEqual([5, 3, 3]);
  for (const leak of [
    { ...fixture, timestamp: 1790000000000 },
    { ...fixture, tab_run_id: "\uE100\uE100" },
    { ...fixture, history: [[{ user: "operator@example.test /private secret" }]] },
    { ...fixture, history: [["private reply"]] },
    { ...fixture, actions: ["chat.send", "private prompt"] },
    { ...fixture, actions: [{ "chat.send": 42 }] },
  ]) {
    expect(() => assertJourneyCorpus(leak)).toThrow("Invalid journey corpus");
  }
});
