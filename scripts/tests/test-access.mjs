#!/usr/bin/env node

/**
 * test-access.mjs -- access-core against recorded NCDOT responses. No network.
 *
 * The rule being tested is that "major road adjacency" is now a measurement:
 * a named route, a traffic count, and a distance, judged against thresholds
 * from config/profile.yml. An uncounted street is unmeasured, not quiet, and a
 * blocked NCDOT query is unknown, not low-risk.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ROOT } from '../shared/paths.mjs';
import {
  DEFAULT_THRESHOLDS,
  buildAccessRecord,
  buildDriveTimes,
  buildRedistrictingGuide,
  buildSexOffenderGuide,
  latestAadt,
  mapsDirectionsUrl,
  parseDurationMinutes,
  parseRoadAccess,
  resolveThresholds,
} from '../research/access-core.mjs';
import { COVERAGE_STATES, PROVENANCE_STATES } from '../research/source-coverage.mjs';

const FIXTURES = join(ROOT, 'scripts', 'tests', 'fixtures', 'sources');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
const ok = (body) => ({ ok: true, features: body.features ?? [] });

const HOME = { lat: 35.702073063508, lng: -78.807313479268 };
const TARGET = { address: '2201 Newleaf Dr', city: 'Apex', state: 'NC', relativePath: 'reports/001-x-2026-08-11.md' };

// ── thresholds come from the buyer profile, not from _shared.md ──────

assert.deepEqual(resolveThresholds({}), DEFAULT_THRESHOLDS);
const custom = resolveThresholds({ access: { busy_road_aadt: 8000, busy_road_distance_meters: 400 } });
assert.equal(custom.busyRoadAadt, 8000);
assert.equal(custom.busyRoadDistanceMeters, 400);
assert.equal(custom.aadtSearchRadiusMeters, DEFAULT_THRESHOLDS.aadtSearchRadiusMeters, 'unset keys keep their default');

// The shipped example profile must document the thresholds the code reads.
const exampleProfile = YAML.parse(readFileSync(join(ROOT, 'config', 'profile.example.yml'), 'utf8'));
assert.ok(exampleProfile.access?.busy_road_aadt, 'config/profile.example.yml must document access.busy_road_aadt');
assert.ok(exampleProfile.access?.busy_road_distance_meters, 'config/profile.example.yml must document access.busy_road_distance_meters');

// ── latest AADT year ─────────────────────────────────────────────────

// NCDOT leaves uncounted years blank, so "latest" is the newest populated one.
assert.deepEqual(latestAadt({ AADT_2019: '48000', AADT_2021: '47000', AADT_2022: ' ' }), { year: 2021, aadt: 47000 });
assert.equal(latestAadt({ AADT_2020: ' ', AADT_2021: '' }), null);
assert.equal(latestAadt({}), null);
assert.deepEqual(latestAadt({ AADT_2005: '38000', ROUTE: 'NC 55' }), { year: 2005, aadt: 38000 });

// ── road access ──────────────────────────────────────────────────────

const stations = ok(fixture('ncdot-aadt-stations'));
const segments = ok(fixture('ncdot-aadt-segments'));

const road = parseRoadAccess(stations, segments, HOME, DEFAULT_THRESHOLDS);
assert.equal(road.dimension.provenance, 'captured');
assert.ok(road.nearestRoad, 'a nearest station must be resolved from the fixture');
assert.ok(road.nearestRoad.route, 'the nearest road must be named');
assert.ok(Number.isFinite(road.nearestRoad.aadt) && road.nearestRoad.aadt > 0);
assert.ok(Number.isFinite(road.nearestRoad.distanceMeters));
// Stations must come back nearest-first.
const distances = road.stations.map((s) => s.distanceMeters);
assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
assert.match(road.dimension.value, /AADT at \d+ m/);
assert.match(road.dimension.note, /unmeasured, not quiet/);
assert.equal(road.busyRoadExposure.exposed, false, 'default thresholds: no qualifying road in this fixture');
assert.ok(road.peakSegmentAadt > 0, 'segments should contribute a peak volume');

// Loosening the thresholds far enough must flip the exposure flag, proving the
// classification is driven by the numbers rather than hardcoded.
const sensitive = parseRoadAccess(stations, segments, HOME, {
  busyRoadAadt: 1, busyRoadDistanceMeters: 100000, aadtSearchRadiusMeters: 2000,
});
assert.equal(sensitive.busyRoadExposure.exposed, true);
assert.ok(sensitive.busyRoadExposure.matchedRoad.route);
assert.match(sensitive.dimension.detail, /exceeds the buyer's busy-road threshold/);

// A blocked NCDOT query is unknown, not low-risk.
const roadBlocked = parseRoadAccess({ ok: false, error: 'HTTP 503' }, segments, HOME);
assert.equal(roadBlocked.dimension.provenance, 'blocked');
assert.equal(roadBlocked.dimension.value, null);
assert.equal(roadBlocked.busyRoadExposure, null, 'a blocked source must not assert "no busy road"');
assert.match(roadBlocked.dimension.note, /unknown, not low/);
assert.ok(roadBlocked.coverage.some((entry) => entry.status === 'blocked'));

// No station in range is unmeasured, not quiet.
const noStations = parseRoadAccess({ ok: true, features: [] }, segments, HOME);
assert.equal(noStations.dimension.provenance, 'unconfirmed');
assert.equal(noStations.busyRoadExposure, null);
assert.match(noStations.dimension.note, /not evidence of low traffic/);

// A blocked segments query must not blank out an otherwise good station read.
const segmentsBlocked = parseRoadAccess(stations, { ok: false, error: 'timeout' }, HOME);
assert.equal(segmentsBlocked.dimension.provenance, 'captured');
assert.ok(segmentsBlocked.coverage.some((entry) => entry.key === 'ncdot_aadt_segments' && entry.status === 'blocked'));

// ── drive times ──────────────────────────────────────────────────────

assert.equal(parseDurationMinutes('25 min'), 25);
assert.equal(parseDurationMinutes('1 hr 5 min'), 65);
assert.equal(parseDurationMinutes('2 hr'), 120);
assert.equal(parseDurationMinutes('no idea'), null);
assert.equal(parseDurationMinutes(''), null);
assert.equal(parseDurationMinutes(null), null);

assert.match(mapsDirectionsUrl('2201 Newleaf Dr, Apex, NC', 'RTP, NC'), /travelmode=driving/);

// No configured destinations is not-applicable, and says how to enable it.
const noDestinations = buildDriveTimes([], []);
assert.equal(noDestinations.dimension.provenance, 'not-applicable');
assert.equal(noDestinations.coverage.status, 'skipped-by-profile');
assert.match(noDestinations.dimension.note, /commute\.destinations/);

const destinations = [{ name: 'RTP', address: 'Research Triangle Park, NC' }, { name: 'Downtown Raleigh', address: 'Raleigh, NC' }];
const measured = buildDriveTimes(destinations, [
  { name: 'RTP', freeFlowMinutes: 28, peakMinutes: 44, typicalRange: '28 min – 44 min' },
  { name: 'Downtown Raleigh', freeFlowMinutes: 35, peakMinutes: null },
], { origin: '2201 Newleaf Dr, Apex, NC' });
assert.equal(measured.dimension.provenance, 'captured');
assert.match(measured.dimension.value, /RTP 28 min \(peak 44 min\)/);
assert.match(measured.dimension.value, /Downtown Raleigh 35 min/);
assert.equal(measured.routes.length, 2);
assert.ok(measured.routes.every((route) => route.mapUrl), 'every route keeps its map link');

// Unreadable durations degrade to blocked but keep the links -- the PDF used
// to render links only, so this is never worse than the previous behavior.
const failed = buildDriveTimes(destinations, [
  { name: 'RTP', error: 'directions panel carried no readable duration' },
  { name: 'Downtown Raleigh', error: 'timeout' },
]);
assert.equal(failed.dimension.provenance, 'blocked');
assert.equal(failed.dimension.value, null);
assert.equal(failed.coverage.status, 'blocked');
assert.ok(failed.routes.every((route) => route.mapUrl && route.status === 'blocked'));

// ── guided links: official link + instructions, never a scrape ───────

const offender = buildSexOffenderGuide(TARGET);
assert.equal(offender.dimension.provenance, 'unconfirmed', 'a guided check must never present as captured');
assert.equal(offender.dimension.value, null);
assert.match(offender.guide.url, /^https:\/\/sexoffender\.ncsbi\.gov/);
assert.match(offender.guide.instructions, /2201 Newleaf Dr, Apex, NC/);
assert.match(offender.dimension.note, /acceptable-use policy/);
assert.ok(offender.guide.alternateUrl.includes('nsopw.gov'));

const redistricting = buildRedistrictingGuide(TARGET);
assert.equal(redistricting.dimension.provenance, 'unconfirmed');
assert.equal(redistricting.dimension.value, null);
assert.match(redistricting.guide.instructions, /Apex/);

// ── record assembly ──────────────────────────────────────────────────

const record = buildAccessRecord({
  target: TARGET,
  geocode: { lat: HOME.lat, lng: HOME.lng, source: 'us-census-geocoder' },
  road,
  driveTimes: measured,
  sexOffender: offender,
  redistricting,
});
assert.equal(record.address, '2201 Newleaf Dr');
assert.equal(record.busyRoadExposure.exposed, false);
assert.equal(record.guidedChecks.length, 2);
assert.equal(record.warnings.length, 0);
for (const entry of record.sourceCoverage) assert.ok(COVERAGE_STATES.includes(entry.status), `bad status ${entry.status}`);
for (const dim of Object.values(record.dimensions)) {
  assert.ok(PROVENANCE_STATES.includes(dim.provenance));
  if (dim.provenance !== 'captured') assert.equal(dim.value, null, `${dim.label} must carry no value when ${dim.provenance}`);
}

const degraded = buildAccessRecord({
  target: TARGET, geocode: null, road: roadBlocked, driveTimes: failed,
  sexOffender: offender, redistricting,
});
assert.ok(degraded.warnings.some((w) => /blocked, not as a low-risk finding/.test(w)));
assert.equal(degraded.busyRoadExposure, null);

console.log('test-access: all assertions passed');
