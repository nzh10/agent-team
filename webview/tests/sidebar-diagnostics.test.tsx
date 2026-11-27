import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ICONS } from "../src/panels/Icon";
import { Sidebar, type SidebarProps } from "../src/sidebar/Sidebar";

const TRIGGER = "Debug tools";
const SNAPSHOT = "Capture debug snapshot";
const DEMO = "Replay demo";
const TEST_PUSH = "Send test push";

function healthResponse(issues: object[] = []) {
  return { ok: true, json: () => Promise.resolve({ issues }) };
}

function stubHealth(issues: object[] = []) {
  const fetch = vi.fn(() => Promise.resolve(healthResponse(issues)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sidebar(connected = true, over: Partial<SidebarProps> = {}) {
  const noop = vi.fn();
  const props: SidebarProps = {
    connected,
    activeWsId: null,
    workspaces: [],
    groupOverrides: {},
    searchQuery: "",
    searchHits: null,
    systemStatus: null,
    onSelect: noop,
    onDelete: noop,
    onToggleGroup: noop,
    onSearchChange: noop,
    onJump: noop,
    onCreate: noop,
    onCreateIn: noop,
    onReplayDemo: noop,
    onDebugSnapshot: noop,
    onPurgeArchived: noop,
    ...over,
  };
  const view = render(<Sidebar {...props} />);
  return { ...view, props };
}

function expectStripClosed() {
  expect(screen.queryByRole("group", { name: "Debug tools" })).toBeNull();
  expect(screen.queryByRole("link", { name: /Service diagnostics/ })).toBeNull();
  expect(screen.queryByRole("button", { name: DEMO })).toBeNull();
  expect(screen.queryByRole("button", { name: SNAPSHOT })).toBeNull();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  history.replaceState(null, "", location.pathname);
});

it.each([
  ["insecure", "Use HTTPS"],
  ["unsupported", "not supported"],
  ["ios", "Home Screen"],
  ["denied", "blocked"],
])("explains %s notifications without prompting", async (mode, hint) => {
  vi.stubGlobal("isSecureContext", mode !== "insecure");
  const prompt = vi.fn();
  vi.stubGlobal("Notification", {
    permission: mode === "denied" ? "denied" : "default",
    requestPermission: prompt,
  });
  vi.stubGlobal("navigator", {
    userAgent: mode === "ios" ? "iPhone" : "Desktop",
    serviceWorker: mode === "unsupported" ? undefined : {},
  });
  vi.stubGlobal("PushManager", class {});
  stubHealth();
  sidebar();
  await act(async () => {});
  const bell = screen.getByRole("button", { name: "Notifications" });
  expect(bell.title).toContain(hint);
  fireEvent.click(bell);
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toContain(hint);
  expect(prompt).not.toHaveBeenCalled();
});
it.each([false, true])(
  "subscribes from the bell with a stale key: %s, shows test acceptance and unregisters",
  async (stale) => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("PushManager", class {});
    const gate = deferred();
    const permission = {
      permission: "default",
      requestPermission: vi.fn(() => {
        permission.permission = "granted";
        return gate.promise.then(() => "granted");
      }),
    };
    vi.stubGlobal("Notification", permission);
    const subscription = {
      endpoint: "https://push.example/1",
      toJSON: () => ({ endpoint: "https://push.example/1" }),
      unsubscribe: vi.fn(() => Promise.resolve(true)),
    };
    const subscribe = vi.fn(() => Promise.resolve(subscription));
    const old = {
      ...subscription,
      options: { applicationServerKey: new Uint8Array([2]).buffer },
      unsubscribe: vi.fn(() => Promise.resolve(true)),
    };
    const manager = { subscribe, getSubscription: () => Promise.resolve(stale ? old : null) };
    vi.stubGlobal("navigator", {
      userAgent: "Desktop",
      serviceWorker: {
        register: () => Promise.resolve(),
        ready: Promise.resolve({ pushManager: manager }),
      },
    });
    const api = vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.endsWith("public-key")
              ? { publicKey: "AQ" }
              : url.endsWith("test")
                ? { accepted: 2, failed: 1, expired: 0 }
                : { issues: [] },
          ),
      }),
    );
    vi.stubGlobal("fetch", api);
    sidebar();
    await act(async () => {});
    const bell = screen.getByRole("button", { name: "Notifications" });
    expect(permission.requestPermission).not.toHaveBeenCalled();
    expect(old.unsubscribe).not.toHaveBeenCalled();
    expect(bell.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
    fireEvent.click(screen.getByRole("button", { name: SNAPSHOT }));
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toBe("Snapshot saved");
    fireEvent.click(bell);
    expect(screen.getByRole("status").textContent).toBe("Turning notifications on…");
    fireEvent.click(bell);
    expect(screen.queryByText("Push service offline")).toBeNull();
    gate.resolve();
    await act(async () => {});
    expect(old.unsubscribe).toHaveBeenCalledTimes(stale ? 1 : 0);
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1]),
    });
    expect(bell.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").classList.contains("sidebar-debug-status-saved")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: SNAPSHOT }));
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toBe("Snapshot saved");
    fireEvent.click(screen.getByRole("button", { name: TEST_PUSH }));
    expect(screen.getByRole("status").textContent).toBe("Sending test push…");
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toBe("1 failed · 2 accepted");
    expect(screen.getByRole("status").classList.contains("sidebar-debug-status-error")).toBe(true);
    fireEvent.click(bell);
    await act(async () => {});
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(bell.getAttribute("aria-pressed")).toBe("false");
  },
);

