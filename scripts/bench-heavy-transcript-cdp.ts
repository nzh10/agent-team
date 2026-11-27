import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SourceMap } from "node:module";
import { basename, join } from "node:path";
import type { CDPSession } from "playwright";

const stopProfiler = (cdp: CDPSession) => cdp.send("Profiler.stop");
type Profile = Awaited<ReturnType<typeof stopProfiler>>["profile"];
type CallFrame = Profile["nodes"][number]["callFrame"];

const mib = (bytes: number) => +(bytes / 1024 ** 2).toFixed(2);
const ms = (us: number) => +(us / 1000).toFixed(2);

type TraceEvent = {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
};

type Category =
  "react" | "markdown" | "highlight" | "katex" | "mermaid" | "graphviz" | "app" | "otherJs";
function classifySource(source: string): Category {
  const p = source.replaceAll("\\", "/");
  if (
    /\/(?:katex|rehype-katex|remark-math|micromark-extension-math|mdast-util-math)\/|\/mathPlugins\.ts$/.test(
      p,
    )
  )
    return "katex";
  if (/\/(?:mermaid|@mermaid-js|dagre-d3-es|cytoscape)\/|\/mermaidRenderer\.ts$/.test(p))
    return "mermaid";
  if (/\/(@viz-js|graphvizRenderer\.ts)/.test(p)) return "graphviz";
  if (/\/(?:highlight\.js|lowlight)\/|\/highlight\.ts$/.test(p)) return "highlight";
  if (/\/(?:react(?:-dom)?|scheduler)\//.test(p)) return "react";
  if (
    /\/node_modules\/(?:remark[^/]*|rehype[^/]*|micromark[^/]*|mdast[^/]*|hast[^/]*|unified|react-markdown|parse5|unist[^/]*)\/|\/chat\/(?:markdown\.tsx|mdSource\.ts)$/.test(
      p,
    )
  )
    return "markdown";
  return /\/src\//.test(p) && !p.includes("/node_modules/") ? "app" : "otherJs";
}

export class CpuSources {
  private maps = new Map<string, SourceMap | null>();
  constructor(private webDir: string) {}

  source(frame: CallFrame): string {
    if (!frame.url.startsWith("http")) return "";
    const file = basename(new URL(frame.url).pathname);
    if (!this.maps.has(file)) {
      try {
        this.maps.set(
          file,
          new SourceMap(
            JSON.parse(
              readFileSync(join(this.webDir, "assets", `${file}.map`), "utf8"),
            ) as ConstructorParameters<typeof SourceMap>[0],
          ),
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        this.maps.set(file, null);
      }
    }
    const mapped = this.maps.get(file)?.findEntry(frame.lineNumber, frame.columnNumber);
    return mapped && "originalSource" in mapped ? mapped.originalSource : "";
  }
}

function traced(events: TraceEvent[]) {
  const start =
    events.find((e) => e.name === "bench-heavy-start" && e.ph === "I") ??
    events.find((e) => e.name === "bench-heavy-start");
  const end = events.find((e) => e.name === "bench-heavy-end" && e.ts >= (start?.ts ?? Infinity));
  assert(start && end, "Chromium trace lacks the input and render marks");
  const main = events.filter((e) => e.pid === start.pid && e.tid === start.tid);
  function overlap(e: TraceEvent) {
    const from = Math.max(e.ts, start!.ts);
    const to = Math.min(e.ts + (e.dur ?? 0), end!.ts);
    return to > from ? ([from, to] as const) : null;
  }
  const kinds: Record<string, "style" | "layout" | "paint"> = {
    UpdateLayoutTree: "style",
    RecalculateStyles: "style",
    Layout: "layout",
    PrePaint: "paint",
    Paint: "paint",
    Layerize: "paint",
    CompositeLayers: "paint",
  };
  const intervals = main.flatMap((e) => {
    const kind = kinds[e.name];
    const range = kind && overlap(e);
    return range ? [{ from: range[0], to: range[1], kind }] : [];
  });
  // Chrome emits nested scopes (e.g. Layout under UpdateLayoutTree). Charge
  // each instant once to the innermost scope, not to both parent and child.
  const boundaries = [...new Set(intervals.flatMap(({ from, to }) => [from, to]))].sort(
    (a, b) => a - b,
  );
  const totals = { style: 0, layout: 0, paint: 0 };
  for (let i = 1; i < boundaries.length; i++) {
    const a = boundaries[i - 1],
      b = boundaries[i];
    let inner: (typeof intervals)[number] | undefined;
    for (const scope of intervals) {
      if (
        scope.from <= a &&
        scope.to >= b &&
        (!inner || scope.to - scope.from < inner.to - inner.from)
      )
        inner = scope;
    }
    if (inner) totals[inner.kind] += b - a;
  }
  const tasks = main.filter(
    (e) => e.name === "RunTask" && e.ph === "X" && e.dur! >= 50_000 && overlap(e),
  );
  const frames = events.filter(
    (e) => e.pid === start.pid && e.name === "DrawFrame" && e.ts >= start.ts && e.ts <= end.ts,
  );
  return {
    startUs: start.ts,
    endUs: end.ts,
    inputToReadyMs: ms(end.ts - start.ts),
    styleMs: ms(totals.style),
    layoutMs: ms(totals.layout),
    paintMs: ms(totals.paint),
    framesMs: [...new Set(frames.map((e) => ms(e.ts - start.ts)))].sort((a, b) => a - b),
    traceLongTasks: tasks.map((e) => ({ atMs: ms(e.ts - start.ts), durationMs: ms(e.dur!) })),
  };
}

function cpuTimes(profile: Profile, sources: CpuSources, start: number, end: number) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map(
    profile.nodes.flatMap((n) => (n.children ?? []).map((id) => [id, n.id] as const)),
  );
  const mapped = new Map(profile.nodes.map((n) => [n.id, sources.source(n.callFrame)]));
  const categories = new Map([...mapped].map(([id, file]) => [id, classifySource(file)]));
  const appFiles = new Map<string, number>();
  const totals: Record<Category | "idle" | "gc" | "native", number> = {
    react: 0,
    markdown: 0,
    highlight: 0,
    katex: 0,
    mermaid: 0,
    graphviz: 0,
    app: 0,
    otherJs: 0,
    idle: 0,
    gc: 0,
    native: 0,
  };
  let time = profile.startTime;
  for (const [i, id] of (profile.samples ?? []).entries()) {
    const next = time + (profile.timeDeltas?.[i] ?? 0);
    const duration = Math.min(next, end) - Math.max(time, start);
    time = next;
    if (duration <= 0) continue;
    const name = byId.get(id)?.callFrame.functionName;
    if (name === "(idle)" || name === "(garbage collector)" || name === "(program)") {
      totals[name === "(idle)" ? "idle" : name === "(program)" ? "native" : "gc"] += duration;
      continue;
    }
    // Prefer deepest mapped source; attribute primitives (regex, timers,
    // etc.) to their closest identifiable caller. Buckets are exclusive.
    let frame: number | undefined = id;
    while (frame !== undefined && categories.get(frame) === "otherJs") frame = parent.get(frame);
    const category = (frame !== undefined && categories.get(frame)) || "otherJs";
    totals[category] += duration;
    if (category === "app") {
      const file = basename(mapped.get(frame!)!);
      appFiles.set(file, (appFiles.get(file) ?? 0) + duration);
    }
  }
  assert(
    end > profile.startTime && start < profile.endTime,
    "CPU and Trace clocks did not overlap",
  );
  return {
    cpuMs: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, ms(v)])),
    appCpuTopMs: Object.fromEntries(
      [...appFiles]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, v]) => [k, ms(v)]),
    ),
  };
}

