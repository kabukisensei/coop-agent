/** Run in a real Windows terminal. Pipe-only tests cannot prove console attachment. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
if(process.platform!=='win32'||!process.stdin.isTTY||!process.stdout.isTTY) {
  console.error('This regression requires a real Windows terminal.');process.exit(2);
}
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'coop-beta-console-'));
const which=name=>execFileSync('where.exe',[name],{encoding:'utf8'}).trim().split(/\r?\n/)[0];
const python=process.env.COOP_TEST_PYTHON||which('python.exe');
const child=path.join(scratch,'console.py');
fs.writeFileSync(child,`import ctypes,json,os,sys
from pathlib import Path
pids=(ctypes.c_uint32*256)()
count=ctypes.windll.kernel32.GetConsoleProcessList(pids,len(pids))
result={"ownerAttached":int(sys.argv[1]) in list(pids)[:count],
        "stdin":sys.stdin.isatty(),"stdout":sys.stdout.isatty(),"stderr":sys.stderr.isatty()}
Path(sys.argv[2]).write_text(json.dumps(result),encoding="utf-8")
print("BETA_CONSOLE_ATTACHED",flush=True)
sys.exit(7 if all(result.values()) else 13)
`);
const quote=value=>`'${value.replaceAll("'","''")}'`;
for(const [index,shell] of [path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),which('pwsh.exe')].entries()) {
  const receipt=path.join(scratch,`console-${index}.json`);
  const code=`$ErrorActionPreference='Stop'; $script:CoopInstallationContext=@{root=${quote(scratch)}}; . ${quote(path.join(repo,'lib/owned-process.ps1'))}; Invoke-CoopWindowsOwnedProcess -FilePath ${quote(python)} -ArgumentVector @('-I','-B','-X','utf8',${quote(child)},[string]$PID,${quote(receipt)}) -TimeoutMilliseconds 15000 -ReadOnly; exit $LASTEXITCODE`;
  const result=spawnSync(shell,['-NoProfile','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{cwd:scratch,env:process.env,stdio:'inherit',windowsHide:false,timeout:25000});
  assert.equal(result.error,undefined);assert.equal(result.status,7);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt)),{ownerAttached:true,stdin:true,stdout:true,stderr:true});
}
console.log('Beta real console: PS 5.1/7 parent attachment, terminal handles and exit codes passed');
