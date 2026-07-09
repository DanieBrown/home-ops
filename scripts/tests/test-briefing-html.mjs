#!/usr/bin/env node

import assert from 'node:assert/strict';
import { ROOT } from '../shared/paths.mjs';
import { parseReport } from '../research/research-utils.mjs';
import { buildHtml } from '../reports/briefing-pdf.mjs';

const report = parseReport(ROOT, 'scripts/tests/fixtures/briefing/046-fixture-home.md');
assert.equal(report.address, '100 Fixture Dr');

export function makeFinalist(overrides = {}) {
  return {
    rank: 1,
    report,
    construction: null,
    permits: null,
    sentiment: null,
    builder: null,
    hoaRules: null,
    utilities: null,
    packet: null,
    listing: null,
    community: null,
    axis: null,
    constructionMismatch: '',
    permitsMismatch: '',
    sentimentMismatch: '',
    builderMismatch: '',
    hoaMismatch: '',
    utilitiesMismatch: '',
    packetMismatch: '',
    axisMismatch: '',
    ...overrides,
  };
}

// Legacy render without any axis sidecar must still work end-to-end.
const legacyHtml = buildHtml([makeFinalist()], null, 'single');
assert.ok(legacyHtml.includes('100 Fixture Dr'));
assert.ok(legacyHtml.includes('Neighborhood Sentiment'));
assert.ok(/Not yet captured from Facebook or Nextdoor/.test(legacyHtml));

// A missing axis sidecar is a named research gap.
assert.ok(/Axis-agent interpretation sidecar has not been written/.test(legacyHtml));

console.log('test-briefing-html: all assertions passed');
