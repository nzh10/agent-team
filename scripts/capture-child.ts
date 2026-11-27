import { execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

// Own only this spawned process. A broken stdin or a recorder failure must
// not leave Pi running after its scratch home has been removed.
export function trackCaptureChild(
  child: ChildProcess & { stdin: Writable },
  killAfter: number,
  terminateAfter?: number,
) {
  const closed = once(child, "close");
  void closed.catch(() => {}); // Report spawn errors on cleanup even if stdout ended first.
  const terminate = () => child.kill("SIGTERM");
  const kill = () => child.kill("SIGKILL");
  child.stdin.on("error", terminate);
  const terminateTimer =
    terminateAfter === undefined ? undefined : setTimeout(terminate, terminateAfter);
  const killTimer = setTimeout(kill, killAfter);
  return async () => {
    clearTimeout(terminateTimer);
    clearTimeout(killTimer);
    child.stdin.end();
    const reap = setTimeout(kill, 3000);
    try {
      await closed;
    } finally {
      clearTimeout(reap);
    }
  };
}

function processSnapshot() {
  return execFileSync("ps", ["-ww", "-axo", "pid=,ppid=,lstart=,command="], {
    encoding: "utf8",
    maxBuffer: 16 << 20,
    timeout: 1000,
  })
    .split("\n")
    .flatMap((line) => {
      const row = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/.exec(line);
      return row
        ? [{ pid: Number(row[1]), parent: Number(row[2]), identity: row[3], command: row[4] }]
        : [];
    });
}

// Acceptance also checks detached descendants that do not expose a child handle.
export function trackAcceptanceProcesses(markers: string[]) {
  const baseline = new Map(processSnapshot().map((row) => [row.pid, row.identity]));
  const owned = new Map<number, string>();
  function capture() {
    const rows = processSnapshot();
    const live = new Map(rows.map(({ pid, identity }) => [pid, identity]));
    let size: number;
    do {
      size = owned.size;
      for (const { pid, parent, identity, command } of rows) {
        if (
          pid === process.pid ||
          baseline.get(pid) === identity ||
          /(?:^|\/)ps -ww -axo /.test(command)
        )
          continue;
        if (
          parent === process.pid ||
          (live.has(parent) && owned.get(parent) === live.get(parent)) ||
          markers.some((marker) => command.includes(marker))
        )
          owned.set(pid, identity);
      }
    } while (size !== owned.size);
    return rows.filter(({ pid, identity }) => owned.get(pid) === identity).map(({ pid }) => pid);
  }
  let samplingError: unknown;
  const timer = setInterval(() => {
    try {
      capture();
    } catch (error) {
      samplingError = error;
    }
  }, 150);
  timer.unref();
  return {
    capture,
    observed: () => [...owned.keys()],
    async release(deadline: number) {
      clearInterval(timer);
      let remaining = capture();
      while (remaining.length && Date.now() < deadline) {
        await sleep(50);
        remaining = capture();
      }
      // Record the leak before emergency cleanup; it must never count as a pass.
      for (const pid of remaining) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      if (samplingError)
        throw new Error("Could not sample the acceptance process tree", { cause: samplingError });
      return remaining;
    },
  };
}