export async function profileSwitch(
  cdp: CDPSession,
  sources: CpuSources,
  run: () => Promise<void>,
) {
  const events: TraceEvent[] = [];
  const receive = ({ value }: { value: object[] }) => events.push(...(value as TraceEvent[]));
  cdp.on("Tracing.dataCollected", receive);
  const complete = new Promise<void>((resolve) =>
    cdp.once("Tracing.tracingComplete", () => resolve()),
  );
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
  await cdp.send("Tracing.start", {
    categories:
      "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing,toplevel",
    transferMode: "ReportEvents",
  });
  await cdp.send("Profiler.start");
  let profile: Profile;
  try {
    await run();
  } finally {
    try {
      ({ profile } = await stopProfiler(cdp));
      await cdp.send("Tracing.end");
      await complete;
    } finally {
      cdp.off("Tracing.dataCollected", receive);
      await cdp.send("Profiler.disable");
    }
  }
  const { startUs, endUs, ...timeline } = traced(events);
  return { ...timeline, ...cpuTimes(profile, sources, startUs, endUs) };
}

export async function stopAllocationSample(cdp: CDPSession, sources: CpuSources) {
  const { profile } = await cdp.send("HeapProfiler.stopSampling");
  const queue = [{ node: profile.head, fallback: "otherJs" as Category }];
  const totals = new Map<Category, number>();
  while (queue.length) {
    const { node, fallback } = queue.pop()!;
    const own = classifySource(sources.source(node.callFrame));
    const category = own === "otherJs" ? fallback : own;
    if (node.selfSize > 0) totals.set(category, (totals.get(category) ?? 0) + node.selfSize);
    for (const child of node.children) queue.push({ node: child, fallback: category });
  }
  return Object.fromEntries(
    [...totals].sort((a, b) => b[1] - a[1]).map(([k, bytes]) => [k, mib(bytes)]),
  );
}

