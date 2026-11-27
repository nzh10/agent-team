// No fetch handler or app cache: Web Push does not change normal navigation.
const root = new URL(self.registration.scope);
async function appWindows() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.filter((client) => {
    const url = new URL(client.url);
    return (
      client.frameType !== "nested" &&
      url.origin === root.origin &&
      (url.pathname === root.pathname || url.pathname === root.pathname + "index.html")
    );
  });
}
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let notice;
      try {
        notice = event.data?.json();
      } catch {
        return;
      }
      if (
        !notice ||
        typeof notice.body !== "string" ||
        !["yourTurn", "failed", "reply", "test"].includes(notice.trigger)
      )
        return;
      if (
        notice.test !== true &&
        (await appWindows()).some((c) => c.visibilityState === "visible" && c.focused)
      )
        return;
      const wsId = typeof notice.wsId === "string" ? notice.wsId : "";
      await self.registration.showNotification("YAAT", {
        body: notice.body,
        tag: `yaat:${wsId}:${notice.trigger}`,
        data: { wsId },
        icon: new URL("icons/icon-192.png", root).href,
      });
    })(),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const wsId = event.notification.data?.wsId,
        url = new URL(root);
      if (typeof wsId === "string" && wsId) url.searchParams.set("ws", wsId);
      const [client] = await appWindows();
      if (client) {
        try {
          await client.focus();
          if (wsId) client.postMessage({ type: "yaat.open-workspace", wsId });
          return;
        } catch {
          /* Window closed during activation. */
        }
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
