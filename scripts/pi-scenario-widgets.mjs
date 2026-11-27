import { parseJsonLine, writeJsonl } from "./capture-io.ts";
import path from "node:path";
import { sanitizer } from "./capture-pi.ts";

const launch = "pi-e2e-launch:widgetbusy";
const hold = "pi-e2e-hold-parent";
const inspect = "/subagents-inspect-rpc fixture-request";
const asyncPrefix = "PI_SUBAGENT_ASYNC_JSON:";
const inspectPrefix = "PI_SUBAGENT_INSPECT_JSON:";

// The deterministic scenario may deliver a worker report after the held
// parent settles and before Pi starts the separate native wake.
export function widgetClip(clip, runId) {
  const held = clip.findIndex((r) => r.sent?.message === hold);
  const parentEnd = clip.findIndex(
    ({ frame: f }, i) => i > held && f?.command === "get_session_stats",
  );
  const notice = clip.findIndex(
    ({ frame: f }, i) =>
      i > parentEnd &&
      f?.type === "message_start" &&
      f.message?.customType === "subagent-notify" &&
      f.message.details.runs.some((r) => r.runId === runId),
  );
  const wake = clip.findLastIndex(({ frame: f }, i) => i < notice && f?.type === "agent_start");
  const end = clip.findIndex(({ frame: f }, i) => i > wake && f?.type === "agent_settled");
  if (held < 0 || parentEnd < 0 || wake <= parentEnd || end <= notice)
    throw new Error("Missing native wake or settlement");
  const native = clip.slice(wake, end + 1);
  if (native.some(({ frame: f }) => f?.type === "message_start" && f.message?.role === "user"))
    throw new Error("Native notice arrived in a user turn, not a separate wake");
  // Shutdown can preempt the wake's stats RPC. The recorded settlement is the boundary.
  return [
    ...clip.slice(0, parentEnd + 1),
    ...native.filter(({ sent, frame }) => !sent && frame?.type !== "response"),
  ];
}

