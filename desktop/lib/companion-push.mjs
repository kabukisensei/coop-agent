// Phone notices (master plan row MC11, desktop/COMPANION.md "Notices"). When
// coop asks a question or finishes a turn and a paired phone's page is closed,
// the window sends that phone a web push with NO payload: the push service
// (Apple's or Google's) learns only that something happened, never what. The
// phone's service worker shows a fixed "coop is waiting for you" line; the
// session itself is read only when the page opens, over the tailnet.
//
// Standard Web Push with VAPID (RFC 8292): one P-256 key pair per Windows
// user, kept beside the device list; a short ES256 token per request. No
// payload means no message encryption (RFC 8291) is needed.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname } from "node:path";

/** Push services a subscription may point at; anything else is refused (no requests to arbitrary hosts). */
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/];
export const PUSH_ENDPOINT_CHARS = 1000;
const TOKEN_SECONDS = 12 * 3600;

/** Whether `endpoint` is an https URL on a known push service. */
export function pushEndpointOk(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > PUSH_ENDPOINT_CHARS) return false;
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  return url.protocol === "https:" && !url.username && !url.password && !url.port && PUSH_HOSTS.some((host) => host.test(url.hostname));
}

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

/** The VAPID key pair in `file`, made on first use. Returns `{ publicKey (base64url, raw 65 bytes), privateKey (KeyObject) }`. */
export function loadVapid(file) {
  let jwk = null;
  try { if (existsSync(file)) jwk = JSON.parse(readFileSync(file, "utf8")).jwk; } catch { jwk = null; }
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    jwk = privateKey.export({ format: "jwk" });
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, jwk })}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
  }
  const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
  const pub = createPublicKey(privateKey).export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);
  return { publicKey: b64url(raw), privateKey };
}

/** The Authorization header for one push to `endpoint`: `vapid t=<ES256 token>, k=<public key>`. */
export function vapidAuthorization(endpoint, { publicKey, privateKey }, subject, nowMs = Date.now()) {
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + TOKEN_SECONDS, sub: subject }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey}`;
}

/**
 * The sender the companion server uses: `send(endpoint)` resolves to the push
 * service's HTTP status (0 when it could not be reached). `subject` is the
 * companion's own https origin, which Apple requires as the VAPID contact.
 */
export function createPushSender({ keys, subject, request = httpsRequest, now = Date.now, timeoutMs = 10_000 }) {
  return {
    publicKey: keys.publicKey,
    send(endpoint) {
      if (!pushEndpointOk(endpoint)) return Promise.resolve(0);
      return new Promise((resolve) => {
        const req = request(endpoint, {
          method: "POST",
          timeout: timeoutMs,
          headers: { Authorization: vapidAuthorization(endpoint, keys, subject, now()), TTL: "3600", Urgency: "high", "Content-Length": "0" },
        }, (res) => { res.resume(); resolve(res.statusCode || 0); });
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve(0));
        req.end();
      });
    },
  };
}
