import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planBetaContext,claimBetaRoot,betaEnvironment} from '../lib/installation-context.mjs';
import {checkBetaSupport,writeBetaLaunchers} from '../lib/beta-lifecycle.mjs';
import {fingerprintBuild} from '../lib/support-center.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'coop-beta-support-'));
const fixture=path.join(scratch,'fixture');
const git=process.env.COOP_TEST_GIT || execFileSync(process.platform==='win32'?'where.exe':'which',[process.platform==='win32'?'git.exe':'git'],{encoding:'utf8'}).trim().split(/\r?\n/)[0];
const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(scratch,'no-global'),GIT_TERMINAL_PROMPT:'0'};
const runGit=(cwd,args)=>execFileSync(git,['-C',cwd,...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true}).trim();
for(const file of ['VERSION','config/windows-beta-manifest.json','config/standards-registry.json',
  'bin/coop','bin/coop.ps1','scripts/support-center.ps1','scripts/support-center.sh',
  ...['installation-context.mjs','beta-lifecycle.mjs','beta-entry.mjs','owned-process.ps1','common.ps1','common.sh','support-center-cli.mjs','support-center.mjs','coop-build-identity.mjs','standards.mjs'].map(name=>`lib/${name}`)]) {
  fs.mkdirSync(path.dirname(path.join(fixture,file)),{recursive:true}); fs.copyFileSync(path.join(repo,file),path.join(fixture,file));
}
runGit(fixture,['init']); runGit(fixture,['config','core.autocrlf','false']); runGit(fixture,['add','.']);
runGit(fixture,['-c','user.name=Coop fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic support fixture']);
const build=runGit(fixture,['rev-parse','HEAD']);
const ctx=planBetaContext({root:path.join(scratch,'Beta Ω'),build,tools:{node:process.execPath,python:process.execPath,fabricPython:process.execPath,git},manifest:fs.readFileSync(path.join(fixture,'config/windows-beta-manifest.json'))});
claimBetaRoot(ctx);
execFileSync(git,['-c','core.autocrlf=false','clone','--no-hardlinks',fixture,ctx.paths.source],{env,stdio:'ignore',windowsHide:true});
writeBetaLaunchers(ctx);
const cwd=path.join(ctx.root,'workspaces'); fs.mkdirSync(cwd);
fs.mkdirSync(ctx.paths.temp); fs.mkdirSync(ctx.paths.agent,{recursive:true});
const auth=path.join(ctx.paths.agent,'auth.json'); fs.writeFileSync(auth,'{"synthetic":"preserve"}');
const outside=path.join(scratch,'outside'); fs.mkdirSync(outside);
const sentinel=path.join(outside,'keep.json'); fs.writeFileSync(sentinel,'preserve');
for(const args of [['--export',sentinel],['--export',auth],['--export',path.join(ctx.paths.source,'new.json')],['--export'],['--json','--json'],['--bogus']]) assert.throws(()=>checkBetaSupport(ctx,cwd,args));
assert.equal(fs.existsSync(path.join(ctx.paths.profile,'support')),false,'rejected requests must not write diagnostics');
const junction=path.join(cwd,'escape'); fs.symlinkSync(outside,junction,process.platform==='win32'?'junction':'dir');
assert.throws(()=>checkBetaSupport(ctx,cwd,['--export',path.join(junction,'new.json')]),/Link|Reparse/); fs.unlinkSync(junction);
const config=path.join(ctx.paths.profile,'config'); fs.writeFileSync(config,JSON.stringify({knowledge:{repos:[{name:'coop-team-knowledge',local_path:outside}]}}));
assert.throws(()=>checkBetaSupport(ctx,cwd,[]),/outside/); fs.unlinkSync(config);
fs.writeFileSync(config,'not-json synthetic-config-secret');
assert.throws(()=>checkBetaSupport(ctx,cwd,[]),error=>error.message==='Invalid beta support configuration');
fs.unlinkSync(config);
const support=path.join(ctx.paths.profile,'support'),bundles=path.join(support,'bundles');
fs.mkdirSync(bundles,{recursive:true});
const events=path.join(support,'events.jsonl'); fs.writeFileSync(events,'bad line token=synthetic-secret\n'+JSON.stringify({event:'test',api_key:'synthetic-api-canary'})+'\n');
fs.writeFileSync(path.join(bundles,'keep-user-note.json'),'preserve');
for(let i=0;i<12;i++) fs.writeFileSync(path.join(bundles,`bundle-run-2026-01-01-${i.toString(16).padStart(8,'0')}.json`),'{}');
const scoped=betaEnvironment(ctx,env);
const poisoned={...scoped,PATH:outside,COOP_DIR:outside,COOP_PROFILE_ROOT:outside,COOP_STANDARDS_ROOT:outside};
const call=(executable,args,extra={})=>spawnSync(executable,args,{cwd,env:poisoned,encoding:'utf8',timeout:120000,windowsHide:true,...extra});
// A PATH/CWD impostor must never be used for diagnostic Git or Node calls.
for(const name of ['git','node','coop-sql-review','coop-dax-review']) {
  const shim=process.platform==='win32'?`${name}.cmd`:name;
  const text=process.platform==='win32'?'@echo POISON_EXECUTED\r\nexit /b 91\r\n':'#!/bin/sh\necho POISON_EXECUTED\nexit 91\n';
  for(const dir of [outside,cwd]) fs.writeFileSync(path.join(dir,shim),text,{mode:0o755});
}
fs.mkdirSync(path.join(cwd,'.coop'));
fs.writeFileSync(path.join(cwd,'.coop/project.yml'),'standards:\n  sql: sql-standard.md\n');
fs.writeFileSync(path.join(cwd,'sql-standard.md'),'# Synthetic SQL standard\nUse qualified names.\n');
runGit(cwd,['init']); runGit(cwd,['config','core.autocrlf','false']); runGit(cwd,['add','.']);
runGit(cwd,['-c','user.name=Coop fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic project standard']);
const projectBuild=runGit(cwd,['rev-parse','HEAD']);
const direct=call(process.execPath,[path.join(ctx.paths.source,'lib/support-center-cli.mjs'),'--json']);
assert.equal(direct.status,0,direct.stderr);
const bundle=JSON.parse(direct.stdout); assert.equal(bundle.versions.coopBuild,fingerprintBuild({version:fs.readFileSync(path.join(fixture,'VERSION'),'utf8').trim(),commit:build}).value);
assert.equal(bundle.standards.domains.sql.state,'project_override');
assert.equal(bundle.standards.domains.sql.revision,projectBuild,'project provenance must use selected Git, never the CWD/PATH impostor');
assert.equal(JSON.stringify(bundle).includes('synthetic-api-canary'),false); assert.equal(JSON.stringify(bundle).includes('synthetic-secret'),false);
assert.equal(direct.stdout.includes('POISON_EXECUTED'),false);
for(const component of ['node','git']) assert.equal(bundle.manifest.components.find(entry=>entry.component===component).status,'ok','diagnostic executable must not resolve a failing PATH impostor');
assert.equal(fs.readFileSync(path.join(bundles,'keep-user-note.json'),'utf8'),'preserve');
assert.equal(fs.readdirSync(bundles).filter(name=>name.startsWith('bundle-')).length,10);
assert.equal(fs.readFileSync(auth,'utf8'),'{"synthetic":"preserve"}'); assert.equal(fs.readFileSync(sentinel,'utf8'),'preserve');
const eventBefore=fs.readFileSync(events);
const eventAlias=path.join(outside,'event-alias.jsonl');
fs.linkSync(events,eventAlias);
assert.throws(()=>checkBetaSupport(ctx,cwd,[]),/Hardlink/);
const linkedEvent=call(process.execPath,[path.join(ctx.paths.source,'lib/support-center-cli.mjs'),'--json']);
assert.equal(linkedEvent.status,1); assert.match(linkedEvent.stderr,/Hardlink/);
assert.deepEqual(fs.readFileSync(events),eventBefore); assert.deepEqual(fs.readFileSync(eventAlias),eventBefore);
if(process.platform==='win32') {
  const linkedPublic=call(process.execPath,[path.join(ctx.paths.bin,'beta-entry.mjs'),'support','--json']);
  assert.equal(linkedPublic.status,1); assert.match(linkedPublic.stderr,/Hardlink/);
  assert.deepEqual(fs.readFileSync(eventAlias),eventBefore);
}
fs.unlinkSync(eventAlias);
const refused=call(process.execPath,[path.join(ctx.paths.source,'lib/support-center-cli.mjs'),'--export',sentinel]);
assert.equal(refused.status,1); assert.deepEqual(fs.readFileSync(events),eventBefore);
fs.writeFileSync(config,'not-json synthetic-config-secret',{flag:'wx'});
try {
  const malformed=call(process.execPath,[path.join(ctx.paths.source,'lib/support-center-cli.mjs'),'--json']);
  assert.equal(malformed.status,1); assert.equal((malformed.stdout+malformed.stderr).includes('synthetic-config-secret'),false);
  assert.match(malformed.stderr,/Invalid beta support configuration/); assert.deepEqual(fs.readFileSync(events),eventBefore);
} finally { fs.unlinkSync(config); }
if(process.platform==='win32') {
  const shells=[path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),execFileSync('where.exe',['pwsh.exe'],{encoding:'utf8'}).trim().split(/\r?\n/)[0]];
  for(let i=0;i<shells.length;i++) {
    const output=path.join(cwd,`export Ω ${i}.json`);
    const result=call(shells[i],['-NoProfile','-File',path.join(ctx.paths.bin,'coop-beta.ps1'),'support','--json','--export',output]);
    assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(fs.readFileSync(output)).versions.coopBuild,bundle.versions.coopBuild);
  }
  const bridge=call(process.execPath,[path.join(ctx.paths.bin,'beta-entry.mjs'),'support','--json']); assert.equal(bridge.status,0,bridge.stderr);
  const bash=process.env.COOP_TEST_BASH || 'C:/Program Files/Git/bin/bash.exe';
  const shell=call(bash,['--noprofile','--norc',path.join(ctx.paths.source,'scripts/support-center.sh'),'--json'],{env:{...scoped,MSYS2_ARG_CONV_EXCL:'*'}});
  assert.equal(shell.status,0,shell.stderr);
}
console.log('Beta support: scoped/sanitized exports, retention, exact diagnostic tools, overwrite/junction/foreign-state refusal and native entries passed');
