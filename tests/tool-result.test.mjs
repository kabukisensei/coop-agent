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
  assert.equal(normalizeResult({ state: 'unknown', scope: 'project' }).scope, 'project');
});

test('malformed errors invalidate an otherwise successful result', () => {
  const result = normalizeResult({
    state: 'success',
    findings: [],
    errors: 'not-an-array',
    provenance: { tool: 'review', sha: 'abc' },
    zeroFindings: true,
  });
  assert.equal(result.state, 'incomplete');
  assert.equal(validateResult(result).ok, true);
});

test('success without provenance is invalid', () => {
  const result = validateResult(normalizeResult({ state: 'success', findings: [{ id: 'a', severity: 'minor', message: 'x' }] }));
  assert.equal(result.ok, false);
});

test('zero-findings success requires marker and provenance', () => {
  const base = { state: 'success', findings: [], provenance: { tool: 'review', sha: 'abc' } };
  assert.equal(validateResult(normalizeResult(base)).ok, false);
  assert.equal(validateResult(normalizeResult({ ...base, zeroFindings: true })).ok, true);
});

test('zero-findings success rejects undefined provenance', () => {
  const env = {
    state: 'success', findings: [], errors: [], provenance: undefined,
    redactions: [], scope: 'team', zeroFindings: true,
  };
  assert.equal(validateResult(env).ok, false);
});

test('cancellation preserves partial findings and errors', () => {
  const original = normalizeResult({ state: 'incomplete', findings: [{ id: '1', severity: 'major', message: 'found' }], errors: ['ToolResult: partial'] });
  const cancelled = markCancelled(original);
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(cancelled.findings, original.findings);
  assert.deepEqual(cancelled.errors, original.errors);
});

test('exception fallback preserves legal project scope', () => {
  const raw = { state: 'success', scope: 'project' };
  Object.defineProperty(raw, 'findings', { get() { throw new Error('bad findings'); } });
  const env = normalizeResult(raw);
  assert.equal(env.state, 'incomplete');
  assert.equal(env.scope, 'project');
});

test('malformed optional finding fields are dropped with diagnostics', () => {
  const env = normalizeResult({
    state: 'success',
    findings: [{ id: 'a', severity: 'major', message: 'x', line: 0 }],
    provenance: { tool: 'review', rev: 'abc' },
  });
  assert.equal(env.state, 'incomplete');
  assert.deepEqual(env.findings, []);
  assert.ok(env.errors.includes('ToolResult: finding 0.line is invalid'));
  assert.equal(validateResult(env).ok, true);
});

test('sparse findings and redactions are materialized before validation', () => {
  const provenance = { tool: 'review', rev: 'abc' };
  const env = normalizeResult({
    state: 'success', findings: new Array(1), redactions: new Array(1),
    provenance, zeroFindings: true,
  });
  assert.equal(env.state, 'incomplete');
  assert.deepEqual(env.findings, []);
  assert.deepEqual(env.redactions, []);
  assert.ok(env.errors.includes('ToolResult: finding 0 is malformed'));
  assert.ok(env.errors.includes('ToolResult: redactions must be an array of strings'));
  assert.equal(validateResult({ ...env, findings: new Array(1), redactions: [] }).ok, false);
  assert.equal(validateResult({ ...env, findings: [], redactions: new Array(1) }).ok, false);
});

test('sparse errors are materialized and can never yield a clean success', () => {
  const sparse = [];
  sparse[0] = 'real error';
  sparse[2] = 'another error';
  const env = normalizeResult({
    state: 'success', errors: sparse,
    findings: [], provenance: { tool: 'review', rev: 'abc' }, zeroFindings: true,
  });
  assert.equal(env.state, 'incomplete');
  assert.ok(env.errors.some((e) => e.includes('errors must be an array of strings')));
  const rawEnvelope = { state: 'success', findings: [], errors: sparse, redactions: [], provenance: { tool: 'review', rev: 'abc' }, scope: 'team', zeroFindings: true };
  assert.equal(validateResult(rawEnvelope).ok, false);
});

test('arrays with lying iterators cannot spoof zero findings', () => {
  const sneaky = [];
  sneaky[0] = { id: 'f1', severity: 'major', message: 'real problem' };
  Object.defineProperty(sneaky, Symbol.iterator, { value: function* () { /* yields nothing */ } });
  const env = normalizeResult({ state: 'success', findings: sneaky, errors: [], redactions: [], provenance: { tool: 'review', rev: 'abc' } });
  assert.equal(env.findings.length, 1);
  assert.equal(env.findings[0].id, 'f1');
});

test('findings require a non-empty id', () => {
  const provenance = { tool: 'review', rev: 'abc' };
  const env = normalizeResult({
    state: 'success', findings: [{ severity: 'major', message: 'problem' }], provenance,
  });
  assert.equal(env.state, 'incomplete');
  assert.deepEqual(env.findings, []);
  assert.ok(env.errors.includes('ToolResult: finding 0.id is invalid'));
  assert.equal(validateResult({ ...env, findings: [{ severity: 'major', message: 'problem' }] }).ok, false);
});

test('sha-only provenance normalizes to rev', () => {
  const env = normalizeResult({
    state: 'success', findings: [], zeroFindings: true,
    provenance: { tool: 'review', sha: 'abc' },
  });
  assert.deepEqual(env.provenance, { tool: 'review', rev: 'abc' });
  assert.equal(validateResult(env).ok, true);
});

test('exception formatting never reads properties from the thrown value', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'message', { get() { throw new Error('second failure'); } });
  const raw = {};
  Object.defineProperty(raw, 'state', { get() { throw hostile; } });
  assert.deepEqual(normalizeResult(raw), {
    state: 'incomplete',
    findings: [],
    errors: ['ToolResult: input could not be normalized'],
    provenance: null,
    redactions: [],
    scope: 'team',
    zeroFindings: false,
  });
});

test('invalid scope diagnostics are accumulated', () => {
  const env = normalizeResult({
    state: 'success', scope: 'invalid', findings: [], zeroFindings: true,
    provenance: { tool: 'review', rev: 'abc' },
  });
  assert.equal(env.state, 'incomplete');
  assert.ok(env.errors.includes('ToolResult: scope is invalid'));
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
