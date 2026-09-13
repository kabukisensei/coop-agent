import { isAbsolute } from "node:path";
import { runUpdateCommand } from "./update-installer.mjs";

// Darwin's renamex_np(RENAME_SWAP | RENAME_NOFOLLOW_ANY), from sys/stdio.h.
// Python is the verified bundled interpreter in the stable prepared release,
// outside both directories being exchanged. No compiler or system Python needed.
const SCRIPT = `import ctypes, os, stat, sys
left, right = sys.argv[1:]
a, b = os.lstat(left), os.lstat(right)
if not stat.S_ISDIR(a.st_mode) or not stat.S_ISDIR(b.st_mode) or a.st_dev != b.st_dev:
    raise RuntimeError("Swap requires directories on one filesystem")
libc = ctypes.CDLL(None, use_errno=True)
swap = libc.renamex_np
swap.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
swap.restype = ctypes.c_int
if swap(os.fsencode(left), os.fsencode(right), 0x00000012) != 0:
    raise OSError(ctypes.get_errno(), "Atomic application swap failed")
`;

export async function swapMacDirectories(left, right, { pythonPath, signal, platform = process.platform, execute = runUpdateCommand } = {}) {
  if (platform !== "darwin") throw new Error("Atomic application swap requires macOS.");
  for (const path of [left, right, pythonPath]) {
    if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error("Atomic application swap path is invalid.");
  }
  await execute(pythonPath, ["-I", "-B", "-c", SCRIPT, left, right], { signal });
}
