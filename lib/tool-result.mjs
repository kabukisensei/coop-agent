const LEGAL_STATES = ['success', 'failed', 'unavailable', 'cancelled', 'incomplete'];
const LEGAL_SCOPES = ['public', 'team', 'project'];
const LEGAL_SEVERITIES = ['critical', 'major', 'minor', 'info'];

export function states() {
  return [...LEGAL_STATES];
}

function diagnostic(message) {
  return `ToolResult: ${message}`;
}

// Materialize producer-supplied arrays WITHOUT trusting custom iterators:
// index-based copy where holes become undefined (rejected as malformed).
function materialize(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    out.push(Object.prototype.hasOwnProperty.call(arr, i) ? arr[i] : undefined);
  }
  return out;
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
  if (!isRecord(value)) return { error: diagnostic(`finding ${index} is malformed`) };

  const severity = value.severity;
  const message = value.message;
  const id = value.id;
  const file = value.file;
  const line = value.line;
  const source = value.source;
  if (!LEGAL_SEVERITIES.includes(severity) ||
      typeof message !== 'string' || message.trim() === '') {
    return { error: diagnostic(`finding ${index} is malformed`) };
  }
  if (typeof id !== 'string' || id.trim() === '') {
    return { error: diagnostic(`finding ${index}.id is invalid`) };
  }

  const finding = { id, severity, message };
  if (file !== undefined) {
    if (typeof file !== 'string') return { error: diagnostic(`finding ${index}.file is invalid`) };
    finding.file = file;
  }
  if (line !== undefined) {
    if (!Number.isInteger(line) || line < 1) {
      return { error: diagnostic(`finding ${index}.line is invalid`) };
    }
    finding.line = line;
  }
  if (source !== undefined) {
    if (typeof source !== 'string') return { error: diagnostic(`finding ${index}.source is invalid`) };
    finding.source = source;
  }
  return { finding };
}

function normalizeProvenance(value) {
  if (value === null || value === undefined) return { provenance: null };
  if (!isRecord(value)) return { error: diagnostic('provenance must include tool and rev or sha') };
  const tool = value.tool;
  const rev = value.rev;
  const sha = value.sha;
  if (typeof tool !== 'string' || tool.trim() === '' ||
      (rev !== undefined && (typeof rev !== 'string' || rev.trim() === '')) ||
      (sha !== undefined && (typeof sha !== 'string' || sha.trim() === '')) ||
      (rev === undefined && sha === undefined) ||
      (rev !== undefined && sha !== undefined)) {
    return { error: diagnostic('provenance must include tool and rev or sha') };
  }
  return { provenance: { tool, rev: rev ?? sha } };
}

export function normalizeResult(raw) {
  let preservedScope = 'team';
  const verifiedFindings = [];
  try {
    if (!isRecord(raw)) return emptyEnvelope({ errors: [diagnostic('input must be an object')] });
    const result = emptyEnvelope();
    let malformed = false;

    const scope = raw.scope;
    if (LEGAL_SCOPES.includes(scope)) {
      preservedScope = scope;
      result.scope = scope;
    }
    else if (scope !== undefined) {
      result.errors.push(diagnostic('scope is invalid'));
      malformed = true;
    }

    const state = raw.state;
    if (typeof state !== 'string' || !LEGAL_STATES.includes(state)) {
      result.errors.push(diagnostic('state is missing or invalid'));
      return result;
    }
    result.state = malformed ? 'incomplete' : state;

    const rawErrors = raw.errors;
    if (rawErrors === undefined) {
      // Retain diagnostics collected while normalizing earlier fields.
    } else if (Array.isArray(rawErrors)) {
      // Materialize sparse arrays: holes become undefined and are rejected
      // with a diagnostic instead of being silently skipped by forEach.
      for (const item of materialize(rawErrors)) {
        if (typeof item === 'string') result.errors.push(normalizedError(item));
        else {
          result.errors.push(diagnostic('errors must be an array of strings'));
          result.state = 'incomplete';
        }
      }
    } else {
      result.errors.push(diagnostic('errors must be an array of strings'));
      result.state = 'incomplete';
    }

    const rawFindings = raw.findings;
    if (Array.isArray(rawFindings)) {
      materialize(rawFindings).forEach((value, index) => {
        const normalized = normalizeFinding(value, index);
        if (normalized.error) {
          result.state = 'incomplete';
          result.errors.push(normalized.error);
        } else verifiedFindings.push(normalized.finding);
      });
      result.findings = [...verifiedFindings];
    } else if (rawFindings !== undefined) {
      result.state = 'incomplete';
      result.errors.push(diagnostic('findings must be an array'));
    }

    const rawProvenance = raw.provenance;
    const provenance = normalizeProvenance(rawProvenance);
    if (provenance.error) {
      result.state = 'incomplete';
      result.errors.push(provenance.error);
    } else result.provenance = provenance.provenance;

    const redactions = raw.redactions;
    if (redactions === undefined) result.redactions = [];
    else if (Array.isArray(redactions)) {
      const materializedRedactions = materialize(redactions);
      if (materializedRedactions.every(item => typeof item === 'string')) {
        result.redactions = materializedRedactions;
      } else {
        result.state = 'incomplete';
        result.errors.push(diagnostic('redactions must be an array of strings'));
      }
    } else {
      result.state = 'incomplete';
      result.errors.push(diagnostic('redactions must be an array of strings'));
    }

    const zeroFindings = raw.zeroFindings;
    if (zeroFindings !== undefined && typeof zeroFindings !== 'boolean') {
      result.state = 'incomplete';
      result.errors.push(diagnostic('zeroFindings must be a boolean'));
    }
    if (zeroFindings === true && result.findings.length > 0) {
      result.errors.push(diagnostic('zeroFindings contradicts nonempty findings'));
      result.zeroFindings = false;
      result.state = 'incomplete';
    } else {
      result.zeroFindings = result.state === 'success' && zeroFindings === true;
    }
    return result;
  } catch {
    return emptyEnvelope({
      findings: [...verifiedFindings],
      errors: [diagnostic('input could not be normalized')],
      scope: preservedScope,
    });
  }
}