it("shows safe subscribe diagnostics and hides unknown API details", async () => {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { permission: "granted" });
  const subscription = {
    toJSON: () => ({ endpoint: "https://push.example/1" }),
    unsubscribe: vi
      .fn()
      .mockRejectedValueOnce(new Error("Rollback failed"))
      .mockResolvedValue(true),
  };
  vi.stubGlobal("navigator", {
    userAgent: "Desktop",
    serviceWorker: {
      register: () => Promise.resolve(),
      ready: Promise.resolve({
        pushManager: {
          getSubscription: () => Promise.resolve(null),
          subscribe: () => Promise.resolve(subscription),
        },
      }),
    },
  });
  let error = "Invalid push subscription";
  const delayed = deferred();
  let deferSubscribe = false;
  vi.stubGlobal("fetch", (url: string) => {
    if (url.endsWith("/subscribe")) {
      const reply = { ok: false, status: 400, json: () => Promise.resolve({ error }) };
      return deferSubscribe ? delayed.promise.then(() => reply) : Promise.resolve(reply);
    }
    if (url.endsWith("/test"))
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ publicKey: "AQ", issues: [] }),
    });
  });
  sidebar();
  await act(async () => {});
  const bell = screen.getByRole("button", { name: "Notifications" });
  fireEvent.click(bell);
  await act(async () => {});
  expect(bell.getAttribute("aria-pressed")).toBe("false");
  expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toBe("Invalid push subscription");
  expect(screen.getByRole("status").classList.contains("sidebar-debug-status-error")).toBe(true);

  error = "Connection error: https://push.example/private-token";
  fireEvent.click(bell);
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toBe("Notification update failed. Try again.");

  deferSubscribe = true;
  fireEvent.click(bell);
  fireEvent.click(screen.getByRole("button", { name: TEST_PUSH }));
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toBe("Sign in to manage notifications");
  delayed.resolve();
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toBe("Sign in to manage notifications");
});

it.each([
  ["default", "Enable notifications first"],
  ["denied", "No subscribed devices"],
])(
  "shows zero-device feedback with %s permission without restoring an earlier snapshot status",
  async (permission, status) => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission });
    vi.stubGlobal("navigator", {
      userAgent: "Desktop",
      serviceWorker: {
        register: () => Promise.resolve(),
        ready: Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(null) } }),
      },
    });
    vi.stubGlobal("fetch", (url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.endsWith("/test")
              ? { accepted: 0, expired: 0, failed: 0 }
              : { publicKey: "AQ", issues: [] },
          ),
      }),
    );
    const upload = deferred();
    const onDebugSnapshot = vi.fn(() => upload.promise);
    sidebar(true, { onDebugSnapshot });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
    const snapshot = screen.getByRole("button", { name: SNAPSHOT });
    fireEvent.click(snapshot);
    expect(screen.getByRole("status").textContent).toBe("Saving snapshot…");
    fireEvent.click(screen.getByRole("button", { name: TEST_PUSH }));
    expect(screen.getByRole("status").textContent).toBe("Sending test push…");
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toBe(status);
    expect(snapshot.hasAttribute("disabled")).toBe(true);
    fireEvent.click(snapshot);
    expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
    upload.resolve();
    await act(async () => {});
    expect(snapshot.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("status").textContent).toBe(status);
  },
);

