#!/usr/bin/env node

/**
 * test-sentiment-provenance.mjs -- Phase 1 of the sentiment-capture goal
 * prompt: the stale query-field fix, and that every profile-enabled
 * sentiment source always surfaces a record (captured, skipped, or
 * not-attempted), never silent disappearance. No network.
 */

import assert from 'node:assert/strict';
import { pairSearchUrlsWithQueries } from '../research/sentiment-public-extract.mjs';
import { SUPPORTED_BROWSER_SOURCES, selectBrowserSourceEntries } from '../research/sentiment-browser-extract.mjs';
import { buildSentimentSourcePlan } from '../research/research-utils.mjs';
import { evaluateCoverage } from '../research/sentiment-doctor.mjs';

// ── Task 1.1: each queryResults[] entry names the query that produced it ──
// Recorded two-query fixture: Google Maps search URLs are path-based
// (https://www.google.com/maps/search/<encoded>), so they carry no ?q=
// parameter. Before the fix, every entry fell back to queries[0].

{
  const urls = [
    'https://www.google.com/maps/search/West%20Lake%20Elementary',
    'https://www.google.com/maps/search/Apex%20neighborhood',
  ];
  const queries = ['West Lake Elementary', 'Apex neighborhood'];
  const pairs = pairSearchUrlsWithQueries(urls, queries);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].query, 'West Lake Elementary', 'entry 1 must keep its own query');
  assert.equal(pairs[1].query, 'Apex neighborhood', 'entry 2 must not inherit entry 1\'s query');
}

// A URL that does encode ?q=/&query= still wins over positional inference.
{
  const urls = ['https://example.com/search?q=Explicit%20Query'];
  const queries = ['Positional Query'];
  const pairs = pairSearchUrlsWithQueries(urls, queries);
  assert.equal(pairs[0].query, 'Explicit Query');
}

// Fewer urls than queries: still pairs positionally, never crashes.
{
  const pairs = pairSearchUrlsWithQueries(['https://x/search/A'], ['A', 'B', 'C']);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].query, 'A');
}

console.log('test-sentiment-provenance: query-per-result pairing OK');

// ── Task 1.2: every profile-enabled browser source reaches the capture loop ──

{
  const context = {
    profile: {},
    portals: {
      sentiment_sources: {
        google_maps: { login_required: false },
        facebook: { base_url: 'https://www.facebook.com/', login_required: true },
        nextdoor: { base_url: 'https://nextdoor.com/', login_required: true },
        twitter: { base_url: 'https://x.com/', login_required: true },
      },
    },
    generatedDevelopmentSources: null,
    generatedStateSources: null,
    generatedUtilitySources: null,
  };
  const report = {
    address: '1 Test Provenance Ct',
    city: 'Apex',
    state: 'NC',
    sections: {},
    manualCountyHint: '',
    manualSubdivisionHint: '',
  };

  const plan = buildSentimentSourcePlan(report, context);
  const byKey = Object.fromEntries(plan.entries.map((entry) => [entry.key, entry]));
  assert.equal(byKey.facebook.browserSupported, true);
  assert.equal(byKey.nextdoor.browserSupported, true);
  assert.equal(byKey.twitter.browserSupported, true, 'twitter must be marked browser-supported, or it never reaches the capture loop');
  assert.equal(byKey.google_maps.browserSupported, false, 'google_maps stays public-extractor-only');

  assert.ok(SUPPORTED_BROWSER_SOURCES.has('twitter'));
  const selected = selectBrowserSourceEntries(plan.entries).map((entry) => entry.key).sort();
  assert.deepEqual(selected, ['facebook', 'nextdoor', 'twitter'], 'every browser-supported source must reach the capture loop, including twitter');
}

console.log('test-sentiment-provenance: twitter reaches the browser capture loop OK');

// ── Task 1.3/1.4: the diagnostic surfaces exactly which field caused a skip ──
// and flags when the stored packet plan disagrees with captured coverage.

