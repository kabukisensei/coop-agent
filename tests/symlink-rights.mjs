// Probe once whether this account can create a file symlink in a temp dir.
// Windows without Developer Mode or an administrator token throws EPERM;
// some filesystems throw EACCES / ENOSYS / EOPNOTSUPP. Guardrail tests skip
// only their symlink cases when this returns false; other errors still throw.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UNSUPPORTED = new Set(["EPERM", "EACCES", "ENOSYS", "EOPNOTSUPP", "ENOTSUP"]);

let cached;

export function canCreateFileSymlink() {
  if (cached !== undefined) return cached;
  const dir = fs.mkdtempSync(join(tmpdir(), "coop-symlink-probe-"));
  try {
    fs.writeFileSync(join(dir, "target"), "x");
    fs.symlinkSync(join(dir, "target"), join(dir, "link"));
    cached = true;
  } catch (err) {
    if (!UNSUPPORTED.has(err?.code)) throw err;
    cached = false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return cached;
}
