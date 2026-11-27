import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
  type webcrypto,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

export interface Subscription {
  endpoint: string;
  keys: { auth: string; p256dh: string };
}
export interface Delivery {
  headers: Record<string, string>;
  body: Buffer;
}

const blocked = new BlockList();
for (const cidr of [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/3",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
]) {
  const [ip, bits] = cidr.split("/");
  blocked.addSubnet(ip, Number(bits), ip.includes(":") ? "ipv6" : "ipv4");
}
const fakeIp = new BlockList();
fakeIp.addSubnet("198.18.0.0", 15, "ipv4");

function routable(ip: string) {
  return isIP(ip) === 4
    ? !blocked.check(ip, "ipv4")
    : isIP(ip) === 6 && /^[23]/.test(ip) && !blocked.check(ip, "ipv6");
}
export class InvalidSubscription extends Error {}
export function endpointUrl(endpoint: unknown): URL {
  if (typeof endpoint !== "string" || endpoint.length > 4096) throw new InvalidSubscription();
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InvalidSubscription();
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (isIP(host)
      ? !routable(host)
      : !host.includes(".") || /\.(?:localhost|local|internal)$/.test(host))
  )
    throw new InvalidSubscription();
  return url;
}
export async function destination(
  url: URL,
  resolve: (
    host: string,
    options: { all: true },
  ) => Promise<{ address: string; family: number }[]> = lookup,
) {
  const host = endpointUrl(url.href).hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await resolve(host, { all: true });
  // A TUN resolver can use RFC 2544 addresses for HTTPS names. Never accept them as
  // literal endpoints; sendPush pins the address and authenticates the original name.
  if (
    !addresses.length ||
    !addresses.every(
      (a) =>
        a.family === isIP(a.address) &&
        (routable(a.address) || (!family && a.family === 4 && fakeIp.check(a.address, "ipv4"))),
    )
  )
    throw new InvalidSubscription();
  return addresses[0];
}
// Pin this connection to the checked address; TLS still authenticates the URL host.
// A separate DNS preflight followed by fetch would permit rebinding. Do not follow redirects.
export async function sendPush(endpoint: string, { headers, body }: Delivery): Promise<number> {
  const url = endpointUrl(endpoint),
    address = await destination(url);
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers,
        agent: false,
        rejectUnauthorized: true,
        servername: isIP(host) ? undefined : host,
        family: address.family,
        lookup: (_host, _opts, cb) => cb(null, address.address, address.family),
        signal: AbortSignal.timeout(10_000),
      },
      (res) => {
        resolve(res.statusCode ?? 0);
        res.destroy();
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
export function rawKey(key: webcrypto.JsonWebKey): Buffer {
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(key.x!, "base64url"),
    Buffer.from(key.y!, "base64url"),
  ]);
}
function derive(secret: Buffer, salt: Buffer, info: string | Buffer, n: number) {
  return Buffer.from(hkdfSync("sha256", secret, salt, info, n));
}
export function encodePush(sub: Subscription, key: webcrypto.JsonWebKey, text: string): Delivery {
  const plain = Buffer.from(text);
  if (plain.length > 3993) throw new RangeError("Push message too large");
  const ec = createECDH("prime256v1"),
    server = ec.generateKeys(),
    client = Buffer.from(sub.keys.p256dh, "base64url");
  const ikm = derive(
    ec.computeSecret(client),
    Buffer.from(sub.keys.auth, "base64url"),
    Buffer.concat([Buffer.from("WebPush: info\0"), client, server]),
    32,
  );
  const salt = randomBytes(16),
    cek = derive(ikm, salt, "Content-Encoding: aes128gcm\0", 16),
    nonce = derive(ikm, salt, "Content-Encoding: nonce\0", 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const header = Buffer.alloc(5);
  header.writeUInt32BE(4096);
  header[4] = server.length;
  const body = Buffer.concat([
    salt,
    header,
    server,
    cipher.update(plain),
    cipher.update(Buffer.from([2])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const claims = `${b64({ typ: "JWT", alg: "ES256" })}.${b64({ aud: new URL(sub.endpoint).origin, exp: Math.floor(Date.now() / 1000) + 3600, sub: "mailto:admin@yaat.invalid" })}`;
  const signature = sign("sha256", Buffer.from(claims), {
    key: createPrivateKey({ format: "jwk", key }),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    body,
    headers: {
      Authorization: `vapid t=${claims}.${signature}, k=${rawKey(key).toString("base64url")}`,
      TTL: "300",
      Urgency: "normal",
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
    },
  };
}
