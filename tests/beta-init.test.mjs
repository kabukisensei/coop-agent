import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planBetaContext,claimBetaRoot,betaEnvironment} from '../lib/installation-context.mjs';
import {writeBetaLaunchers,checkBetaInit} from '../lib/beta-lifecycle.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'coop-beta-init-'));
const which=name=>execFileSync(process.platform==='win32'?'where.exe':'which',[name],{encoding:'utf8'}).trim().split(/\r?\n/)[0];
const git=process.env.COOP_TEST_GIT || which(process.platform==='win32'?'git.exe':'git');
const python=process.env.COOP_TEST_PYTHON || which(process.platform==='win32'?'python.exe':'python3');
const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(scratch,'no-global'),GIT_TERMINAL_PROMPT:'0'};
const runGit=(cwd,args)=>execFileSync(git,['-C',cwd,...args],{env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const fixture=path.join(scratch,'fixture');
for(const file of ['VERSION','config/windows-beta-manifest.json','config/defaults.yml','.coop/project.example.yml',
  'bin/coop','bin/coop.ps1',...['installation-context.mjs','beta-lifecycle.mjs','beta-entry.mjs','owned-process.ps1',
  'common.ps1','common.sh','init_wizard.py','beta_paths.py','azure_auth.py','_seeddocs.py','_ciscaffold.py','_yaml.py','project_health.py'].map(name=>`lib/${name}`)]) {
  fs.mkdirSync(path.dirname(path.join(fixture,file)),{recursive:true});fs.copyFileSync(path.join(repo,file),path.join(fixture,file));
}
runGit(fixture,['init']);runGit(fixture,['config','core.autocrlf','false']);runGit(fixture,['add','.']);
runGit(fixture,['-c','user.name=Coop fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic beta init fixture']);
const build=runGit(fixture,['rev-parse','HEAD']);
const ctx=planBetaContext({root:path.join(scratch,'Beta Ω'),build,tools:{node:process.execPath,python,fabricPython:python,git},manifest:fs.readFileSync(path.join(fixture,'config/windows-beta-manifest.json'))});
claimBetaRoot(ctx);execFileSync(git,['-c','core.autocrlf=false','clone','--no-hardlinks',fixture,ctx.paths.source],{env,stdio:'ignore',windowsHide:true});writeBetaLaunchers(ctx);
const cwd=path.join(ctx.root,'workspaces');
for(const dir of [cwd,ctx.paths.agent,ctx.paths.temp])fs.mkdirSync(dir,{recursive:true});
const retained=['auth.json','settings.json','mcp.json'].map(name=>path.join(ctx.paths.agent,name));
for(const file of retained)fs.writeFileSync(file,'{"syntheticFutureField":42}');
const before=retained.map(file=>fs.readFileSync(file));
const outside=path.join(scratch,'outside');fs.mkdirSync(outside);
const sentinel=path.join(outside,'preserve.txt');fs.writeFileSync(sentinel,'preserve outside');
const poison=path.join(outside,'tool-ran');
for(const name of ['python','python3','az','git','te','coop-data-doc']) {
  fs.writeFileSync(path.join(outside,process.platform==='win32'?`${name}.cmd`:name),process.platform==='win32'?`@echo called > "${poison}"\r\nexit /b 91\r\n`:`#!/bin/sh\nprintf called > '${poison}'\nexit 91\n`,{mode:0o755});
}
const childEnv={...betaEnvironment(ctx,env),PATH:outside,COOP_GIT:outside,COOP_AZ_BIN:outside,COOP_DATA_DOC_BIN:outside,COOP_BETA_DATA_DOC_COMMAND:JSON.stringify([path.join(outside,'coop-data-doc.cmd')])};
const publicArgs=args=>process.platform==='win32'?[path.join(ctx.paths.bin,'beta-entry.mjs'),'init',...args]:[path.join(ctx.paths.source,'lib/beta-lifecycle.mjs'),'init',ctx.root,...args];
const call=(args,options={})=>spawnSync(process.execPath,publicArgs(args),{cwd,env:childEnv,encoding:'utf8',windowsHide:true,timeout:120000,...options});
const success=(args,options)=>{const r=call(args,options);assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);return r;};
const contract=dir=>path.join(dir,'.coop/project.yml');
const target=path.join(cwd,'Template Ω');
success(['--template',target]);assert.equal(fs.readFileSync(contract(target),'utf8').replace(/\r\n/g,'\n'),fs.readFileSync(path.join(ctx.paths.source,'.coop/project.example.yml'),'utf8').replace(/\r\n/g,'\n'));
assert.equal(call(['--template',target]).status,1); // no overwrite
assert.equal(call(['--template',outside]).status,1);assert.equal(fs.existsSync(contract(outside)),false);
assert.equal(call(['--template','new'],{cwd:outside}).status,1);
for(const args of [['a','b'],['--template','--ci','github'],['--template','--template'],['--apply'],['--archive','.pi/AGENTS.md'],['--ci','bad'],['--migrate-legacy','--archive','../escape'],['--seed-docs']]) {
  assert.throws(()=>checkBetaInit(ctx,cwd,args),/Beta|beta|Migration|Choose|Unsupported|Repeated/);
}
const wizard=path.join(cwd,'Wizard Ω');
const answers=['Beta Ω','Synthetic engagement','UTC','workspace','Test project',wizard,'main','generic','n','y','manual-tenant'];
const guided=success([wizard],{input:answers.join('\n')+'\n'});
assert.match(guided.stderr,/Lineage setup is unavailable/);
assert.match(fs.readFileSync(contract(wizard),'utf8'),/organization: 'Beta Ω'/);
assert.match(fs.readFileSync(contract(wizard),'utf8'),/tenant_id: 'manual-tenant'/);
const eof=path.join(cwd,'EOF');assert.equal(call([eof],{input:''}).status,1);assert.equal(fs.existsSync(eof),false);
const escaped=path.join(cwd,'Rejected input');
assert.equal(call([escaped],{input:['Org','Client','UTC','repo','desc',outside].join('\n')+'\n'}).status,1);
assert.equal(fs.existsSync(escaped),false,'outside wizard input must fail before creating a contract');
const extra=path.join(cwd,'Rejected extra');
assert.equal(call([extra],{input:['Org','Client','UTC','repo','desc',extra,'main','generic','y',outside].join('\n')+'\n'}).status,1);
assert.equal(fs.existsSync(extra),false);
const fileTarget=path.join(cwd,'file-target');fs.writeFileSync(fileTarget,'preserve file');
assert.throws(()=>checkBetaInit(ctx,cwd,['--template',fileTarget]),/directory/);assert.equal(fs.readFileSync(fileTarget,'utf8'),'preserve file');
if(process.platform==='win32') {
  const ambiguous=path.join(cwd,'Ambiguous input');
  assert.equal(call([ambiguous],{input:['Org','Client','UTC','repo','desc',path.join(cwd,'.. ','outside')].join('\n')+'\n'}).status,1);
  assert.equal(fs.existsSync(ambiguous),false);
}
console.log('Beta init: template/guided Unicode, no overwrite, EOF, interactive path and option refusals passed');

const ci=path.join(cwd,'CI');fs.mkdirSync(path.dirname(contract(ci)),{recursive:true});
fs.writeFileSync(contract(ci),'repositories:\n  sql:\n    local_path: .\n    sql_root: sql\ncustom:\n  keep: true\n');
const ciBefore=fs.readFileSync(contract(ci));
for(const type of ['github','ado']) {
  success(['--ci',type,ci]);
  const output=path.join(ci,...(type==='github'?['.github','workflows']:['azure-pipelines']),'coop-gates.yml');
  const contents=fs.readFileSync(output);assert.match(contents.toString(),/coop-sql-review/);
  assert.equal(call(['--ci',type,ci]).status,1);assert.deepEqual(fs.readFileSync(output),contents);
}
assert.deepEqual(fs.readFileSync(contract(ci)),ciBefore);
fs.writeFileSync(contract(ci),'repositories:\n  sql:\n    local_path: TOKEN_CANARY=private\n');
// A different directory keeps the CI-file no-overwrite gate from masking the
// content-free input-validation error under test.
const invalidCi=path.join(cwd,'Invalid CI');fs.mkdirSync(path.dirname(contract(invalidCi)),{recursive:true});
fs.copyFileSync(contract(ci),contract(invalidCi));fs.writeFileSync(contract(ci),ciBefore);
const invalid=call(['--ci','github',invalidCi]);assert.equal(invalid.status,1);assert.equal((invalid.stdout+invalid.stderr).includes('TOKEN_CANARY'),false);assert.equal(fs.existsSync(path.join(invalidCi,'.github')),false);
const migration=path.join(cwd,'Migration');fs.mkdirSync(path.dirname(contract(migration)),{recursive:true});
const original='profile:\n  organization: Test\nstandards:\n  sql: docs/standards/sql-standards.md\n  dax: docs/standards/dax-standards.md\n  documentation: docs/standards/documentation-standards.md\n  fabric: docs/standards/fabric-standards.md\ncustom:\n  keep: true\n';
fs.writeFileSync(contract(migration),original);
success(['--migrate-legacy',migration]);assert.equal(fs.readFileSync(contract(migration),'utf8'),original);
assert.equal(call(['--migrate-legacy','--apply',migration],{input:'n\n'}).status,1);assert.equal(fs.readFileSync(contract(migration),'utf8'),original);
success(['--migrate-legacy','--apply','--yes',migration]);
assert.doesNotMatch(fs.readFileSync(contract(migration),'utf8'),/standards:/);assert.match(fs.readFileSync(contract(migration),'utf8'),/keep: true/);
const archive=path.join(migration,'.coop','legacy-project-archive');const archiveEntries=fs.readdirSync(archive);
assert.equal(archiveEntries.length,1);assert.equal(fs.readFileSync(path.join(archive,archiveEntries[0],'.coop/project.yml'),'utf8'),original);
success(['--migrate-legacy','--apply','--yes',migration]);assert.deepEqual(fs.readdirSync(archive),archiveEntries);
const linked=path.join(cwd,'Linked');fs.symlinkSync(outside,linked,process.platform==='win32'?'junction':'dir');
assert.throws(()=>checkBetaInit(ctx,cwd,['--template',linked]),/Link|Reparse/);assert.equal(fs.existsSync(contract(outside)),false);
assert.throws(()=>checkBetaInit({...ctx,tools:{...ctx.tools,python:{...ctx.tools.python,path:path.join(outside,'missing.exe')}}},cwd,['--template','missing-tool']),/missing/);
console.log('Beta init: CI refusal/preservation, dry-run/decline/apply/idempotent migration, archive preservation and link/missing-tool refusal passed');
if(process.platform==='win32') {
  for(const shell of [path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),which('pwsh.exe')]) {
    const name='Native '+path.basename(path.dirname(shell));
    const result=spawnSync(shell,['-NoProfile','-File',path.join(ctx.paths.bin,'coop-beta.ps1'),'init','--template',name],{cwd,env:childEnv,encoding:'utf8',windowsHide:true,timeout:120000});
    assert.equal(result.status,0,result.stderr);assert.ok(fs.existsSync(contract(path.join(cwd,name))));
  }
  const bash=spawnSync(process.env.COOP_TEST_BASH || 'C:/Program Files/Git/bin/bash.exe',['--noprofile','--norc',path.join(ctx.paths.source,'bin/coop'),'init','--template','Git Bash Ω'],{cwd,env:{...betaEnvironment(ctx,env),MSYS2_ARG_CONV_EXCL:'*'},encoding:'utf8',windowsHide:true,timeout:120000});
  assert.equal(bash.status,0,bash.stderr);assert.ok(fs.existsSync(contract(path.join(cwd,'Git Bash Ω'))));
}
assert.deepEqual(retained.map(file=>fs.readFileSync(file)),before);assert.equal(fs.readFileSync(sentinel,'utf8'),'preserve outside');assert.equal(fs.existsSync(poison),false);
console.log('Beta init: selected tools, profile preservation and native PS 5.1/7/Node/Git Bash entries passed; no Azure/TE/data-doc calls');
