// @vitest-environment node
import { expect, it } from "vitest";
import type { Message } from "../src/state/useServer";
import { rowAt, transcriptGeometry } from "../src/viewport/transcriptWindow";

it("chooses the next row at its exact boundary and clamps outside the transcript", () => {
  const offsets = [0, 40, 110, 160];
  expect([-1, 0, 39.9, 40, 109.9, 110, 160, 1_000].map((y) => rowAt(offsets, y))).toEqual([
    0, 0, 0, 1, 1, 2, 2, 2,
  ]);
  expect(rowAt([0], 100)).toBe(0);
});

it("uses measured height only for the same row revision at the same width", () => {
  const row: Message = {
    id: "m",
    kind: "agent",
    agentId: "a",
    content: "x".repeat(100),
    timestamp: 0,
    status: "done",
  };
  const measured = new WeakMap([[row, { width: 800, height: 177 }]]);
  const offsets = (message: Message, width: number) =>
    transcriptGeometry([message], width, measured).offsets;
  expect(offsets(row, 800)).toEqual([0, 177]);
  expect(offsets(row, 390)).toEqual([0, 96]);
  expect(offsets({ ...row, content: "new revision" }, 800)).toEqual([0, 60]);
});
