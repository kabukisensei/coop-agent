// The phones paired with this Windows user (master plan row MC2, contract in
// desktop/COMPANION.md, "Identity"). One JSON file in the user's coop profile,
// `<profile>\companion\devices.json`, holding each device's name, the Windows
// user and client it was paired on, its times and the SHA-256 of its secret;
// the secret itself is only ever in the phone's cookie. Pairing codes live in
// memory: shown in the window, 5 minutes, one use, dead after 5 wrong tries.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LIMITS, newDeviceSecret, newPairingCode } from "./companion-protocol.mjs";

const TOUCH_MS = 60_000;
const MAX_DEVICES = 20;

const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export class DeviceStore {
  constructor(file, { now = Date.now, random = randomBytes } = {}) {
    Object.assign(this, { file, now, random });
    this.pairing = null;
    this.devices = this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.file)) return [];
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(data.devices) ? data.devices.filter((d) => d && typeof d.id === "string" && typeof d.secretHash === "string") : [];
    } catch {
      return [];
    }
  }

  #save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, devices: this.devices }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.file);
  }

  /** The devices as the window lists them, without hashes. */
  list() {
    return this.devices.filter((d) => !d.revokedAt).map(({ id, name, windowsUser, client, createdAt, lastSeenAt }) => ({ id, name, windowsUser, client, createdAt, lastSeenAt }));
  }

  get(id) {
    return this.devices.find((d) => d.id === id);
  }

  /** A new pairing code for this binding; any earlier code dies. */
  startPairing({ windowsUser, client }) {
    this.pairing = { code: newPairingCode(this.random), windowsUser, client, expiresAt: this.now() + LIMITS.pairingCodeMs, tries: 0 };
    return { code: this.pairing.code, expiresAt: this.pairing.expiresAt };
  }

  cancelPairing() {
    this.pairing = null;
  }

  /**
   * Trade a code for a device. Returns `{ device, secret }` or `{ error }`
   * ("not-paired" for a wrong, used or expired code).
   */
  redeem(code, deviceName) {
    const p = this.pairing;
    if (!p || p.expiresAt <= this.now()) { this.pairing = null; return { error: "not-paired" }; }
    if (!sameText(code, p.code)) {
      p.tries += 1;
      if (p.tries >= LIMITS.pairFailuresPerHour) this.pairing = null;
      return { error: "not-paired" };
    }
    this.pairing = null;
    const { secret, secretHash } = newDeviceSecret(this.random);
    const now = this.now();
    const device = { id: this.random(12).toString("base64url"), name: deviceName, secretHash, windowsUser: p.windowsUser, client: p.client, createdAt: now, lastSeenAt: now, revokedAt: null };
    // Removed and expired devices are dropped as new ones arrive.
    this.devices = this.devices.filter((d) => !d.revokedAt && now - d.createdAt <= LIMITS.deviceMaxMs).slice(-(MAX_DEVICES - 1));
    this.devices.push(device);
    this.#save();
    return { device, secret };
  }

  /** Record a use; written at most once a minute per device. */
  touch(id) {
    const device = this.get(id);
    if (!device) return;
    const now = this.now();
    if (now - device.lastSeenAt < TOUCH_MS) return;
    device.lastSeenAt = now;
    try { this.#save(); } catch { /* the next touch writes it */ }
  }

  /** Turn notices on (a push endpoint) or off (null) for one device (MC11). */
  setPush(id, endpoint) {
    const device = this.get(id);
    if (!device || device.revokedAt) return false;
    if (endpoint) device.push = { endpoint, at: this.now() };
    else delete device.push;
    this.#save();
    return true;
  }

  /** Remove one device (or every device with id "*"). Returns the ids removed. */
  revoke(id) {
    const now = this.now();
    const removed = [];
    for (const device of this.devices) {
      if (!device.revokedAt && (id === "*" || device.id === id)) { device.revokedAt = now; removed.push(device.id); }
    }
    if (removed.length) this.#save();
    return removed;
  }
}