export async function memory(cdp: CDPSession) {
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const values = new Map(metrics.map(({ name, value }) => [name, value]));
  const get = (name: string) => {
    const value = values.get(name);
    assert(value !== undefined, `Chromium did not report ${name}`);
    return value;
  };
  return {
    heapUsedMiB: mib(get("JSHeapUsedSize")),
    heapTotalMiB: mib(get("JSHeapTotalSize")),
    nodes: get("Nodes"),
    listeners: get("JSEventListeners"),
  };
}

type Heap = {
  snapshot: {
    node_count: number;
    meta: {
      node_fields: string[];
      node_types: [string[]];
      edge_fields: string[];
      edge_types: [string[]];
    };
  };
  nodes: number[];
  edges: number[];
  strings: string[];
};

const nativeProbeNames = [
  "AXDirtyObject",
  "AXNodeObject",
  "AXInlineTextBox",
  "AXObjectCacheImpl",
  "FontResource",
  "CSSFontFaceSrcValue",
  "CSSUnicodeRangeValue",
  "ShapeResultRun",
] as const;
type NativeProbeName = (typeof nativeProbeNames)[number];
function nativeProbeName(label: string): NativeProbeName | undefined {
  if (!label.startsWith("blink::")) return;
  const last = label.slice(label.lastIndexOf("::") + 2);
  return (nativeProbeNames as readonly string[]).includes(last)
    ? (last as NativeProbeName)
    : undefined;
}

function nativeCounters(heap: Heap) {
  const {
    nodes,
    strings,
    snapshot: { meta },
  } = heap;
  const fields = meta.node_fields;
  const type = fields.indexOf("type"),
    name = fields.indexOf("name"),
    size = fields.indexOf("self_size");
  const native = meta.node_types[0].indexOf("native");
  const counts = new Map(nativeProbeNames.map((key) => [key, { objects: 0, bytes: 0 }]));
  for (let i = 0; i < nodes.length; i += fields.length) {
    if (native < 0 || nodes[i + type] !== native) continue;
    const key = nativeProbeName(strings[nodes[i + name]]);
    if (!key) continue;
    const counter = counts.get(key)!;
    counter.objects++;
    counter.bytes += nodes[i + size];
  }
  return Object.fromEntries(
    [...counts].map(([key, { objects, bytes }]) => [key, { objects, mib: mib(bytes) }]),
  );
}

