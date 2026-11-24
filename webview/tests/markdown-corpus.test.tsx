import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { InlineMd, loadMath, MdBlock, StreamingMdBlock } from "../src/chat/markdown";
import raw from "./fixtures/markdown-real.json?raw";

const expected: Record<
  string,
  { math?: number; display?: number; del?: number; inline?: boolean; rich?: boolean }
> = {
  "home-paths": { inline: true },
  "multiline-home-paths": {},
  "numeric-range": { inline: true },
  "approximate-seconds": { inline: true },
  "approximate-lines": { inline: true },
  "promql-matchers": { inline: true },
  "key-regex": {},
  "space-regex": {},
  "latency-regex": {},
  "literal-ellipsis": {},
  "strike-example": { del: 1, inline: true },
  "paren-example": { math: 1 },
  "nested-paren-example": { math: 1 },
  "inline-math": { math: 2 },
  "display-cjk": { math: 1, display: 1 },
  "inline-escaped-underscores": { math: 1 },
  "streamed-display": { math: 1, display: 1, rich: true },
};

// An allowlist also catches bare hostnames, project names and user names which
// generic secret patterns cannot distinguish from ordinary prose. Review new
// entries against the redacted excerpts, not by copying a raw transcript.
const approvedWords = new Set(
  `
  B BDP Correction For Key L_1 L_k M Mathematical Mbps N O S Simple Throughput U_k _ _delay _shift
  about agent approx at begin budget cache cases config connect d delay device dist distance end ends
  eth0 eth1 f for frac ge global handle host in interval la lceil le left local log ls max ms n node
  node-a node_network_receive_bytes_total node_network_transmit_bytes_total output payload_cost pre_delay
  qquad queue_delay r rceil regex right round_trip s sample-app-home send_delay sessions sum_k text the
  theta times to total_delay cat current-version gap install is latency model nm node_modules releases
  required sample ver with 两点客观修正 两种 中文 为什么同事会觉得是 二 余量很大 删除线
  协议窗口决定的有效吞吐上限 在宏观上长得几乎一模一样 天花板 实际能力 带宽 带宽问题 或
  波内和单行实测都在 物理链路带宽 触发条件
`
    .trim()
    .split(/\s+/),
);
const approvedNumbers = new Set(
  "0 1 2 3 4 6 10 20 22 51 56 60 70 100 120 210 400 1200 1210".split(" "),
);
const approvedPaths = new Set([
  "~/.config/agent/sessions/",
  "~/.cache/sample-app-home/sessions/",
  "~/.config/sample/install/current-version",
  "~/.config/sample/install/releases/",
]);

function isPublicExcerpt(text: string): boolean {
  const normalized = text.normalize("NFKC");
  if (
    /\/home\/|\/Users\/|[a-z]:\\+Users\\+|(?:\w+:\/\/)|@|data:image\/|(?:\d{1,3}\.){3}\d{1,3}|[\dA-Fa-f]*::[\dA-Fa-f]+/.test(
      normalized,
    )
  )
    return false;
  if (/\b\d{1,2}:\d{2}(?::\d{2})?\b|\b\d{4}-\d{2}-\d{2}\b/.test(normalized)) return false;
  if (/\b(?:[\da-f]{1,4}:){7}[\da-f]{1,4}\b/i.test(normalized)) return false;
  for (const path of text.match(/~\/[\w./-]*/g) ?? []) {
    if (!approvedPaths.has(path)) return false;
  }
  const units = text.match(/[\p{L}\p{M}_][\p{L}\p{M}\d_-]*|\d+/gu) ?? [];
  return units.every((unit) => approvedWords.has(unit) || approvedNumbers.has(unit));
}

type Sample = { id: string; chunks: string[] };

