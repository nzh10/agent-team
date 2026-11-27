// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
function harness() {
  const scope = "https://example.org/panel/";
  const client = {
    url: scope,
    focused: true,
    visibilityState: "visible",
    focus: vi.fn(),
    postMessage: vi.fn(),
  };
  const matchAll = vi.fn(() => Promise.resolve([client]));
  const openWindow = vi.fn(),
    showNotification = vi.fn();
  const listeners = new Map<string, (e: unknown) => void>();
  runInNewContext(source, {
    URL,
    self: {
      clients: { matchAll, openWindow },
      registration: { scope, showNotification },
      addEventListener: (name: string, cb: (e: unknown) => void) => listeners.set(name, cb),
    },
  });
  function fire(name: string, event: object) {
    let work: Promise<void> | undefined;
    listeners.get(name)!({
      ...event,
      waitUntil: (p: Promise<void>) => {
        work = p;
      },
    });
    return work;
  }
  const push = (test = false) =>
    fire("push", {
      data: { json: () => ({ test, wsId: "w/2", body: "Ready.", trigger: "reply" }) },
    });
  const close = vi.fn();
  const click = () => fire("notificationclick", { notification: { close, data: { wsId: "w/2" } } });
  return { client, scope, matchAll, openWindow, showNotification, close, push, click };
}
it("suppresses only for visible focused windows of this app; a test push always shows", async () => {
  const t = harness();
  t.matchAll.mockResolvedValueOnce([{ ...t.client, focused: false }, t.client]);
  await t.push();
  expect(t.matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
  expect(t.showNotification).not.toHaveBeenCalled();
  await t.push(true);
  t.client.visibilityState = "hidden";
  await t.push();
  t.client.visibilityState = "visible";
  t.client.focused = false;
  await t.push();
  t.client.focused = true;
  t.client.url = t.scope + "uploads/preview";
  await t.push();
  expect(t.showNotification).toHaveBeenCalledTimes(4);
  expect(t.showNotification).toHaveBeenLastCalledWith(
    "YAAT",
    expect.objectContaining({ tag: "yaat:w/2:reply", data: { wsId: "w/2" } }),
  );
});
it("focuses and selects without reloading; cold opens the encoded workspace inside the mount", async () => {
  const t = harness();
  await t.click();
  expect(t.client.focus).toHaveBeenCalled();
  expect(t.client.postMessage).toHaveBeenCalledWith({ type: "yaat.open-workspace", wsId: "w/2" });
  expect(t.openWindow).not.toHaveBeenCalled();
  t.matchAll.mockResolvedValue([]);
  await t.click();
  expect(t.close).toHaveBeenCalledTimes(2);
  expect(t.openWindow).toHaveBeenCalledWith(t.scope + "?ws=w%2F2");
});
