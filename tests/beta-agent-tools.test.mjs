import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { default: register, companionInvocation, runJsonlSetup } = await import(pathToFileURL(join(process.env.COOP_TEST_DIST, 'coop-tools.mjs')).href);
const source = join(process.env.COOP_TEST_DIST, 'selected source');
const root = join(process.env.COOP_TEST_DIST, 'selected beta');
const node = process.execPath;
const env = { COOP_CHANNEL: 'beta', COOP_ROOT: source, COOP_BETA_ROOT: root, COOP_NODE: node, PATH: 'poisoned',
  COOP_PROFILE_ROOT: join(root, 'profile'), COOP_STANDARDS_SNAPSHOT_ROOT: join(root, 'profile', 'standards', 'snapshots'),
  COOP_STANDARDS_STATE: join(root, 'profile', 'standards', 'status.json') };
const entry = join(source, 'lib', 'beta-lifecycle.mjs');
assert.deepEqual(companionInvocation('coop-data-doc', ['lineage', '--', 'Table'], env),
  { bin: node, args: [entry, 'data-doc', root, 'lineage', '--', 'Table'] });
assert.deepEqual(companionInvocation('coop-sql-review', ['check', 'query.sql'], env),
  { bin: node, args: [entry, 'sql-review', root, 'check', 'query.sql'] });
assert.deepEqual(companionInvocation('coop-dax-review', ['check', 'measure.dax'], env),
  { bin: node, args: [entry, 'dax-review', root, 'check', 'measure.dax'] });
assert.deepEqual(companionInvocation('coop-data-doc', ['scan'], { COOP_CHANNEL: 'stable' }),
  { bin: 'coop-data-doc', args: ['scan'] });
for (const omitted of ['COOP_ROOT', 'COOP_BETA_ROOT', 'COOP_NODE']) {
  const broken = { ...env }; delete broken[omitted];
  assert.throws(() => companionInvocation('coop-data-doc', ['scan'], broken), /incomplete/);
}

