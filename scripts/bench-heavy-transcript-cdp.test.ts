import assert from "node:assert/strict";
import { test } from "node:test";
import { heapRetainers } from "./bench-heavy-transcript-cdp";

void test("counts distinct array versions but excludes weak and shared payloads", () => {
  const labels = "root object bench-ws-1 array payload id messages messagesLoaded agents";
  const strings = labels.split(" ");
  const work = (array: number) => [0, 5, 3, 0, 6, array, 0, 7, 3, 0, 8, 3];
  // Each edge triplet holds type, name/index and destination node ordinal.
  const refs = [
    [3, 0, 1, 3, 0, 2, 3, 0, 7], // root owns both workspace versions and shared payload
    work(4),
    work(5),
    [],
    [1, 0, 6, 1, 1, 7],
    [1, 0, 7],
    [2, 4, 8], // private payload has only a weak reference to node 8
    [],
    [],
  ];
  const names = [0, 1, 1, 2, 3, 3, 4, 4, 4];
  const sizes = [0, 0, 0, 0, 1, 1, 2, 4, 8];
  const meta: Parameters<typeof heapRetainers>[0]["snapshot"]["meta"] = {
    node_fields: ["type", "name", "self_size", "edge_count"],
    node_types: [["object", "string"]],
    edge_fields: ["type", "name_or_index", "to_node"],
    edge_types: [["property", "element", "weak", "internal"]],
  };
  const MiB = 2 ** 20;
  const nodes = names.flatMap((n, i) => [+(n === 2), n, sizes[i] * MiB, refs[i].length / 3]);
  const edges = refs.flat().map((value, i) => (i % 3 === 2 ? value * 4 : value));
  const heap = { snapshot: { node_count: refs.length, meta }, nodes, edges, strings };
  const result = heapRetainers(heap, "bench-ws-0");
  assert.equal(result.snapshotMiB, 16);
  assert.deepEqual(result.workspaceVersions, { arrayInstances: 2, maxArraysPerWorkspace: 2 });
  const { activeMessages, inactiveWorkspaces, inactiveMessages } = result.transcriptArrays;
  assert.deepEqual([activeMessages, inactiveWorkspaces, inactiveMessages], [0, 1, 2]);
  const retained = Object.fromEntries(result.retainers.map(({ category, mib }) => [category, mib]));
  assert.equal(retained["Inactive messages[]"], 4);
  assert.equal(retained["Unclassified/shared"], 4);
  assert.equal(retained["Weak-only/unreachable"], 8);
});
