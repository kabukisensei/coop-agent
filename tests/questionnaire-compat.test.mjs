import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureQuestionnaireCompatibility, patchQuestionnaireSource } from '../lib/questionnaire-compat.mjs';
const root = mkdtempSync(join(tmpdir(), 'coop-question-compat-'));
try {
  const original = readFileSync(new URL('./fixtures/rpiv-ask-user-question-1.20.0/ask-user-question.ts', import.meta.url), 'utf8');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@juicesharp/rpiv-ask-user-question', version: '1.20.0' }));
  const source = join(root, 'ask-user-question.ts');
  writeFileSync(source, original);
  assert.throws(() => ensureQuestionnaireCompatibility(root, { check: true }), /missing/);
  assert.equal(existsSync(join(root, 'coop-rpc-questionnaire.mjs')), false, 'check mode must not write');
  const receipt = ensureQuestionnaireCompatibility(root);
  assert.equal(receipt.id, 'rpc-questionnaire-v1');
  assert.equal(readFileSync(source, 'utf8'), patchQuestionnaireSource(original));
  assert.deepEqual(ensureQuestionnaireCompatibility(root), receipt);
  assert.deepEqual(ensureQuestionnaireCompatibility(root, { check: true }), receipt);
  writeFileSync(join(root, 'coop-rpc-questionnaire.mjs'), '// tampered');
  assert.throws(() => ensureQuestionnaireCompatibility(root, { check: true }), /changed/);
  rmSync(join(root, 'coop-rpc-questionnaire.mjs'));
  writeFileSync(source, original + '\n// upstream drift');
  assert.throws(() => ensureQuestionnaireCompatibility(root), /Unrecognized/);
  assert.equal(existsSync(join(root, 'coop-rpc-questionnaire.mjs')), false);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@juicesharp/rpiv-ask-user-question', version: '1.20.1' }));
  assert.throws(() => ensureQuestionnaireCompatibility(root), /package version/);
  console.log('PASS: questionnaire pin, exact source, read-only verification, idempotence and tamper rejection.');
} finally { rmSync(root, { recursive: true, force: true }); }
