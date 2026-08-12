// scripts/research/source-coverage.mjs
//
// The provenance vocabulary shared by the snapshot sidecars, the briefing PDF,
// and the tests. Keeping it in one place is what stops "the source was
// unreachable" from ever rendering the same as "no hazard found".

/** Per-source states recorded in a sidecar's `sourceCoverage` array. */
export const COVERAGE_STATES = Object.freeze([
  'captured',           // the source answered and the answer was used
  'blocked',            // the source was unreachable or refused -- NOT an all-clear
  'unsupported',        // no queryable source exists for this county/jurisdiction
  'skipped-by-profile', // the buyer's profile turned this source off
  'missing',            // a prerequisite (geocode, parcel match) was unavailable
]);

/**
 * Per-dimension provenance rendered next to a value. `captured` is the only
 * state that licenses a factual claim; every other state must remain visually
 * distinct in the report so absence of evidence never reads as evidence of
 * absence.
 */
export const PROVENANCE_STATES = Object.freeze([
  'captured',
  'unconfirmed',    // checked, but the answer was inconclusive
  'blocked',        // the source failed -- lowers confidence, raises an open question
  'unsupported',    // nothing queryable exists here
  'not-applicable', // the dimension genuinely does not apply to this home
]);

export function isCoverageState(value) {
  return COVERAGE_STATES.includes(value);
}

export function isProvenanceState(value) {
  return PROVENANCE_STATES.includes(value);
}

/**
 * Builds one `sourceCoverage` entry. `status` is validated rather than
 * defaulted so a typo fails loudly instead of silently becoming "captured".
 */
export function coverageEntry({ key, name, url = null, status, note = null, checkedAt = null, error = null }) {
  if (!isCoverageState(status)) {
    throw new Error(`Invalid sourceCoverage status "${status}" for "${key}". Use one of: ${COVERAGE_STATES.join(', ')}`);
  }
  return {
    key,
    name,
    url,
    status,
    checkedAt: checkedAt ?? new Date().toISOString(),
    note,
    error,
  };
}

/**
 * A dimension the report will display: its value plus how we came to know it.
 * `value` stays null for anything not `captured` -- there is no such thing as
 * a default flood zone.
 */
export function dimension({ label, provenance, value = null, detail = null, sourceUrl = null, note = null }) {
  if (!isProvenanceState(provenance)) {
    throw new Error(`Invalid provenance "${provenance}" for "${label}". Use one of: ${PROVENANCE_STATES.join(', ')}`);
  }
  return {
    label,
    provenance,
    value: provenance === 'captured' ? value : null,
    detail,
    sourceUrl,
    note,
  };
}

/** True when at least one source in the sidecar came back blocked. */
export function hasBlockedSource(sourceCoverage = []) {
  return sourceCoverage.some((entry) => entry?.status === 'blocked');
}

/**
 * Overall confidence for a sidecar. Any blocked source caps confidence at
 * "low" -- a partially failed capture must never present as a complete one.
 */
export function coverageConfidence(sourceCoverage = []) {
  const entries = sourceCoverage.filter(Boolean);
  if (entries.length === 0) return 'low';
  if (entries.some((entry) => entry.status === 'blocked')) return 'low';
  const captured = entries.filter((entry) => entry.status === 'captured').length;
  const answerable = entries.filter((entry) => entry.status !== 'skipped-by-profile' && entry.status !== 'unsupported').length;
  if (answerable === 0) return 'low';
  const ratio = captured / answerable;
  if (ratio >= 0.8) return 'high';
  if (ratio >= 0.5) return 'medium';
  return 'low';
}
