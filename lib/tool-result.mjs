const LEGAL_STATES = ['success', 'failed', 'unavailable', 'cancelled', 'incomplete'];
const LEGAL_SCOPES = ['public', 'team', 'project'];

export function states() {
  return [...LEGAL_STATES];
}

function error(message) {
  return `ToolResult: ${message}`;
}

function emptyEnvelope(overrides = {}) {
  return {
    state: 'incomplete',
    findings: [],
    errors: [],
    provenance: null,
    redactions: [],
    scope: 'team',
    zeroFindings: false,
    ...overrides,
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFinding(value, index) {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.severity !== 'string' ||
      typeof value.message !== 'string') {
    return { error: error(`finding ${index} is malformed`) };
  }

  const finding = {
    id: value.id,
    severity: value.severity,
    message: value.message,
  };
  for (const field of ['file', 'line', 'source']) {
    if (value[field] !== undefined) finding[field] = value[field];
  }
  return { finding };
}

export function normalizeResult(raw) {
  if (!isRecord(raw)) {
    return emptyEnvelope({ errors: [error('input must be an object')] });
  }

  const state = raw.state;
  if (typeof state !== 'string' || !LEGAL_STATES.includes(state)) {
    return emptyEnvelope({ errors: [error('state is missing or invalid')] });
  }

  const result = emptyEnvelope({ state });
  const errors = Array.isArray(raw.errors) && raw.errors.every(item => typeof item === 'string')
    ? [...raw.errors]
    : [error('errors must be an array of strings')];
  result.errors = errors;

  if (Array.isArray(raw.findings)) {
    const findings = raw.findings.map(normalizeFinding);
    const malformed = findings.find(item => item.error);
    if (malformed) {
      result.findings = [];
      result.state = 'incomplete';
      result.errors.push(malformed.error);
    } else {
      result.findings = findings.map(item => item.finding);
    }
  } else if (raw.findings !== undefined) {
    result.state = 'incomplete';
    result.errors.push(error('findings must be an array'));
  }

  if (raw.provenance !== null && raw.provenance !== undefined) {
    if (isRecord(raw.provenance)) {
      const provenance = { tool: raw.provenance.tool };
      if (raw.provenance.rev !== undefined) provenance.rev = raw.provenance.rev;
      if (raw.provenance.sha !== undefined) provenance.sha = raw.provenance.sha;
      result.provenance = provenance;
    } else {
      result.state = 'incomplete';
      result.errors.push(error('provenance must be an object or null'));
    }
  }

  if (Array.isArray(raw.redactions) && raw.redactions.every(item => typeof item === 'string')) {
    result.redactions = [...raw.redactions];
  } else if (raw.redactions !== undefined) {
    result.state = 'incomplete';
    result.errors.push(error('redactions must be an array of strings'));
  }

  if (LEGAL_SCOPES.includes(raw.scope)) result.scope = raw.scope;
  else if (raw.scope !== undefined) {
    result.state = 'incomplete';
    result.errors.push(error('scope is invalid'));
  }

  result.zeroFindings = raw.zeroFindings === true && state === 'success';
  return result;
}

export function validateResult(env) {
  const errors = [];
  if (!isRecord(env)) return { ok: false, errors: [error('result must be an object')] };
  if (!LEGAL_STATES.includes(env.state)) errors.push(error('state is invalid'));
  if (!Array.isArray(env.findings)) errors.push(error('findings must be an array'));
  else {
    env.findings.forEach((finding, index) => {
      if (!isRecord(finding) || typeof finding.id !== 'string' ||
          typeof finding.severity !== 'string' || typeof finding.message !== 'string') {
        errors.push(error(`finding ${index} is malformed`));
      }
    });
  }
  if (!Array.isArray(env.errors) || !env.errors.every(item => typeof item === 'string')) {
    errors.push(error('errors must be an array of strings'));
  }
  if (!Array.isArray(env.redactions) || !env.redactions.every(item => typeof item === 'string')) {
    errors.push(error('redactions must be an array of strings'));
  }
  if (!LEGAL_SCOPES.includes(env.scope)) errors.push(error('scope is invalid'));

  if (env.state === 'success') {
    const provenance = env.provenance;
    if (!isRecord(provenance) || typeof provenance.tool !== 'string' || !provenance.tool ||
        ((!provenance.rev || typeof provenance.rev !== 'string') &&
         (!provenance.sha || typeof provenance.sha !== 'string'))) {
      errors.push(error('success requires provenance.tool and provenance.rev or provenance.sha'));
    }
    if (Array.isArray(env.findings) && env.findings.length === 0 && env.zeroFindings !== true) {
      errors.push(error('zero findings requires explicit zeroFindings:true'));
    }
  }

  return { ok: errors.length === 0, errors };
}

function transition(env, state) {
  const normalized = normalizeResult(env);
  return { ...normalized, state };
}

export function markCancelled(env) {
  return transition(env, 'cancelled');
}

export function markFailed(env) {
  return transition(env, 'failed');
}

export function markIncomplete(env) {
  return transition(env, 'incomplete');
}
