import { useEffect, useRef, useState } from "react";

export function pushGuidance() {
  if (!window.isSecureContext) return "Use HTTPS to enable notifications";
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (
    ios &&
    !(navigator as Navigator & { standalone?: boolean }).standalone &&
    !window.matchMedia?.("(display-mode: standalone)").matches
  )
    return "Add YAAT to your Home Screen to enable notifications";
  if (!("Notification" in window) || !("PushManager" in window) || !navigator.serviceWorker)
    return "Notifications are not supported in this browser";
  if (Notification.permission === "denied") return "Notifications are blocked in browser settings";
  return "";
}
function applicationKey(key: string) {
  return Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
}
class PushApiError extends Error {}

// Only display fixed diagnostics from the push API, never proxy or transport details.
const pushDiagnostics = new Set([
  "Invalid push subscription",
  "Subscription limit reached",
  "Push service unavailable",
  "No such push action",
  "Send JSON",
  "Too large",
  "Invalid JSON",
]);

type PushStatus = { text: string; tone?: "saved" | "error" };

function failure(error: unknown, fallback: string) {
  return error instanceof PushApiError ? error.message : fallback;
}

async function api<T = unknown>(action: string, body?: unknown) {
  const r = await fetch(
    `api/push/${action}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!r.ok) {
    if (r.status === 401) throw new PushApiError("Sign in to manage notifications");
    const data: unknown = await r.json().catch(() => null);
    if (data && typeof data === "object" && "error" in data) {
      const { error } = data;
      if (typeof error === "string" && pushDiagnostics.has(error)) throw new PushApiError(error);
    }
    throw new Error("Push service unavailable");
  }
  return r.json() as Promise<T>;
}
export function usePush(connected: boolean) {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();
  const stale = useRef<PushSubscription | null>(null);
  const [key, setKey] = useState("");
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [status, setStatus] = useState<PushStatus>();
  const latestAction = useRef(0);
  function startAction() {
    const id = ++latestAction.current;
    return (text: string, tone?: PushStatus["tone"]) => {
      if (latestAction.current === id) setStatus(text ? { text, tone } : undefined);
    };
  }
  const [busy, setBusy] = useState(false),
    [testing, setTesting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const guidance = pushGuidance();
  useEffect(() => {
    if (!connected || guidance) return;
    let live = true;
    const id = latestAction.current;
    const init = async () => {
      // Prepare the worker and application key before the bell gesture, including on iOS.
      await navigator.serviceWorker.register("./sw.js", { scope: "./", updateViaCache: "none" });
      const [reg, { publicKey }] = await Promise.all([
        navigator.serviceWorker.ready,
        api<{ publicKey: string }>("public-key"),
      ]);
      const existing = await reg.pushManager.getSubscription();
      if (!live) return;
      const bound = existing?.options?.applicationServerKey;
      const current = applicationKey(publicKey);
      const mismatch =
        bound &&
        (bound.byteLength !== current.byteLength ||
          new Uint8Array(bound).some((byte, i) => byte !== current[i]));
      // Replacing an old signing key requires a fresh browser subscription and a gesture.
      stale.current = mismatch ? existing : null;
      if (existing && !mismatch) await api("subscribe", existing.toJSON());
      if (live) {
        setRegistration(reg);
        setKey(publicKey);
        setSub(mismatch ? null : existing);
        if (latestAction.current === id) {
          setStatus(
            mismatch
              ? { text: "Notification key changed. Enable notifications again." }
              : undefined,
          );
        }
      }
    };
    void init().catch((error: unknown) => {
      if (live) {
        setRegistration(undefined);
        if (latestAction.current === id) {
          setStatus({
            text: failure(error, "Notifications unavailable. Click to retry."),
            tone: "error",
          });
        }
      }
    });
    return () => {
      live = false;
    };
  }, [guidance, connected, attempt]);
  async function toggle() {
    if (busy) return;
    const report = startAction();
    if (guidance || !connected) {
      report(guidance || "Push service offline", "error");
      return true;
    }
    if (!registration || !key) {
      report("Preparing notifications…");
      setAttempt((n) => n + 1);
      return true;
    }
    setBusy(true);
    report(sub ? "Turning notifications off…" : "Turning notifications on…");
    try {
      if (sub) {
        await api("unsubscribe", { endpoint: sub.endpoint });
        await sub.unsubscribe();
        setSub(null);
        report("Notifications off", "saved");
      } else {
        if (
          Notification.permission !== "granted" &&
          (await Notification.requestPermission()) !== "granted"
        ) {
          report(pushGuidance() || "Permission not granted", "error");
          return true;
        }
        if (stale.current) {
          await api("unsubscribe", { endpoint: stale.current.endpoint });
          await stale.current.unsubscribe();
          stale.current = null;
        }
        const next = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationKey(key),
        });
        try {
          await api("subscribe", next.toJSON());
        } catch (error) {
          // Keep the server diagnostic even if the browser cannot undo the subscription.
          await next.unsubscribe().catch(() => {});
          throw error;
        }
        setSub(next);
        report("Notifications on", "saved");
      }
    } catch (error) {
      report(failure(error, "Notification update failed. Try again."), "error");
      return true;
    } finally {
      setBusy(false);
    }
  }
  async function testPush() {
    if (testing || !connected) return;
    const report = startAction();
    setTesting(true);
    report("Sending test push…");
    try {
      const { accepted, expired, failed } = await api<{
        accepted: number;
        expired: number;
        failed: number;
      }>("test", {});
      // Put problems first so they stay visible when a narrow strip truncates the status.
      const counts = [
        failed && `${failed} failed`,
        expired && `${expired} expired`,
        accepted && `${accepted} accepted`,
      ].filter(Boolean);
      if (counts.length) report(counts.join(" · "), failed || expired ? "error" : "saved");
      else report(sub || guidance ? "No subscribed devices" : "Enable notifications first");
    } catch (error) {
      report(failure(error, "Test push failed"), "error");
    } finally {
      setTesting(false);
    }
  }
  const hint =
    guidance ||
    (!connected
      ? "Push service offline"
      : !registration
        ? status?.text || "Preparing notifications…"
        : sub
          ? "Turn notifications off"
          : "Turn notifications on");
  return {
    subscribed: !!sub && !guidance,
    hint,
    status,
    busy,
    testing,
    toggle,
    testPush,
    clearStatus: () => startAction()(""),
    unavailable: !!guidance || !connected,
  };
}
