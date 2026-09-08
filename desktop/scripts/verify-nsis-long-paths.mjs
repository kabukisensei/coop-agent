// Real NSIS/NTFS regression checks. Run on Windows with the packaged NSIS compiler.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, access, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("This acceptance check requires native Windows.");
const [compiler, parent] = process.argv.slice(2);
if (!compiler || !parent) throw new Error("Usage: node desktop/scripts/verify-nsis-long-paths.mjs <makensis.exe> <evidence-directory>");
const root = await mkdtemp(join(resolve(parent), "nsis-uninstall-"));
const include = fileURLToPath(new URL("../build/windows-uninstall.nsh", import.meta.url));
const nsis = value => value.replaceAll("/", "\\").replaceAll("$", "$$");
const exists = async path => { try { await access(path); return true; } catch { return false; } };
function run(exe, args) {
  const result = spawnSync(exe, args, { encoding: "utf8", windowsHide: true, timeout: 60000 });
  if (result.error || result.status !== 0) throw new Error(`${exe}: ${result.error || result.status}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const receipts = [];
for (const scenario of ["success", "locked", "junction"]) {
  const locked = scenario === "locked";
  const caseRoot = join(root, scenario);
  const app = join(caseRoot, "application"), temp = join(caseRoot, "temp");
  const nested = join(app, "m".repeat(100), "n".repeat(100));
  await mkdir(nested, { recursive: true }); await mkdir(temp);
  const files = [join(app, "a-first.txt"), join(nested, "payload.txt"), join(app, "z-locked.txt")];
  for (const file of files) await writeFile(file, "fixture content: " + file);
  const outside = join(caseRoot, "outside");
  if (scenario === "junction") {
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "outside fixture preserved");
    await symlink(outside, join(app, "z-junction"), "junction");
  }
  assert.ok(files[1].length > 260);
  const installer = join(caseRoot, "fixture.exe"), uninstaller = join(caseRoot, "uninstall.exe");
  const script = `Unicode true
Name "Coop disposable uninstall regression"
OutFile "${nsis(installer)}"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
!include LogicLib.nsh
!define BUILD_UNINSTALLER
!define UNINSTALL_FILENAME "uninstall.exe"
!include "${nsis(include)}"
Section
 WriteUninstaller "${nsis(uninstaller)}"
SectionEnd
Section "Uninstall"
 StrCpy $INSTDIR "${nsis(app)}"
 InitPluginsDir
 CreateDirectory "\\\\?\\$PLUGINSDIR\\old-install"
 Push ""
 Call un.coopAtomicRMDir
 Pop $0
 FileOpen $1 "${nsis(join(caseRoot, "result.txt"))}" w
 FileWrite $1 "$0"
 FileClose $1
 StrCmp $0 "0" done
 IfFileExists "\\\\?\\$PLUGINSDIR\\old-install\\a-first.txt" 0 +4
 FileOpen $1 "${nsis(join(caseRoot, "partial-move.txt"))}" w
 FileWrite $1 "moved before failure"
 FileClose $1
 Push ""
 Call un.coopRestoreFiles
 Pop $0
 done:
SectionEnd
`;
  const scriptPath = join(caseRoot, "fixture.nsi"); await writeFile(scriptPath, script);
  const compilation = run(compiler, ["/V2", scriptPath]);
  await writeFile(join(caseRoot, "compile.log"), compilation.stdout + compilation.stderr);
  run(installer, ["/S"]);
  let helper;
  try {
    if (locked) {
      helper = spawn(process.env.COOP_TEST_PYTHON || "python", ["-u", "-c", `
import ctypes,sys
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.CreateFileW.argtypes=[ctypes.c_wchar_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p]
k.CreateFileW.restype=ctypes.c_void_p
h=k.CreateFileW(sys.argv[1],0x80000000,3,None,3,0,None)
if h == ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
try:
 print('locked',flush=True)
 sys.stdin.readline()
finally:
 k.CloseHandle.argtypes=[ctypes.c_void_p]
 k.CloseHandle(h)
`, files[2]], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const ready = await Promise.race([once(helper.stdout, "data"), once(helper, "close").then(() => { throw new Error("Lock helper exited before readiness."); })]);
      assert.match(String(ready[0]), /locked/);
    }
    // _?= prevents NSIS spawning an asynchronous copy, so exit is observable.
    run(uninstaller, ["/S", `_?=${caseRoot}`]);
    const result = await readFile(join(caseRoot, "result.txt"), "utf8");
    if (scenario !== "success") {
      assert.match(result, locked ? /z-locked\.txt$/ : /z-junction$/);
      assert.ok(await exists(join(caseRoot, "partial-move.txt")));
      for (const file of files) assert.equal(await readFile(file, "utf8"), "fixture content: " + file);
      if (scenario === "junction") assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "outside fixture preserved");
    } else {
      assert.equal(result, "0");
      for (const file of files) assert.equal(await exists(file), false);
    }
    receipts.push({ case: scenario, passed: true, longPathLength: files[1].length });
  } finally {
    if (helper && helper.exitCode === null) { helper.stdin.end("release\n"); await once(helper, "close"); }
  }
}
await writeFile(join(root, "receipt.json"), JSON.stringify(receipts, null, 2) + "\n");
console.log(JSON.stringify({ passed: true, root, receipts }));
