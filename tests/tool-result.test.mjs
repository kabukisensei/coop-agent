import assert from 'node:assert/strict';
import {
  markCancelled,
  markFailed,
  markIncomplete,
  normalizeResult,
  states,
  validateResult,
} from '../lib/tool-result.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test('states lists exactly the legal states', () => {
  assert.deepEqual(states(), ['success', 'failed', 'unavailable', 'cancelled', 'incomplete']);
});

test('malformed input is incomplete and never a zero-findings success', () => {
  const result = normalizeResult('garbage');
  assert.equal(result.state, 'incomplete');
  assert.deepEqual(result.findings, []);
  assert.match(result.errors[0], /^ToolResult:/);
  assert.notEqual(result.state === 'success' && result.findings.length === 0, true);
});

test('success without provenance is invalid', () => {
  const result = validateResult(normalizeResult({ state: 'success', findings: [{ id: 'a', severity: 'low', message: 'x' }] }));
  assert.equal(result.ok, false);
});

test('zero-findings success requires marker and provenance', () => {
  const base = { state: 'success', findings: [], provenance: { tool: 'review', sha: 'abc' } };
  assert.equal(validateResult(normalizeResult(base)).ok, false);
  assert.equal(validateResult(normalizeResult({ ...base, zeroFindings: true })).ok, true);
});

test('cancellation preserves partial findings and errors', () => {
  const original = normalizeResult({ state: 'incomplete', findings: [{ id: '1', severity: 'high', message: 'found' }], errors: ['ToolResult: partial'] });
  const cancelled = markCancelled(original);
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(cancelled.findings, original.findings);
  assert.deepEqual(cancelled.errors, original.errors);
});

test('all states round-trip through normalization and validation', () => {
  for (const state of states()) {
    const raw = { state, findings: [{ id: '1', severity: 'info', message: 'note' }] };
    if (state === 'success') raw.provenance = { tool: 'review', rev: 'abc' };
    const normalized = normalizeResult(raw);
    assert.equal(normalized.state, state);
    assert.equal(validateResult(normalized).ok, true);
  }
});

test('normalization defaults scope to team and does not broaden project', () => {
  assert.equal(normalizeResult({ state: 'failed' }).scope, 'team');
  assert.equal(normalizeResult({ state: 'failed', scope: 'project' }).scope, 'project');
});

test('state helpers make explicit transitions', () => {
  const source = { state: 'unavailable', findings: [], errors: ['ToolResult: unavailable'] };
  assert.equal(markFailed(source).state, 'failed');
  assert.equal(markIncomplete(source).state, 'incomplete');
});

console.log(`Passed ${passed} tests`);
