import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { request } from "node:https";
import { afterEach, expect, it, vi } from "vitest";
import { PushStore, MAX_SUBSCRIPTIONS } from "../../src/push/store";
import {
  destination,
  endpointUrl,
  InvalidSubscription,
  sendPush,
  type Delivery,
} from "../../src/push/transport";
import { Auth } from "../../src/server/auth";
import { HttpHandler } from "../../src/server/http";
import { PushCues, replyPreview } from "../../src/push/cues";
import { setupProjects } from "./projectHarness";

vi.mock("node:dns/promises", { spy: true });
vi.mock("node:https", { spy: true });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const resolvePublic = () => Promise.resolve({ address: "1.1.1.1", family: 4 });
const receiver = createECDH("prime256v1");
const ua = receiver.generateKeys(),
  auth = randomBytes(16);
const keys = { p256dh: ua.toString("base64url"), auth: auth.toString("base64url") };
function decrypt({ body }: Delivery) {
  const salt = body.subarray(0, 16),
    as = body.subarray(21, 21 + body[20]);
  expect(body.readUInt32BE(16)).toBe(4096);
  expect(as.length).toBe(65);
  const ikm = Buffer.from(
    hkdfSync(
      "sha256",
      receiver.computeSecret(as),
      auth,
      Buffer.concat([Buffer.from("WebPush: info\0"), ua, as]),
      32,
    ),
  );
  const expand = (name: string, n: number) =>
    Buffer.from(hkdfSync("sha256", ikm, salt, `Content-Encoding: ${name}\0`, n));
  const cipher = createDecipheriv("aes-128-gcm", expand("aes128gcm", 16), expand("nonce", 12));
  cipher.setAuthTag(body.subarray(-16));
  const plain = Buffer.concat([cipher.update(body.subarray(21 + as.length, -16)), cipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return JSON.parse(plain.subarray(0, -1).toString()) as unknown;
}
it("authenticates the push API, broadcasts an independently verified Web Push and prunes only gone subscriptions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaat-push-"));
  dirs.push(dir);
  const send = vi.fn((endpoint: string, _wire: Delivery) =>
    Promise.resolve(Number(endpoint.split("/").pop())),
  );
  const endpoint = (status: number) => `https://fcm.googleapis.com/fcm/send/${status}`;
  const resolveFakeIp = (url: URL) =>
    destination(url, () => Promise.resolve([{ address: "198.18.0.144", family: 4 }]));
  let store = new PushStore(dir, send, resolveFakeIp);
  const authn = new Auth(() => ({
    username: "u",
    password: "p",
    session_secret: "s",
    max_age_days: 1,
  }));
  const web = join(__dirname, "../../../webview/public");
  const handler = () =>
    new HttpHandler(
      authn,
      web,
      dir,
      dir,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );
  const server = createServer((req, res) => handler().handle(req, res));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    const sw = await fetch(url + "sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers.get("content-type")).toMatch(/javascript/);
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    expect(sw.headers.get("service-worker-allowed")).toBe("./");
    const anon = await fetch(url + "api/push/public-key");
    expect(anon.status).toBe(401);
    expect((await fetch(url + "?ws=w%2F2", { redirect: "manual" })).headers.get("location")).toBe(
      "login?ws=w%2F2",
    );
    expect(
      (await fetch(url + "index.html?ws=w%2F2", { redirect: "manual" })).headers.get("location"),
    ).toBe("login?ws=w%2F2");
    const login = await fetch(url + "login?ws=w%2F2", {
      method: "POST",
      body: "username=u&password=p",
      redirect: "manual",
    });
    expect(login.headers.get("location")).toBe("./?ws=w%2F2");
    const headers = {
      "Content-Type": "Application/JSON; charset=utf-8",
      Cookie: login.headers.getSetCookie()[0].split(";")[0],
    };
    const post = (action: string, data: unknown) =>
      fetch(url + "api/push/" + action, { method: "POST", headers, body: JSON.stringify(data) });
    const key = (
      (await (await fetch(url + "api/push/public-key", { headers })).json()) as {
        publicKey: string;
      }
    ).publicKey;
    for (const status of [201, 404, 410, 503])
      expect((await post("subscribe", { endpoint: endpoint(status), keys })).status).toBe(200);
    expect(
      (
        await post("subscribe", {
          endpoint: "https://push.example/200",
          keys: { auth: "", p256dh: "bad" },
        })
      ).status,
    ).toBe(400);
    store = new PushStore(dir, send, resolvePublic);
    expect(store.publicKey()).toBe(key);
    expect(await (await post("test", {})).json()).toEqual({
      accepted: 1,
      failed: 1,
      expired: 2,
      errors: { "HTTP 503": 1 },
    });
    const [, wire] = send.mock.calls[0];
    expect(wire.headers).toMatchObject({
      "Content-Encoding": "aes128gcm",
      TTL: "300",
      Urgency: "normal",
    });
    expect(decrypt(wire)).toEqual({ body: "Test notification", trigger: "test", test: true });
    const [, jwt, k] = /^vapid t=(.*), k=(.*)$/.exec(wire.headers.Authorization)!;
    expect(k).toBe(key);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toMatchObject({ alg: "ES256" });
    const claims = JSON.parse(Buffer.from(c, "base64url").toString()) as {
      aud: string;
      exp: number;
    };
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    expect(claims.exp).toBeLessThan(Date.now() / 1000 + 86400);
    const pub = Buffer.from(k, "base64url");
    expect(
      verify(
        "sha256",
        Buffer.from(`${h}.${c}`),
        {
          key: createPublicKey({
            format: "jwk",
            key: {
              kty: "EC",
              crv: "P-256",
              x: pub.subarray(1, 33).toString("base64url"),
              y: pub.subarray(33).toString("base64url"),
            },
          }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(s, "base64url"),
      ),
    ).toBe(true);
    if (process.platform !== "win32")
      for (const file of ["push-vapid.json", "push-subscriptions.json"])
        expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    await post("unsubscribe", { endpoint: endpoint(503) });
    store = new PushStore(dir, send, resolvePublic);
    expect(await (await post("test", {})).json()).toMatchObject({
      accepted: 1,
      expired: 0,
      failed: 0,
    });
    const full = Array.from({ length: MAX_SUBSCRIPTIONS }, (_, i) => ({
      endpoint: `https://push.example/sub/${i}`,
      keys,
    }));
    writeFileSync(join(dir, "push-subscriptions.json"), JSON.stringify(full));
    store = new PushStore(dir, send, resolvePublic);
    expect((await post("subscribe", full[0])).status).toBe(200);
    expect((await post("subscribe", { endpoint: "https://push.example/extra", keys })).status).toBe(
      409,
    );
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});
it("rejects private addresses, local names, non-HTTPS endpoints and mixed DNS answers before delivery", async () => {
  for (const url of [
    "http://example.com",
    "https://localhost",
    "https://printer.local",
    "https://127.0.0.1",
    "https://10.1.2.3",
    "https://169.254.169.254",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://[fc00::1]",
  ])
    expect(() => endpointUrl(url)).toThrow();
  const url = endpointUrl("https://push.example/abc");
  await expect(
    destination(url, async () => [await resolvePublic(), { address: "172.16.0.1", family: 4 }]),
  ).rejects.toThrow();
});
it("allows RFC 2544 DNS answers for public HTTPS names but not literal or mixed destinations", async () => {
  const fake = { address: "198.18.0.144", family: 4 };
  const resolveFake = () => Promise.resolve([fake]);
  expect(() => endpointUrl("https://198.18.0.144/abc")).toThrow(InvalidSubscription);
  await expect(destination(new URL("https://printer.local"), resolveFake)).rejects.toThrow(
    InvalidSubscription,
  );
  const url = endpointUrl("https://fcm.googleapis.com/fcm/send/abc");
  await expect(destination(url, resolveFake)).resolves.toEqual(fake);
  for (const address of ["127.0.0.1", "169.254.169.254", "100.64.0.1", "224.0.0.1"]) {
    await expect(
      destination(url, () => Promise.resolve([fake, { address, family: 4 }])),
    ).rejects.toThrow(InvalidSubscription);
  }
  await expect(
    destination(url, () => Promise.resolve([fake, { address: "::ffff:198.18.0.144", family: 6 }])),
  ).rejects.toThrow(InvalidSubscription);
});
it("pins fake-IP delivery to the resolved address with TLS verification of the endpoint host", async () => {
  const host = "fcm.googleapis.com";
  const address = "198.18.0.144";
  const lookupAll: (
    host: string,
    options: { all: true },
  ) => Promise<{ address: string; family: number }[]> = lookup;
  const dns = vi.mocked(lookupAll).mockResolvedValueOnce([{ address, family: 4 }]);
  const stopped = new Error("No network in this test");
  const https = vi.mocked(request).mockImplementationOnce(() => {
    throw stopped;
  });
  try {
    await expect(
      sendPush(`https://${host}/fcm/send/abc`, { headers: {}, body: Buffer.alloc(0) }),
    ).rejects.toBe(stopped);
    expect(dns).toHaveBeenCalledExactlyOnceWith(host, { all: true });
    expect(https).toHaveBeenCalledTimes(1);
    const [url, options] = https.mock.calls[0];
    expect(url).toMatchObject({ hostname: host, protocol: "https:" });
    expect(options).toMatchObject({
      agent: false,
      rejectUnauthorized: true,
      servername: host,
      family: 4,
    });
    expect(options?.checkServerIdentity).toBeUndefined(); // Keep Node's default identity check.
    const callback = vi.fn();
    options?.lookup?.(host, { family: 4 }, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, address, 4);
  } finally {
    dns.mockRestore();
    https.mockRestore();
  }
});
it("extracts at most two plain sentences and falls back when there is no suitable text", () => {
  expect(replyPreview("## **Ready**. See [details](https://example.org). Extra.")).toBe(
    "Ready. See details.",
  );
  expect(replyPreview("```ts\ncode\n```")).toBe("Lead replied");
  expect(replyPreview("Finished " + "x".repeat(400))).toHaveLength(180);
});
it("routes live attention only on eligible, non-retrying terminal transitions", () => {
  const { lead } = setupProjects().create("demo");
  const agent = lead.resolveAgent()!;
  const input = {
    id: "input",
    kind: "user" as const,
    agentId: null,
    content: "question",
    status: "done" as const,
    timestamp: 1,
  };
  lead.messages.push(input);
  agent.input = { id: input.id, replies: ["reply"] };
  const reply = { ...input, kind: "agent" as const, id: "reply", content: "**All done**." };
  let live = false,
    atRest = false;
  const emit = vi.fn();
  const cues = new PushCues(
    () => live,
    () => (atRest ? "ready" : "busy"),
    emit,
  );
  const terminal = () => cues.terminal(lead, agent.info.id, reply, false);
  terminal();
  live = true;
  terminal();
  terminal();
  expect(emit.mock.calls.flat()).toEqual([{ wsId: lead.id, trigger: "reply", body: "All done." }]);
  const workerInput = {
    ...input,
    id: "final",
    from: { role: "worker" as const, workspaceId: "worker", name: "Worker" },
  };
  lead.messages.push(workerInput);
  agent.input = { id: "final", replies: [] };
  terminal();
  expect(emit).toHaveBeenCalledTimes(1);
  atRest = true;
  cues.flush(lead);
  cues.flush(lead);
  expect(emit).toHaveBeenCalledTimes(2);
  const fail = () => cues.terminal(lead, agent.info.id, { ...reply, status: "error" }, false);
  agent.retryPending = true;
  fail();
  agent.retryPending = false;
  lead.leadOutage = {
    id: "o",
    agentId: agent.info.id,
    started: 1,
    next: 2,
    deadline: 3,
    attempts: 0,
    reason: "network",
    phase: "waiting",
    supersedes: [],
    retainedReports: [],
  };
  fail();
  delete lead.leadOutage;
  lead.archivedAt = 1;
  fail();
  lead.archivedAt = null;
  expect(emit).toHaveBeenCalledTimes(2);
  fail();
  expect(emit).toHaveBeenLastCalledWith({
    wsId: lead.id,
    trigger: "failed",
    body: "Run failed — needs attention",
  });
  cues.waiting(lead);
  expect(emit).toHaveBeenCalledTimes(3);
  lead.projectLink!.role = "worker";
  cues.waiting(lead);
  expect(emit).toHaveBeenLastCalledWith({
    wsId: lead.id,
    trigger: "yourTurn",
    body: "Waiting for your reply",
  });
});