// Attribute each node's shallow bytes once using its nearest identifiable
// dominator, not the paths of arbitrary shortest retainers (which can share
// objects). Native totals cover only bytes represented in this V8 snapshot.
// Weak V8 edges are not owning references, including artificial WeakMap
// key->value and table->value ephemeron annotations.
export function heapRetainers(heap: Heap, activeId: string) {
  const {
    nodes,
    edges,
    strings,
    snapshot: { meta, node_count: count },
  } = heap;
  const nf = meta.node_fields,
    ef = meta.edge_fields;
  const nodeType = nf.indexOf("type"),
    nodeName = nf.indexOf("name"),
    size = nf.indexOf("self_size");
  const detached = nf.indexOf("detachedness"),
    edgeCount = nf.indexOf("edge_count");
  const type = ef.indexOf("type"),
    name = ef.indexOf("name_or_index"),
    dest = ef.indexOf("to_node");
  const [nodeTypes] = meta.node_types,
    [edgeTypes] = meta.edge_types;
  assert([nodeType, nodeName, size, edgeCount, type, name, dest].every((n) => n >= 0));
  assert.equal(nodes.length, count * nf.length);
  const weak = edgeTypes.indexOf("weak"),
    internal = edgeTypes.indexOf("internal");
  const property = edgeTypes.indexOf("property");
  assert(weak >= 0 && property >= 0 && internal >= 0);
  const begin = new Uint32Array(count + 1);
  const reverse = new Uint32Array(count + 1);
  const anchors = new Map<number, string>();
  const workspaceVersions = new Map<string, Map<number, number>>();
  const target = (edge: number) => edges[edge + dest] / nf.length;
  const label = (node: number) => strings[nodes[node * nf.length + nodeName]];
  const strong = (i: number) =>
    edges[i + type] !== weak &&
    !(edges[i + type] === internal && strings[edges[i + name]]?.includes("part of key"));
  for (let n = 0, e = 0; n < count; n++) {
    begin[n] = e;
    e += nodes[n * nf.length + edgeCount] * ef.length;
  }
  begin[count] = edges.length;
  for (let n = 0; n < count; n++) {
    const node = n * nf.length;
    const kind = nodeTypes[nodes[node + nodeType]];
    const title = label(n);
    if (kind === "native") {
      const status = detached >= 0 ? nodes[node + detached] : 0;
      const probeName = nativeProbeName(title);
      if (probeName?.startsWith("AX")) {
        anchors.set(n, "Blink accessibility (AX)");
      } else if (probeName) {
        anchors.set(n, "Blink font/shaping");
      } else if (title.includes("AXDirtyObject") && title.includes("HeapVectorBacking")) {
        anchors.set(n, "Blink accessibility (AX)");
      } else if (status === 2 || title.startsWith("Detached ")) {
        anchors.set(n, "Detached DOM (native)");
      } else if (
        status === 1 ||
        /^(?:blink::)?(?:(?:HTML|SVG|MathML)\w*Element|Text|Comment|Document|ShadowRoot|DocumentFragment|Attr|Element|Node)$/.test(
          title,
        )
      ) {
        anchors.set(n, "Attached DOM (native)");
      } else if (!/^system \/ (?:ExternalString|JSArrayBuffer)Data$/.test(title)) {
        // Let a backing store inherit ownership from the string/buffer that
        // dominates it. Its shallow bytes also appear in nativeShallowTop.
        anchors.set(n, "Other native (Blink/V8)");
      }
    }
    let props: Map<string, number> | undefined;
    for (let e = begin[n]; e < begin[n + 1]; e += ef.length) {
      if (strong(e)) reverse[target(e) + 1]++;
      if (kind === "object" && edges[e + type] === property) {
        (props ??= new Map()).set(strings[edges[e + name]], target(e));
      }
    }
    if (!props) continue;
    const msgs = props.get("messages"),
      id = props.get("id");
    if (
      msgs !== undefined &&
      id !== undefined &&
      /^bench-ws-\d+$/.test(label(id)) &&
      props.has("messagesLoaded") &&
      props.has("agents")
    ) {
      let length = 0;
      const element = edgeTypes.indexOf("element");
      for (let e = begin[msgs]; e < begin[msgs + 1]; e += ef.length)
        if (edges[e + type] === element) length++;
      if (length > 0) {
        const ws = label(id);
        anchors.set(msgs, ws === activeId ? "Active messages[]" : "Inactive messages[]");
        let versions = workspaceVersions.get(ws);
        if (!versions) workspaceVersions.set(ws, (versions = new Map<number, number>()));
        versions.set(msgs, length);
      }
    } else if (
      ["stateNode", "memoizedProps", "memoizedState", "return", "alternate"].every((k) =>
        props.has(k),
      )
    ) {
      anchors.set(n, "React Fibers/owned JS");
    } else if (props.has("parts") && props.has("folded")) {
      anchors.set(n, "Subagent folded event values");
    } else if (
      props.has("matcher") &&
      (props.has("keywordPatternRe") || props.has("terminatorEnd"))
    ) {
      anchors.set(n, "Highlight compiled grammars");
    } else if (props.has("remark") && props.has("rehype") && props.size <= 3) {
      anchors.set(n, "Markdown/math plugin config");
    }
  }
  for (let i = 1; i < reverse.length; i++) reverse[i] += reverse[i - 1];
  const predecessors = new Uint32Array(reverse[count]);
  const cursors = reverse.slice();
  for (let n = 0; n < count; n++) {
    for (let e = begin[n]; e < begin[n + 1]; e += ef.length)
      if (strong(e)) predecessors[cursors[target(e)]++] = n;
  }

  // Iterative DFS postorder, then Cooper-style immediate dominators in
  // reverse postorder. The graph has one synthetic GC root (node zero).
  const order = new Uint32Array(count),
    rank = new Int32Array(count).fill(-1);
  const stack = new Uint32Array(count);
  let depth = 1,
    post = count;
  rank[0] = 0;
  for (let i = 0; i < count; i++) cursors[i] = begin[i];
  while (depth) {
    const n = stack[depth - 1];
    if (cursors[n] >= begin[n + 1]) {
      order[--post] = n;
      depth--;
      continue;
    }
    const e = cursors[n];
    cursors[n] += ef.length;
    const to = target(e);
    if (!strong(e) || rank[to] >= 0) continue;
    rank[to] = 0;
    stack[depth++] = to;
  }
  for (let i = post; i < count; i++) rank[order[i]] = i;
  const dom = new Int32Array(count).fill(-1);
  dom[0] = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = post + 1; i < count; i++) {
      const n = order[i];
      let d = -1;
      for (let j = reverse[n]; j < reverse[n + 1]; j++) {
        let a = predecessors[j];
        if (dom[a] === -1) continue;
        if (d === -1) {
          d = a;
          continue;
        }
        while (d !== a) {
          if (rank[d] > rank[a]) d = dom[d];
          else a = dom[a];
        }
      }
      if (dom[n] !== d) {
        dom[n] = d;
        changed = true;
      }
    }
  }
  const categories = new Map<string, { bytes: number; objects: number }>();
  const nativeNames = new Map<string, number>();
  const owner = new Uint32Array(count);
  const labels = ["Unclassified/shared", "Weak-only/unreachable"];
  const ids = new Map(labels.map((k, i) => [k, i]));
  let total = 0;
  for (const [n, k] of anchors) {
    if (!ids.has(k)) {
      ids.set(k, labels.length);
      labels.push(k);
    }
    owner[n] = ids.get(k)!;
  }
  for (let i = post + 1; i < count; i++) {
    const n = order[i];
    owner[n] ||= owner[dom[n]];
  }
  for (let n = 0; n < count; n++) {
    const k = labels[rank[n] < 0 ? 1 : owner[n]];
    const row = categories.get(k) ?? { bytes: 0, objects: 0 };
    const bytes = nodes[n * nf.length + size];
    if (nodeTypes[nodes[n * nf.length + nodeType]] === "native") {
      const title = label(n);
      nativeNames.set(title, (nativeNames.get(title) ?? 0) + bytes);
    }
    row.bytes += bytes;
    row.objects++;
    total += bytes;
    categories.set(k, row);
  }
  const workspaces = [...workspaceVersions].flatMap(([ws, arrays]) => {
    const lengths = [...arrays].filter(([index]) => rank[index] >= 0).map(([, length]) => length);
    return lengths.length
      ? [{ active: ws === activeId, messages: Math.max(...lengths), versions: lengths.length }]
      : [];
  });
  return {
    snapshotMiB: mib(total),
    nodes: count,
    nativeCounters: nativeCounters(heap),
    nativeShallowTop: [...nativeNames]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, bytes]) => ({
        name,
        mib: mib(bytes),
        pct: +((100 * bytes) / total).toFixed(2),
      })),
    workspaceVersions: {
      arrayInstances: workspaces.reduce((n, w) => n + w.versions, 0),
      maxArraysPerWorkspace: workspaces.reduce((n, w) => Math.max(n, w.versions), 0),
    },
    transcriptArrays: {
      activeMessages: workspaces.filter((w) => w.active).reduce((n, w) => n + w.messages, 0),
      inactiveWorkspaces: workspaces.filter((w) => !w.active).length,
      inactiveMessages: workspaces.filter((w) => !w.active).reduce((n, w) => n + w.messages, 0),
    },
    retainers: [...categories]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([category, row]) => ({
        category,
        mib: mib(row.bytes),
        pct: +((100 * row.bytes) / total).toFixed(2),
        objects: row.objects,
      })),
  };
}

async function takeSnapshot(cdp: CDPSession) {
  const chunks: string[] = [];
  const add = ({ chunk }: { chunk: string }) => chunks.push(chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", add);
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot");
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", add);
  }
  const heap = JSON.parse(chunks.join("")) as Heap;
  chunks.length = 0;
  return heap;
}

export async function snapshotNativeCounters(cdp: CDPSession) {
  return nativeCounters(await takeSnapshot(cdp));
}

export async function snapshotRetainers(cdp: CDPSession, activeId: string) {
  return heapRetainers(await takeSnapshot(cdp), activeId);
}