it("purely toggles # without auto-capturing and highlights active state", async () => {
  stubHealth();
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  const { container } = sidebar(true, { onDebugSnapshot });
  await act(async () => {});

  const trigger = screen.getByRole("button", { name: TRIGGER });
  expect(trigger.getAttribute("title")).toBe(TRIGGER);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.getAttribute("aria-pressed")).toBe("false");
  expectStripClosed();

  fireEvent.click(trigger);
  expect(onDebugSnapshot).not.toHaveBeenCalled();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(trigger.getAttribute("aria-pressed")).toBe("true");

  const diagnostics = screen.getByRole("link", { name: "Service diagnostics" });
  const demo = screen.getByRole("button", { name: DEMO });
  const snapshot = screen.getByRole("button", { name: SNAPSHOT });
  expect(diagnostics.getAttribute("href")).toBe("api/diagnostics?format=text");
  expect(diagnostics.getAttribute("target")).toBe("_blank");
  expect(diagnostics.getAttribute("rel")).toBe("noopener noreferrer");
  expect(diagnostics.textContent).toBe("");
  expect(demo.textContent).toBe("");
  expect(snapshot.textContent).toBe("");

  const notificationsPath = screen
    .getByRole("button", { name: "Notifications" })
    .querySelector("svg path")
    ?.getAttribute("d");
  const testPushPath = screen
    .getByRole("button", { name: TEST_PUSH })
    .querySelector("svg path")
    ?.getAttribute("d");
  expect(notificationsPath).toBe(ICONS.bell);
  expect(testPushPath).toBe(ICONS.testPush);
  expect(testPushPath).not.toBe(notificationsPath);

  // Distinct linear SVG icons for #, Diagnostics, Demo, and Snapshot (camera != #).
  const triggerPath = trigger.querySelector("svg path")?.getAttribute("d");
  const diagnosticsPath = diagnostics.querySelector("svg path")?.getAttribute("d");
  const demoPath = demo.querySelector("svg path")?.getAttribute("d");
  const snapshotPath = snapshot.querySelector("svg path")?.getAttribute("d");
  expect(triggerPath).toBe(ICONS.debug);
  expect(diagnosticsPath).toBe(ICONS.diagnostics);
  expect(demoPath).toBe(ICONS.play);
  expect(snapshotPath).toBe(ICONS.camera);
  expect(new Set([triggerPath, diagnosticsPath, demoPath, snapshotPath]).size).toBe(4);
  expect(container.querySelectorAll(".sidebar-debug-dot")).toHaveLength(0);

  fireEvent.click(trigger);
  expectStripClosed();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.getAttribute("aria-pressed")).toBe("false");
  expect(onDebugSnapshot).not.toHaveBeenCalled();
});