function validateFinding(finding, index) {
  if (!isRecord(finding)) return diagnostic(`finding ${index} is malformed`);
  const severity = finding.severity;
  const message = finding.message;
  const id = finding.id;
  const file = finding.file;
  const line = finding.line;
  const source = finding.source;
  if (!LEGAL_SEVERITIES.includes(severity) ||
      typeof message !== 'string' || message.trim() === '') {
    return diagnostic(`finding ${index} is malformed`);
  }
  if (typeof id !== 'string' || id.trim() === '') return diagnostic(`finding ${index}.id is invalid`);
  if (file !== undefined && typeof file !== 'string') return diagnostic(`finding ${index}.file is invalid`);
  if (line !== undefined && (!Number.isInteger(line) || line < 1)) return diagnostic(`finding ${index}.line is invalid`);
  if (source !== undefined && typeof source !== 'string') return diagnostic(`finding ${index}.source is invalid`);
  return null;
}

export function validateResult(env) {
  try {
    const errors = [];
    if (!isRecord(env)) return { ok: false, errors: [diagnostic('result must be an object')] };
    const state = env.state;
    const findings = env.findings;
    const resultErrors = env.errors;
    const redactions = env.redactions;
    const scope = env.scope;
    const hasProvenance = Object.prototype.hasOwnProperty.call(env, 'provenance');
    const provenanceValue = hasProvenance ? env.provenance : undefined;
    const zeroFindings = env.zeroFindings;

    if (!LEGAL_STATES.includes(state)) errors.push(diagnostic('state is invalid'));
    if (!Array.isArray(findings)) errors.push(diagnostic('findings must be an array'));
    else materialize(findings).forEach((finding, index) => {
      const findingError = validateFinding(finding, index);
      if (findingError) errors.push(findingError);
    });
    if (!Array.isArray(resultErrors) || !materialize(resultErrors).every(item => typeof item === 'string' && item.startsWith('ToolResult:'))) {
      errors.push(diagnostic('errors must be an array of ToolResult strings'));
    }
    if (!Array.isArray(redactions) || !materialize(redactions).every(item => typeof item === 'string')) {
      errors.push(diagnostic('redactions must be an array of strings'));
    }
    if (!LEGAL_SCOPES.includes(scope)) errors.push(diagnostic('scope is invalid'));
    if (!hasProvenance || provenanceValue === undefined) {
      errors.push(diagnostic('provenance is required'));
    } else if (provenanceValue !== null) {
      const provenance = normalizeProvenance(provenanceValue);
      if (provenance.error) errors.push(provenance.error);
    }
    if (typeof zeroFindings !== 'boolean') errors.push(diagnostic('zeroFindings must be a boolean'));
    if (state === 'success') {
      const provenance = normalizeProvenance(provenanceValue);
      if (provenance.error || provenance.provenance === null) {
        errors.push(diagnostic('success requires provenance.tool and provenance.rev or provenance.sha'));
      }
      if (Array.isArray(findings) && findings.length === 0 && zeroFindings !== true) {
        errors.push(diagnostic('successful zero-findings claim requires zeroFindings: true'));
      }
      if (zeroFindings === true && Array.isArray(findings) && findings.length > 0) {
        errors.push(diagnostic('zeroFindings contradicts nonempty findings'));
      }
    } else if (zeroFindings === true) errors.push(diagnostic('zeroFindings is only valid for success'));
    return { ok: errors.length === 0, errors };
  } catch {
    return { ok: false, errors: [diagnostic('result could not be validated')] };
  }
}

function transition(env, state) {
  const normalized = normalizeResult(env);
  return { ...normalized, state, zeroFindings: false };
}

export function markCancelled(env) { return transition(env, 'cancelled'); }
export function markFailed(env) { return transition(env, 'failed'); }
export function markIncomplete(env) { return transition(env, 'incomplete'); }
