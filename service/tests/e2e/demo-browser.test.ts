import { describe, expect, it } from "vitest";
import { formatBenchmarkTable, runDemoBrowserSuite } from "../../../scripts/bench-demo";

// Full-stack Chromium Demo E2E + Performance Regression Gate.
// Runs against the real seeded demo (scripts/seed-demo.ts), real Server +
// HostRegistry/LocalHost, real built dist/webview bundle, real headless
// Playwright Chromium, and the live Workspace 🎬 Replay Demo fixture.
//
// Ceilings below are deliberately generous (3x-5x above typical local runs) so
// they catch catastrophic latency regressions or unbounded DOM/heap leaks
// without flaking under laptop/CI CPU variance.
const CEILINGS = {
  hydrationMs: 10_000,
  workspaceSwitchP95Ms: 2_000,
  boardOpenMs: 2_000,
  replayP95CommitMs: 500,
  clientHeapAfterMb: 256,
  clientHeapDeltaMb: 96,
  clientDomNodesAfter: 15_000,
  serverRssMb: 512,
};

describe("full-stack Demo Browser E2E + Performance Benchmark", () => {
  it("drives all seeded Demo and Replay Demo journeys in Chromium within performance ceilings", async () => {
    const result = await runDemoBrowserSuite();
    console.log(`\n${formatBenchmarkTable(result)}\n`);

    expect(result.journeysVerified).toEqual([
      "archived-reply-file-links",
      "hydration-sidebar-archive-search",
      "workspace-switch-history-git-indicators",
      "side-panels-files-diff-asklines-agents",
      "board-objectives-graph-issues-notes",
      "replay-demo-cancel-desktop-and-mobile",
    ]);

    expect(result.consoleErrors, "unexpected browser console errors").toEqual([]);
    expect(result.pageErrors, "unexpected uncaught page errors").toEqual([]);
    expect(result.portClosed, "server port should be closed after teardown").toBe(true);

    const { metrics } = result;
    expect(metrics.desktopOverflowPx, "desktop 1280x800 horizontal overflow").toBeLessThanOrEqual(
      1,
    );
    expect(metrics.mobileOverflowPx, "mobile 390x844 horizontal overflow").toBeLessThanOrEqual(1);

    expect(metrics.hydrationMs).toBeLessThan(CEILINGS.hydrationMs);
    expect(metrics.workspaceSwitchP95Ms).toBeLessThan(CEILINGS.workspaceSwitchP95Ms);
    expect(metrics.boardOpenMs).toBeLessThan(CEILINGS.boardOpenMs);
    expect(metrics.replay.dispatchedFrames).toBe(metrics.replay.totalFrames);
    expect(metrics.replay.p95CommitMs).toBeLessThan(CEILINGS.replayP95CommitMs);
    expect(metrics.clientAfterReplay.jsHeapUsedMb).toBeLessThan(CEILINGS.clientHeapAfterMb);
    expect(metrics.clientHeapDeltaMb).toBeLessThan(CEILINGS.clientHeapDeltaMb);
    expect(metrics.clientAfterReplay.domNodes).toBeLessThan(CEILINGS.clientDomNodesAfter);
    expect(metrics.serverAfterReplay.rssMb).toBeLessThan(CEILINGS.serverRssMb);
  }, 120_000);
});
