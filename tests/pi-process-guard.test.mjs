import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cases = [
  [String.raw`"C:\Program Files\nodejs\node.exe" "D:\Coop Runtime\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js" --mode rpc`, true],
  [String.raw`node.exe D:\npm\node_modules\@mariozechner\pi-coding-agent\dist\cli.js`, true],
  ["node.exe --no-warnings D:/runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc", true],
  [String.raw`node.exe D:\npm\npm-cli.js install --prefix D:\runtime @earendil-works/pi-coding-agent@0.84.3`, false],
  ["node.exe npm-cli.js view @earendil-works/pi-coding-agent version", false],
  ["node.exe D:/other-pi-coding-agent/dist/cli.js", false],
  ["node.exe D:/pi-coding-agent/dist/cli.js.backup", false],
  ["", false],
];
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const ps = process.platform === "win32" ? "powershell.exe" : "pwsh";
for (const [commandLine, expected] of cases) {
  const env = { ...process.env, COOP_TEST_PROCESS_LINE: commandLine };
  const shell = spawnSync(bash, ["-c", '. ./lib/common.sh; coop_is_pi_command_line "$COOP_TEST_PROCESS_LINE"'], { cwd: root, env, encoding: "utf8" });
  assert.equal(shell.status, expected ? 0 : 1, `Bash: ${commandLine}: ${shell.stderr}`);
  const windows = spawnSync(ps, ["-NoProfile", "-Command", '. ./lib/common.ps1; if (Test-CoopPiCommandLine $env:COOP_TEST_PROCESS_LINE) { exit 0 } else { exit 1 }'], { cwd: root, env, encoding: "utf8" });
  if (windows.error?.code !== "ENOENT") assert.equal(windows.status, expected ? 0 : 1, `PowerShell: ${commandLine}: ${windows.stderr}`);
}
console.log(`Pi process guard: ${cases.length} command lines distinguish agent sessions from npm operations in both shell helpers.`);
