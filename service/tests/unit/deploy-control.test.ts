import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeployControl, type Blockers } from "../../src/server/deploy-control";
import { retireOnEof } from "../../src/session/retire";
import { spawn } from "node:child_process";

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "yaat-dc-"));
});
afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

const rpc = (file: string, command: unknown): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(file, () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("error", reject);
    socket.setEncoding("utf8");
    let output = "";
    socket.on("data", (data: string) => {
      output += data;
    });
    socket.on("end", () => resolve(JSON.parse(output) as Record<string, unknown>));
  });

function setup(retire = (_signal: AbortSignal) => Promise.resolve(), leaseMs = 20_000) {
  const blockers: Blockers = { workspaces: 0 };
  const resumed = vi.fn();
  const control = new DeployControl(
    { baseDir, port: 19738, label: "test", releaseId: "gen-one", installedRepoDir: baseDir },
    () => blockers,
    retire,
    resumed,
    leaseMs,
    join(baseDir, "transaction.json"),
  );
  return {
    blockers,
    resumed,
    control,
    seal: { ...control.status(), cmd: "seal", deployId: "job" },
  };
}

describe("deploy control", () => {
  it.skipIf(process.platform === "win32")(
    "waits for the requesting turn and rejects wrong generation/boot/repo/target over an owner-only socket",
    async () => {
      const { control, seal, blockers } = setup();
      const socket = join(baseDir, "deploy-control/control.sock");
      try {
        await control.listen();
        expect(lstatSync(join(baseDir, "deploy-control")).mode & 0o777).toBe(0o700);
        expect(lstatSync(socket).mode & 0o777).toBe(0o600);
        expect(await rpc(socket, { cmd: "status" })).toMatchObject({
          pid: process.pid,
          bootId: seal.bootId,
        });
        for (const key of [
          "bootId",
          "releaseId",
          "installedRepoDir",
          "label",
          "port",
          "baseDir",
          "pid",
        ]) {
          expect(await rpc(socket, { ...seal, [key]: "wrong" })).toEqual({
            error: "Target identity mismatch",
          });
        }
        blockers.workspaces = 1;
        expect(await rpc(socket, seal)).toMatchObject({
          sealed: false,
          blockers: { workspaces: 1 },
        });
        blockers.workspaces = 0;
        expect(await rpc(socket, seal)).toMatchObject({
          sealed: true,
          deployId: "job",
          commitReady: true,
        });
        expect(await rpc(socket, { ...seal, cmd: "unseal", deployId: "another" })).toEqual({
          error: "Seal owner mismatch",
        });
        expect(await rpc(socket, { ...seal, cmd: "unseal" })).toMatchObject({ sealed: false });
      } finally {
        await control.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "will not replace a live listener or use an exposed directory",
    async () => {
      const first = setup().control;
      const another = setup().control;
      try {
        await first.listen();
        await expect(another.listen()).rejects.toThrow("already listening");
        chmodSync(join(baseDir, "deploy-control"), 0o755);
        await expect(another.listen()).rejects.toThrow("owner-only");
      } finally {
        await first.close();
        await another.close();
      }
    },
  );

  it("revokes the lease even if unsolicited work ends before retirement returns", async () => {
    const { control, seal, resumed } = setup(
      (signal) =>
        new Promise<void>((resolve) => {
          expect(signal.aborted).toBe(false);
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    try {
      const attempt = control.request(seal);
      expect(control.status()).toMatchObject({ sealed: true, commitReady: false });
      control.observe(true);
      expect(await attempt).toMatchObject({ sealed: false, commitReady: false });
      expect(resumed).toHaveBeenCalledOnce();
    } finally {
      await control.close();
    }
  });

  it("expires a pre-commit lease, but not a committed handoff", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { control, seal, resumed } = setup(undefined, 100);
    try {
      await control.request(seal);
      await vi.advanceTimersByTimeAsync(101);
      expect(control.sealed).toBe(false);
      expect(resumed).toHaveBeenCalledOnce();
      await control.request(seal);
      expect(await control.request({ ...seal, commit: true })).toMatchObject({ committed: false });
      const journal = join(baseDir, "transaction.json");
      writeFileSync(journal, "{}");
      expect(await control.request({ ...seal, commit: true })).toMatchObject({ committed: true });
      await vi.advanceTimersByTimeAsync(501);
      expect(control.sealed).toBe(true);
      unlinkSync(journal);
      await vi.advanceTimersByTimeAsync(501);
      expect(control.sealed).toBe(false);
    } finally {
      await control.close();
      vi.useRealTimers();
    }
  });

  it("retires without signalling a child, and drains its final frames before returning", async () => {
    const child = spawn(
      process.execPath,
      ["-e", `process.stdin.resume(); process.stdin.on('end', () => console.log('settled'))`],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    let frames = "";
    child.stdout.on("data", (data: Buffer) => {
      frames += data.toString();
    });
    await retireOnEof(child, child.stdin);
    expect(child.signalCode).toBe(null);
    expect(frames.trim()).toBe("settled");
  });
});
