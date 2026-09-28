import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planBetaContext,claimBetaRoot,betaEnvironment,assertOwnedPath} from '../lib/installation-context.mjs';
import {writeBetaLaunchers} from '../lib/beta-lifecycle.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'coop-beta-profile-'));
const which=name=>execFileSync(process.platform==='win32'?'where.exe':'which',[name],{encoding:'utf8'}).trim().split(/\r?\n/)[0];
const git=process.env.COOP_TEST_GIT || which(process.platform==='win32'?'git.exe':'git');
const python=process.env.COOP_TEST_PYTHON || which(process.platform==='win32'?'python.exe':'python3');
const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(scratch,'no-global'),GIT_TERMINAL_PROMPT:'0'};
const runGit=(cwd,args)=>execFileSync(git,['-C',cwd,...args],{env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const fixture=path.join(scratch,'fixture');
for(const file of ['VERSION','config/windows-beta-manifest.json','config/defaults.yml','docs/guardrails.md',
  'bin/coop','bin/coop.ps1','scripts/onboard.py','scripts/context-budget.py',
  ...['installation-context.mjs','beta-lifecycle.mjs','beta-entry.mjs','owned-process.ps1','common.ps1','common.sh','azure_auth.py'].map(name=>`lib/${name}`)]) {
  fs.mkdirSync(path.dirname(path.join(fixture,file)),{recursive:true});fs.copyFileSync(path.join(repo,file),path.join(fixture,file));
}
runGit(fixture,['init']);runGit(fixture,['config','core.autocrlf','false']);runGit(fixture,['add','.']);
const commit=()=>{runGit(fixture,['add','.']);runGit(fixture,['-c','user.name=Coop fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic profile fixture']);return runGit(fixture,['rev-parse','HEAD']);};
function install(name,build) {
  const ctx=planBetaContext({root:path.join(scratch,name),build,tools:{node:process.execPath,python,fabricPython:python,git},manifest:fs.readFileSync(path.join(fixture,'config/windows-beta-manifest.json'))});
  claimBetaRoot(ctx);execFileSync(git,['-c','core.autocrlf=false','clone','--no-hardlinks',fixture,ctx.paths.source],{env,stdio:'ignore',windowsHide:true});writeBetaLaunchers(ctx);
  for(const dir of [ctx.paths.agent,ctx.paths.temp,path.join(ctx.root,'workspaces')])fs.mkdirSync(dir,{recursive:true});
  return ctx;
}
const ctx=install('Beta Ω',commit()),cwd=path.join(ctx.root,'workspaces');
const outside=path.join(scratch,'outside');fs.mkdirSync(outside);
const sentinel=path.join(outside,'user.json');fs.writeFileSync(sentinel,'preserve outside');
const poisonMarker=path.join(outside,'tool-ran');
for(const name of ['python','python3','az']) {
  const shim=process.platform==='win32'?`${name}.cmd`:name;
  const text=process.platform==='win32'?`@echo invoked > "${poisonMarker}"\r\nexit /b 91\r\n`:`#!/bin/sh\nprintf invoked > '${poisonMarker}'\nexit 91\n`;
  fs.writeFileSync(path.join(outside,shim),text,{mode:0o755});
}
const childEnv={...betaEnvironment(ctx,env),PATH:outside,COOP_PROFILE_ROOT:outside,COOP_DIR:outside,PYTHONPATH:outside,PYTHONSTARTUP:path.join(outside,'poison.py')};
const entry=process.platform==='win32'?[path.join(ctx.paths.bin,'beta-entry.mjs')]:[path.join(ctx.paths.source,'lib/beta-lifecycle.mjs')];
function call(operation,args=[],options={}) {
  const vector=process.platform==='win32'?[...entry,operation,...args]:[...entry,operation,ctx.root,...args];
  return spawnSync(process.execPath,vector,{cwd,env:childEnv,encoding:'utf8',windowsHide:true,timeout:120000,...options});
}
const user=path.join(ctx.paths.profile,'user.json');
const original={schema_version:1,name:'Before',future:{keep:42},communication:{preset:'balanced',custom_instructions:'',futureStyle:{keep:true}}};
fs.writeFileSync(user,'\uFEFF'+JSON.stringify(original));
const retained=['auth.json','settings.json','mcp.json'].map(name=>path.join(ctx.paths.agent,name));
for(const file of retained)fs.writeFileSync(file,'{"synthetic":"preserve"}');
const before=retained.map(file=>fs.readFileSync(file));
let result=call('profile',['--json']);assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),original);
result=call('context-budget',['--json']);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).categories.profile.valid,true,'both beta profile readers accept a Windows UTF-8 BOM');
result=call('profile',['--edit','--json'],{input:'Beta Ω\n1\n'});assert.equal(result.status,0,result.stderr);
const edited=JSON.parse(result.stdout);assert.equal(edited.name,'Beta Ω');assert.equal(edited.communication.preset,'concise');assert.deepEqual(edited.future,original.future);assert.deepEqual(edited.communication.futureStyle,original.communication.futureStyle);
const editedBytes=fs.readFileSync(user);
for(const args of [['--edit','--reset'],['--unknown'],['--json','--json']]) {result=call('profile',args);assert.equal(result.status,1);assert.deepEqual(fs.readFileSync(user),editedBytes);}
fs.writeFileSync(user,'not-json synthetic-profile-secret');
result=call('profile',['--edit'],{input:'Do not write\n1\n'});assert.equal(result.status,1);assert.equal((result.stdout+result.stderr).includes('synthetic-profile-secret'),false);assert.equal(fs.readFileSync(user,'utf8'),'not-json synthetic-profile-secret');fs.writeFileSync(user,editedBytes);
fs.writeFileSync(path.join(cwd,'AGENTS.md'),'# Owned beta instructions\n');
result=call('context-budget',['--json','--measure','--yes']);assert.equal(result.status,0,result.stderr);
const budget=JSON.parse(result.stdout);assert.equal(budget.measurement.method,'static_char_estimate');assert.equal(path.resolve(budget.categories.profile.path),user);assert.equal(budget.categories.profile.valid,true);assert.equal(path.resolve(budget.categories.project_instructions.path),path.join(cwd,'AGENTS.md'));assert.match(result.stderr,/not available/);
result=call('context-budget',['--json'],{cwd:outside});assert.equal(result.status,1);
const marker=path.join(ctx.root,'.coop-beta.json'),markerBytes=fs.readFileSync(marker);
const missing=JSON.parse(markerBytes);missing.tools.python.path=path.join(outside,'missing-python.exe');fs.writeFileSync(marker,JSON.stringify(missing));
try {result=call('profile',['--json']);assert.equal(result.status,1);} finally {fs.writeFileSync(marker,markerBytes);}
const saved=assertOwnedPath(ctx,`${user}.saved`);assertOwnedPath(ctx,user);fs.renameSync(user,saved);fs.symlinkSync(outside,user,process.platform==='win32'?'junction':'dir');
try {result=call('profile',['--reset']);assert.equal(result.status,1);assert.equal(fs.readFileSync(sentinel,'utf8'),'preserve outside');} finally {fs.unlinkSync(user);fs.renameSync(saved,user);}
if(process.platform==='win32') {
  for(const shell of [path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),which('pwsh.exe')]) {
    result=spawnSync(shell,['-NoProfile','-File',path.join(ctx.paths.bin,'coop-beta.ps1'),'profile','--json'],{cwd,env:childEnv,encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).name,'Beta Ω');
  }
  result=spawnSync(process.env.COOP_TEST_BASH || 'C:/Program Files/Git/bin/bash.exe',['--noprofile','--norc',path.join(ctx.paths.source,'bin/coop'),'context-budget','--json'],{cwd,env:{...betaEnvironment(ctx,env),MSYS2_ARG_CONV_EXCL:'*'},encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(result.status,0,result.stderr);
}
result=call('profile',['--reset']);assert.equal(result.status,0,result.stderr);assert.equal(fs.existsSync(user),false);
result=call('profile',['--json']);assert.equal(result.status,1);assert.equal(fs.existsSync(user),false);
result=call('profile',['--edit'],{input:''});assert.equal(result.status,1);assert.equal(fs.existsSync(user),false,'EOF must not invent a profile');
assert.deepEqual(retained.map(file=>fs.readFileSync(file)),before);assert.equal(fs.readFileSync(sentinel,'utf8'),'preserve outside');assert.equal(fs.existsSync(poisonMarker),false);
// A clean, explicitly selected source still cannot configure external budget resources.
fs.writeFileSync(path.join(fixture,'config/defaults.yml'),`guardrails: ${sentinel.replaceAll('\\','/')}\n`);
const bad=install('Budget scope check',commit());
const badArgs=process.platform==='win32'?[path.join(bad.paths.bin,'beta-entry.mjs'),'context-budget','--json']:[path.join(bad.paths.source,'lib/beta-lifecycle.mjs'),'context-budget',bad.root,'--json'];
result=spawnSync(process.execPath,badArgs,{cwd:path.join(bad.root,'workspaces'),env:betaEnvironment(bad,env),encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(result.status,1);assert.match(result.stderr,/Beta context resources must remain inside/);assert.equal(fs.readFileSync(sentinel,'utf8'),'preserve outside');
console.log('Beta profile/context: selected Python, Unicode edit, future-field preservation, scoped reset/read, static measurement, EOF and path/tool/config refusal passed');
