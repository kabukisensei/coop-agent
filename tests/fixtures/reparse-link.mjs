import { statSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";

// Exercise real native link rejection without requiring Windows Developer Mode
// or elevation. Windows uses an NTFS directory junction; POSIX uses a symlink.
// For a file target the junction points at its containing directory. Callers
// only test rejection, never read fixture content through this link.
export function createReparseLink(target, link, type) {
  if (process.platform === "win32") {
    symlinkSync(statSync(target).isDirectory() ? target : dirname(target), link, "junction");
  } else {
    symlinkSync(target, link, type);
  }
}
