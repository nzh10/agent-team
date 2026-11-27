import { createContext, useLayoutEffect, useMemo, type ReactNode } from "react";
import type { DiagramLanguage, DiagramTheme } from "./DiagramPreview";

const KIB = 1024;
const MAX_ENTRIES = 4;
const MAX_BYTES = 128 * KIB;
const MAX_ENTRY = 64 * KIB;
const MAX_BOX_BYTES = 8 * KIB;
// Old workspace jobs may finish after a switch; they still occupy a slot.
const MAX_RENDERING = 4;
let rendering = 0;

type Request = { source: string; language: DiagramLanguage; theme: DiagramTheme };
export type DiagramAnswer = { svg: string } | { error: string };
export type DiagramBox = { width: number; height: number };
type Receiver = (answer: DiagramAnswer) => void;

function intrinsicBox(svg: string): DiagramBox | undefined {
  // Read only the root of the already sanitized SVG. The preview does not
  // scale the drawing to the column, so these dimensions also work after a resize.
  const opening = svg.slice(0, svg.indexOf(">"));
  const width = Number(opening.match(/\swidth="(\d+(?:\.\d+)?)"/)?.[1]);
  const height = Number(opening.match(/\sheight="(\d+(?:\.\d+)?)"/)?.[1]);
  if (width > 0 && height > 0 && Number.isFinite(width + height)) return { width, height };
}

function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() || "Unknown rendering error"
  ).slice(0, 180);
}

function touch<T>(map: Map<string, T>, key: string) {
  const entry = map.get(key);
  if (entry !== undefined) {
    map.delete(key);
    map.set(key, entry);
  }
}

export class DiagramCache {
  private readonly entries = new Map<string, { value: string; bytes: number }>();
  private readonly boxes = new Map<string, { value: DiagramBox; bytes: number }>();
  private readonly pending = new Map<string, Set<Receiver>>();
  private entryBytes = 0;
  private boxBytes = 0;

  peek(key: string) {
    return this.entries.get(key)?.value;
  }

  box(key: string) {
    return this.boxes.get(key)?.value;
  }

  touch(key: string) {
    touch(this.entries, key);
    touch(this.boxes, key);
  }

  private store(key: string, source: string, svg: string) {
    const box = intrinsicBox(svg);
    const boxBytes = 2 * key.length + 128;
    if (box && boxBytes <= MAX_BOX_BYTES) {
      this.boxBytes -= this.boxes.get(key)?.bytes ?? 0;
      this.boxes.delete(key);
      this.boxes.set(key, { value: box, bytes: boxBytes });
      this.boxBytes += boxBytes;
      while (this.boxes.size > 2 * MAX_ENTRIES || this.boxBytes > MAX_BOX_BYTES) {
        const first = this.boxes.keys().next().value!;
        this.boxBytes -= this.boxes.get(first)!.bytes;
        this.boxes.delete(first);
      }
    }
    const bytes = 2 * (key.length + source.length + svg.length) + 128;
    if (bytes <= MAX_ENTRY) {
      this.entryBytes -= this.entries.get(key)?.bytes ?? 0;
      this.entries.delete(key);
      this.entries.set(key, { value: svg, bytes });
      this.entryBytes += bytes;
    }
    while (this.entries.size > MAX_ENTRIES || this.entryBytes + this.boxBytes > MAX_BYTES) {
      const first = this.entries.keys().next().value!;
      this.entryBytes -= this.entries.get(first)!.bytes;
      this.entries.delete(first);
    }
  }

  request(key: string, { source, language, theme }: Request, receive: Receiver) {
    let listeners = this.pending.get(key);
    if (!listeners) {
      if (rendering >= MAX_RENDERING) {
        receive({ error: "Too many diagrams are rendering. Try again." });
        return () => {};
      }
      const job = new Set<Receiver>();
      listeners = job;
      this.pending.set(key, job);
      rendering++;
      const finish = (answer: DiagramAnswer) => {
        rendering--;
        if (this.pending.get(key) !== job) return;
        this.pending.delete(key);
        if ("svg" in answer) this.store(key, source, answer.svg);
        for (const notify of job) notify(answer);
        job.clear();
      };
      void import("./diagramRender")
        .then(({ renderDiagram }) => renderDiagram(source, language, theme))
        .then(
          (svg) => finish({ svg }),
          (error: unknown) => finish({ error: reason(error) }),
        );
    }
    listeners.add(receive);
    return () => {
      listeners.delete(receive);
    };
  }

  abandon(key: string) {
    this.pending.get(key)?.clear();
    this.pending.delete(key);
  }

  clear() {
    for (const key of this.pending.keys()) this.abandon(key);
    this.entries.clear();
    this.boxes.clear();
    this.entryBytes = this.boxBytes = 0;
  }
}

export const DiagramCacheContext = createContext<DiagramCache | null>(null);

export function DiagramCacheScope({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cache = useMemo(() => new DiagramCache(), [workspaceId]);
  useLayoutEffect(() => () => cache.clear(), [cache]);
  return <DiagramCacheContext value={cache}>{children}</DiagramCacheContext>;
}
