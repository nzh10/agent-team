import { ECDH, generateKeyPairSync, randomUUID, type webcrypto } from "node:crypto";
import { readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  destination,
  encodePush,
  endpointUrl,
  InvalidSubscription,
  rawKey,
  sendPush,
  type Subscription,
} from "./transport";

export interface PushNotice {
  wsId?: string;
  trigger: "yourTurn" | "failed" | "reply" | "test";
  body: string;
  test?: true;
}
function load<T>(file: string, fallback: () => T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback();
    throw e;
  }
}
function save(file: string, value: unknown) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}
export class SubscriptionLimit extends Error {}
// Reject new registrations at capacity; never evict a working device silently.
export const MAX_SUBSCRIPTIONS = 1024;
export class PushStore {
  private key?: webcrypto.JsonWebKey;
  private subs?: Map<string, Subscription>;
  constructor(
    private baseDir: string,
    private send = sendPush,
    private resolve = destination,
  ) {}
  private get signingKey() {
    const file = join(this.baseDir, "push-vapid.json");
    return (this.key ??= load(file, () => {
      const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
        format: "jwk",
      });
      save(file, key);
      return key;
    }));
  }
  publicKey() {
    return rawKey(this.signingKey).toString("base64url");
  }
  private get subscriptions() {
    return (this.subs ??= new Map(
      load<Subscription[]>(join(this.baseDir, "push-subscriptions.json"), () => []).map((s) => [
        s.endpoint,
        s,
      ]),
    ));
  }
  private commit(next: Map<string, Subscription>) {
    save(join(this.baseDir, "push-subscriptions.json"), Array.from(next.values()));
    this.subs = next;
  }
  async subscribe(value: unknown) {
    const sub = value as Partial<Subscription> | null;
    const url = endpointUrl(sub?.endpoint);
    const keys = sub?.keys;
    if (
      !keys ||
      typeof keys.auth !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/.test(keys.auth) ||
      typeof keys.p256dh !== "string" ||
      !/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh)
    )
      throw new InvalidSubscription();
    const point = Buffer.from(keys.p256dh, "base64url");
    try {
      if (point[0] !== 4) throw new Error();
      ECDH.convertKey(point, "prime256v1");
    } catch {
      throw new InvalidSubscription();
    }
    await this.resolve(url);
    const old = this.subscriptions.get(url.href);
    if (!old && this.subscriptions.size >= MAX_SUBSCRIPTIONS) throw new SubscriptionLimit();
    if (old?.keys.auth === keys.auth && old.keys.p256dh === keys.p256dh) return;
    this.commit(
      new Map(this.subscriptions).set(url.href, {
        endpoint: url.href,
        keys: { auth: keys.auth, p256dh: keys.p256dh },
      }),
    );
  }
  unsubscribe(endpoint: unknown) {
    const key = endpointUrl(endpoint).href;
    const next = new Map(this.subscriptions);
    if (next.delete(key)) this.commit(next);
  }
  async broadcast(notice: PushNotice) {
    const counts = { accepted: 0, expired: 0, failed: 0, errors: {} as Record<string, number> };
    const queue = [...this.subscriptions.values()].values();
    const run = async () => {
      for (const sub of queue) {
        let error = "Transport error";
        try {
          const status = await this.send(
            sub.endpoint,
            encodePush(sub, this.signingKey, JSON.stringify(notice)),
          );
          if (status >= 200 && status < 300) {
            counts.accepted++;
            continue;
          }
          if (status === 404 || status === 410) {
            if (this.subscriptions.get(sub.endpoint) === sub) this.unsubscribe(sub.endpoint);
            counts.expired++;
            continue;
          }
          error = `HTTP ${status}`;
        } catch {
          /* Endpoint URLs and auth secrets must not appear in diagnostics. */
        }
        counts.failed++;
        counts.errors[error] = (counts.errors[error] ?? 0) + 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.subscriptions.size, 8) }, run));
    return counts;
  }
}
