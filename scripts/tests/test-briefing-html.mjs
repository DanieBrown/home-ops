#!/usr/bin/env node

import assert from 'node:assert/strict';
import { ROOT } from '../shared/paths.mjs';
import { parseReport } from '../research/research-utils.mjs';
import { buildHtml, parseGateRows, computeCityMedianPricePerSqft } from '../reports/briefing-pdf.mjs';

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

// --- Task 5: overview dashboard ---
const gateRows = parseGateRows(report.sections['Hard Requirement Gate']);
assert.equal(gateRows.length, 4);
assert.deepEqual(gateRows.map((row) => row.state), ['pass', 'pass', 'unknown', 'fail']);
assert.deepEqual(parseGateRows(''), []);

const trackerFixture = [
  '| # | Date | Address | City | Price | Beds/Baths | SqFt | Score | Status | Report | Notes |',
  '|---|------|---------|------|-------|------------|------|-------|--------|--------|-------|',
  '| 1 | 2026-05-07 | 1 A St | Apex | $600,000 | 4/2 | 3,000 | 4/5 | Evaluated | [1](reports/1.md) | n |',
  '| 2 | 2026-05-07 | 2 B St | Apex | $700,000 | 4/2 | 2,800 | 4/5 | Evaluated | [2](reports/2.md) | n |',
  '| 3 | 2026-05-07 | 3 C St | Apex | $750,000 | 4/2 | 3,000 | 4/5 | Evaluated | [3](reports/3.md) | n |',
  '| 4 | 2026-05-07 | 4 D St | Cary | $900,000 | 4/2 | 3,000 | 4/5 | Evaluated | [4](reports/4.md) | n |',
].join('\n');
const median = computeCityMedianPricePerSqft(trackerFixture, 'Apex');
assert.equal(median.sampleSize, 3);
assert.equal(Math.round(median.median), 250);
assert.equal(computeCityMedianPricePerSqft(trackerFixture, 'Cary'), null);

const axisFixture = {
  address: '100 Fixture Dr',
  city: 'Apex',
  state: 'NC',
  sentiment: {
    sentimentScores: {
      community: { score: 0.4, signalDirection: 'positive', evidenceCount: 5, proximityMix: 'near', quotes: ['Lovely block parties'], source: 'sidecar' },
      traffic_commute: { score: -0.3, signalDirection: 'negative', evidenceCount: 3, proximityMix: 'adjacent', quotes: ['Backups on the collector'], source: 'sidecar' },
    },
    redFlagsTriggered: ['busy road'],
    sourceCoverage: { google_maps: 'captured', facebook: 'blocked' },
    confidence: 'medium',
  },
  riskBuilder: {
    riskLevel: 'moderate',
    nearbyProjects: [
      { description: 'Collector road widening', source: 'ncdot', status: 'active', distanceMiles: 0.8, caseId: 'STIP-U-1234' },
      { description: 'Subdivision phase 2', source: 'county-permit', status: 'approved', distanceMiles: 2.4, caseId: 'SUB-22-01' },
      { description: 'Sewer extension', source: 'county-permit', status: 'approved' },
    ],
    resaleRiskNote: 'Fixture resale note.',
    sourceCoverage: { ncdot: 'captured', county: 'captured', builder: 'not-applicable' },
    confidence: 'medium',
  },
  schools: {
    schools: [{ name: 'Fixture Elementary School', gradeLevel: 'elementary', rating: 8, source: 'sidecar' }],
    weightedSchoolScore: 0.64,
    flags: ['ratio-above-district-mean'],
    sourceCoverage: 'captured',
    confidence: 'high',
  },
  verdict: { recommendation: 'pursue', confidence: 'medium', rationale: 'Fixture.', inPersonChecks: [] },
};

const richFinalist = makeFinalist({
  axis: axisFixture,
  listing: {
    address: '100 Fixture Dr', city: 'Apex', state: 'NC',
    price: 700000, sqftFinished: 2900, beds: 4, baths: 2.5,
    yearBuilt: 2015, hoaMonthly: 50, daysOnMarket: 3, lotSqft: 12000,
    listingStatus: 'active', mls: 'FIX123',
    photos: { count: 10, urls: [], localPaths: ['scripts/tests/fixtures/briefing/photo-1.png'] },
  },
});
const richHtml = buildHtml([richFinalist], null, 'single', { trackerContent: trackerFixture });
assert.ok(richHtml.includes('data:image/png;base64'), 'photo strip embeds base64 data URI');
assert.ok(richHtml.includes('kpi-band'), 'KPI tiles render');
assert.ok(richHtml.includes('$241'), 'computed $/sqft renders (700000/2900)');
assert.ok(/vs Apex tracker median \(n=3\)/.test(richHtml), 'median delta renders');
assert.ok(richHtml.includes('gate-chip gate-pass'), 'gate pass chip renders');
assert.ok(richHtml.includes('gate-chip gate-fail'), 'gate fail chip renders');
assert.ok(richHtml.includes('gate-chip gate-unknown'), 'gate unknown chip renders');
assert.ok(richHtml.includes('axis-scoreboard'), 'axis scoreboard renders');
assert.ok(richHtml.includes('conf-badge'), 'per-axis confidence chips render');
assert.ok(richHtml.includes('sentiment: medium'), 'confidence chip content renders from axis data');
assert.ok(richHtml.includes('MODERATE RISK'), 'risk chip renders');

// No axis, no photos -> dashboard blocks are simply absent, page still renders.
const bareHtml = buildHtml([makeFinalist()], null, 'single', { trackerContent: '' });
assert.ok(!bareHtml.includes('axis-scoreboard'));
assert.ok(!bareHtml.includes('data:image/png'));
assert.ok(bareHtml.includes('gate-chip'), 'gate chips come from the report, not the axis file');
assert.ok(!bareHtml.includes('sentiment: medium'), 'no confidence chip content without axis data');

// --- Task 6: sentiment axis section ---
assert.ok(richHtml.includes('sentiment-axis'), 'axis sentiment section renders when axis data exists');
assert.ok(richHtml.includes('Lovely block parties'), 'verbatim quote renders');
assert.ok(richHtml.includes('class="diverge"'), 'diverging bar SVG renders');
assert.ok(richHtml.includes('Deal-breaker red flags'), 'red flag callout renders');
assert.ok(richHtml.includes('facebook: blocked'), 'source coverage chips render');
assert.ok(!richHtml.includes('Not yet captured from Facebook or Nextdoor'), 'legacy placeholder replaced when axis data exists');
assert.ok(bareHtml.includes('Not yet captured from Facebook or Nextdoor'), 'legacy fallback preserved without axis data');

console.log('test-briefing-html: all assertions passed');