// Keep only the gated run (the live widget also lists earlier scenario jobs).
// These payloads are JSON inside a widget line; sanitizing the outer RPC alone
// would either leak the nested data or destroy the protocol under test.
export function extractScenarioWidgets(sessions, snap, versions) {
  const session = sessions.find((rows) => rows.some((r) => r.sent?.message === launch));
  if (!session) throw new Error("No gated parent RPC trace");
  const start = session.findIndex((r) => r.sent?.message === launch);
  const clip = session.slice(start);
  const tool = clip.find(
    ({ frame: f }) => f?.type === "tool_execution_end" && f.toolName === "subagent",
  )?.frame;
  const runId = tool?.result.details.asyncId;
  if (!runId) throw new Error("No gated run launch receipt");
  const slots = new Map([
    [runId, "fixture-run"],
    ["task-1", "child-1"],
    ["task-2", "child-2"],
  ]);
  const clean = sanitizer(slots);
  const rows = [];
  const widgetStates = new Set();
  let parentBusy = false;
  let inspectReply = false;
  let inspectClear = false;
  for (const { at, sent, frame: f } of widgetClip(clip, runId)) {
    const add = (entry) => rows.push({ t: at - clip[0].at, ...entry });
    if (sent?.type === "prompt") {
      const { message } = sent;
      if (
        message !== launch &&
        message !== hold &&
        message !== `${inspect} ${runId} step:0 --lines 2`
      )
        throw new Error("Unexpected prompt in widget capture");
      add({ sent: { type: sent.type, message: message.replace(runId, "fixture-run") } });
      continue;
    }
    if (sent?.type === "get_session_stats") add({ sent: { type: sent.type } });
    if (!f) continue;
    if (f.type === "extension_ui_request" && f.method === "setWidget") {
      const { type, id, method, widgetKey, widgetLines, widgetPlacement } = f;
      const frame = { type, id: clean({ id }).id, method, widgetKey };
      if (widgetPlacement !== undefined) {
        if (!["aboveEditor", "belowEditor"].includes(widgetPlacement))
          throw new Error("Unknown widget placement");
        frame.widgetPlacement = widgetPlacement;
      }
      if (widgetKey === "subagent-async" && widgetLines?.[0]?.startsWith(asyncPrefix)) {
        const payload = parseJsonLine(widgetLines[0].slice(asyncPrefix.length));
        const run = payload.runs.find((r) => r.id === runId);
        if (!run || widgetStates.has(run.state)) continue;
        if (run.state === "complete" && !parentBusy)
          throw new Error("Parent was not busy at native completion");
        widgetStates.add(run.state);
        // The scenario defines all labels, kinds, IDs and model values below.
        function node(n) {
          const {
            id,
            kind,
            label,
            state,
            startedAt,
            updatedAt,
            endedAt,
            children,
            agent,
            model,
            activity,
          } = n;
          if (
            !(
              (id === runId && kind === "workflow") ||
              (/^task-[12]$/.test(id) && kind === "step")
            ) ||
            ![
              "workflow",
              "pi-e2e-child",
              "pi-e2e-child, pi-e2e-child",
              "task-1",
              "task-2",
            ].includes(label) ||
            !["queued", "running", "complete"].includes(state) ||
            (agent !== undefined && agent !== "pi-e2e-child") ||
            (model !== undefined && model !== "pi-e2e/scenario")
          )
            throw new Error("Unreviewed widget node");
          const number = (value) => (Number.isSafeInteger(value) ? value : undefined);
          return {
            id: slots.get(id),
            kind,
            label: slots.get(label) ?? label,
            state,
            startedAt: number(startedAt),
            updatedAt: number(updatedAt),
            endedAt: number(endedAt),
            activity: activity && {
              turnCount: number(activity.turnCount),
              lastActivityAt: number(activity.lastActivityAt),
            },
            agent,
            model,
            children: children?.map(node),
          };
        }
        const { kind, version, generatedAt, caps, omitted } = payload;
        if (
          kind !== "pi-subagents.async-status-snapshot" ||
          version !== 1 ||
          !Number.isSafeInteger(generatedAt) ||
          Object.keys(caps).sort().join() !==
            "maxChildrenPerNode,maxDepth,maxRuns,maxSerializedBytes,maxStringLength" ||
          Object.values(caps).some((v) => !Number.isSafeInteger(v)) ||
          omitted.runs !== 0 ||
          omitted.children !== 0 ||
          omitted.byteLimitExceeded !== false
        )
          throw new Error("Unreviewed async snapshot envelope");
        frame.widgetLines = [
          asyncPrefix +
            JSON.stringify({
              kind,
              version,
              generatedAt,
              caps,
              omitted: { runs: 0, children: 0, byteLimitExceeded: false },
              runs: [node(run)],
            }),
        ];
      } else if (widgetKey === "subagent-inspect" && widgetLines?.[0]?.startsWith(inspectPrefix)) {
        const { kind, version, requestId, asyncId, childId, status, label, task, messages } =
          parseJsonLine(widgetLines[0].slice(inspectPrefix.length));
        if (
          kind !== "pi-subagents.inspect-reply" ||
          version !== 1 ||
          requestId !== "fixture-request" ||
          asyncId !== runId ||
          childId !== "step:0" ||
          status !== "running" ||
          label !== "task-1" ||
          typeof task !== "string" ||
          !Array.isArray(messages) ||
          messages.some((m) => m.role !== "user" || m.kind !== "text" || typeof m.text !== "string")
        )
          throw new Error("Unreviewed inspect reply");
        frame.widgetLines = [
          inspectPrefix +
            JSON.stringify({
              kind,
              version,
              requestId,
              asyncId: "fixture-run",
              childId,
              status,
              label: slots.get(label),
              task: clean({ text: task }).text,
              messages: messages.map(({ role, kind, text }) => ({
                role,
                kind,
                text: clean({ text }).text,
              })),
            }),
        ];
        inspectReply = true;
      } else if (widgetKey === "subagent-inspect" && widgetLines === undefined) inspectClear = true;
      else continue;
      add({ frame });
      continue;
    }
    if (f.type === "message_end" && f.message?.role === "user")
      parentBusy = f.message.content.some((c) => c.text === hold);
    if (f.type === "agent_settled") parentBusy = false;
    if (
      (f.type === "response" && ["prompt", "get_session_stats"].includes(f.command)) ||
      ["agent_start", "agent_end", "agent_settled"].includes(f.type) ||
      (f.type === "message_start" && f.message.customType === "subagent-notify")
    ) {
      const raw = { ...f };
      if (f.type === "response") delete raw.id; // Replay binds the request ID.
      if (f.type === "agent_end") delete raw.messages; // Only the lifecycle marker is needed.
      const frame = clean(raw);
      if (f.type === "response" && f.command === "prompt" && f.data?.disposition === "handled")
        frame.data.disposition = f.data.disposition;
      add({ frame });
    }
  }
  if (
    !["queued", "running", "complete"].every((state) => widgetStates.has(state)) ||
    !inspectReply ||
    !inspectClear
  )
    throw new Error("Incomplete native widget lifecycle");
  const header = {
    backend: "pi",
    fixture: "subagents-widgets",
    source: "Offline pi --mode rpc / installed pi-subagents; deterministic pi-e2e scenario excerpt",
    model: "pi-e2e/scenario",
    ...versions,
    recordedAt: new Date(clip[0].at).toISOString(),
  };
  writeJsonl(path.join(snap, "pi/messages/subagents-widgets.jsonl"), [{ header }, ...rows]);
}
