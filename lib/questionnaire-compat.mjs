// Pinned rpiv-ask-user-question 1.20.0 (MIT) RPC compatibility. Interactive
// terminal sessions retain the upstream custom questionnaire unchanged.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const ORIGINAL_QUESTIONNAIRE_SHA256 = '9ffeb0a1c2a2b0e9f47b65453f9845e504bd378fc6c16a0767e05de7c48565ae';
const hash = value => createHash('sha256').update(value).digest('hex');
const helper = readFileSync(new URL('./rpc-questionnaire.mjs', import.meta.url), 'utf8');
const importLine = 'import { askRpcQuestionnaire, isRpcQuestionnaireHost } from "./coop-rpc-questionnaire.mjs";\n';
const before = '\t\t\temitAskUserPromptEvent(pi, typed);';
const after = before + '\n\t\t\tif (isRpcQuestionnaireHost()) {\n\t\t\t\treturn buildQuestionnaireResponse(await askRpcQuestionnaire(typed, ctx.ui, _signal), typed);\n\t\t\t}';
export function patchQuestionnaireSource(source) {
  if (hash(source) !== ORIGINAL_QUESTIONNAIRE_SHA256 || source.split(before).length !== 2) {
    throw new Error('Unrecognized questionnaire source; review RPC compatibility for this revision.');
  }
  return importLine + source.replace(before, after);
}
export function ensureQuestionnaireCompatibility(packageRoot, { check = false } = {}) {
  if (lstatSync(packageRoot).isSymbolicLink()) throw new Error('Questionnaire package must not be a link.');
  const read = name => {
    const path = join(packageRoot, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Questionnaire input must be a bounded regular file.');
    return readFileSync(path, 'utf8');
  };
  const pkg = JSON.parse(read('package.json'));
  if (pkg.name !== '@juicesharp/rpiv-ask-user-question' || pkg.version !== '1.20.0') throw new Error('Review questionnaire compatibility for this package version.');
  const source = read('ask-user-question.ts');
  const original = source.startsWith(importLine) ? source.slice(importLine.length).replace(after, before) : source;
  const patched = hash(original) === ORIGINAL_QUESTIONNAIRE_SHA256 && patchQuestionnaireSource(original) === source;
  const helperName = 'coop-rpc-questionnaire.mjs', helperExists = existsSync(join(packageRoot, helperName));
  if (helperExists && read(helperName) !== helper) throw new Error('Questionnaire RPC helper is changed.');
  if (check && (!patched || !helperExists)) throw new Error('Packaged questionnaire RPC correction is missing.');
  // Validate the exact upstream source before writing either file.
  const expected = patched ? source : patchQuestionnaireSource(source);
  const atomicWrite = (name, content) => {
    const path = join(packageRoot, name), temporary = `${path}.coop-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o644 });
    try { renameSync(temporary, path); } catch (error) { unlinkSync(temporary); throw error; }
  };
  if (!helperExists) atomicWrite(helperName, helper);
  if (!patched) atomicWrite('ask-user-question.ts', expected);
  return { id: 'rpc-questionnaire-v1', upstreamSha256: ORIGINAL_QUESTIONNAIRE_SHA256,
    patchedSha256: hash(expected), helperSha256: hash(helper) };
}
