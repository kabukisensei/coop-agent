import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planBetaContext, claimBetaRoot, betaEnvironment, verifyBetaSource } from '../lib/installation-context.mjs';
import { writeBetaLaunchers, betaPythonFlags } from '../lib/beta-lifecycle.mjs';

if (process.platform !== 'win32') {
  console.log('Native context entry tests require Windows; covered by the Windows full suite.');
  process.exit(0);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-context-native-'));
const fixture = path.join(scratch, 'fixture');
const root = path.join(scratch, 'Beta Ω with spaces');
const which = name => execFileSync('where.exe', [name], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
const git = process.env.COOP_TEST_GIT || which('git.exe');
const python = process.env.COOP_TEST_PYTHON || which('python.exe');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'no-global'), GIT_TERMINAL_PROMPT: '0' };
const runGit = (cwd, args) => execFileSync(git, ['-C', cwd, ...args], { env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
fs.mkdirSync(path.join(fixture, 'lib'), { recursive: true });
fs.mkdirSync(path.join(fixture, 'config'));
for (const file of ['lib/common.ps1', 'lib/common.sh', 'lib/owned-process.ps1', 'lib/installation-context.mjs', 'lib/beta-lifecycle.mjs', 'lib/beta-entry.mjs', 'bin/coop', 'bin/coop.ps1', 'config/windows-beta-manifest.json', 'VERSION']) {
  fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
  fs.copyFileSync(path.join(repo, file), path.join(fixture, file));
}
// Native process tests use inert package metadata, not downloaded providers.
const fixtureManifest = JSON.parse(fs.readFileSync(path.join(fixture, 'config/windows-beta-manifest.json')));
for (const group of ['extensions', 'python_tools', 'npm_tools', 'mcp_servers']) fixtureManifest[group] = {};
fs.writeFileSync(path.join(fixture, 'config/windows-beta-manifest.json'), JSON.stringify(fixtureManifest));
fs.mkdirSync(path.join(fixture, 'scripts'));
fs.writeFileSync(path.join(fixture, 'scripts/install.ps1'), '\uFEFF[IO.File]::WriteAllText((Join-Path $env:COOP_PROFILE_ROOT "WRONG_INSTALLER"),"wrong dispatcher"); exit 97;');
runGit(fixture, ['init']);
runGit(fixture, ['config', 'core.autocrlf', 'false']);
runGit(fixture, ['add', '.']);
runGit(fixture, ['-c', 'user.name=Coop test fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic context acceptance fixture']);
const build = runGit(fixture, ['rev-parse', 'HEAD']);
// Initial ownership is atomic even before there is an installation to lock.
// The process owner must not pollute an empty destination with its own lock,
// and existing user files (including a lock-shaped file) remain a refusal.
const claimScript = path.join(scratch, 'claim-root.mjs');
fs.writeFileSync(claimScript, `import fs from 'node:fs';
import {claimBetaRoot} from ${JSON.stringify(new URL('../lib/installation-context.mjs', import.meta.url).href)};
claimBetaRoot(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));`);
for (const shell of [path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), which('pwsh.exe')]) {
  for (const state of ['absent', 'empty', 'user-file', 'foreign-lock']) {
    const claimRoot = path.join(scratch, `claim-${path.basename(path.dirname(shell))}-${state}`);
    const record = planBetaContext({ root: claimRoot, build,
      tools: { node: process.execPath, python, fabricPython: python, git },
      manifest: fs.readFileSync(path.join(fixture, 'config/windows-beta-manifest.json')) });
    const input = `${claimRoot}.json`;
    fs.writeFileSync(input, JSON.stringify(record));
    if (state !== 'absent') fs.mkdirSync(claimRoot);
    const unowned = state === 'user-file' ? 'keep.txt' : state === 'foreign-lock' ? '.coop-beta.lock' : null;
    if (unowned) fs.writeFileSync(path.join(claimRoot, unowned), 'preserve');
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const code = `$ProgressPreference='SilentlyContinue'; $script:CoopInstallationContext = Get-Content -LiteralPath ${quote(input)} -Raw -Encoding UTF8 | ConvertFrom-Json; . ${quote(path.join(repo, 'lib/owned-process.ps1'))}; Invoke-CoopWindowsOwnedProcess -FilePath ${quote(process.execPath)} -ArgumentVector @(${quote(claimScript)},${quote(input)}) -TimeoutMilliseconds 30000; exit $LASTEXITCODE`;
    const result = spawnSync(shell, ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
      env, cwd: scratch, encoding: 'utf8', timeout: 40000, windowsHide: true });
    assert.equal(result.status, unowned ? 1 : 0, `${state}: ${result.stderr}`);
    assert.deepEqual(fs.readdirSync(claimRoot), [unowned || '.coop-beta.json']);
    if (unowned) assert.equal(fs.readFileSync(path.join(claimRoot, unowned), 'utf8'), 'preserve');
    else assert.throws(() => claimBetaRoot(record), /not already owned/);
  }
}
console.log('Native initial ownership: absent/empty roots accepted; foreign files/locks and duplicate claims refused');
const ctx = planBetaContext({ root, build, tools: { node: process.execPath, python, fabricPython: python, git }, manifest: fs.readFileSync(path.join(fixture, 'config/windows-beta-manifest.json')) });
claimBetaRoot(ctx);
fs.mkdirSync(ctx.paths.temp);
execFileSync(git, ['clone', '--no-hardlinks', fixture, ctx.paths.source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
assert.equal(verifyBetaSource(ctx, ctx.paths.source).build, build);
writeBetaLaunchers(ctx);
const workspace = path.join(ctx.root, 'workspaces');
fs.mkdirSync(workspace);
fs.mkdirSync(ctx.paths.agent, { recursive: true });
fs.writeFileSync(path.join(ctx.paths.agent, 'settings.json'), JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'gpt-5.6-terra', packages: [] }));
fs.writeFileSync(path.join(ctx.paths.agent, 'mcp.json'), '{"mcpServers":{}}');
for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-tui']) {
  const dir = path.join(ctx.paths.agent, 'npm/node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.84.3' }));
}

