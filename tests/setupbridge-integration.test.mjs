import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const mod = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);
const { JsonlLineDecoder, resolveDataDocExecutable, runJsonlSetup } = mod;
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
 if(mode==='hello-bad'){line({type:'hello',protocol_version:'2.0'});line({type:'complete'});process.exit(0)}
 if(mode==='hello-dup'){line({type:'hello',protocol_version:'1.1'});line({type:'hello',protocol_version:'1.1'});line({type:'complete'});process.exit(0)}
 if(mode==='no-hello'){line({type:'prompt',id:'q',kind:'text',message:'x',default:'',choices:[]});process.exit(0)}
 if(mode==='early-close'){line({type:'hello',protocol_version:'1.1'});line({type:'prompt',id:'q',kind:'text',message:'x',default:'',choices:[]});process.exit(0)}
 if(mode==='large'){process.stdout.write(JSON.stringify({type:'notice',message:'x'.repeat(1024*1024+2)})+'\\n');return}
 if(mode==='missing'){process.exit(0)}
 if(mode==='duplicate'){line({type:'complete'});line({type:'complete'});return}
 if(mode==='contradiction'){line({type:'hello',protocol_version:'1.1'});process.stderr.write('diagnostic-tail\\n');line({type:'complete'});process.exit(2)}
 if(mode==='error'){process.stderr.write('child-stderr\\n');line({type:'error',message:'boom'});process.exit(2)}
 if(mode==='repo-path'){
   // coop-data-doc 1.2.0's Power BI slot: _ask_repo_path (suggest ../pbi-repo; a
   // missing folder asks "Use it anyway?" with default=False), then save and
   // re-validate; a missing repo path is saved with the "not runnable" notice.
   const fs=require('node:fs'),path=require('node:path');
   const it=rl[Symbol.asyncIterator]();
   const ask=async(o)=>{line(o);const r=await it.next();if(r.done)process.exit(1);const a=JSON.parse(r.value);if(a.cancelled){line({type:'cancelled'});process.exit(130)}return a.answer};
   line({type:'hello',protocol_version:'1.1'});
   let raw;
   for(;;){
     const a=await ask({type:'prompt',id:'pbi_path',kind:'path',message:'Power BI repo path \u2014 the folder with your semantic models and reports:',default:'../pbi-repo',choices:[]});
     raw=(typeof a==='string'&&a.trim())||'../pbi-repo';
     const abs=path.resolve(process.cwd(),raw);
     if(fs.existsSync(abs)&&fs.statSync(abs).isDirectory())break;
     if(await ask({type:'prompt',id:'pbi_missing',kind:'confirm',message:"'"+abs+"' doesn't exist (yet). Use it anyway?",default:false,choices:[]})===true)break;
   }
   const cfg=path.join(process.cwd(),'coop-data-doc.yml'),abs=path.resolve(process.cwd(),raw);
   fs.writeFileSync(cfg,'repos:\\n  powerbi:\\n    path: '+JSON.stringify(raw)+'\\n');
   if(fs.existsSync(abs)){line({type:'notice',message:"Saved coop-data-doc.yml \u2014 project 'x', 1 repos, 0 schema mapping(s)."});line({type:'complete',message:'Setup complete.',data:{config:'coop-data-doc.yml'}});process.exit(0)}
   line({type:'notice',message:"Saved, but not runnable yet: Repo 'powerbi' path does not exist: "+abs+" (configured in "+cfg+")"});
   line({type:'notice',message:'Saved coop-data-doc.yml. Fix the noted problem, then run \`coop-data-doc build\`.'});
   line({type:'complete',message:'Setup saved with validation notices.',data:{config:'coop-data-doc.yml'}});process.exit(0)
 }
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
  // r8-test-hygiene: sandboxed review environments may deny direct exec of
  // shebang scripts from tmp (spawnSync reports ENOENT while `node <script>`
  // still works). The product intentionally spawns the resolved executable
  // shell-free, so when the environment forbids that, skip the integration
  // block explicitly — assertions below are unchanged and still run wherever
  // direct exec is available.
  const execProbe = spawnSync(exe, [], { encoding: "utf8" });
  if (execProbe.error) {
    console.log(`  ↷ SKIP fake-subprocess integration — direct exec of tmp fixtures unavailable in this environment (${execProbe.error.code || execProbe.error.message}); unit resolver/decoder tests above still ran`);
  } else {
  const oldPath = process.env.PATH; process.env.PATH = dir + delimiter + oldPath;
  const notices = [];
  const ctx = { cwd: dir, ui: {
    input: async () => "answer",
    select: async (message, choices) => message === "Pick" ? "Beta" : "✓ Done",
    notify: (m) => notices.push(String(m)),
  } };
  process.env.COOP_FIXTURE_MODE = "flow"; assert.equal(await runJsonlSetup({}, ctx), true);
  process.env.COOP_FIXTURE_MODE = "cancel"; assert.equal(await runJsonlSetup({}, { ...ctx, ui: { ...ctx.ui, input: async () => null } }), false);
  process.env.COOP_FIXTURE_MODE = "early-close";
  assert.equal(await runJsonlSetup({}, { ...ctx, ui: {
    ...ctx.ui,
    input: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return "answer"; },
  } }), false, "early-close");
  for (const mode of ["error", "malformed", "large", "missing", "duplicate", "contradiction", "hello-bad", "hello-dup", "no-hello"]) {
    process.env.COOP_FIXTURE_MODE = mode; assert.equal(await runJsonlSetup({}, ctx), false, mode);
  }
  process.env.PATH = "/no/such/path"; delete process.env.COOP_FIXTURE_MODE;
  assert.equal(await runJsonlSetup({}, ctx), false, "spawn error");
  process.env.PATH = oldPath;
  assert.ok(notices.some((n) => n.includes("diagnostic-tail")), "stderr tail reported on contradiction");
  assert.ok(notices.some((n) => n.includes("protocol")), "protocol failures reported");
  assert.ok(notices.some((n) => /closed|input/.test(n)), "early wizard close is reported without an unhandled stdin error");
  console.log("  ✓ fake subprocess covers sequencing/select/checkbox/progress/cancel/framing/terminal errors/spawn/stderr");

  // --- #102: /setup-docs Enter-through from a home-folder session ------------
  // The teammate's session ran in C:\Users\<user>. Pressing Enter (the first
  // option) everywhere saved ../pbi-repo (= C:\Users\pbi-repo) and then
  // started a build that failed. Pi's own confirm lists Yes first, so Enter
  // there is Yes. After 12 dialogs the simulated user gives up with Esc.
  process.env.PATH = dir + delimiter + oldPath;
  process.env.COOP_FIXTURE_MODE = "repo-path";
  const homeLike = () => {
    const users = join(mkdtempSync(join(tmpdir(), "coop-102-")), "Users");
    const home = join(users, "me");
    mkdirSync(join(home, "Documents"), { recursive: true });
    mkdirSync(join(users, "Public"));
    return home;
  };
  const enterEverywhere = (cwd, notes) => {
    let dialogs = 0;
    const giveUp = () => ++dialogs > 12;
    return { cwd, hasUI: true, mode: "tui", ui: {
      select: async (_title, options) => (giveUp() ? undefined : options[0]),
      confirm: async (title) => { notes.push({ message: `confirm: ${title}`, type: "dialog" }); return !giveUp(); },
      input: async () => (giveUp() ? undefined : ""),
      notify: (message, type) => notes.push({ message: String(message), type }),
    } };
  };
  const bootPi = () => {
    const commands = {}, execs = [];
    mod.default({
      on: () => {}, registerTool: () => {}, sendUserMessage: () => {},
      registerCommand: (name, spec) => { commands[name] = spec.handler; },
      exec: async (_bin, args) => {
        execs.push(args.join(" "));
        if (args[0] === "setup") return { code: 0, stdout: "--transport [terminal|jsonl]", stderr: "" };
        return { code: 1, stdout: "", stderr: "Error: Repo 'powerbi' path does not exist: C:\\Users\\pbi-repo (configured in C:\\Users\\me\\coop-data-doc.yml)\n" };
      },
    });
    return { commands, execs };
  };

  // 1. The bridge alone: Enter at every prompt never saves the placeholder.
  const bridgeHome = homeLike();
  const bridgeNotes = [];
  const bridgeOk = await runJsonlSetup({}, enterEverywhere(bridgeHome, bridgeNotes));
  const bridgeCfg = join(bridgeHome, "coop-data-doc.yml");
  assert.ok(!existsSync(bridgeCfg), `Enter-through saved ${existsSync(bridgeCfg) ? JSON.stringify(readFileSync(bridgeCfg, "utf8")) : ""}`);
  assert.equal(bridgeOk, false, "Enter-through ends only by Esc");
  console.log("  ✓ #102 bridge: Enter at every setup prompt never saves the ../pbi-repo placeholder");

  // 2. The command: /setup-docs in the home folder writes nothing and builds nothing.
  const home = homeLike();
  const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const { commands, execs } = bootPi();
    const notes = [];
    await commands["setup-docs"]("", enterEverywhere(home, notes));
    assert.ok(!existsSync(join(home, "coop-data-doc.yml")), "no coop-data-doc.yml in the home folder");
    assert.ok(!execs.includes("build"), "no build is started");
    assert.ok(notes.some((n) => n.type === "warning" && /home folder/i.test(n.message)), JSON.stringify(notes));
  } finally {
    for (const [k, v] of Object.entries(savedHome)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  console.log("  ✓ #102 /setup-docs from the home folder writes no config and starts no build");

  // 3. A deliberately kept missing path: a warning naming it, and no "Build now?".
  // realpath: the wizard reports paths from its own (resolved) working folder.
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "coop-102-proj-")));
  const project = join(workspace, "project");
  mkdirSync(project);
  const deliberate = (notes, typed) => ({ cwd: project, hasUI: true, mode: "tui", ui: {
    select: async (_title, options) => options.find((o) => o.startsWith("⌨")) || options.find((o) => o === "Yes"),
    confirm: async (title) => { notes.push({ message: `confirm: ${title}`, type: "dialog" }); return true; },
    input: async () => typed,
    notify: (message, type) => notes.push({ message: String(message), type }),
  } });
  const keptNotes = [];
  assert.equal(await runJsonlSetup({}, deliberate(keptNotes, "../pbi-repo")), true, "a saved config is a completed setup");
  assert.ok(keptNotes.some((n) => n.type === "warning" && n.message.startsWith("Saved, but not runnable yet:")),
    `the not-runnable notice is a warning: ${JSON.stringify(keptNotes)}`);
  {
    const { commands, execs } = bootPi();
    const notes = [];
    await commands["setup-docs"]("", deliberate(notes, "../pbi-repo"));
    assert.ok(!notes.some((n) => n.message === "confirm: Build now?"), `no Build now? after a not-runnable setup: ${JSON.stringify(notes)}`);
    assert.ok(!execs.includes("build"), "no build is started");
    const last = notes.filter((n) => n.type === "warning").pop();
    assert.ok(last && last.message.includes(join(workspace, "pbi-repo")), `the warning names the missing path: ${JSON.stringify(notes)}`);
  }
  // Control: a runnable setup still offers "Build now?".
  mkdirSync(join(workspace, "PowerBI"));
  {
    const { commands } = bootPi();
    const notes = [];
    await commands["setup-docs"]("", deliberate(notes, "../PowerBI"));
    assert.ok(notes.some((n) => n.message === "confirm: Build now?"), `a runnable setup offers Build now?: ${JSON.stringify(notes)}`);
  }
  process.env.PATH = oldPath; delete process.env.COOP_FIXTURE_MODE;
  console.log("  ✓ #102 a not-runnable setup warns with the missing path and skips Build now?; runnable setup still offers it");
  }
} else {
  console.log("  ✓ Windows subprocess execution remains covered by CI/manual .exe launch; unsafe shell fallback is impossible");
}
