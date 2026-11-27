import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { assertJourneyCorpus } from "../../scripts/export-anon-corpus";
import {
  pilotModel,
  pilotServer,
  PilotSocket,
  sandboxAgent,
} from "../../service/tests/e2e/pilot-server";
import { ProjectStore } from "../../service/src/project/store";
import { PiRpcClient } from "../../service/src/session/pi-rpc";
import { PiRpcPlayer } from "../../service/tests/snap/harness";
import { piOps, playPi, queueTape, recordedPrompt } from "../../service/tests/snap/queue-tape";
import { App } from "../src/App";

it("sends, streams, cancels, switches sessions, resyncs and stops through the Hub", async () => {
  const corpus: unknown = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../service/tests/corpus/anon-journey.jsonl"),
      "utf8",
    ),
  );
  assertJourneyCorpus(corpus);
  const { first, second, firstResponse, prompt, reply } = queueTape();
  const firstChunk = first.findIndex(
    (entry) =>
      "frame" in entry &&
      (entry.frame.assistantMessageEvent as { type?: string } | undefined)?.type === "text_delta",
  );
  expect(firstChunk).toBeGreaterThan(firstResponse);
  const abort = piOps("interrupt-abort");
  const stopAt = abort.findIndex((entry) => "sent" in entry && entry.sent.type === "abort");
  expect(stopAt).toBeGreaterThan(0);
  const abortPrompt = recordedPrompt(abort[0]);
  let player: PiRpcPlayer | undefined;
  try {
    await pilotServer(
      (root) => {
        player = new PiRpcPlayer(root, pilotModel, 100_000);
        vi.spyOn(PiRpcClient, "spawn").mockImplementation((options) => player!.connect(options!));
        const now = Date.now();
        const project = new ProjectStore(root);
        project.save({
          schemaVersion: 2,
          status: "active",
          id: "queue-journey",
          name: "Journey project",
          root,
          createdAt: now,
          lead: { hostId: "local", workspaceId: "journey-0" },
          leadWorkspaceId: "journey-0",
        });
        return corpus.history.map((kinds, i) => ({
          id: `journey-${i}`,
          name: `Session ${i}`,
          project: "Journey project",
          hostId: "local",
          cwd: root,
          normalizedCwd: root,
          projectLink: { projectId: "queue-journey", role: i === 0 ? "lead" : "worker" },
          createdAt: now,
          agents: [sandboxAgent(root, root, `pilot-agent-${i}`)],
          messages: kinds.map((kind, j) => ({
            id: `history-${i}-${j}`,
            kind,
            agentId: kind === "agent" ? `pilot-agent-${i}` : null,
            status: "done",
            timestamp: now - kinds.length + j,
            content: `History ${i}:${j}`,
          })),
        }));
      },
      async (origin, _server, firstId) => {
        // Node's native WebSocket emits events from a different realm in jsdom.
        const sockets: PilotSocket[] = [];
        const hydrated = new Set<PilotSocket>();
        const completed = new Map<PilotSocket, Set<string>>();
        const nativeFetch = fetch;
        // Socket updates come from actual I/O; synchronize on rendered outcomes.
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
        vi.stubGlobal(
          "WebSocket",
          class extends PilotSocket {
            constructor(url: string) {
              super(new URL(new URL(url).pathname, origin.replace(/^http/, "ws")).href);
              sockets.push(this);
              const replies = new Set<string>();
              completed.set(this, replies);
              this.on("message", (data) => {
                if (!Buffer.isBuffer(data)) return;
                const frame = JSON.parse(data.toString()) as {
                  type: string;
                  workspaceId?: string;
                  before?: string | null;
                  status?: string;
                  content?: string;
                };
                if (frame.workspaceId !== firstId) return;
                if (frame.type === "workspace_messages" && frame.before === null)
                  hydrated.add(this);
                if (frame.type === "message_done" && frame.status === "done" && frame.content)
                  replies.add(frame.content);
              });
            }
          },
        );
        vi.stubGlobal("fetch", (url: string, options?: RequestInit) =>
          nativeFetch(new URL(url, origin).href, options),
        );
        const scroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
        Object.defineProperty(Element.prototype, "scrollIntoView", {
          configurable: true,
          value: () => {},
        });
        localStorage.setItem("activeWsId", firstId);
        let app = render(<App />);
        try {
          // The Hub performs real I/O. Bound the wire wait separately from the DOM
          // assertion so a descheduled worker does not look like a rendering failure.
          const wireWait = { timeout: 4_000, interval: 10 };
          const waitForHydration = (index: number) =>
            expect
              .poll(() => hydrated.has(sockets[index]), {
                ...wireWait,
                message: `expected newest history page on socket ${index + 1}`,
              })
              .toBe(true);
          const messages = () => within(app.container.querySelector(".messages")!);
          const visible = (text: string) =>
            app.findByText(text, { exact: true, selector: ".messages *" });
          const row = (text: string) =>
            messages().getByText(text, { exact: true }).closest<HTMLElement>("[id^=msg-]")!;
          const send = async (text: string) => {
            const input = app.container.querySelector<HTMLTextAreaElement>("textarea.chat-input")!;
            fireEvent.change(input, { target: { value: text } });
            fireEvent.keyDown(input, { key: "Enter" });
            await visible(text);
            await expect.poll(() => input.value, { interval: 5 }).toBe("");
          };
          const remove = (text: string) => within(row(text)).getByTitle("Remove from queue");
          const state = () =>
            [...app.container.querySelectorAll(".messages [id^=msg-]")].map((row) => ({
              id: row.id,
              body: [...row.querySelectorAll(".message-content")].map((node) => node.textContent),
              badge: row.querySelector(".queued-badge")?.textContent,
              dimmed: row.classList.contains("message-queued"),
              canRemove: !!row.querySelector(".queued-cancel"),
            }));
          await waitForHydration(0);
          await visible("History 0:0");
          await send(prompt(0));
          await playPi(player!, first.slice(0, firstChunk + 1));
          await expect
            .poll(
              () =>
                [...app.container.querySelectorAll(".messages .message[id]")]
                  .at(-1)
                  ?.querySelector(".message-agent .message-content")?.textContent,
              { interval: 10 },
            )
            .toBe("xxxx");
          await send(prompt(1));
          await send(prompt(2));
          expect(row(prompt(2)).classList.contains("message-queued")).toBe(true);
          expect(row(prompt(2)).querySelector(".queued-badge")?.textContent).toMatch(/^queued\b/);
          fireEvent.click(remove(prompt(2)));
          await expect.poll(() => messages().queryByText(prompt(2)), { interval: 10 }).toBeNull();
          expect(remove(prompt(1))).toBeTruthy();
          expect(player!.sent.filter(({ type }) => type === "prompt")).toHaveLength(1);
          const pending = state();

          // Reuse the leading real switch burst, assigning sandbox destinations by ordinal;
          // the export intentionally contains no destination or link to the Pi tape.
          const switches = corpus.actions.indexOf("chat.send");
          expect(switches).toBeGreaterThanOrEqual(2);
          const order = Array.from(
            { length: switches - 1 },
            (_, i) => 1 + (i % (corpus.history.length - 1)),
          );
          for (const i of [...order, 0]) {
            fireEvent.click(
              within(app.container.querySelector(".sidebar")!).getByText(
                i === 0 ? "Journey project" : `Session ${i}`,
                {
                  exact: true,
                },
              ),
            );
            await visible(`History ${i}:0`);
          }
          expect(state()).toEqual(pending);

          // A real disconnect followed by a foreground liveness check and a fresh socket.
          const disconnected = new Promise<void>((resolve) =>
            sockets[0].once("close", () => resolve()),
          );
          await act(async () => {
            sockets[0].close();
            await disconnected;
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await waitForHydration(1);
          expect(sockets).toHaveLength(2);
          expect(state()).toEqual(pending);
          app.unmount();
          app = render(<App />);
          await waitForHydration(2);
          await visible(prompt(1));
          expect(sockets).toHaveLength(3);
          expect(state()).toEqual(pending);

          // Pi stdout replay does not wait for Hub delivery or the React commit.
          await act(async () => {
            await playPi(player!, first.slice(firstChunk + 1));
            await playPi(player!, second);
            await expect
              .poll(() => completed.get(sockets[2])?.has(reply), {
                ...wireWait,
                message: "expected Hub completion for the queued reply on the live socket",
              })
              .toBe(true);
          });
          await visible(reply);
          expect(state().filter(({ canRemove }) => canRemove)).toEqual([]);
          expect(
            player!.sent.filter(({ type }) => type === "prompt").map(({ message }) => message),
          ).toEqual([prompt(0), prompt(1)]);
          await player!.finish();
          const settled = state();
          app.unmount();
          app = render(<App />);
          await waitForHydration(3);
          await visible(reply);
          expect(state()).toEqual(settled);

          await send(abortPrompt);
          await playPi(player!, abort.slice(0, stopAt));
          fireEvent.click(await screen.findByRole("button", { name: "Stop Pilot Agent" }));
          await playPi(player!, abort.slice(stopAt));
          await expect
            .poll(() => app.container.querySelector(".messages")?.textContent, { interval: 10 })
            .toContain("interrupted");
          await player!.finish();
        } finally {
          app.unmount();
          localStorage.clear();
          if (scroll) Object.defineProperty(Element.prototype, "scrollIntoView", scroll);
          else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
          vi.unstubAllGlobals();
        }
      },
    );
  } finally {
    player?.close();
  }
}, 15_000);
