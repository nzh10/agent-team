import type { Message } from "../state/useServer";

// Leave room inside the 45-row DOM budget for focus, a selection's endpoints,
// and the synthetic Starting row attached to a pending input.
export const WINDOW_ROWS = 40;
export const WINDOW_OVERSCAN = 360;

export interface TranscriptRange {
  start: number;
  end: number;
}

export interface TranscriptGeometry {
  ids: string[];
  offsets: number[];
  indexById: Map<string, number>;
}

export function transcriptGeometry(
  messages: readonly Message[],
  width: number,
  measured: WeakMap<Message, { width: number; height: number }>,
): TranscriptGeometry {
  const ids: string[] = [];
  const offsets = [0];
  const indexById = new Map<string, number>();
  const columns = Math.max(24, Math.floor((width - 76) / 8));
  for (const [i, msg] of messages.entries()) {
    const id = `msg-${msg.id}`;
    ids.push(id);
    indexById.set(id, i);
    const cached = measured.get(msg);
    // Use an estimate only for unmounted rows. Message identity is the
    // revision: replacing a summary, streaming, or editing invalidates it.
    const height =
      cached?.width === width
        ? cached.height
        : 42 +
          Math.ceil(msg.content.length / columns) * 18 +
          Math.min(msg.events?.length ?? 0, 12) * 8 +
          (msg.images?.length ? 180 : 0);
    offsets.push(offsets[i] + height);
  }
  return { ids, offsets, indexById };
}

export function rowAt(offsets: readonly number[], top: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const i = (low + high) >>> 1;
    if (offsets[i + 1] <= top) low = i + 1;
    else high = i;
  }
  return low;
}

export function transcriptRange(
  offsets: number[],
  height: number,
  anchor?: number,
): TranscriptRange {
  const count = offsets.length - 1;
  if (count <= WINDOW_ROWS) return { start: 0, end: count };
  if (anchor === undefined) {
    const top = offsets[count] - height - 2 * WINDOW_OVERSCAN;
    return { start: Math.max(rowAt(offsets, top), count - WINDOW_ROWS), end: count };
  }
  const top = offsets[anchor];
  const start = Math.max(rowAt(offsets, top - 2 * WINDOW_OVERSCAN), anchor - 15);
  return {
    start,
    end: Math.min(start + WINDOW_ROWS, rowAt(offsets, top + height + 2 * WINDOW_OVERSCAN) + 1),
  };
}