{
  const context = {
    profile: { research_sources: { sentiment: { google_maps: true, facebook: true, nextdoor: true, twitter: true } } },
    portals: {
      sentiment_sources: {
        google_maps: { login_required: false },
        facebook: { base_url: 'https://www.facebook.com/', login_required: true },
        nextdoor: { base_url: 'https://nextdoor.com/', login_required: true },
        twitter: { base_url: 'https://x.com/', login_required: true },
      },
    },
    generatedDevelopmentSources: null,
    generatedStateSources: null,
    generatedUtilitySources: null,
  };
  const target = {
    address: '8121 Wheeler Woods Dr', city: 'Apex', state: 'NC', sections: {},
    manualCountyHint: '', manualSubdivisionHint: '',
  };

  // Fixture mirrors the real 2026-08-12 Wheeler Woods run: community lookup
  // failed, facebook/nextdoor recorded the skip, twitter recorded nothing at
  // all, google_maps captured. The packet's stored plan (built before the
  // capture ran) still lists all 4 sources.
  const sentimentSidecar = {
    sources: [
      { key: 'facebook', queryResults: [{ status: 'no-community-match', reason: 'community lookup did not produce a valid neighborhood; browser searches skipped' }] },
      { key: 'nextdoor', queryResults: [{ status: 'no-community-match', reason: 'community lookup did not produce a valid neighborhood; browser searches skipped' }] },
      { key: 'google_maps', queryResults: [{ status: 'ok', snippets: [{ text: 'quiet street' }] }] },
    ],
  };
  const communitySidecar = { status: 'no-community-match', community: null };
  const packetSidecar = {
    sourcePlans: { sentiment: { entries: [{ key: 'google_maps' }, { key: 'facebook' }, { key: 'nextdoor' }, { key: 'twitter' }] } },
    sentimentEvidence: { coverageSummary: { configuredSources: 3 } },
  };

  const result = evaluateCoverage(target, context, 'test-wheeler-woods-fixture', {
    sentimentSidecar, communitySidecar, packetSidecar,
  });

  const byKey = Object.fromEntries(result.rows.map((row) => [row.key, row]));
  assert.equal(byKey.twitter.attempted, false, 'twitter must show as not attempted');
  assert.match(byKey.twitter.upstreamField, /sources\[\] \(key "twitter" absent\)/, 'the diagnostic must name the exact field that would hold the missing record');
  assert.equal(byKey.facebook.status, 'no-community-match');
  assert.match(byKey.facebook.upstreamField, /output\/communities\/.*status="no-community-match"/, 'a community-gated skip must point at the community sidecar that caused it');
  assert.equal(byKey.google_maps.status, 'captured');
  assert.equal(byKey.google_maps.snippetCount, 1);

  assert.equal(result.consistency.planEntryCount, 4);
  assert.equal(result.consistency.capturedCount, 3);
  assert.equal(result.consistency.packetPlanVsCoverageMismatch, true, 'a planned-but-never-captured source must be flagged as a mismatch');
}

// A source with no evidence, but that WAS captured, must never be confused
// with one that was never attempted (rule 2: evidenceCount 0 is a finding,
// not silence).
{
  const context = {
    profile: { research_sources: { sentiment: { google_maps: true } } },
    portals: { sentiment_sources: { google_maps: { login_required: false } } },
    generatedDevelopmentSources: null, generatedStateSources: null, generatedUtilitySources: null,
  };
  const target = { address: '2 Quiet Cul-de-sac', city: 'Apex', state: 'NC', sections: {}, manualCountyHint: '', manualSubdivisionHint: '' };
  const sentimentSidecar = { sources: [{ key: 'google_maps', queryResults: [{ status: 'empty' }] }] };

  const result = evaluateCoverage(target, context, 'test-quiet-fixture', {
    sentimentSidecar, communitySidecar: null, packetSidecar: null,
  });
  const googleMaps = result.rows.find((row) => row.key === 'google_maps');
  assert.equal(googleMaps.attempted, true, 'a captured-but-empty source is attempted, not missing');
  assert.equal(googleMaps.status, 'empty');
  assert.equal(googleMaps.snippetCount, 0);
}

console.log('test-sentiment-provenance: diagnostic field attribution OK');
console.log('test-sentiment-provenance: all assertions passed');