it("handles consecutive Snapshot clicks with anti-reentry guard and uploading/saved/error feedback", async () => {
  stubHealth();
  const first = deferred();
  const second = deferred();
  const onDebugSnapshot = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
    .mockImplementationOnce(() => Promise.resolve());
  sidebar(true, { onDebugSnapshot });
  await act(async () => {});

  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  expect(onDebugSnapshot).not.toHaveBeenCalled();

  const snapshot = screen.getByRole("button", { name: SNAPSHOT });
  fireEvent.click(snapshot);
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
  expect(snapshot.hasAttribute("disabled")).toBe(true);
  expect(snapshot.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("status").textContent).toBe("Saving snapshot…");

  // Repeated clicks and toggling # cannot overlap an in-flight upload.
  fireEvent.click(snapshot);
  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  expectStripClosed();
  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  expect(screen.getByRole("button", { name: SNAPSHOT }).hasAttribute("disabled")).toBe(true);
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);

  first.resolve();
  await act(async () => {});
  expect(screen.getByRole("button", { name: SNAPSHOT }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("status").textContent).toBe("Snapshot saved");

  // Consecutive click starts immediately and surfaces failure without closing the strip.
  fireEvent.click(screen.getByRole("button", { name: SNAPSHOT }));
  expect(onDebugSnapshot).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status").textContent).toBe("Saving snapshot…");

  second.reject(new Error("read-only filesystem"));
  await act(async () => {});
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();
  expect(screen.getByRole("button", { name: SNAPSHOT }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("status").textContent).toBe("Snapshot failed");

  // Subsequent retry after failure succeeds.
  fireEvent.click(screen.getByRole("button", { name: SNAPSHOT }));
  await act(async () => {});
  expect(onDebugSnapshot).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("status").textContent).toBe("Snapshot saved");
});

it("keeps the strip open on outside clicks, workspace actions, and desktop Demo clicks", async () => {
  stubHealth();
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  const onReplayDemo = vi.fn();
  const onCreateIn = vi.fn();
  sidebar(true, {
    onDebugSnapshot,
    onReplayDemo,
    onCreateIn,
    workspaces: [
      {
        id: "w",
        name: "w",
        hostId: "local",
        project: "repo",
        cwd: "/repo",
        agents: [],
        messages: [],
        createdAt: 1,
        git: null,
        pr: null,
      },
    ],
  });
  await act(async () => {});

  const trigger = screen.getByRole("button", { name: TRIGGER });
  fireEvent.click(trigger);
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();

  fireEvent.click(document.body);
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();

  fireEvent.click(screen.getByTitle("New workspace in /repo"));
  expect(onCreateIn).toHaveBeenCalledWith("/repo");
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: DEMO }));
  expect(onReplayDemo).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(onDebugSnapshot).not.toHaveBeenCalled();
});

it("restores focus to # on Escape without capturing", async () => {
  stubHealth();
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  sidebar(true, { onDebugSnapshot });
  await act(async () => {});

  const trigger = screen.getByRole("button", { name: TRIGGER });
  fireEvent.click(trigger);
  const demo = screen.getByRole("button", { name: DEMO });
  demo.focus();
  fireEvent.keyDown(demo, { key: "Escape" });

  expectStripClosed();
  expect(document.activeElement).toBe(trigger);
  expect(onDebugSnapshot).not.toHaveBeenCalled();
});

it("resets on a mobile drawer close and stays collapsed when reopened", async () => {
  stubHealth();
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  const view = sidebar(true, { sidebarOpen: true, onDebugSnapshot });
  await act(async () => {});

  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();
  view.rerender(<Sidebar {...view.props} sidebarOpen={false} />);
  expectStripClosed();
  view.rerender(<Sidebar {...view.props} sidebarOpen={true} />);
  expectStripClosed();
  expect(onDebugSnapshot).not.toHaveBeenCalled();
});

it("starts open for ?debug=1 without auto-capturing and exposes one Diagnostics entry", async () => {
  history.replaceState(null, "", "?debug=1");
  const fetch = stubHealth();
  const onDebugSnapshot = vi.fn(() => Promise.resolve());
  const onReplayDemo = vi.fn();
  sidebar(true, { onDebugSnapshot, onReplayDemo });

  expect(onDebugSnapshot).not.toHaveBeenCalled();
  const links = screen.getAllByRole("link", { name: "Service diagnostics" });
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute("href")).toBe("api/diagnostics?format=text");
  expect(links[0].getAttribute("target")).toBe("_blank");
  expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
  expect(screen.getByRole("button", { name: DEMO })).toBeTruthy();
  expect(screen.getByRole("button", { name: SNAPSHOT })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "JSON" })).toBeNull();

  await act(async () => {});
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: SNAPSHOT }));
  expect(onDebugSnapshot).toHaveBeenCalledTimes(1);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: DEMO }));
  expect(onReplayDemo).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("group", { name: "Debug tools" })).toBeTruthy();
});

