import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const { JsonlLineDecoder, resolveDataDocExecutable, runJsonlSetup } = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);
const d = new JsonlLineDecoder(100);
assert.deepEqual(d.push('{"x":"a\u2028b\u2029c"}\r\n{"y":'), ['{"x":"a\u2028b\u2029c"}']);
assert.deepEqual(d.push('1}\n'), ['{"y":1}']); d.finish();
assert.throws(() => new JsonlLineDecoder(3).push("1234"), /exceeds/);
const emoji = Buffer.from('{"x":"😀"}\n'); const split = new JsonlLineDecoder();
assert.deepEqual([...split.push(emoji.subarray(0, 8)), ...split.push(emoji.subarray(8))], ['{"x":"😀"}']); split.finish();
console.log("  ✓ LF-only decoder handles partial/multiple/CRLF/Unicode/size limit");

// Cross-platform Windows resolution is shell-free, even with metacharacters in PATH.
const winRoot = mkdtempSync(join(tmpdir(), "coop &(win)-"));
writeFileSync(join(winRoot, "coop-data-doc.exe"), "fixture");
assert.equal(resolveDataDocExecutable("win32", { PATH: winRoot }), join(winRoot, "coop-data-doc.exe"));
const cmdOnly = join(winRoot, "cmd-only"); mkdirSync(cmdOnly); writeFileSync(join(cmdOnly, "coop-data-doc.cmd"), "echo unsafe");
assert.throws(() => resolveDataDocExecutable("win32", { PATH: cmdOnly }), /unsafe \.cmd/);
console.log("  ✓ Windows resolver prefers direct .exe and rejects shell shims/metacharacter injection");

if (process.platform !== "win32") {
  const dir = mkdtempSync(join(tmpdir(), "coop-jsonl-"));
  const exe = join(dir, "coop-data-doc");
  writeFileSync(exe, `#!${process.execPath}
const rl=require('node:readline').createInterface({input:process.stdin});
const mode=process.env.COOP_FIXTURE_MODE||'flow';
const line=o=>process.stdout.write(JSON.stringify(o)+'\\n');
(async()=>{
 if(mode==='malformed'){process.stdout.write('not json\\n');return}
 if(mode==='large'){process.stdout.write(JSON.stringify({type:'notice',message:'x'.repeat(1024*1024+2)})+'\\n');return}
 if(mode==='missing'){process.exit(0)}
 if(mode==='duplicate'){line({type:'complete'});line({type:'complete'});return}
 if(mode==='contradiction'){process.stderr.write('diagnostic-tail\\n');line({type:'complete'});process.exit(2)}
 if(mode==='error'){process.stderr.write('child-stderr\\n');line({type:'error',message:'boom'});process.exit(2)}
 if(mode==='cancel'){
   line({type:'prompt',id:'cancel',kind:'text',message:'Cancel me',default:'',choices:[]});
   const a=JSON.parse((await rl[Symbol.asyncIterator]().next()).value); if(!a.cancelled) process.exit(3);
   line({type:'cancelled'});process.exit(130)
 }
 process.stdout.write(JSON.stringify({type:'hello',protocol_version:'1.1'})+'\\n'+JSON.stringify({type:'notice',message:'ready'})+'\\n'+JSON.stringify({type:'progress',message:'scan \\u2028 ok'})+'\\n');
 const select=JSON.stringify({type:'prompt',id:'select',kind:'select',message:'Pick',choices:[{label:'Alpha',value:'a'},{label:'Beta',value:'b'}]})+'\\r\\n';
 process.stdout.write(select.slice(0,11));setTimeout(()=>process.stdout.write(select.slice(11)),5);
 const it=rl[Symbol.asyncIterator](); const a1=JSON.parse((await it.next()).value); if(a1.answer!=='b') process.exit(4);
 line({type:'prompt',id:'check',kind:'checkbox',message:'Folders',choices:[{label:'A',value:'a',checked:true}]});
 const a2=JSON.parse((await it.next()).value); if(JSON.stringify(a2.answer)!=='["a"]') process.exit(5);
 line({type:'complete',message:'done',data:{config:'coop-data-doc.yml'}});process.exit(0);
})().catch(e=>{process.stderr.write(String(e));process.exit(9)});
`);
  chmodSync(exe, 0o755);
  const oldPath = process.env.PATH; process.env.PATH = dir + delimiter + oldPath;
  const notices = [];
  const ctx = { cwd: dir, ui: {
    input: async () => "answer",
    select: async (message, choices) => message === "Pick" ? "Beta" : "✓ Done",
    notify: (m) => notices.push(String(m)),
  } };
  process.env.COOP_FIXTURE_MODE = "flow"; assert.equal(await runJsonlSetup({}, ctx), true);
  process.env.COOP_FIXTURE_MODE = "cancel"; assert.equal(await runJsonlSetup({}, { ...ctx, ui: { ...ctx.ui, input: async () => null } }), false);
  for (const mode of ["error", "malformed", "large", "missing", "duplicate", "contradiction"]) {
    process.env.COOP_FIXTURE_MODE = mode; assert.equal(await runJsonlSetup({}, ctx), false, mode);
  }
  process.env.PATH = "/no/such/path"; delete process.env.COOP_FIXTURE_MODE;
  assert.equal(await runJsonlSetup({}, ctx), false, "spawn error");
  process.env.PATH = oldPath;
  assert.ok(notices.some((n) => n.includes("diagnostic-tail")), "stderr tail reported on contradiction");
  assert.ok(notices.some((n) => n.includes("protocol")), "protocol failures reported");
  console.log("  ✓ fake subprocess covers sequencing/select/checkbox/progress/cancel/framing/terminal errors/spawn/stderr");
} else {
  console.log("  ✓ Windows subprocess execution remains covered by CI/manual .exe launch; unsafe shell fallback is impossible");
}
