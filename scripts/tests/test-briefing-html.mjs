#!/usr/bin/env node

import assert from 'node:assert/strict';
import { ROOT } from '../shared/paths.mjs';
import { parseReport } from '../research/research-utils.mjs';
import { buildHtml, parseGateRows, computeCityMedianPricePerSqft, ringMapPoints } from '../reports/briefing-pdf.mjs';

/**
 * Strips the static <style> block before any assertion runs.
 *
 * The stylesheet names every selector in the document, so a bare
 * `html.includes('axis-panel')` passes even when nothing rendered. That has
 * already produced a false pass once. Every assertion below runs against the
 * rendered body, so a class token can never satisfy one on its own -- and the
 * negative assertions ("this must NOT appear") become meaningful too.
 */
function renderedBody(html) {
  return String(html).replace(/<style[\s\S]*?<\/style>/gi, '');
}

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
    hazards: null,
    parcel: null,
    access: null,
    hazardsMismatch: '',
    parcelMismatch: '',
    accessMismatch: '',
    ...overrides,
  };
}

// Legacy render without any axis sidecar must still work end-to-end.
const legacyHtml = renderedBody(buildHtml([makeFinalist()], null, 'single'));
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
  verdict: { recommendation: 'pursue', confidence: 'medium', rationale: 'Verdict rationale fixture.', inPersonChecks: ['Confirm fence height'] },
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
const richHtml = renderedBody(buildHtml([richFinalist], null, 'single', { trackerContent: trackerFixture }));
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
const bareHtml = renderedBody(buildHtml([makeFinalist()], null, 'single', { trackerContent: '' }));
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

// --- Task 7: risk ring map ---
const { points, legendOnly } = ringMapPoints(axisFixture.riskBuilder.nearbyProjects);
assert.equal(points.length, 2, 'projects with distanceMiles become dots');
assert.equal(legendOnly.length, 1, 'projects without distance are legend-only');
for (const point of points) {
  const dx = point.x - 150;
  const dy = point.y - 150;
  const radius = Math.sqrt(dx * dx + dy * dy);
  assert.ok(radius <= 130.5, 'dots stay inside the 5-mile ring');
}
const rerun = ringMapPoints(axisFixture.riskBuilder.nearbyProjects);
assert.deepEqual(rerun.points.map((p) => [p.x, p.y]), points.map((p) => [p.x, p.y]), 'angles are deterministic');
assert.deepEqual(ringMapPoints([]), { points: [], legendOnly: [] });

assert.ok(richHtml.includes('ring-map'), 'ring map renders in the infrastructure page');
assert.ok(richHtml.includes('Collector road widening'), 'project appears in ring legend');
assert.ok(richHtml.includes('Fixture resale note.'), 'axis resale note renders');
assert.ok(richHtml.includes('bearing is schematic'), 'schematic-bearing caption present');
assert.ok(!bareHtml.includes('ring-map'), 'no ring map without axis data');

// --- Task 8: schools additions + packing ---
assert.ok(richHtml.includes('school-weighted'), 'weighted school gauge renders with axis data');
assert.ok(richHtml.includes('ratio above district mean'), 'axis school flags render');

