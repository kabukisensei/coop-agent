const LEGAL_STATES = ['success', 'failed', 'unavailable', 'cancelled', 'incomplete'];
const LEGAL_SCOPES = ['public', 'team', 'project'];

export function states() {
  return [...LEGAL_STATES];
}

function diagnostic(message) {
  return `ToolResult: ${message}`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function normalizedError(value) {
  if (typeof value !== 'string') return diagnostic('errors must be an array of strings');
  return value.startsWith('ToolResult:') ? value : diagnostic(value);
}

function normalizeFinding(value, index) {
  if (!isRecord(value) || typeof value.id !== 'string' ||
      typeof value.severity !== 'string' || typeof value.message !== 'string') {
    return { error: diagnostic(`finding ${index} is malformed`) };
  }
  const finding = { id: value.id, severity: value.severity, message: value.message };
  for (const field of ['file', 'line', 'source']) {
    if (value[field] !== undefined) finding[field] = value[field];
  }
  return { finding };
}

function normalizeProvenance(value) {
  if (value === null || value === undefined) return { provenance: null };
  if (!isRecord(value) || typeof value.tool !== 'string' || !value.tool ||
      (value.rev !== undefined && (typeof value.rev !== 'string' || !value.rev)) ||
      (value.sha !== undefined && (typeof value.sha !== 'string' || !value.sha)) ||
      (value.rev === undefined && value.sha === undefined)) {
    return { error: diagnostic('provenance must include tool and rev or sha') };
  }
  const provenance = { tool: value.tool };
  if (value.rev !== undefined) provenance.rev = value.rev;
  if (value.sha !== undefined) provenance.sha = value.sha;
  return { provenance };
}

export function normalizeResult(raw) {
  try {
    if (!isRecord(raw)) return emptyEnvelope({ errors: [diagnostic('input must be an object')] });
    const result = emptyEnvelope();
    let malformed = false;

    if (LEGAL_SCOPES.includes(raw.scope)) result.scope = raw.scope;
    else if (raw.scope !== undefined) {
      result.errors.push(diagnostic('scope is invalid'));
      malformed = true;
    }

    if (typeof raw.state !== 'string' || !LEGAL_STATES.includes(raw.state)) {
      result.errors.push(diagnostic('state is missing or invalid'));
      return result;
    }
    result.state = malformed ? 'incomplete' : raw.state;

    if (raw.errors === undefined) result.errors = [];
    else if (Array.isArray(raw.errors) && raw.errors.every(item => typeof item === 'string')) {
      result.errors = raw.errors.map(normalizedError);
    } else {
      result.errors.push(diagnostic('errors must be an array of strings'));
      result.state = 'incomplete';
    }

    if (Array.isArray(raw.findings)) {
      const findings = raw.findings.map(normalizeFinding);
      const malformed = findings.find(item => item.error);
      if (malformed) {
        result.state = 'incomplete';
        result.errors.push(malformed.error);
      } else result.findings = findings.map(item => item.finding);
    } else if (raw.findings !== undefined) {
      result.state = 'incomplete';
      result.errors.push(diagnostic('findings must be an array'));
    }

    const provenance = normalizeProvenance(raw.provenance);
    if (provenance.error) {
      result.state = 'incomplete';
      result.errors.push(provenance.error);
    } else result.provenance = provenance.provenance;

    if (raw.redactions === undefined) result.redactions = [];
    else if (Array.isArray(raw.redactions) && raw.redactions.every(item => typeof item === 'string')) {
      result.redactions = [...raw.redactions];
    } else {
      result.state = 'incomplete';
      result.errors.push(diagnostic('redactions must be an array of strings'));
    }

    if (raw.zeroFindings !== undefined && typeof raw.zeroFindings !== 'boolean') {
      result.state = 'incomplete';
      result.errors.push(diagnostic('zeroFindings must be a boolean'));
    }
    result.zeroFindings = result.state === 'success' && raw.zeroFindings === true;
    return result;
  } catch (cause) {
    const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : '';
    return emptyEnvelope({ errors: [diagnostic(`input could not be normalized${detail}`)] });
  }
}

function validateFinding(finding, index) {
  if (!isRecord(finding) || typeof finding.id !== 'string' ||
      typeof finding.severity !== 'string' || typeof finding.message !== 'string') {
    return diagnostic(`finding ${index} is malformed`);
  }
  if (finding.file !== undefined && typeof finding.file !== 'string') return diagnostic(`finding ${index}.file is invalid`);
  if (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1)) return diagnostic(`finding ${index}.line is invalid`);
  if (finding.source !== undefined && typeof finding.source !== 'string') return diagnostic(`finding ${index}.source is invalid`);
  return null;
}

export function validateResult(env) {
  try {
    const errors = [];
    if (!isRecord(env)) return { ok: false, errors: [diagnostic('result must be an object')] };
    if (!LEGAL_STATES.includes(env.state)) errors.push(diagnostic('state is invalid'));
    if (!Array.isArray(env.findings)) errors.push(diagnostic('findings must be an array'));
    else env.findings.forEach((finding, index) => {
      const findingError = validateFinding(finding, index);
      if (findingError) errors.push(findingError);
    });
    if (!Array.isArray(env.errors) || !env.errors.every(item => typeof item === 'string' && item.startsWith('ToolResult:'))) {
      errors.push(diagnostic('errors must be an array of ToolResult strings'));
    }
    if (!Array.isArray(env.redactions) || !env.redactions.every(item => typeof item === 'string')) {
      errors.push(diagnostic('redactions must be an array of strings'));
    }
    if (!LEGAL_SCOPES.includes(env.scope)) errors.push(diagnostic('scope is invalid'));
    if (!Object.prototype.hasOwnProperty.call(env, 'provenance')) errors.push(diagnostic('provenance is required'));
    else if (env.provenance !== null) {
      const provenance = normalizeProvenance(env.provenance);
      if (provenance.error) errors.push(provenance.error);
    }
    if (typeof env.zeroFindings !== 'boolean') errors.push(diagnostic('zeroFindings must be a boolean'));
    if (env.state === 'success') {
      if (env.provenance === null) errors.push(diagnostic('success requires provenance.tool and provenance.rev or provenance.sha'));
      if (Array.isArray(env.findings) && env.findings.length === 0 && env.zeroFindings !== true) {
        errors.push(diagnostic('zero findings requires explicit zeroFindings:true'));
      }
    } else if (env.zeroFindings === true) errors.push(diagnostic('zeroFindings is only valid for success'));
    return { ok: errors.length === 0, errors };
  } catch (cause) {
    const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : '';
    return { ok: false, errors: [diagnostic(`result could not be validated${detail}`)] };
  }
}

function transition(env, state) {
  const normalized = normalizeResult(env);
  return { ...normalized, state, zeroFindings: false };
}

export function markCancelled(env) { return transition(env, 'cancelled'); }
export function markFailed(env) { return transition(env, 'failed'); }
export function markIncomplete(env) { return transition(env, 'incomplete'); }