function readCorpus(source: string): Sample[] {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Invalid Markdown corpus JSON");
  }
  // Parsing can hide a duplicate key and its payload. Require canonical data
  // apart from formatting whitespace, which is not part of any excerpt.
  if (
    source.replace(/"(?:[^"\\]|\\.)*"|\s+/g, (part) => (part.startsWith('"') ? part : "")) !==
    JSON.stringify(value)
  ) {
    throw new Error("Non-canonical Markdown corpus JSON");
  }
  if (!Array.isArray(value)) throw new Error("Unexpected Markdown corpus schema");
  const ids = new Set(Object.keys(expected));
  const samples: Sample[] = [];
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== "object") throw new Error("Unexpected Markdown corpus schema");
    const sample = entry as Record<string, unknown>;
    if (
      Object.keys(sample).sort().join(",") !== "chunks,id" ||
      typeof sample.id !== "string" ||
      !ids.delete(sample.id) ||
      !Array.isArray(sample.chunks) ||
      !sample.chunks.length ||
      !sample.chunks.every(
        (chunk: unknown): chunk is string => typeof chunk === "string" && chunk.length > 0,
      )
    ) {
      throw new Error("Unexpected Markdown corpus schema");
    }
    if (!isPublicExcerpt(sample.chunks.join("")))
      throw new Error("Unapproved Markdown corpus content");
    samples.push({ id: sample.id, chunks: sample.chunks });
  }
  if (ids.size) throw new Error("Missing Markdown corpus excerpt");
  return samples;
}

// Audit before registering render tests so a failure cannot print unapproved text.
const corpus = readCorpus(raw);

function semantics(container: HTMLElement): string[] {
  // Block splitting may insert a separator newline; never normalize content
  // inside the elements, including the text and MathML emitted by KaTeX.
  return [...container.childNodes].flatMap((node) =>
    node instanceof Element ? [node.outerHTML] : node.textContent?.trim() ? [node.textContent] : [],
  );
}

describe("real transcript Markdown corpus", () => {
  beforeAll(async () => {
    await loadMath();
  });

  it("gates the checked-in excerpts and rejects injected private-looking content", () => {
    expect(corpus).toHaveLength(Object.keys(expected).length);
    expect(() => readCorpus('[{"id":"unapproved","id":"home-paths","chunks":["host"]}]')).toThrow(
      "Non-canonical Markdown corpus JSON",
    );
    for (const text of [
      "/home/host",
      "C:\\Users\\host",
      "~/.cache/host",
      "https://host",
      "host@node",
      "172.16.1.2",
      "2001:db8::1",
      "2026-01-01",
      "20:22:51",
      "20：22：51",
      "1:2:3:4:6:1:2:3",
      "Bearer node",
      "sk-synthetic-secret",
      "unapproved-repo",
      "私人项目名",
    ])
      expect(isPublicExcerpt(text)).toBe(false);
  });

  it.each(corpus)(
    "renders $id with the same semantics at recorded chunk boundaries",
    ({ id, chunks }) => {
      const { math = 0, display = 0, del = 0, inline, rich } = expected[id];
      const whole = render(<MdBlock>{""}</MdBlock>);
      const stream = render(<StreamingMdBlock>{""}</StreamingMdBlock>);
      let source = "";
      for (const chunk of chunks) {
        source += chunk;
        whole.rerender(<MdBlock>{source}</MdBlock>);
        stream.rerender(<StreamingMdBlock>{source}</StreamingMdBlock>);
        expect(semantics(stream.container)).toEqual(semantics(whole.container));
      }
      const { container } = whole;
      expect(container.querySelectorAll("del")).toHaveLength(del);
      expect(container.querySelectorAll(".katex")).toHaveLength(math);
      expect(container.querySelectorAll(".katex-display")).toHaveLength(display);
      expect(container.querySelector(".katex-error")).toBeNull();
      if (rich) {
        expect(chunks.length).toBeGreaterThan(1);
        for (const tag of ["h3", "strong", "ol", "ul", "code"]) {
          expect(container.querySelector(tag), tag).not.toBeNull();
        }
      }
      if (id === "literal-ellipsis") expect(container.textContent).toContain("$$...$$");
      if (inline) {
        const row = render(<InlineMd>{source}</InlineMd>);
        expect(row.container.querySelectorAll("del")).toHaveLength(del);
        expect(row.container.textContent).toBe(container.textContent);
      }
    },
  );
});
