#!/usr/bin/env node

/**
 * test-site-hazards.mjs -- site-hazards-core parsers against recorded
 * responses from the real sources. No network.
 *
 * The assertions that matter most are the negative ones: a blocked source must
 * never render as "no hazard found", and being outside the modelled airport
 * contours must never render as "quiet".
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ROOT } from '../shared/paths.mjs';
import {
  buildHazardsRecord,
  lookupRadonZone,
  parseEpaSites,
  parseFloodZone,
  parseSepticSuitability,
  parseWetlands,
  resolveAirportNoise,
} from '../research/site-hazards-core.mjs';
import { COVERAGE_STATES, PROVENANCE_STATES, coverageConfidence } from '../research/source-coverage.mjs';
import { haversineMeters, pointInRings, toWebMercator } from '../shared/geo.mjs';

const FIXTURES = join(ROOT, 'scripts', 'tests', 'fixtures', 'sources');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
const ok = (body) => ({ ok: true, features: body.features ?? [] });

// 2201 Newleaf Dr, Apex NC — the home all fixtures were recorded against.
const HOME = { lat: 35.702073063508, lng: -78.807313479268 };

// ── geo helpers ──────────────────────────────────────────────────────

// Apex to Raleigh is ~19 km; a loose band proves the formula, not the constant.
const apexToRaleigh = haversineMeters(35.7327, -78.8503, 35.7796, -78.6382);
assert.ok(apexToRaleigh > 18000 && apexToRaleigh < 22000, `unexpected haversine distance: ${apexToRaleigh}`);
assert.equal(haversineMeters(NaN, 0, 1, 1), null);

const mercator = toWebMercator(-78.807313479268, 35.702073063508);
assert.ok(Math.abs(mercator.x - -8772980) < 500, `web mercator x off: ${mercator.x}`);
assert.ok(Math.abs(mercator.y - 4258900) < 2000, `web mercator y off: ${mercator.y}`);

const square = [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]];
assert.equal(pointInRings({ x: 5, y: 5 }, square), true);
assert.equal(pointInRings({ x: 15, y: 5 }, square), false);

// ── flood ────────────────────────────────────────────────────────────

const floodX = parseFloodZone(ok(fixture('fema-flood-zone-x')));
assert.equal(floodX.dimension.provenance, 'captured');
assert.equal(floodX.dimension.value, 'X');
assert.equal(floodX.isSFHA, false);
assert.match(floodX.dimension.detail, /Outside the Special Flood Hazard Area/);

const floodAE = parseFloodZone(ok(fixture('fema-flood-zone-sfha')));
assert.equal(floodAE.dimension.value, 'AE');
assert.equal(floodAE.isSFHA, true, 'zone AE must be flagged as a Special Flood Hazard Area');
assert.match(floodAE.dimension.detail, /Special Flood Hazard Area/);

// A dead FEMA host is blocked, not "no flood risk".
const floodBlocked = parseFloodZone({ ok: false, error: 'HTTP 503', features: [] });
assert.equal(floodBlocked.dimension.provenance, 'blocked');
assert.equal(floodBlocked.dimension.value, null, 'a blocked source must carry no value');
assert.equal(floodBlocked.isSFHA, null, 'a blocked source must not assert "not in an SFHA"');
assert.equal(floodBlocked.coverage.status, 'blocked');
assert.match(floodBlocked.dimension.note, /unknown, not clear/i);

// An unmapped area is not an all-clear either.
const floodUnmapped = parseFloodZone({ ok: true, features: [] });
assert.equal(floodUnmapped.dimension.provenance, 'unconfirmed');
assert.equal(floodUnmapped.isSFHA, null);

// ── wetlands ─────────────────────────────────────────────────────────

const wetNearby = parseWetlands(ok(fixture('nwi-wetlands-none')), ok(fixture('nwi-wetlands-nearby')));
assert.equal(wetNearby.dimension.provenance, 'captured');
assert.match(wetNearby.dimension.value, /none on parcel; 4 within 500 m/);
assert.match(wetNearby.dimension.detail, /Freshwater Pond/);

const wetOnSite = parseWetlands(ok(fixture('nwi-wetlands-nearby')), ok(fixture('nwi-wetlands-nearby')));
assert.equal(wetOnSite.dimension.value, 'on parcel');

const wetBlocked = parseWetlands({ ok: false, error: 'timeout' }, { ok: false, error: 'timeout' });
assert.equal(wetBlocked.dimension.provenance, 'blocked');
assert.equal(wetBlocked.dimension.value, null);

// ── radon ────────────────────────────────────────────────────────────

const radonConfig = YAML.parse(readFileSync(join(ROOT, 'config', 'radon-zones.yml'), 'utf8'));
const radonTable = radonConfig.counties ?? {};

// The shipped table must match the EPA distribution for North Carolina.
const counts = Object.values(radonTable).reduce((acc, zone) => ({ ...acc, [zone]: (acc[zone] ?? 0) + 1 }), {});
assert.equal(Object.keys(radonTable).length, 100, 'North Carolina has 100 counties');
assert.equal(counts[1], 8, 'EPA lists 8 Zone 1 counties in NC');
assert.equal(counts[2], 31, 'EPA lists 31 Zone 2 counties in NC');
assert.equal(counts[3], 61, 'EPA lists 61 Zone 3 counties in NC');

const radonWake = lookupRadonZone('Wake', radonTable);
assert.equal(radonWake.dimension.provenance, 'captured');
assert.equal(radonWake.dimension.value, 'Zone 2');
assert.match(radonWake.dimension.note, /Only a test of this specific house/);
assert.equal(lookupRadonZone('Wake County', radonTable).dimension.value, 'Zone 2', 'the "County" suffix must be tolerated');

const radonUnknown = lookupRadonZone('Fairfax', radonTable);
assert.equal(radonUnknown.dimension.provenance, 'unsupported');
assert.equal(radonUnknown.coverage.status, 'unsupported');
assert.equal(lookupRadonZone('', radonTable).coverage.status, 'missing');

// ── EPA sites ────────────────────────────────────────────────────────

const epa = parseEpaSites(ok(fixture('epa-frs-nearby')), HOME, { radiusMeters: 3000 });
assert.equal(epa.dimension.provenance, 'captured');
assert.ok(epa.sites.length > 0, 'expected FRS records in the fixture');
assert.ok(epa.sites.every((site) => site.distanceMiles == null || site.distanceMiles >= 0));
// Distances must be sorted nearest-first.
const distances = epa.sites.map((site) => site.distanceMiles ?? 99);
assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
// A routine regulated facility must never be labelled a superfund site.
for (const site of epa.sites) {
  if (!['SEMS', 'SEMS-ARCHIVE', 'ACRES'].includes(site.program)) {
    assert.equal(site.serious, false, `${site.name} (${site.program}) must not be flagged as a contaminated site`);
    assert.doesNotMatch(site.programLabel, /Superfund|Brownfield/, `${site.program} mislabelled`);
  }
}

const epaBlocked = parseEpaSites({ ok: false, error: 'HTTP 500' }, HOME);
assert.equal(epaBlocked.dimension.provenance, 'blocked');
assert.equal(epaBlocked.dimension.value, null);

// ── septic ───────────────────────────────────────────────────────────

const septic = parseSepticSuitability(fixture('nrcs-septic-suitability'), { sewerStatus: 'unconfirmed' });
assert.equal(septic.dimension.provenance, 'captured');
assert.equal(septic.dimension.value, 'Somewhat limited');
assert.match(septic.dimension.detail, /Wedowee/, 'the dominant soil component (94%) must win');

const septicSkipped = parseSepticSuitability(fixture('nrcs-septic-suitability'), { sewerStatus: 'public' });
assert.equal(septicSkipped.dimension.provenance, 'not-applicable');
assert.equal(septicSkipped.coverage.status, 'skipped-by-profile');

const septicBlocked = parseSepticSuitability({ error: 'HTTP 400' }, { sewerStatus: 'unconfirmed' });
assert.equal(septicBlocked.dimension.provenance, 'blocked');

// ── airport noise ────────────────────────────────────────────────────

const contours = { ok: true, features: fixture('rdu-noise-contours').features };
assert.ok(contours.features.length >= 4, 'expected the 55/60/65/70 dB contours');

// Apex is far outside the modelled contours: not-applicable, never "quiet".
const noiseAway = resolveAirportNoise(HOME, contours);
assert.equal(noiseAway.dimension.provenance, 'not-applicable');
assert.equal(noiseAway.band, null);
assert.match(noiseAway.dimension.note, /Not a quietness finding/);
assert.doesNotMatch(noiseAway.dimension.note, /\bquiet\b(?!ness)/);

// A point inside the innermost contour must report its band.
const innermost = contours.features.reduce((best, f) =>
  Number(f.attributes.Noise_Leve) > Number(best.attributes.Noise_Leve) ? f : best);
const ring = innermost.geometry.rings[0];
const centroid = ring.reduce((acc, [x, y]) => ({ x: acc.x + x / ring.length, y: acc.y + y / ring.length }), { x: 0, y: 0 });
const R = 6378137;
const insideLng = (centroid.x / R) * (180 / Math.PI);
const insideLat = (2 * Math.atan(Math.exp(centroid.y / R)) - Math.PI / 2) * (180 / Math.PI);
const noiseInside = resolveAirportNoise({ lat: insideLat, lng: insideLng }, contours);
assert.equal(noiseInside.dimension.provenance, 'captured', 'a point inside the contours must report a band');
assert.equal(noiseInside.band, 70);
assert.match(noiseInside.dimension.detail, /FAA 65 dB DNL/);

const noiseBlocked = resolveAirportNoise(HOME, { ok: false, error: 'offline' });
assert.equal(noiseBlocked.dimension.provenance, 'blocked');

// ── record assembly ──────────────────────────────────────────────────

const target = { address: '2201 Newleaf Dr', city: 'Apex', state: 'NC', relativePath: 'reports/001-2201-newleaf-dr-2026-08-11.md' };
const record = buildHazardsRecord({
  target,
  geocode: { lat: HOME.lat, lng: HOME.lng, source: 'us-census-geocoder' },
  results: { flood: floodX, wetlands: wetNearby, radon: radonWake, epaSites: epa, septic, airportNoise: noiseAway },
});

assert.equal(record.address, '2201 Newleaf Dr');
assert.equal(record.floodIsSFHA, false);
assert.equal(record.floodZone, 'X');
assert.equal(Object.keys(record.dimensions).length, 6);
assert.equal(record.sourceCoverage.length, 6);
for (const entry of record.sourceCoverage) {
  assert.ok(COVERAGE_STATES.includes(entry.status), `invalid coverage status: ${entry.status}`);
  assert.ok(entry.key && entry.name, 'every coverage entry needs a key and a name');
}
for (const dim of Object.values(record.dimensions)) {
  assert.ok(PROVENANCE_STATES.includes(dim.provenance), `invalid provenance: ${dim.provenance}`);
  if (dim.provenance !== 'captured') assert.equal(dim.value, null, `${dim.label} must carry no value when ${dim.provenance}`);
}
assert.equal(record.warnings.length, 0);

// A blocked source must surface as a warning and cap confidence.
const degraded = buildHazardsRecord({
  target,
  geocode: null,
  results: { flood: floodBlocked, wetlands: wetNearby, radon: radonWake, epaSites: epa, septic, airportNoise: noiseAway },
});
assert.equal(degraded.floodIsSFHA, null);
assert.ok(degraded.warnings.some((w) => /blocked, not as "no hazard found"/.test(w)));
assert.equal(coverageConfidence(degraded.sourceCoverage), 'low', 'any blocked source caps confidence at low');
assert.equal(coverageConfidence(record.sourceCoverage), 'high');

console.log('test-site-hazards: all assertions passed');
