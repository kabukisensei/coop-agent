import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync, spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {planBetaContext, claimBetaRoot, loadBetaContext, betaRecoveryDirectory} from '../lib/installation-context.mjs';
import {prepareInitialBeta} from '../lib/beta-lifecycle.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-beta-initial-'));
const which = name => execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], {encoding:'utf8'}).trim().split(/\r?\n/)[0];
const git = process.env.COOP_TEST_GIT || which(process.platform === 'win32' ? 'git.exe' : 'git');
const env = {...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:path.join(scratch,'no-global'), GIT_TERMINAL_PROMPT:'0'};
for (const key of Object.keys(env)) if (/^COOP_/i.test(key)) delete env[key];
const runGit = (cwd, args) => execFileSync(git, ['-C',cwd,...args], {env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const fixture = path.join(scratch, 'fixture');
fs.mkdirSync(fixture);
runGit(fixture,['init']);
runGit(fixture,['config','core.autocrlf','false']);
// CI may have a shallow product checkout. Use a real synthetic ancestor and
// descendant in the disposable repo; keep every ancestry check enabled.
runGit(fixture,['-c','user.name=Coop test fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','Synthetic accepted ancestor']);
const testBaseline = runGit(fixture,['rev-parse','HEAD']);
for (const file of ['VERSION','config/windows-beta-manifest.json','bin/coop','bin/coop.ps1',
  ...['beta-lifecycle.mjs','installation-context.mjs','beta-entry.mjs','owned-process.ps1','common.ps1','common.sh'].map(name=>`lib/${name}`)]) {
  fs.mkdirSync(path.dirname(path.join(fixture,file)),{recursive:true});
  fs.writeFileSync(path.join(fixture,file),fs.readFileSync(path.join(repo,file),'utf8').replace(/\r\n/g,'\n'));
}
// Exercise the public source installer without package downloads. Only this
// committed test fixture substitutes sync and adds a controllable source pause.
const lifecycle = path.join(fixture,'lib/beta-lifecycle.mjs');
fs.writeFileSync(lifecycle,fs.readFileSync(lifecycle,'utf8')
  .replace(/const baseline = '[0-9a-f]{40}';/, `const baseline = '${testBaseline}';`)
  .replace('export function syncBeta(ctx) {', 'export function syncBeta(ctx) { fs.writeFileSync(path.join(ctx.paths.temp,"sync-reached"),"owned"); return {syntheticSync:true};')
  .replace('function cloneBuild(ctx, source, build, destination) {', 'function cloneBuild(ctx, source, build, destination) { if(fs.existsSync(path.join(ctx.paths.temp,"hold"))){fs.writeFileSync(path.join(ctx.paths.temp,"held"),String(process.pid));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,180000);}'));
runGit(fixture,['add','.']);
runGit(fixture,['-c','user.name=Coop test fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic initial-install recovery fixture']);
const build = runGit(fixture,['rev-parse','HEAD']);
const {claimInstall} = await import(pathToFileURL(lifecycle).href);
const tools = {node:process.execPath,python:process.execPath,fabricPython:process.execPath,git};
const manifest = fs.readFileSync(path.join(fixture,'config/windows-beta-manifest.json'));
function claimed(name) {
  const ctx = planBetaContext({root:path.join(scratch,name),build,tools,manifest});
  claimBetaRoot(ctx);
  fs.mkdirSync(ctx.paths.agent,{recursive:true});
  fs.writeFileSync(path.join(ctx.paths.agent,'auth.json'),'synthetic user data');
  return ctx;
}
for (const phase of ['claimed','partial-source','partial-bootstrap','partial-archive']) {
  const ctx = claimed(`Beta Ω ${phase}`);
  const partials = phase === 'claimed' ? [] : phase === 'partial-source' ? ['source'] : ['source','bin','recovery'];
  for (const name of partials) {
    fs.mkdirSync(path.join(ctx.root,name),{recursive:true});
    fs.writeFileSync(path.join(ctx.root,name,'incomplete'),'preserve '+name);
  }
  if (phase === 'partial-archive') {
    fs.mkdirSync(path.join(ctx.root,'retained-installs','earlier'),{recursive:true});
    fs.renameSync(ctx.paths.source,path.join(ctx.root,'retained-installs','earlier','source'));
  }
  prepareInitialBeta(ctx,fixture);
  assert.equal(runGit(ctx.paths.source,['rev-parse','HEAD']),build);
  betaRecoveryDirectory(ctx);
  assert.equal(fs.readFileSync(path.join(ctx.paths.agent,'auth.json'),'utf8'),'synthetic user data');
  for (const name of partials) {
    assert.ok(fs.readdirSync(path.join(ctx.root,'retained-installs')).some(id=> {
      const file = path.join(ctx.root,'retained-installs',id,name,'incomplete');
      return fs.existsSync(file) && fs.readFileSync(file,'utf8') === 'preserve '+name;
    }));
  }
  const bootstrap = fs.readFileSync(path.join(ctx.paths.bin,'recovery.json'));
  prepareInitialBeta(ctx,fixture); // completed source, not yet synced
  assert.deepEqual(fs.readFileSync(path.join(ctx.paths.bin,'recovery.json')),bootstrap);
  assert.equal(fs.existsSync(path.join(ctx.root,'runtime')),false);
  fs.appendFileSync(path.join(ctx.paths.bin,'beta-entry.mjs'),'\n// tamper');
  assert.throws(()=>prepareInitialBeta(ctx,fixture),/changed|hash/);
  assert.deepEqual(fs.readFileSync(path.join(ctx.paths.bin,'recovery.json')),bootstrap);
}
for (const extra of ['runtime','unknown-user-file','.coop-beta-removed.json','.coop-beta-transaction.json','profile/agent/npm']) {
  const ctx = claimed('refuse-'+extra.replaceAll('/','-'));
  const file = path.join(ctx.root,extra);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'preserve');
  assert.throws(()=>prepareInitialBeta(ctx,fixture),/unexpected application state|interrupted beta operation/);
  assert.equal(fs.readFileSync(file,'utf8'),'preserve');
  assert.equal(fs.existsSync(ctx.paths.source),false);
}
if (process.platform === 'win32') {
  const linked = claimed('linked-partial'), outside = path.join(scratch,'outside');
  fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'canary'),'outside');
  fs.symlinkSync(outside,linked.paths.source,'junction');
  assert.throws(()=>prepareInitialBeta(linked,fixture),/Link|Reparse/);
  assert.equal(fs.readFileSync(path.join(outside,'canary'),'utf8'),'outside');
  // Real native public dispatcher: claim, hold under lease, refuse a concurrent
  // owner, kill only our installer, then retry with unchanged identity.
  for (const shell of [path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),which('pwsh.exe')]) {
    const root = path.join(scratch,'native-'+path.basename(path.dirname(shell)));
    const request = {root,source:fixture,build,tools};
    const input = root+'.json';fs.writeFileSync(input,JSON.stringify(request));
    const ctx = claimInstall(request);
    assert.ok(ctx.protectedRoots.includes(os.homedir()), 'initial plan protects the original home');
    assert.throws(()=>claimInstall({...request,tools:{...tools,python:git}}),/same beta build/);
    fs.mkdirSync(ctx.paths.temp);fs.writeFileSync(path.join(ctx.paths.temp,'hold'),'pause source');
    const args = ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(fixture,'bin/coop.ps1'),'install','--beta-plan',input];
    const owner = spawn(shell,args,{cwd:fixture,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output = '';owner.stdout.on('data',b=>output+=b);owner.stderr.on('data',b=>output+=b);
    const stopped = new Promise(resolve=>owner.once('close',resolve));
    try {
      for(let n=0;n<1200&&owner.exitCode===null&&!fs.existsSync(path.join(ctx.paths.temp,'held'));n++) await new Promise(r=>setTimeout(r,50));
      assert.equal(fs.existsSync(path.join(ctx.paths.temp,'held')),true,output);
      const second = spawnSync(shell,args,{cwd:fixture,env,windowsHide:true,encoding:'utf8',timeout:60000});
      assert.equal(second.error,undefined);assert.equal(second.status,1,second.stderr);
      assert.match(second.stderr,/busy|ownership lock/);
      assert.equal(fs.existsSync(path.join(ctx.paths.temp,'sync-reached')),false);
    } finally { owner.kill();await stopped; }
    for(let n=0;n<100&&fs.existsSync(path.join(root,'.coop-beta.lock'));n++) await new Promise(r=>setTimeout(r,50));
    assert.equal(fs.existsSync(path.join(root,'.coop-beta.lock')),false);
    fs.unlinkSync(path.join(ctx.paths.temp,'hold')); // only our synthetic pause
    const retry = spawnSync(shell,args,{cwd:fixture,env,windowsHide:true,encoding:'utf8',timeout:120000});
    assert.equal(retry.error,undefined);assert.equal(retry.status,0,retry.stderr);
    assert.ok(loadBetaContext(root).protectedRoots.includes(os.homedir()),
      'the native installer retains the original protected home after private-home handoff');
    assert.equal(fs.readFileSync(path.join(ctx.paths.temp,'sync-reached'),'utf8'),'owned');
    betaRecoveryDirectory(ctx);
    const malformed = path.join(scratch,'malformed-'+path.basename(path.dirname(shell)));
    fs.mkdirSync(malformed);fs.writeFileSync(path.join(malformed,'.coop-beta.json'),'{');
    assert.throws(()=>claimInstall({...request,root:malformed}));
    assert.equal(fs.readFileSync(path.join(malformed,'.coop-beta.json'),'utf8'),'{');
    for (const state of ['absent','empty','foreign-lock']) {
      const freshRoot = root+'-'+state;
      if (state !== 'absent') fs.mkdirSync(freshRoot);
      if (state === 'foreign-lock') fs.writeFileSync(path.join(freshRoot,'.coop-beta.lock'),'preserve');
      fs.writeFileSync(input,JSON.stringify({...request,root:freshRoot}));
      const fresh = spawnSync(shell,args,{cwd:fixture,env,windowsHide:true,encoding:'utf8',timeout:120000});
      assert.equal(fresh.error,undefined);assert.equal(fresh.status,state==='foreign-lock'?1:0,fresh.stderr);
      if (state === 'foreign-lock') assert.deepEqual(fs.readdirSync(freshRoot),['.coop-beta.lock']);
      else assert.equal(fs.readFileSync(path.join(freshRoot,'temp','sync-reached'),'utf8'),'owned');
    }
  }
}
console.log('Initial beta install: interrupted source/bootstrap retained, same-plan retry, idempotent source-ready retry, identity/state/link refusals and native lease enforced');