const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
const tools = new Map(), calls = [], hooks = new Map();
const project = join(root, 'workspaces', 'project');
mkdirSync(join(project, '.coop'), { recursive: true });
mkdirSync(join(project, 'standards'), { recursive: true });
writeFileSync(join(project, 'standards', 'sql.md'), '# SQL\n## Stored procedures\nUse a schema.\n');
writeFileSync(join(project, 'standards', 'dax.md'), '# DAX\n## Measures\nUse explicit measures.\n');
writeFileSync(join(project, '.coop', 'project.yml'), 'standards:\n  sql: standards/sql.md\n  dax: standards/dax.md\n');
const pi = {
  on(name, hook) { hooks.set(name, hook); }, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); },
  async exec(bin, args, options) {
    calls.push({ bin, args, options });
    const domain = args[1] === 'sql-review' ? 'sql' : args[1] === 'dax-review' ? 'dax' : null;
    if (domain) {
      const location = args.indexOf('--standards');
      const standardsPath = args[location + 1];
      assert.ok(location >= 0 && standardsPath);
      const sha256 = createHash('sha256').update(readFileSync(standardsPath)).digest('hex');
      return { code: 0, stderr: '', stdout: JSON.stringify({ tool: `coop-${domain}-review`,
        schema_version: domain === 'sql' ? 4 : 3, version: 'synthetic',
        [domain === 'sql' ? 'files_checked' : 'models_checked']: 0,
        standards: { path: standardsPath, sha256 }, findings: [], diagnostics: [], agent_review: [],
        summary: { error: 0, warning: 0, info: 0 }, verdict: { clean: true, highest_severity: null } }) };
    }
    return { code: 0, stdout: JSON.stringify({ object: { name: 'Table' }, upstream: [], downstream: [], relationships: [] }), stderr: '' };
  },
};
try {
  register(pi);
  const ctx = { cwd: project, hasUI: false, ui: { setStatus() {}, notify() {} } };
  await hooks.get('before_agent_start')({ prompt: 'Review SQL and DAX', systemPrompt: 'base' }, ctx);
  const emptyProject = join(root, 'workspaces', 'without-standards');
  mkdirSync(emptyProject, { recursive: true });
  const originals = { spawnSync: childProcess.spawnSync, execFileSync: childProcess.execFileSync };
  const attempts = [];
  try {
    childProcess.spawnSync = (command, args) => {
      const domain = args?.[1] === 'sql-review' ? 'sql' : args?.[1] === 'dax-review' ? 'dax' : null;
      attempts.push({ command, args });
      assert.equal(command, node, 'bundled reviewer probe uses selected Node');
      assert.ok(domain && args[0] === entry && args[2] === root && args[3] === 'check');
      assert.ok(args[4].startsWith(join(root, 'workspaces') + '\\') || args[4].startsWith(join(root, 'workspaces') + '/'));
      const selected = args.indexOf('--standards');
      const standard = selected < 0 ? join(project, 'standards', `${domain}.md`) : args[selected + 1];
      if (selected >= 0) assert.ok(standard.startsWith(join(root, 'profile', 'standards', 'snapshots')));
      const sha256 = createHash('sha256').update(readFileSync(standard)).digest('hex');
      return { status: 0, stdout: JSON.stringify({ tool: `coop-${domain}-review`,
        schema_version: domain === 'sql' ? 4 : 3, version: 'synthetic',
        [domain === 'sql' ? 'files_checked' : 'models_checked']: 0,
        standards: { path: standard, sha256 }, findings: [], diagnostics: [], agent_review: [],
        summary: { error: 0, warning: 0, info: 0 }, verdict: { clean: true, highest_severity: null } }), stderr: '' };
    };
    childProcess.execFileSync = (...args) => { attempts.push({ method: 'execFileSync', args }); throw Error('unexpected child process'); };
    syncBuiltinESMExports();
    await hooks.get('before_agent_start')({ prompt: 'Review SQL', systemPrompt: 'base' }, { ...ctx, cwd: emptyProject });
    assert.equal(attempts.length, 4, 'beta startup verifies both bundled reviewers by selected companion twice');
  } finally {
    childProcess.spawnSync = originals.spawnSync;
    childProcess.execFileSync = originals.execFileSync;
    syncBuiltinESMExports();
  }
  await hooks.get('before_agent_start')({ prompt: 'Review SQL and DAX', systemPrompt: 'base' }, ctx);
  const signal = new AbortController().signal;
  await tools.get('data_doc').execute('1', { command: 'lineage', object: 'Table' }, signal, undefined, ctx);
  assert.deepEqual(calls.at(-1).args, [entry, 'data-doc', root, 'lineage', '--', 'Table']);
  await tools.get('data_doc').execute('2', { command: 'scan' }, signal, undefined, ctx);
  assert.deepEqual(calls.at(-1).args, [entry, 'data-doc', root, 'scan']);
  const reviewedSql = await tools.get('sql_review').execute('3', { paths: ['query.sql'] }, signal, undefined, ctx);
  assert.equal(reviewedSql.details.reportRejected, undefined);
  assert.deepEqual(calls.at(-1).args.slice(0, 6), [entry, 'sql-review', root, 'check', 'query.sql', '--format']);
  const reviewedDax = await tools.get('dax_review').execute('4', { paths: ['measure.dax'] }, signal, undefined, ctx);
  assert.equal(reviewedDax.details.reportRejected, undefined);
  assert.deepEqual(calls.at(-1).args.slice(0, 6), [entry, 'dax-review', root, 'check', 'measure.dax', '--format']);
  assert.ok(calls.every(call => call.bin === node && call.options.cwd === ctx.cwd && call.options.signal === signal));
  const before = calls.length;
  const bpa = await tools.get('bpa_review').execute('5', {}, signal, undefined, ctx);
  assert.equal(bpa.details.state, 'beta_unqualified');
  const sql = await tools.get('fabric_sql_query').execute('6', { query: 'SELECT TOP 1 * FROM t' }, signal, undefined, ctx);
  assert.equal(sql.details.state, 'beta_unqualified');
  assert.equal(calls.length, before);
  mkdirSync(join(source, 'lib'), { recursive: true });
  writeFileSync(entry, [
    "import { createInterface } from 'node:readline';",
    "if (process.argv[2] !== 'data-doc' || process.argv[3] !== process.env.COOP_BETA_ROOT || process.argv[4] !== 'setup' || process.argv[5] !== '--transport' || process.argv[6] !== 'jsonl') process.exit(21);",
    "const line = value => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));",
    "line({ type: 'hello', protocol_version: '1.1' });",
    "line({ type: 'prompt', id: 'answer', kind: 'text', message: 'Answer', default: '' });",
    "const rl = createInterface({ input: process.stdin });",
    "setTimeout(() => { process.stderr.write('synthetic answer timeout'); process.exit(23); }, 3000);",
    "rl.once('line', value => {",
    "  if (JSON.parse(value).answer !== 'yes') process.exit(22);",
    "  process.stdout.write(JSON.stringify({ type: 'complete', message: 'done' }) + String.fromCharCode(10), () => process.exit(0));",
    "});",
  ].join('\n'));
  const notices = [];
  const wizard = await runJsonlSetup(pi, { ...ctx, ui: { ...ctx.ui,
    notify: message => notices.push(String(message)),
    input: async () => { notices.push('prompt-seen'); return 'yes'; },
  } });
  assert.equal(wizard, true, 'beta JSONL bridge uses selected invocation: ' + JSON.stringify(notices));
  console.log('  ✓ in-agent beta companions use the owned lifecycle; unqualified tools fail closed');
} finally {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