const pageCount = (richHtml.match(/class="report-page/g) ?? []).length;
// With this fixture: overview, property snapshot, sentiment-axis,
// infrastructure, schools, 1 compact page (utilities "unreviewed" placeholder
// is the only compact card -- HOA/builder/commute are empty), and sources
// (the fixture report's URL yields one source-ledger link) = 7 pages.
assert.equal(pageCount, 7, `expected 7 report pages, got ${pageCount}`);
assert.ok(richHtml.includes('report-page-compact'), 'compact packing page exists');

// --- Fix wave: final whole-branch review ---

// Fix 2: axis red flags + high risk feed Top Concerns.
assert.ok(richHtml.includes('Deal-breaker red flag from neighborhood sentiment'), 'axis red flags feed top concerns');
assert.ok(!bareHtml.includes('Deal-breaker red flag from neighborhood sentiment'));

// Fix 3: persisted verdict renders in the Decision Read panel (axis-first hierarchy).
assert.ok(richHtml.includes('PURSUE'), 'verdict recommendation renders uppercased');
assert.ok(richHtml.includes('Verdict rationale fixture.'), 'verdict rationale renders');
assert.ok(richHtml.includes('Confirm fence height'), 'in-person checks render');
assert.ok(richHtml.includes('Check in person'), 'in-person checks heading renders');
assert.ok(!bareHtml.includes('Check in person'), 'no in-person checks heading without axis verdict');

// Fix 6: projects farther than the 5-mile ring are legend-only, not clamped onto the outer ring.
assert.equal(ringMapPoints([{ description: 'Far project', status: 'active', distanceMiles: 7 }]).legendOnly.length, 1);

// --- riskLevel: 'high' feeds Top Concerns (previously never exercised) ---

const highRiskHtml = renderedBody(buildHtml([makeFinalist({
  axis: {
    ...axisFixture,
    riskBuilder: { ...axisFixture.riskBuilder, riskLevel: 'high' },
  },
})], null, 'single', { trackerContent: '' }));
assert.ok(highRiskHtml.includes('HIGH RISK'), 'a high risk level renders its chip');
assert.ok(!richHtml.includes('HIGH RISK'), 'the moderate fixture must not render a high-risk chip');
assert.ok(
  /high development pressure|High development pressure|high risk/i.test(highRiskHtml),
  'a high risk level surfaces in the Top Concerns copy',
);

// --- Property Snapshot ---

// Nothing captured: every dimension reads as unknown, and the copy says so.
assert.ok(bareHtml.includes('Property Snapshot'), 'the snapshot panel always renders');
assert.ok(bareHtml.includes('Site hazards have not been captured'), 'missing hazards are named, not omitted');
assert.ok(/unknown &mdash; not clear|unknown, not clear/.test(bareHtml), 'missing hazards read as unknown, never as clear');
assert.ok(bareHtml.includes('Assessed value and property tax are unknown'), 'missing parcel record is named');
assert.ok(bareHtml.includes('unmeasured, not low'), 'missing access reads as unmeasured, never as low traffic');

const snapshotFinalist = makeFinalist({
  listing: {
    address: '100 Fixture Dr', city: 'Apex', state: 'NC', price: 650000,
    priceMovement: {
      originalListPrice: 700000, currentPrice: 650000, totalCutAmount: 50000,
      totalCutPct: 7.1, cutCount: 2, cuts: [], daysToFirstCut: 31, eventCount: 3,
    },
  },
  hazards: {
    address: '100 Fixture Dr', city: 'Apex', state: 'NC', confidence: 'low',
    dimensions: {
      flood: { label: 'FEMA flood zone', provenance: 'captured', value: 'AE', detail: 'Special Flood Hazard Area (1% annual chance)', sourceUrl: 'https://hazards.fema.gov/x' },
      radon: { label: 'Radon zone', provenance: 'captured', value: 'Zone 2', detail: null, sourceUrl: 'https://epa.gov/x' },
      // Deliberately blocked: this is the case that must never read as clear.
      epaSites: { label: 'Environmental sites', provenance: 'blocked', value: null, detail: null, sourceUrl: 'https://epa.gov/frs', note: 'EPA FRS query failed (HTTP 503).' },
      airportNoise: { label: 'Airport noise', provenance: 'not-applicable', value: null, detail: null, note: 'Outside every modelled RDU contour.' },
      septic: { label: 'Septic suitability', provenance: 'unsupported', value: null, detail: null },
    },
    sourceCoverage: [
      { key: 'fema_nfhl', name: 'FEMA National Flood Hazard Layer', url: 'https://hazards.fema.gov/x', status: 'captured' },
      { key: 'epa_frs', name: 'EPA Facility Registry Service', url: 'https://epa.gov/frs', status: 'blocked' },
    ],
    warnings: [],
  },
  parcel: {
    address: '100 Fixture Dr', city: 'Apex', state: 'NC', confidence: 'high',
    dimensions: {
      assessedValue: { label: 'Assessed value', provenance: 'captured', value: '$646,411', detail: 'land $120,000', sourceUrl: 'https://maps.wake.gov/x' },
      estimatedTax: { label: 'Estimated annual tax', provenance: 'captured', value: '~$5,643/yr', detail: 'Wake County 0.5171 + Apex 0.356 per $100', note: 'Estimate only — not a tax quote.' },
    },
    sourceCoverage: [{ key: 'county_parcel', name: 'Wake parcel layer', url: 'https://maps.wake.gov/x', status: 'captured' }],
    billLookup: { name: 'Wake County tax bill search', url: 'https://services.wake.gov/realestate/', instructions: 'Search by address or PIN.' },
    warnings: [],
  },
  access: {
    address: '100 Fixture Dr', city: 'Apex', state: 'NC', confidence: 'medium',
    dimensions: {
      nearestRoad: { label: 'Nearest counted road', provenance: 'captured', value: 'NC 55 — 47,000 AADT at 180 m', detail: '2021 count; exceeds the buyer\'s busy-road threshold', sourceUrl: 'https://ncdot/x' },
      driveTimes: { label: 'Drive times', provenance: 'blocked', value: null, detail: null, note: 'Directions could not be read from the hosted session.' },
    },
    sourceCoverage: [
      { key: 'ncdot_aadt_stations', name: 'NCDOT AADT stations', url: 'https://ncdot/x', status: 'captured' },
      { key: 'google_maps_directions', name: 'Google Maps directions', url: 'https://maps.google.com', status: 'blocked' },
    ],
    guidedChecks: [{ name: 'NC SBI Sex Offender Registry — radius search', url: 'https://sexoffender.ncsbi.gov', instructions: 'Run a 1-mile radius search on this address.' }],
    warnings: [],
  },
});
const snapshotHtml = renderedBody(buildHtml([snapshotFinalist], null, 'single', { trackerContent: '' }));

// Captured values render.
assert.ok(snapshotHtml.includes('AE'), 'the captured flood zone renders');
assert.ok(snapshotHtml.includes('Special Flood Hazard Area'), 'the SFHA detail renders');
assert.ok(snapshotHtml.includes('Zone 2'), 'the captured radon zone renders');
assert.ok(snapshotHtml.includes('$646,411'), 'the captured assessed value renders');
assert.ok(snapshotHtml.includes('~$5,643/yr'), 'the captured tax estimate renders');
assert.ok(snapshotHtml.includes('not a tax quote'), 'the tax estimate carries its caveat');
assert.ok(snapshotHtml.includes('NC 55 — 47,000 AADT at 180 m'), 'the measured road and volume render');

// A blocked source must be labelled and must carry no value.
assert.ok(snapshotHtml.includes('BLOCKED'), 'a blocked dimension is labelled BLOCKED');
assert.ok(snapshotHtml.includes('EPA FRS query failed (HTTP 503).'), 'the blocked reason renders');
assert.ok(
  snapshotHtml.includes('could not be reached (EPA Facility Registry Service)'),
  'a blocked source is banner-flagged inside its group',
);
assert.ok(
  /Those dimensions are unknown, not clear/.test(snapshotHtml),
  'the blocked banner states that blocked is not an all-clear',
);
assert.ok(
  snapshotHtml.includes('1 site hazard source could not be reached (EPA Facility Registry Service)'),
  'a blocked source also becomes a research-gap line',
);
assert.ok(
  snapshotHtml.includes('1 access source could not be reached (Google Maps directions)'),
  'a blocked drive-time source becomes its own research-gap line',
);

// The distinct states must not collapse into each other.
assert.ok(snapshotHtml.includes('not applicable') || snapshotHtml.includes('n/a'), 'not-applicable renders distinctly');
assert.ok(snapshotHtml.includes('Outside every modelled RDU contour.'), 'the not-applicable reason renders');
assert.ok(!/Airport noise[\s\S]{0,200}quiet/i.test(snapshotHtml), 'airport noise must never be described as quiet');
assert.ok(snapshotHtml.includes('unsupported'), 'unsupported renders distinctly');

// Price movement and guided checks.
assert.ok(snapshotHtml.includes('2 cuts'), 'price movement renders the cut count');
assert.ok(snapshotHtml.includes('First cut after 31 days on market'), 'days-to-first-cut renders');
assert.ok(snapshotHtml.includes('NC SBI Sex Offender Registry'), 'the guided registry check renders');
assert.ok(snapshotHtml.includes('nothing was scraped'), 'the guided-check block states nothing was scraped');
assert.ok(snapshotHtml.includes('Wake County tax bill search'), 'the county bill lookup renders');

// Sources Checked carries the snapshot sources with their real status, so a
// blocked source is visible in the ledger rather than silently absent.
assert.ok(snapshotHtml.includes('EPA Facility Registry Service'), 'blocked sources still appear in Sources Checked');
assert.ok(snapshotHtml.includes('https://hazards.fema.gov/x'), 'captured source URLs appear in Sources Checked');

// An address-mismatched sidecar is a named gap.
const mismatchHtml = renderedBody(buildHtml([makeFinalist({
  hazardsMismatch: 'Site hazards sidecar is for 999 Other Rd, Cary but this report is 100 Fixture Dr, Apex.',
})], null, 'single', { trackerContent: '' }));
assert.ok(mismatchHtml.includes('999 Other Rd'), 'an address-mismatched snapshot sidecar is surfaced as a gap');

console.log('test-briefing-html: all assertions passed');
