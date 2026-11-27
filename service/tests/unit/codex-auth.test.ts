import { afterEach, describe, expect, it, vi } from "vitest";
import { probeCodexAuth } from "../../src/session/codex";
import type { RpcMessage, Transport } from "../../src/session/codex-rpc";
import { codexFields } from "./fixtures/codex-wire";

function mockTransport(
  onWrite: (
    msg: RpcMessage,
    emit: (reply: RpcMessage) => void,
    close: (reason: string) => void,
  ) => void,
): { transport: () => Transport; closed: () => number; sent: RpcMessage[] } {
  const sent: RpcMessage[] = [];
  let closed = 0;
  return {
    sent,
    closed: () => closed,
    transport: () => {
      const listeners: Array<(m: RpcMessage) => void> = [];
      const closers: Array<(r: string) => void> = [];
      const emit = (reply: RpcMessage) => {
        for (const cb of listeners) cb(reply);
      };
      const triggerClose = (reason: string) => {
        for (const cb of closers) cb(reason);
      };
      return {
        write: (msg) => {
          sent.push(msg);
          onWrite(msg, emit, triggerClose);
        },
        onMessage: (cb) => listeners.push(cb),
        onClose: (cb) => closers.push(cb),
        close: () => {
          closed++;
          queueMicrotask(() => triggerClose("closed"));
        },
      };
    },
  };
}

function probeWithTransport(transport: () => Transport, options: { timeoutMs?: number } = {}) {
  return probeCodexAuth({}, { codexBinary: () => "/usr/local/bin/codex", transport, ...options });
}

function accountRead(result: { account: unknown; requiresOpenaiAuth: boolean }) {
  return mockTransport((msg, emit) => {
    if (msg.method === "initialize") emit({ id: msg.id, result: codexFields("initialize") });
    if (msg.method === "account/read") emit({ id: msg.id, result });
  });
}

describe("probeCodexAuth", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports authenticated ChatGPT and API key accounts via account/read without consuming quota", async () => {
    for (const account of [
      { type: "chatgpt", email: "user@example.com", planType: "plus" },
      { type: "apiKey" },
    ]) {
      const fake = accountRead({ account, requiresOpenaiAuth: true });
      const result = await probeWithTransport(fake.transport);

      expect(result).toMatchObject({
        cliAvailable: true,
        authenticated: true,
        status: "authenticated",
        accountType: account.type,
      });
      expect(fake.sent.map((m) => m.method)).toEqual(["initialize", "initialized", "account/read"]);
      expect(fake.sent.find((m) => m.method === "account/read")?.params).toEqual({
        refreshToken: false,
      });
      expect(fake.closed()).toBe(1);
    }
  });

  it("treats requiresOpenaiAuth=false as authenticated even when account is null", async () => {
    const fake = accountRead({ account: null, requiresOpenaiAuth: false });
    const result = await probeWithTransport(fake.transport);

    expect(result).toMatchObject({
      cliAvailable: true,
      authenticated: true,
      status: "authenticated",
      accountType: null,
    });
  });

  it("reports unauthenticated when account is null and requiresOpenaiAuth is true", async () => {
    const fake = accountRead({ account: null, requiresOpenaiAuth: true });
    const result = await probeWithTransport(fake.transport);

    expect(result).toMatchObject({
      cliAvailable: true,
      authenticated: false,
      status: "unauthenticated",
      accountType: null,
    });
    expect(fake.closed()).toBe(1);
  });

  it("reports unavailable when the codex binary is missing without spawning", async () => {
    const transport = vi.fn();
    const result = await probeCodexAuth(
      {},
      {
        codexBinary: () => {
          throw new Error("Codex CLI not found");
        },
        transport,
      },
    );

    expect(result).toMatchObject({
      cliAvailable: false,
      authenticated: false,
      status: "unavailable",
      accountType: null,
      error: "Codex CLI not found",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("handles RPC errors and premature closes cleanly as error status", async () => {
    const rpcErr = mockTransport((msg, emit) => {
      if (msg.method === "initialize") emit({ id: msg.id, result: codexFields("initialize") });
      if (msg.method === "account/read") {
        emit({ id: msg.id, error: { code: -32000, message: "account store unreadable" } });
      }
    });

    const resErr = await probeWithTransport(rpcErr.transport);
    expect(resErr).toMatchObject({
      cliAvailable: true,
      authenticated: false,
      status: "error",
    });
    expect(resErr.error).toContain("account store unreadable");
    expect(rpcErr.closed()).toBe(1);

    const crashed = mockTransport((msg, _emit, triggerClose) => {
      if (msg.method === "initialize") queueMicrotask(() => triggerClose("EOF"));
    });
    const resCrash = await probeWithTransport(crashed.transport);
    expect(resCrash).toMatchObject({
      cliAvailable: true,
      authenticated: false,
      status: "error",
    });
    expect(crashed.closed()).toBe(1);
  });

  it("times out cleanly without hanging startup or leaking transports", async () => {
    vi.useFakeTimers();
    const hanging = mockTransport(() => {
      // Never replies to initialize / account/read.
    });

    const promise = probeWithTransport(hanging.transport, { timeoutMs: 250 });
    await vi.advanceTimersByTimeAsync(250);
    const result = await promise;

    expect(result).toMatchObject({
      cliAvailable: true,
      authenticated: false,
      status: "error",
      error: "Codex account probe timed out",
    });
    expect(hanging.closed()).toBe(1);
  });
});