it("does not flash an abnormal indicator while the initial health probe is unknown", async () => {
  const probe = deferred();
  const fetch = vi.fn(() => probe.promise.then(() => healthResponse()));
  vi.stubGlobal("fetch", fetch);
  const { container } = sidebar();

  expect(fetch).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll(".sidebar-debug-dot")).toHaveLength(0);
  expect(screen.queryByRole("link", { name: /Service diagnostics/ })).toBeNull();
  expect(screen.getByRole("button", { name: TRIGGER })).toBeTruthy();
  expectStripClosed();

  probe.resolve();
  await act(async () => {});
  expect(container.querySelectorAll(".sidebar-debug-dot")).toHaveLength(0);
  expect(screen.queryByRole("link", { name: /Service diagnostics/ })).toBeNull();
});

it("keeps both diagnostics icons clear for an info-only report", async () => {
  stubHealth([{ severity: "info" }]);
  const { container } = sidebar();
  await act(async () => {});
  expect(container.querySelector(".sidebar-debug-dot")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  expect(screen.getByRole("link", { name: "Service diagnostics" })).toBeTruthy();
  expect(container.querySelector(".sidebar-debug-dot")).toBeNull();
});

it.each([
  ["offline", []],
  ["unhealthy", [{}]],
  ["unhealthy", [{ severity: "info" }, { severity: "warning" }]],
] as const)(
  "places a single abnormal dot on # when collapsed and moves it to the single Diagnostics entry when expanded (%s)",
  async (state, issues) => {
    const fetch = stubHealth([...issues]);
    const { container } = sidebar(state !== "offline");
    await act(async () => {});

    expect(fetch).toHaveBeenCalledTimes(state === "offline" ? 0 : 1);
    expectStripClosed();
    expect(screen.queryByRole("link", { name: /Service diagnostics/ })).toBeNull();

    // Collapsed: dot appears only on #, with accessible unhealthy/offline text.
    const collapsedTrigger = screen.getByRole("button", {
      name: `Debug tools (service diagnostics ${state})`,
    });
    expect(collapsedTrigger.getAttribute("title")).toBe(
      `Debug tools (service diagnostics ${state})`,
    );
    const collapsedDots = container.querySelectorAll(".sidebar-debug-dot");
    expect(collapsedDots).toHaveLength(1);
    expect(collapsedTrigger.contains(collapsedDots[0])).toBe(true);
    expect(collapsedDots[0].getAttribute("aria-hidden")).toBe("true");

    // Expanded: dot moves from # to the single Diagnostics icon link.
    fireEvent.click(collapsedTrigger);
    const expandedTrigger = screen.getByRole("button", { name: TRIGGER });
    const links = screen.getAllByRole("link", { name: `Service diagnostics (${state})` });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("api/diagnostics?format=text");
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[0].getAttribute("title")).toBe(`Service diagnostics (${state})`);
    expect(screen.queryByRole("link", { name: "JSON" })).toBeNull();

    const expandedDots = container.querySelectorAll(".sidebar-debug-dot");
    expect(expandedDots).toHaveLength(1);
    expect(expandedTrigger.contains(expandedDots[0])).toBe(false);
    expect(links[0].contains(expandedDots[0])).toBe(true);
    expect(expandedDots[0].getAttribute("aria-hidden")).toBe("true");
  },
);

it("surfaces the abnormal indicator when a connected service later becomes degraded", async () => {
  vi.useFakeTimers();
  let issues: object[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(healthResponse(issues))),
  );
  let container!: HTMLElement;
  await act(() => {
    ({ container } = sidebar());
    return Promise.resolve();
  });
  expect(container.querySelectorAll(".sidebar-debug-dot")).toHaveLength(0);
  expect(screen.getByRole("button", { name: TRIGGER })).toBeTruthy();

  issues = [{}];
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  const trigger = screen.getByRole("button", {
    name: "Debug tools (service diagnostics unhealthy)",
  });
  expect(container.querySelectorAll(".sidebar-debug-dot")).toHaveLength(1);
  expect(trigger.contains(container.querySelector(".sidebar-debug-dot"))).toBe(true);
  expect(screen.queryByRole("link", { name: /Service diagnostics/ })).toBeNull();
});
