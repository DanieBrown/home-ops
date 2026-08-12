#!/usr/bin/env node

/**
 * test-neighborhood-resolution.mjs -- Phase 2 of the sentiment-capture goal
 * prompt: the resolveNeighborhood() chain. No network -- GIS/OSM/browser
 * resolvers are injected stubs.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ROOT } from '../shared/paths.mjs';
import { extractSubdivisionHints } from '../research/research-utils.mjs';
import {
  extractStreetHeuristicName,
  parseSubdivisionFromLegalDescription,
  queryCountyParcelSubdivisionField,
  resolveNeighborhood,
  sanitizeCandidateName,
} from '../research/neighborhood-resolution.mjs';

const invalidPatterns = [/find my neighborhood/i, /what neighborhood am i in/i];

// ── each resolver in isolation ─────────────────────────────────────────

// Real Wake County PROPDESC fixtures (output/parcel/*.json, 2026-08-12 runs).
assert.equal(parseSubdivisionFromLegalDescription('LO14 WHEELER WOODS BM2016 -00958'), 'WHEELER WOODS');
assert.equal(parseSubdivisionFromLegalDescription('LO440 BRIGHTON FOREST PH4-A BM2008 -00642'), 'BRIGHTON FOREST');
assert.equal(parseSubdivisionFromLegalDescription(''), null);
assert.equal(parseSubdivisionFromLegalDescription(null), null);
assert.equal(parseSubdivisionFromLegalDescription('not a legal description'), null);

assert.equal(extractStreetHeuristicName('8121 Wheeler Woods Dr'), 'Wheeler Woods');
assert.equal(extractStreetHeuristicName('2201 Newleaf Drive'), 'Newleaf');
assert.equal(extractStreetHeuristicName('141 Main St'), 'Main', 'single-word residuals are kept -- many NC subdivisions are one word -- but this resolver is lowest-confidence and cross-checked against other sources');
assert.equal(extractStreetHeuristicName(''), null);

assert.equal(sanitizeCandidateName('Wheeler Woods HOA', invalidPatterns), 'Wheeler Woods');
assert.equal(sanitizeCandidateName('  ', invalidPatterns), null);
assert.equal(sanitizeCandidateName('Find my neighborhood - Map my location', invalidPatterns), null);
assert.equal(sanitizeCandidateName(null, invalidPatterns), null);

console.log('test-neighborhood-resolution: individual resolvers OK');

// ── the real Wake registry has no subdivision field -- this resolver must
// skip without ever making a network call, not silently return null after
// trying. ─────────────────────────────────────────────────────────────

{
  const registry = YAML.parse(readFileSync(join(ROOT, 'config', 'county-arcgis-registry.yml'), 'utf8'));
  assert.ok(registry.counties.wake.parcelLayer.url, 'fixture premise: Wake has a parcel layer configured');
  assert.equal(registry.counties.wake.parcelLayer.fields.subdivision, undefined, 'fixture premise: Wake\'s layer fields carry no subdivision attribute (verified live)');

  let called = false;
  const arcgisQueryImpl = async () => { called = true; return { ok: true, features: [] }; };
  const outcome = await queryCountyParcelSubdivisionField(
    { county: 'Wake County, NC', parcel: { parcelId: '0679591375' } },
    { registry, arcgisQueryImpl },
  );
  assert.equal(outcome.skipped, true);
  assert.equal(called, false, 'no network call should fire when the registry maps no subdivision field');
}

// If a county registry DOES map a subdivision field, the resolver queries it.
{
  const registry = { counties: { wake: { parcelLayer: { url: 'https://example/0', fields: { parcelId: 'PIN_NUM', subdivision: 'SUBDIVISION_NAME' } } } } };
  const arcgisQueryImpl = async (url, opts) => {
    assert.match(opts.where, /PIN_NUM='0679591375'/);
    return { ok: true, features: [{ attributes: { SUBDIVISION_NAME: 'Wheeler Woods' } }] };
  };
  const outcome = await queryCountyParcelSubdivisionField(
    { county: 'Wake County, NC', parcel: { parcelId: '0679591375' } },
    { registry, arcgisQueryImpl },
  );
  assert.deepEqual(outcome, { ok: true, value: 'Wheeler Woods' });
}

console.log('test-neighborhood-resolution: county-parcel-layer resolver OK');

// ── first-confident-match-wins ordering ──────────────────────────────

{
  const target = { address: '8121 Wheeler Woods Dr', city: 'Apex', state: 'NC' };
  const parcelSidecar = { county: 'Wake County, NC', parcel: { legalDescription: 'LO14 WHEELER WOODS BM2016 -00958', parcelId: '0679591375' } };
  const listingSidecar = { communityName: 'Some Other Name' };
  const hoaSidecar = { hoa: { communityName: 'Yet Another Name' } };

  const result = await resolveNeighborhood(target, { parcelSidecar, listingSidecar, hoaSidecar, invalidPatterns });
  assert.equal(result.resolvedVia, 'parcel-legal-description', 'the highest-priority matched source must win even when lower-priority sources also matched');
  assert.equal(result.community, 'WHEELER WOODS');
  assert.equal(result.disagreement, true, 'three genuinely different names among the tried candidates must be flagged as a conflict');
  assert.equal(result.confidence, 'low', 'a disagreement must lower confidence even though a winner was chosen');
  assert.equal(result.candidates.length, 4, 'parcel, listing, hoa, and street-heuristic are all free and must all be tried, even though parcel already won');
  const bySource = Object.fromEntries(result.candidates.map((c) => [c.source, c]));
  assert.equal(bySource['county-parcel-layer'], undefined, 'a costed resolver must not run once a free-tier source already won');
}

console.log('test-neighborhood-resolution: priority ordering OK');

// ── agreement means no disagreement flag ─────────────────────────────

{
  const target = { address: '8121 Wheeler Woods Dr', city: 'Apex', state: 'NC' };
  const parcelSidecar = { county: 'Wake County, NC', parcel: { legalDescription: 'LO14 WHEELER WOODS BM2016 -00958' } };
  const hoaSidecar = { hoa: { communityName: 'Wheeler Woods' } };
  const result = await resolveNeighborhood(target, { parcelSidecar, hoaSidecar, invalidPatterns });
  assert.equal(result.disagreement, false);
  assert.equal(result.confidence, 'high');
}

// ── full-chain failure: no local source resolves, only mapdevelopers does ──

{
  const target = { address: '100 Court', city: 'Apex', state: 'NC' };
  let overpassCalled = false;
  let mapdevelopersCalled = false;
  const overpassQueryImpl = async () => { overpassCalled = true; return { ok: true, value: null }; };
  const mapdevelopersQueryImpl = async () => { mapdevelopersCalled = true; return { ok: true, value: 'Old Apex Village' }; };

  const result = await resolveNeighborhood(target, {
    invalidPatterns, overpassQueryImpl, mapdevelopersQueryImpl,
  });
  assert.equal(overpassCalled, true, 'osm must be tried once local sources are exhausted');
  assert.equal(mapdevelopersCalled, true, 'mapdevelopers must still be tried as the last resort');
  assert.equal(result.resolvedVia, 'mapdevelopers');
  assert.equal(result.community, 'Old Apex Village');
}

// ── genuine full-chain failure: nothing resolves anywhere ────────────

{
  const target = { address: '100 Court', city: 'Apex', state: 'NC' };
  const overpassQueryImpl = async () => ({ ok: true, value: null });
  const result = await resolveNeighborhood(target, { invalidPatterns, overpassQueryImpl });
  assert.equal(result.community, null);
  assert.equal(result.resolvedVia, null);
  assert.equal(result.confidence, null);
  assert.ok(result.candidates.length > 0, 'every attempted resolver must still be recorded even when nothing matched');
}

// A source that could not be reached is recorded distinctly from one that
// legitimately returned nothing (non-negotiable rule 2).
{
  const target = { address: '100 Court', city: 'Apex', state: 'NC' };
  const overpassQueryImpl = async () => ({ ok: false, error: 'HTTP 504' });
  const result = await resolveNeighborhood(target, { invalidPatterns, overpassQueryImpl });
  const osm = result.candidates.find((c) => c.source === 'osm-overpass');
  assert.equal(osm.status, 'blocked');
  assert.equal(osm.error, 'HTTP 504');
}

console.log('test-neighborhood-resolution: full-chain escalation and blocked-vs-empty OK');

// ── Task 2.2: subdivision hints come from sidecars, not just report prose ──
// extractSubdivisionHints() used to read only report markdown, which is
// circular -- the report is written before capture runs. It must now find
// the resolved community even when the report body says nothing about it.
// Scratch fixture files are written into output/ (the real sidecar
// directories, since the reader is not path-injectable) under a throwaway
// slug and removed in `finally`, per the data contract: scratch never lives
// alongside durable output/ data.

{
  const scratchSlug = '999-test-sidecar-ct-apex-nc';
  const dirs = ['communities', 'parcel'].map((kind) => join(ROOT, 'output', kind));
  const files = dirs.map((dir) => join(dir, `${scratchSlug}.json`));
  try {
    for (const dir of dirs) mkdirSync(dir, { recursive: true });
    writeFileSync(files[0], JSON.stringify({ community: 'Test Meadows' }), 'utf8');
    writeFileSync(files[1], JSON.stringify({ parcel: { legalDescription: 'LO9 TEST MEADOWS BM2020 -00001' } }), 'utf8');

    const report = {
      address: '999 Test Sidecar Ct', city: 'Apex', state: 'NC',
      manualSubdivisionHint: '', sections: { 'Quick Take': '', 'Neighborhood Sentiment': '', 'Development and Infrastructure': '' },
    };
    const hints = extractSubdivisionHints(report);
    assert.ok(hints.includes('Test Meadows'), `resolved community sidecar must seed a hint, got ${JSON.stringify(hints)}`);
    assert.ok(hints.includes('TEST MEADOWS'), `parcel legal-description subdivision must also seed a hint, got ${JSON.stringify(hints)}`);
  } finally {
    for (const file of files) rmSync(file, { force: true });
  }
}

// A report with no sidecars on disk yet must fall through to prose (or
// nothing) without erroring.
{
  const report = {
    address: '1 Nonexistent Sidecar Way', city: 'Apex', state: 'NC',
    manualSubdivisionHint: '', sections: { 'Quick Take': '', 'Neighborhood Sentiment': '', 'Development and Infrastructure': '' },
  };
  assert.deepEqual(extractSubdivisionHints(report), []);
}

console.log('test-neighborhood-resolution: sidecar-seeded subdivision hints OK');
console.log('test-neighborhood-resolution: all assertions passed');