// Reproduce pipx's default-encoding write of a Unicode .pth path. Explicit -X
// is essential because isolated Python ignores the UTF8 environment variable.
const encodingProbe = path.join(ctx.paths.temp, 'unicode.pth');
const pythonEncoding = execFileSync(python, [...betaPythonFlags, '-c',
  'from pathlib import Path; import sys; Path(sys.argv[1]).write_text(sys.argv[2]); print(sys.flags.utf8_mode)',
  encodingProbe, root], { env: betaEnvironment(ctx), encoding: 'utf8', windowsHide: true });
assert.equal(pythonEncoding.trim(), '1');
assert.equal(fs.readFileSync(encodingProbe, 'utf8'), root);

assert.throws(() => verifyBetaSource(ctx, fixture), /different source root/);
const piPackage = path.join(ctx.paths.npm, 'node_modules/@earendil-works/pi-coding-agent');
fs.mkdirSync(path.join(piPackage, 'dist'), { recursive: true });
fs.writeFileSync(path.join(piPackage, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.84.3', bin: { pi: 'dist/cli.js' } }));
fs.writeFileSync(path.join(piPackage, 'dist/cli.js'), 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 17;');
for (const ps of [path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), which('pwsh.exe')]) {
  const childEnv = { ...env, COOP_CHANNEL: 'beta', COOP_BETA_ROOT: root, COOP_DIR: 'poison', COOP_FABRIC_MCP_TOKEN: 'synthetic-do-not-inherit', PI_CODING_AGENT_DIR: 'poison' };
  const command = '. ./lib/common.ps1; @{profile=(Get-CoopProfileRoot); agent=(Get-CoopPiAgentDir); python=(Get-CoopPython); tokenPresent=[bool]$env:COOP_FABRIC_MCP_TOKEN; path=$env:PATH; home=$env:USERPROFILE; automaticHome=$HOME; appdata=$env:APPDATA; localappdata=$env:LOCALAPPDATA} | ConvertTo-Json -Compress';
  const launched = spawnSync(ps, ['-NoProfile', '-Command', command], { cwd: ctx.paths.source, env: childEnv, encoding: 'utf8', timeout: 30000 });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.stderr.trim(), '', 'successful entry must not hide PowerShell errors');
  const result = JSON.parse(launched.stdout.trim());
  assert.equal(result.profile, ctx.paths.profile);
  assert.equal(result.agent, ctx.paths.agent);
  assert.equal(path.normalize(result.python), path.normalize(python));
  assert.equal(result.tokenPresent, false);
  assert.equal(result.path, betaEnvironment(ctx, childEnv).PATH);
  assert.equal(result.home, ctx.paths.profile);
  assert.equal(result.automaticHome, env.HOME,
    'a PowerShell process retains its automatic HOME across an in-process environment switch');
  assert.equal(result.appdata, path.join(ctx.paths.profile, 'AppData', 'Roaming'));
  assert.equal(result.localappdata, path.join(ctx.paths.profile, 'AppData', 'Local'));
  const wrong = spawnSync(ps, ['-NoProfile', '-Command', '. ./lib/common.ps1; Write-Output SHOULD_NOT_REACH'], { cwd: fixture, env: childEnv, encoding: 'utf8' });
  assert.notEqual(wrong.status, 0);
  assert.equal(wrong.stdout.includes('SHOULD_NOT_REACH'), false);
  const vector = ['hello world', 'Ω漢字', 'x&y', "single'quote", '$literal', 'tail\\', 'embedded"quote', '', 'space tail\\'];
  const encoded = Buffer.from(JSON.stringify(vector)).toString('base64');
  const invoke = `. ./lib/common.ps1; $forwarded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; Invoke-CoopPi @forwarded; exit $LASTEXITCODE`;
  const pi = spawnSync(ps, ['-NoProfile', '-Command', invoke], { cwd: ctx.paths.source, env: childEnv, encoding: 'utf8', timeout: 30000 });
  assert.equal(pi.status, 17, pi.stderr);
  assert.equal(pi.stderr.trim(), '');
  assert.deepEqual(JSON.parse(pi.stdout.trim()), vector);
  // Each answer must arrive before EOF. A pre-filled, closed stdin pipe misses
  // the .NET Framework buffering bug that deadlocked the native JSONL wizard.
  const interactive = path.join(ctx.paths.temp, 'interactive-input.cjs');
  fs.writeFileSync(interactive, `const fs=require('fs'),readline=require('readline');
const emit=value=>fs.writeSync(1,JSON.stringify(value)+'\\n');
let count=0;emit({prompt:1});
readline.createInterface({input:process.stdin}).on('line',line=>{
  emit({answer:line});count++;if(count<2)emit({prompt:count+1});else emit({eof:true});
});
process.stdin.on('end',()=>{emit({closed:true});process.exit(29);});
`);
  const interactiveArgs = Buffer.from(JSON.stringify([interactive])).toString('base64');
  const interactiveCommand = `. ./lib/common.ps1; $v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${interactiveArgs}')) | ConvertFrom-Json; Invoke-CoopOwnedProcess -FilePath $env:COOP_NODE -ArgumentVector $v -TimeoutMilliseconds 15000; exit $LASTEXITCODE`;
  const pipe = spawn(ps, ['-NoProfile', '-Command', interactiveCommand], { cwd: ctx.paths.source, env: childEnv, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  const events=[];let buffer='',pipeError=null,pipeStderr='';
  const watchdog=setTimeout(()=>{pipeError=Error('Interactive owned process deadline');pipe.kill();},25000);
  pipe.stdin.on('error',()=>{});
  pipe.stderr.on('data',data=>{pipeStderr+=data;});
  pipe.stdout.on('data',data=>{
    buffer+=data;
    while(buffer.includes('\n')) {
      const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      try {
        const event=JSON.parse(line);events.push(event);
        if(event.prompt)pipe.stdin.write(`answer ${event.prompt} Ω漢字\n`);
        if(event.eof)pipe.stdin.end();
      } catch(error) { pipeError=error;pipe.kill(); }
    }
  });
  const pipeStatus=await new Promise((resolve,reject)=>{pipe.once('error',reject);pipe.once('close',resolve);});
  clearTimeout(watchdog);assert.equal(pipeError,null);assert.equal(pipeStatus,29,pipeStderr);
  assert.deepEqual(events.filter(e=>e.answer).map(e=>e.answer),['answer 1 Ω漢字','answer 2 Ω漢字']);
  assert.equal(events.at(-1).closed,true);assert.equal(fs.existsSync(path.join(ctx.root,'.coop-beta.lock')),false);
  // A real child/grandchild tree, including a detached descendant retaining
  // stdout, must end with its owner. A concurrent unrelated process survives.
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  const ownedScript = path.join(ctx.paths.temp, 'owned-tree.cjs');
  fs.writeFileSync(ownedScript, `const {spawn}=require('child_process');
const fs=require('fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});
fs.writeFileSync(process.argv[2],JSON.stringify([process.pid,child.pid]));
if(process.argv[3]==='exit') setTimeout(()=>process.exit(23),400);
else setInterval(()=>{},1000);
`);
  try {
    for (const mode of ['exit', 'deadline']) {
      const pidFile = path.join(ctx.paths.temp, `pids-${mode}.json`);
      const ownedArgs = Buffer.from(JSON.stringify([ownedScript, pidFile, mode])).toString('base64');
      const command = `. ./lib/common.ps1; $v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${ownedArgs}')) | ConvertFrom-Json; try { Invoke-CoopOwnedProcess -FilePath $env:COOP_NODE -ArgumentVector $v -TimeoutMilliseconds 1600; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 41 }`;
      const child = spawnSync(ps, ['-NoProfile', '-Command', command], { cwd: ctx.paths.source, env: childEnv, encoding: 'utf8', timeout: 30000 });
      assert.equal(child.status, mode === 'exit' ? 23 : 41, child.stderr);
      if (mode === 'deadline') assert.match(child.stderr, /exceeded its deadline/);
      const pids = JSON.parse(fs.readFileSync(pidFile));
      for (const pid of pids) {
        let alive = true;
        for (let retry = 0; retry < 30 && alive; retry++) {
          try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 100)); } catch { alive = false; }
        }
        assert.equal(alive, false, `owned ${mode} process ${pid} survived`);
      }
      assert.doesNotThrow(() => process.kill(sentinel.pid, 0), 'unrelated active process must survive');
      assert.equal(fs.existsSync(path.join(ctx.root, '.coop-beta.lock')), false, 'deadline/completion must release beta ownership');
    }
  } finally { sentinel.kill(); }
}
const vector = ['hello world', 'Ω漢字', 'x&y', "single'quote", '$literal', 'tail\\', 'embedded"quote', '', 'space tail\\'];
const bridgeEnv = { ...env, COOP_CHANNEL: 'beta', COOP_BETA_ROOT: root };
const directShell = spawnSync(process.env.COOP_TEST_BASH || 'C:\\Program Files\\Git\\bin\\bash.exe', ['--noprofile', '--norc', '-s'], { cwd: ctx.paths.source, env: bridgeEnv, input: 'set +e\n. ./lib/common.sh\necho SHOULD_NOT_REACH\n', encoding: 'utf8', timeout: 30000 });
assert.notEqual(directShell.status, 0);
assert.equal(directShell.stdout.includes('SHOULD_NOT_REACH'), false, 'a shell without set -e must not continue into stable helpers');
const untouched = path.join(scratch, 'untouched profile');
const bareEnv = { ...env, COOP_PROFILE_ROOT: untouched, COOP_AGENT_DIR: path.join(untouched, 'agent'), PI_CODING_AGENT_DIR: path.join(untouched, 'agent') };
for (const key of ['COOP_CHANNEL', 'COOP_BETA_ROOT', 'COOP_BETA_PARENT_PID']) delete bareEnv[key];
const malformed = spawnSync(process.env.COOP_TEST_BASH || 'C:\\Program Files\\Git\\bin\\bash.exe', ['--noprofile', '--norc', '-s'], { cwd: ctx.paths.source, env: bareEnv, input: 'exec bash bin/coop install --yes --beta-plan unused.json\n', encoding: 'utf8', timeout: 30000 });
assert.ok(Number.isInteger(malformed.status) && malformed.status > 0);
assert.match(malformed.stderr, /Usage: coop install --beta-plan/);
assert.equal(fs.existsSync(untouched), false, 'invalid beta flags must refuse before stable profile creation');
const bashQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
for (const [executable, args, input] of [
  [process.execPath, [path.join(ctx.paths.bin, 'beta-entry.mjs'), 'pi', ...vector], undefined],
  [process.env.COOP_TEST_BASH || 'C:\\Program Files\\Git\\bin\\bash.exe', ['--noprofile', '--norc', '-s'], `exec bash ${bashQuote(path.join(ctx.paths.source, "bin/coop"))} pi ${vector.map(bashQuote).join(' ')}\n`],
]) {
  const result = spawnSync(executable, args, { cwd: workspace, env: bridgeEnv, input, encoding: 'utf8', timeout: 45000 });
  assert.equal(result.status, 17, result.stderr);
  assert.equal(result.stderr.trim(), '');
  assert.deepEqual(JSON.parse(result.stdout.trim()), vector, `${executable} must preserve literal arguments`);
}
// Preview must describe the private executable, never a PATH-dependent "pi".
for (const command of ['launch-spec', '--no-launch']) {
  const preview = spawnSync(process.execPath, [path.join(ctx.paths.bin, 'beta-entry.mjs'), command, '--json'],
    { cwd: workspace, env: { ...bridgeEnv, OPENAI_API_KEY: 'synthetic-do-not-export' }, encoding: 'utf8', timeout: 45000 });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /^[\x00-\x7f]*$/, 'beta JSON must survive legacy PowerShell output codepages');
  const spec = JSON.parse(preview.stdout);
  assert.equal(spec.bin, ctx.tools.node.path);
  assert.equal(spec.args[0], path.join(piPackage, 'dist/cli.js'));
  assert.equal(spec.env.PI_CODING_AGENT_DIR, ctx.paths.agent);
  assert.equal(spec.env.PATH, betaEnvironment(ctx, bridgeEnv).PATH);
  assert.equal(spec.env.OPENAI_API_KEY, undefined);
  assert.equal(spec.env.COOP_BETA_PARENT_PID, undefined);
  const refused = spawnSync(process.execPath, [path.join(ctx.paths.bin, 'beta-entry.mjs'), command, '--json'],
    { cwd: ctx.paths.source, env: bridgeEnv, encoding: 'utf8', timeout: 45000 });
  assert.ok(Number.isInteger(refused.status) && refused.status !== 0);
}
// The public raw-Pi alias must enforce the same scope before the fake executor.
for (const [cwd, args] of [[ctx.paths.source, []], [workspace, ['--provider', 'anthropic']],
  [workspace, ['--session-dir', scratch]], [workspace, ['--extension', fixture]]]) {
  const rejected = spawnSync(process.execPath, [path.join(ctx.paths.bin, 'beta-entry.mjs'), 'pi', ...args],
    { cwd, env: bridgeEnv, encoding: 'utf8', timeout: 45000 });
  assert.ok(Number.isInteger(rejected.status) && rejected.status !== 0 && rejected.status !== 17);
  assert.match(rejected.stderr + rejected.stdout, /beta|Beta|scope|qualification|workspaces/);
  assert.equal(rejected.stdout.includes('["'), false, 'rejected launch must not reach the represented Pi executor');
}
// Forced entry shutdown must reap its PowerShell/Pi descendants and release the
// beta operation lock. A second launch while it is active must fail, not race.
const commandShim = spawnSync(path.join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/s', '/c', `""${path.join(ctx.paths.bin, 'coop-beta.cmd')}" pi "hello world" "Ω漢字""`], { cwd: workspace, env: bridgeEnv, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 45000 });
assert.equal(commandShim.status, 17, commandShim.stderr);
assert.deepEqual(JSON.parse(commandShim.stdout.trim()), ['hello world', 'Ω漢字']);
const sessionPids = path.join(ctx.paths.temp, 'session-pids.json');
fs.writeFileSync(path.join(piPackage, 'dist/cli.js'), `const fs=require('fs'); const {spawn}=require('child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(sessionPids)},JSON.stringify([process.ppid,process.pid,child.pid]));setInterval(()=>{},1000);`);
const active = spawn(process.execPath, [path.join(ctx.paths.bin, 'beta-entry.mjs'), 'pi'], { cwd: workspace, env: bridgeEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let activeOutput = '';
active.stdout.on('data', chunk => { activeOutput += chunk; });
active.stderr.on('data', chunk => { activeOutput += chunk; });
let ownedPids = [];
try {
  for (let attempt = 0; attempt < 150 && !fs.existsSync(sessionPids); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(sessionPids), true, `public beta session must start: ${activeOutput}`);
  ownedPids = JSON.parse(fs.readFileSync(sessionPids));
  const duplicate = spawnSync(process.execPath, [path.join(ctx.paths.bin, 'beta-entry.mjs'), 'pi'], { cwd: workspace, env: bridgeEnv, encoding: 'utf8', timeout: 30000 });
  assert.equal(duplicate.error, undefined, 'a timeout is not evidence of ownership refusal');
  assert.ok(Number.isInteger(duplicate.status) && duplicate.status > 0, 'active session must exclude a second mutating owner');
  assert.deepEqual(JSON.parse(fs.readFileSync(sessionPids)), ownedPids);
  const busyRecovery = spawnSync(process.execPath, [path.join(ctx.paths.bin, 'beta-entry.mjs'), 'update', '--rollback'], { cwd: workspace, env: bridgeEnv, encoding: 'utf8', timeout: 30000 });
  assert.equal(busyRecovery.error, undefined);
  assert.ok(Number.isInteger(busyRecovery.status) && busyRecovery.status > 0);
  assert.match(busyRecovery.stderr, /busy|ownership lock/);
  active.kill();
  for (const pid of ownedPids) {
    let alive = true;
    for (let retry = 0; retry < 100 && alive; retry++) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 100)); } catch { alive = false; }
    }
    assert.equal(alive, false, `entry-owned process ${pid} survived forced shutdown`);
  }
  assert.equal(fs.existsSync(path.join(ctx.root, '.coop-beta.lock')), false);
} finally {
  active.kill();
  // Only explicitly created test descendants, never enumeration by process name.
  for (const pid of ownedPids) { try { process.kill(pid); } catch { } }
}
// Simulate interruption immediately after moving the old source out of the way.
// The public recovery shim must find that exact clean retained build, take the
// operation lock, restore source and leave all profile data untouched.
fs.writeFileSync(path.join(ctx.root, '.coop-beta-transaction.json'), JSON.stringify({ operation: 'update', before: ctx, after: { ...ctx, build: 'f'.repeat(40) } }));
fs.renameSync(ctx.paths.source, path.join(ctx.root, 'previous-source'));
const recovered = spawnSync(process.execPath, [path.join(ctx.paths.bin, 'beta-entry.mjs'), 'update', '--rollback'], { cwd: ctx.root, env: bridgeEnv, encoding: 'utf8', timeout: 45000 });
assert.equal(recovered.status, 0, recovered.stderr);
assert.equal(JSON.parse(recovered.stdout).build, ctx.build);
assert.equal(fs.existsSync(ctx.paths.source), true);
assert.equal(fs.existsSync(path.join(ctx.root, 'previous-source')), false);
assert.equal(fs.existsSync(path.join(ctx.root, '.coop-beta.lock')), false);
assert.deepEqual(JSON.parse(fs.readFileSync(sessionPids)), ownedPids);
fs.writeFileSync(path.join(ctx.paths.source, 'user-change'), 'do not overwrite');
assert.throws(() => verifyBetaSource(ctx, ctx.paths.source), /dirty/);
assert.equal(fs.readFileSync(path.join(ctx.paths.source, 'user-change'), 'utf8'), 'do not overwrite');
// A locked package may leave partial application removal. Recovery must remain
// executable after source disappears and preserve user files on every retry.
fs.unlinkSync(path.join(ctx.paths.source, 'user-change')); // this test's own marker
const authFile = path.join(ctx.paths.agent, 'auth.json');
fs.writeFileSync(authFile, '{"syntheticUserData":"preserve"}');
const settingsBefore = fs.readFileSync(path.join(ctx.paths.agent, 'settings.json'));
const lockedFile = path.join(ctx.root, 'runtime', 'locked-package.bin');
fs.writeFileSync(lockedFile, 'owned package fixture');
const lockReady = path.join(ctx.paths.temp, 'locked-file-ready');
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
const lockCommand = `$stream=[IO.File]::Open(${psQuote(lockedFile)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[IO.File]::WriteAllText(${psQuote(lockReady)},'ready');try { while($true){Start-Sleep -Seconds 1} } finally {$stream.Dispose()}`;
const lockHolder = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Command', lockCommand], { env, windowsHide: true, stdio: 'ignore' });
const publicOperation = command => spawnSync(process.execPath, [path.join(ctx.paths.bin, 'beta-entry.mjs'), command], { cwd: ctx.root, env: bridgeEnv, encoding: 'utf8', timeout: 45000 });
try {
  for (let attempt = 0; attempt < 100 && !fs.existsSync(lockReady); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(lockReady), true, 'native file-lock fixture must be ready');
  const failed = publicOperation('uninstall');
  assert.ok(Number.isInteger(failed.status) && failed.status !== 0, failed.stderr);
  assert.match(failed.stderr, /removal is incomplete/);
  assert.equal(fs.existsSync(ctx.paths.source), true, 'locked packages must not destroy source/recovery first');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.root, '.coop-beta-transaction.json'))).operation, 'remove');
  const interruptedDoctor = publicOperation('doctor');
  assert.equal(interruptedDoctor.status, 1);
  assert.equal(JSON.parse(interruptedDoctor.stdout).status, 'removal-incomplete');
} finally {
  if (lockHolder.exitCode === null) { const stopped = new Promise(resolve => lockHolder.once('exit', resolve)); lockHolder.kill(); await stopped; }
}
const userEdit = path.join(ctx.paths.source, 'new-user-file');
fs.writeFileSync(userEdit, 'preserve concurrent user edits');
const changedRetry = publicOperation('uninstall');
assert.ok(Number.isInteger(changedRetry.status) && changedRetry.status !== 0);
assert.match(changedRetry.stderr, /Source changed during partial removal/);
assert.equal(fs.readFileSync(userEdit, 'utf8'), 'preserve concurrent user edits');
fs.unlinkSync(userEdit); // only the explicit synthetic marker created above
const removed = publicOperation('uninstall');
assert.equal(removed.status, 0, removed.stderr);
for (const file of [ctx.paths.source, path.join(ctx.root, 'runtime'), path.join(ctx.paths.agent, 'npm')]) assert.equal(fs.existsSync(file), false);
assert.equal(fs.readFileSync(authFile, 'utf8'), '{"syntheticUserData":"preserve"}');
assert.deepEqual(fs.readFileSync(path.join(ctx.paths.agent, 'settings.json')), settingsBefore);
const removedDoctor = publicOperation('doctor');
assert.equal(removedDoctor.status, 1);
assert.equal(JSON.parse(removedDoctor.stdout).status, 'removed');
assert.equal(publicOperation('uninstall').status, 0, 'completed removal is idempotent');
const recoveryHelper = path.join(ctx.root, 'recovery', ctx.build, 'owned-process.ps1');
const helperBytes = fs.readFileSync(recoveryHelper);
fs.appendFileSync(recoveryHelper, '# synthetic modification');
assert.notEqual(publicOperation('doctor').status, 0, 'modified recovery helper must not execute');
fs.writeFileSync(recoveryHelper, helperBytes);
assert.equal(fs.existsSync(path.join(ctx.root, '.coop-beta.lock')), false);
console.log('Native removal: locked-file retry, changed-source refusal, retained recovery, idempotence and user-data preservation passed');
console.log('Native PS 5.1/7 and Git Bash: exact build/profile, literal argv/exit, operation lock, timeout and forced child shutdown passed');
