import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if(process.platform!=='win32')throw Error('This check requires native Windows');
const bundle=resolve(process.argv[2]);
const root=mkdtempSync(join(resolve(process.argv[3]),'shell-tools-é & '));
const python=join(bundle,'python/runtime/python.exe');
const env={PATH:[join(bundle,'python/runtime'),join(process.env.SystemRoot,'System32'),join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0')].join(';'),HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,TEMP:root,TMP:root,PYTHONDONTWRITEBYTECODE:'1'};
for(const key of ['SystemRoot','WINDIR','ComSpec','PATHEXT','ProgramFiles','ProgramFiles(x86)'])if(process.env[key])env[key]=process.env[key];
for(const key of Object.keys(process.env))delete process.env[key];
Object.assign(process.env,env,{COOP_ROOT:join(bundle,'coop'),COOP_DESKTOP_MANAGED_RUNTIME:'1',PI_CODING_AGENT_DIR:join(root,'agent'),PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',COOP_NO_ONBOARD:'1',COOP_SKIP_AZ:'1'});
const {loadExtensions}=await import(pathToFileURL(join(bundle,'npm/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')));
const loaded=await loadExtensions([join(bundle,'coop/extensions/coop-tools/index.ts')],root);
assert.deepEqual(loaded.errors,[]);
assert.equal(loaded.extensions.length,1);
const registered=loaded.extensions[0].tools;
const worker=join(root,'worker.py'), launcher=join(root,'launcher.py'), parent=join(root,'parent.py');
writeFileSync(worker,`import pathlib,os,sys,time
r=pathlib.Path(sys.argv[1]);(r/'started').write_text(str(os.getpid()))
time.sleep(3 if sys.argv[2]=='normal' else 30);(r/'finished').write_text('completed')
`);
writeFileSync(launcher,`import subprocess,sys
subprocess.Popen([sys.executable,sys.argv[1],sys.argv[2],sys.argv[3]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=0x8)
`);
writeFileSync(parent,`import subprocess,sys,pathlib,time
subprocess.run([sys.executable,${JSON.stringify(launcher)},${JSON.stringify(worker)},sys.argv[1],sys.argv[2]],check=True)
if sys.argv[2]!='normal': time.sleep(120)
`);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const receipts=[];
for(const shell of ['bash','powershell'])for(const scenario of ['normal','cancel','timeout']) {
  const cwd=join(root,shell+'-'+scenario);mkdirSync(cwd);
  const definition=registered.get(shell)?.definition;
  assert.equal(typeof definition?.execute,'function',shell+' must be registered by the actual Pi loader');
  const controller=new AbortController();
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  const command=(shell==='powershell'?'& ':'')+[python,parent,cwd,scenario].map(quote).join(' ');
  let output='';
  const outcome=definition.execute('native-'+shell+'-'+scenario,{command,...(scenario==='timeout'?{timeout:10}:{})},controller.signal,chunk=>{output+=JSON.stringify(chunk);},{cwd,hasUI:false,ui:{notify(){}},sessionManager:{getSessionId(){return 'native-fixture';},getSessionFile(){return undefined;}}}).then(value=>({value}),error=>({error}));
  if(scenario==='cancel') {
    const deadline=Date.now()+15000;
    while(!existsSync(join(cwd,'started'))){if(Date.now()>deadline)throw Error('Fixture did not start: '+output);await pause(25);}
    controller.abort();
  }
  const result=await outcome;
  if(scenario==='normal' && result.value && !result.value.isError) {
    const deadline=Date.now()+15000;
    while(!existsSync(join(cwd,'started'))){if(Date.now()>deadline)break;await pause(25);}
  }
  assert.equal(existsSync(join(cwd,'started')),true,shell+' '+scenario+' must exercise a real worker: '+String(result.error||'')+' '+output);
  if(scenario==='normal')assert.ok(result.value && !result.value.isError,output+String(result.error||''));
  else assert.match(result.error?.message||'',scenario==='cancel'?/abort/i:/timed? ?out|timeout/i);
  await pause(3500);
  assert.equal(existsSync(join(cwd,'finished')),scenario==='normal',shell+' '+scenario);
  receipts.push({shell,scenario,passed:true,completionMarker:existsSync(join(cwd,'finished')),workerPid:existsSync(join(cwd,'started'))?Number(readFileSync(join(cwd,'started'),'utf8')):null});
}
writeFileSync(join(root,'receipt.json'),JSON.stringify(receipts,null,2));
console.log(JSON.stringify({passed:true,root,receipts,installedGuiVerified:false}));
