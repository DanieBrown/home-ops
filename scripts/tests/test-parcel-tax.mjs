#!/usr/bin/env node

/**
 * test-parcel-tax.mjs -- parcel-tax-core against recorded Wake County
 * responses. No network.
 *
 * The central assertion is address-match-before-consume: the recorded
 * "no-address-match" fixture is a real 400 m buffer around this home's
 * geocode, and it contains a neighbour's parcel but not this home's. Consuming
 * it would attach someone else's assessment, tax, and sale history to the
 * report.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ROOT } from '../shared/paths.mjs';
import {
  buildAssessmentDimension,
  buildFutureLandUseGuide,
  buildParcelRecord,
  buildSaleHistoryDimension,
  buildTaxEstimate,
  extractParcelFields,
  matchParcel,
  normalizeStreetAddress,
  parseParcel,
  parseZoning,
} from '../research/parcel-tax-core.mjs';
import { COVERAGE_STATES, PROVENANCE_STATES } from '../research/source-coverage.mjs';
import { ringsCentroid } from '../shared/geo.mjs';

const FIXTURES = join(ROOT, 'scripts', 'tests', 'fixtures', 'sources');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
const ok = (body) => ({ ok: true, features: body.features ?? [] });

const registry = YAML.parse(readFileSync(join(ROOT, 'config', 'county-arcgis-registry.yml'), 'utf8'));
const rateConfig = YAML.parse(readFileSync(join(ROOT, 'config', 'property-tax-rates.yml'), 'utf8'));
const layerConfig = registry.counties.wake.parcelLayer;
assert.ok(layerConfig?.url, 'the Wake registry entry must carry a parcelLayer');

const TARGET = {
  address: '2201 Newleaf Dr', city: 'Apex', state: 'NC',
  relativePath: 'reports/001-2201-newleaf-dr-2026-08-11.md',
};

// ── address normalization ────────────────────────────────────────────

assert.equal(normalizeStreetAddress('2201 Newleaf Drive'), '2201 newleaf dr');
assert.equal(normalizeStreetAddress('2201 NEWLEAF DR'), '2201 newleaf dr');
assert.equal(normalizeStreetAddress('141 E. Main Street'), '141 e main st');
assert.notEqual(normalizeStreetAddress('2201 Newleaf Dr'), normalizeStreetAddress('2217 Newleaf Dr'));

// ── address match before consume ─────────────────────────────────────

const byAddress = ok(fixture('wake-parcel-by-address'));
const matched = matchParcel(byAddress.features, TARGET, { addressField: 'SITE_ADDRESS' });
assert.ok(matched, 'the exact-address fixture must match');
assert.equal(matched.attributes.SITE_ADDRESS, '2201 NEWLEAF DR');

// A real 400 m buffer around this home's geocode: it holds 2217 NEWLEAF DR
// and other neighbours, but not 2201. None of them may be consumed.
const buffered = ok(fixture('wake-parcel-no-address-match'));
const addressesInBuffer = buffered.features.map((f) => f.attributes.SITE_ADDRESS);
assert.ok(addressesInBuffer.length > 0, 'the buffer fixture must contain neighbouring parcels');
assert.ok(!addressesInBuffer.includes('2201 NEWLEAF DR'), 'fixture premise: the buffer must NOT contain the subject parcel');
assert.equal(matchParcel(buffered.features, TARGET, { addressField: 'SITE_ADDRESS' }), null,
  'a neighbouring parcel must never be matched to this home');

const nearMiss = parseParcel(buffered, TARGET, { county: 'Wake County, NC', layerConfig });
assert.equal(nearMiss.parcel, null);
assert.equal(nearMiss.dimension.provenance, 'unconfirmed');
assert.equal(nearMiss.dimension.value, null);
assert.match(nearMiss.dimension.note, /none matching "2201 Newleaf Dr"/);
assert.match(nearMiss.dimension.note, /not this home/i);

// ── captured parcel ──────────────────────────────────────────────────

const parcelResult = parseParcel(byAddress, TARGET, { county: 'Wake County, NC', layerConfig });
assert.equal(parcelResult.dimension.provenance, 'captured');
const parcel = parcelResult.parcel;
assert.equal(parcel.parcelId, '0751703521');
assert.equal(parcel.assessedValue, 646411);
assert.equal(parcel.landValue, 120000);
assert.equal(parcel.improvementValue, 526411);
assert.equal(parcel.acres, 0.21);
assert.equal(parcel.heatedArea, 3117);
assert.equal(parcel.siteAddress, '2201 NEWLEAF DR');
assert.match(parcel.lastSaleDate, /^\d{4}-\d{2}-\d{2}$/, 'epoch-ms sale dates must become ISO dates');

const fields = extractParcelFields(byAddress.features[0], layerConfig);
assert.deepEqual(fields, parcel);

// ── assessment and sale ──────────────────────────────────────────────

const assessment = buildAssessmentDimension(parcel, { url: layerConfig.url });
assert.equal(assessment.provenance, 'captured');
assert.equal(assessment.value, '$646,411');
assert.match(assessment.detail, /land \$120,000/);
assert.match(assessment.note, /not a market appraisal/);
assert.equal(buildAssessmentDimension(null).provenance, 'unconfirmed');
assert.equal(buildAssessmentDimension(null).value, null);

const sale = buildSaleHistoryDimension(parcel, { url: layerConfig.url });
assert.equal(sale.provenance, 'captured');
assert.match(sale.value, /^\$[\d,]+$/);

// ── tax estimate ─────────────────────────────────────────────────────

const tax = buildTaxEstimate(parcel, { county: 'Wake', city: 'Apex', rateConfig });
assert.equal(tax.dimension.provenance, 'captured');
// 646411/100 * (0.5171 + 0.356) = 5643.7...
const expected = (646411 / 100) * (rateConfig.counties.wake.rate + rateConfig.municipalities.apex.rate);
assert.ok(Math.abs(tax.annualEstimate - expected) < 1, `tax estimate off: ${tax.annualEstimate} vs ${expected}`);
assert.match(tax.dimension.value, /^~\$[\d,]+\/yr$/);
assert.match(tax.dimension.note, /Not a tax quote/);
assert.match(tax.dimension.note, /Excludes|excludes/);
assert.ok(tax.billLookup?.url, 'the county bill lookup must always accompany the estimate');
assert.equal(tax.municipalRateFound, true);

// A jurisdiction with no rate must report unsupported, never a guessed bill.
const noRate = buildTaxEstimate(parcel, { county: 'Chatham', city: 'Pittsboro', rateConfig });
assert.equal(noRate.dimension.provenance, 'unsupported');
assert.equal(noRate.dimension.value, null);
assert.equal(noRate.coverage.status, 'unsupported');

// County rate but no municipal rate still estimates, and says so.
const countyOnly = buildTaxEstimate(parcel, { county: 'Wake', city: 'Somewhere Else', rateConfig });
assert.equal(countyOnly.dimension.provenance, 'captured');
assert.equal(countyOnly.municipalRateFound, false);
assert.match(countyOnly.dimension.note, /county rate only/);

// No assessed value means no estimate at all.
assert.equal(buildTaxEstimate(null, { county: 'Wake', city: 'Apex', rateConfig }).dimension.provenance, 'unconfirmed');

// ── zoning ───────────────────────────────────────────────────────────

const zoning = parseZoning(ok(fixture('wake-zoning-apex')), {
  url: 'https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer/14',
  classField: 'CLASS',
  jurisdictionLabel: 'Apex',
});
assert.equal(zoning.dimension.provenance, 'captured');
assert.equal(zoning.dimension.value, 'MD-CZ');
assert.match(zoning.dimension.detail, /Apex zoning district/);

assert.equal(parseZoning({ ok: true, features: [] }, { url: 'https://example/0' }).dimension.provenance, 'unconfirmed');
assert.equal(parseZoning({ ok: false, error: 'HTTP 500' }, { url: 'https://example/0' }).dimension.provenance, 'blocked');
assert.equal(parseZoning(null, {}).dimension.provenance, 'unsupported');

// ── future land use is a guided link, never a claimed result ─────────

const landUse = buildFutureLandUseGuide({
  municipalities: [{ key: 'apex', city: 'Apex', name: 'Apex Development Map', url: 'https://www.apexnc.org/devmap' }],
}, { city: 'Apex' });
assert.equal(landUse.dimension.provenance, 'unconfirmed', 'a guided link must never present as captured');
assert.equal(landUse.dimension.value, null);
assert.ok(landUse.guide.instructions.length > 20, 'the guide must tell the buyer how to check this home');
assert.equal(buildFutureLandUseGuide(null, { city: 'Apex' }).dimension.provenance, 'unsupported');

// ── unsupported county ───────────────────────────────────────────────

const unsupported = parseParcel(null, TARGET, { county: 'Harnett County, NC', layerConfig: null });
assert.equal(unsupported.dimension.provenance, 'unsupported');
assert.equal(unsupported.coverage.status, 'unsupported');
assert.match(unsupported.dimension.note, /county-services-discover/);

// A dead county service is blocked, not "no parcel".
const blocked = parseParcel({ ok: false, error: 'HTTP 503' }, TARGET, { county: 'Wake', layerConfig });
assert.equal(blocked.dimension.provenance, 'blocked');
assert.equal(blocked.parcel, null);

// ── centroid re-anchoring ────────────────────────────────────────────

// A unit square centred on the origin.
const squareCentroid = ringsCentroid([[[-1, -1], [-1, 1], [1, 1], [1, -1], [-1, -1]]]);
assert.ok(Math.abs(squareCentroid.x) < 1e-9 && Math.abs(squareCentroid.y) < 1e-9, `centroid off: ${JSON.stringify(squareCentroid)}`);
// An off-origin square lands on its own centre.
const offset = ringsCentroid([[[10, 20], [10, 24], [16, 24], [16, 20], [10, 20]]]);
assert.ok(Math.abs(offset.x - 13) < 1e-9 && Math.abs(offset.y - 22) < 1e-9, `centroid off: ${JSON.stringify(offset)}`);
assert.equal(ringsCentroid([]), null);
assert.equal(ringsCentroid([[[0, 0], [1, 1]]]), null);

// ── record assembly ──────────────────────────────────────────────────

const dimensions = {
  parcel: parcelResult.dimension,
  assessedValue: assessment,
  lastSale: sale,
  estimatedTax: tax.dimension,
  zoning: zoning.dimension,
  futureLandUse: landUse.dimension,
};
const record = buildParcelRecord({
  target: TARGET,
  geocode: { lat: 35.7, lng: -78.8, source: 'us-census-geocoder' },
  parcel,
  dimensions,
  sourceCoverage: [parcelResult.coverage, tax.coverage, zoning.coverage, landUse.coverage],
  extras: { county: 'Wake County, NC' },
});
assert.equal(record.address, '2201 Newleaf Dr');
assert.equal(record.parcel.parcelId, '0751703521');
assert.equal(record.warnings.length, 0);
for (const entry of record.sourceCoverage) assert.ok(COVERAGE_STATES.includes(entry.status), `bad status ${entry.status}`);
for (const dim of Object.values(record.dimensions)) {
  assert.ok(PROVENANCE_STATES.includes(dim.provenance));
  if (dim.provenance !== 'captured') assert.equal(dim.value, null);
}

const unmatched = buildParcelRecord({
  target: TARGET, geocode: null, parcel: null,
  dimensions: { parcel: nearMiss.dimension, estimatedTax: buildTaxEstimate(null, { county: 'Wake', city: 'Apex', rateConfig }).dimension },
  sourceCoverage: [nearMiss.coverage],
});
assert.ok(unmatched.warnings.some((w) => /No county parcel matched/.test(w)));

console.log('test-parcel-tax: all assertions passed');
