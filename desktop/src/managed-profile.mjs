import { randomBytes } from "node:crypto";
// Select a durable Desktop profile without copying, merging, or rewriting Pi data.
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const STABLE = "profile-v1";
const VERSION = "\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?";
const LEGACY = new RegExp(`^coop-${VERSION}-pi-${VERSION}$`);
function validName(name) { return name === STABLE || (typeof name === "string" && name.length < 200 && LEGACY.test(name)); }
function directory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Managed Desktop profile must be a real directory, not a link.");
  return path;
}
function readPointer(pointer, root) {
  const fd = openSync(pointer, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || lstatSync(pointer).isSymbolicLink()) throw new Error("Managed Desktop profile pointer is invalid.");
    let value;
    try { value = JSON.parse(readFileSync(fd, "utf8")); }
    catch { throw new Error("Managed Desktop profile pointer is unreadable; it was preserved for recovery."); }
    if (value?.schemaVersion !== 1 || !validName(value.directory)) throw new Error("Managed Desktop profile pointer is invalid; it was preserved for recovery.");
    const selected = join(root, value.directory);
    if (!existsSync(selected)) throw new Error("The selected Desktop profile is missing. Restore it before opening this profile.");
    return directory(selected);
  } finally { closeSync(fd); }
}

export function resolveManagedDesktopProfile(userData, { selectedDirectory } = {}) {
  if (typeof userData !== "string" || !isAbsolute(userData) || /[\0\r\n]/.test(userData)) throw new Error("Desktop user-data path is invalid.");
  const root = join(userData, "managed-agent");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  directory(root);
  const pointer = join(root, "active-profile.json");
  // lstat catches dangling links too. Never replace an invalid existing pointer.
  let pointerPresent = false;
  try { lstatSync(pointer); pointerPresent = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (pointerPresent) return readPointer(pointer, root);
  const candidates = readdirSync(root).filter(validName).sort().map(name => directory(join(root, name)));
  let selected;
  if (selectedDirectory !== undefined) {
    if (typeof selectedDirectory !== "string" || !isAbsolute(selectedDirectory) || !candidates.includes(resolve(selectedDirectory))) throw new Error("Choose one of the existing Desktop profiles in this app's managed-agent folder.");
    selected = resolve(selectedDirectory);
  } else if (candidates.length > 1) {
    const error = new Error("Several existing Desktop profiles were found. Choose the one whose sign-in and conversations you want to keep.");
    error.code = "PROFILE_SELECTION_REQUIRED";
    error.root = root;
    error.candidates = candidates;
    throw error;
  } else selected = candidates[0] || join(root, STABLE);
  if (!existsSync(selected)) mkdirSync(selected, { mode: 0o700 });
  directory(selected);
  const name = selected.slice(root.length + 1);
  const temporary = join(root, `.active-profile-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, directory: name }, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    linkSync(temporary, pointer); // Publish a complete file exclusively, without overwriting another choice.
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // A concurrent opener won. Use its complete valid choice, never overwrite it.
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return readPointer(pointer, root);
}
