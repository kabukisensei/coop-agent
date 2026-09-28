import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-profile-root-'));
const profile = path.join(scratch, 'beta profile Ω');
const legacy = path.join(scratch, 'legacy');
const python = process.env.COOP_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const probe = `
import importlib.util, json, os, pathlib, sys
root = pathlib.Path(sys.argv[1])
def module(rel, name):
    spec = importlib.util.spec_from_file_location(name, root / rel)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod
onboard = module('scripts/onboard.py', 'onboard')
budget = module('scripts/context-budget.py', 'budget')
knowledge = module('scripts/search-knowledge.py', 'knowledge')
skills = module('lib/microsoft_skills.py', 'skills')
print(json.dumps(dict(onboard=str(onboard.USER_JSON), budget=str(budget.profile_path()), knowledge=knowledge.config_path(), skills=str(skills.agent_dir()))))
`;
function environment(explicit) {
  const env = { ...process.env, COOP_DIR: legacy, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' };
  for (const key of ['COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'COOP_PROFILE_ROOT']) delete env[key];
  if (explicit) env.COOP_PROFILE_ROOT = profile;
  return env;
}
for (const explicit of [false, true]) {
  const env = environment(explicit);
  const result = JSON.parse(execFileSync(python, ['-B', '-c', probe, root], { cwd: scratch, env, encoding: 'utf8' }));
  assert.equal(path.normalize(result.onboard), path.join(explicit ? profile : path.join(legacy, '.coop'), 'user.json'));
  assert.equal(path.normalize(result.budget), path.join(explicit ? profile : legacy, 'user.json'));
  assert.equal(path.normalize(result.knowledge), path.join(explicit ? profile : path.join(legacy, '.coop'), 'config'));
  assert.equal(path.normalize(result.skills), path.join(explicit ? profile : path.join(os.homedir(), '.coop'), 'agent'));
}
fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, 'user.json'), '{}');
fs.writeFileSync(path.join(profile, 'config'), '{}');
const env = environment(true);
// The actual generator must select the explicit profile/manifest, not personal
// config. A beta request refuses regeneration before any config mutation.
fs.writeFileSync(path.join(profile, 'config'), JSON.stringify({ schema_version: 1, integrations: {} }));
const manifest = path.join(root, 'config/windows-beta-manifest.json');
execFileSync(python, ['-B', path.join(root, 'lib/mcp_config.py')], { cwd: scratch, env: { ...env, COOP_RELEASE_MANIFEST: manifest }, encoding: 'utf8' });
const mcpFile = path.join(profile, 'agent/mcp.json');
const generated = fs.readFileSync(mcpFile);
assert.match(generated.toString(), /mcp-remote@0\.14\.2/);
const refused = spawnSync(python, ['-B', path.join(root, 'lib/mcp_config.py')], { cwd: scratch, env: { ...env, COOP_CHANNEL: 'beta' }, encoding: 'utf8' });
assert.equal(refused.status, 2);
assert.deepEqual(fs.readFileSync(mcpFile), generated);
const bash = process.env.COOP_TEST_BASH || 'bash';
const shell = execFileSync(bash, ['-c', '. ./lib/common.sh; coop_profile_root; printf "\\n"; coop_config_file; printf "\\n"; coop_pi_agent_dir; printf "\\n"; coop_user_profile_missing && exit 8; coop_onboarding_missing && exit 9; exit 0'], { cwd: root, env, encoding: 'utf8' }).trim().split(/\r?\n/);
assert.deepEqual(shell.map(p => path.normalize(p)), [profile, path.join(profile, 'config'), path.join(profile, 'agent')]);
if (process.platform === 'win32') {
  for (const ps of [path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), 'pwsh']) {
    const value = JSON.parse(execFileSync(ps, ['-NoProfile', '-Command', '. ./lib/common.ps1; @{profile=(Get-CoopProfileRoot); config=(Get-CoopConfigFile); agent=(Get-CoopPiAgentDir); missing=(Test-CoopOnboardingMissing)} | ConvertTo-Json -Compress'], { cwd: root, env, encoding: 'utf8' }).trim());
    assert.equal(value.profile, profile);
    assert.equal(value.config, path.join(profile, 'config'));
    assert.equal(value.agent, path.join(profile, 'agent'));
    assert.equal(value.missing, false);
  }
}
console.log('profile-root precedence: Python readers, Bash and available Windows shells passed; legacy defaults retained');
