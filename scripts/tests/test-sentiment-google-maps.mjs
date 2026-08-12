#!/usr/bin/env node

/**
 * test-sentiment-google-maps.mjs -- Phase 4 of the sentiment-capture goal
 * prompt: POI-targeted queries (Task 4.2) and mapping real review text onto
 * the scoring dimensions with a meaningful recency flag (Task 4.3). No
 * network -- the hosted-browser reviews path (Task 4.1) is Playwright-only
 * and is exercised manually against a live session, not here.
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../shared/paths.mjs';
import { buildSentimentSourcePlan } from '../research/research-utils.mjs';
import { classifySnippet, isRecent } from '../research/sentiment-public-extract.mjs';

// ── Task 4.2: Google Maps gets POI-targeted queries, not school names ──

{
  const scratchSlug = '77-poi-test-ct-apex-nc';
  const parcelDir = join(ROOT, 'output', 'parcel');
  const parcelFile = join(parcelDir, `${scratchSlug}.json`);
  try {
    mkdirSync(parcelDir, { recursive: true });
    writeFileSync(parcelFile, JSON.stringify({ parcel: { legalDescription: 'LO7 POI TEST BM2021 -00007' } }), 'utf8');

    const context = {
      profile: {},
      portals: {
        sentiment_sources: {
          google_maps: { login_required: false },
          facebook: { base_url: 'https://www.facebook.com/', login_required: true },
        },
      },
      generatedDevelopmentSources: null, generatedStateSources: null, generatedUtilitySources: null,
    };
    const report = {
      address: '77 Poi Test Ct', city: 'Apex', state: 'NC',
      manualSubdivisionHint: '', sections: { 'Quick Take': '', 'Neighborhood Sentiment': '', 'School Review': 'Assigned to West Lake Elementary.', 'Development and Infrastructure': '' },
    };

    const plan = buildSentimentSourcePlan(report, context);
    const byKey = Object.fromEntries(plan.entries.map((entry) => [entry.key, entry]));

    assert.ok(
      byKey.google_maps.recommendedQueries.some((q) => /POI TEST pool/i.test(q)),
      `expected an HOA-amenity query, got ${JSON.stringify(byKey.google_maps.recommendedQueries)}`,
    );
    assert.ok(
      byKey.google_maps.recommendedQueries.some((q) => /parks near/i.test(q)),
      'expected a parks/greenway query',
    );
    assert.ok(
      !byKey.google_maps.recommendedQueries.some((q) => /West Lake Elementary/i.test(q)),
      'Google Maps must not query school names -- schools attract almost no reviews',
    );

    // Facebook is unaffected by the Google-Maps-specific POI catalog and
    // still gets the generic query set, which does include the school.
    assert.ok(
      byKey.facebook.recommendedQueries.some((q) => /West Lake Elementary/i.test(q)),
      'the POI catalog must be Google-Maps-specific, not a global query-builder change',
    );
  } finally {
    rmSync(parcelFile, { force: true });
  }
}

console.log('test-sentiment-google-maps: POI-targeted query catalog OK');

// ── Fallback: a home with no subdivision or road hints still gets queries,
// never an empty search list. ──────────────────────────────────────────

{
  const context = {
    profile: {},
    portals: { sentiment_sources: { google_maps: { login_required: false } } },
    generatedDevelopmentSources: null, generatedStateSources: null, generatedUtilitySources: null,
  };
  const report = {
    address: '1 Unresolved Way', city: 'Apex', state: 'NC',
    manualSubdivisionHint: '', sections: { 'Quick Take': '', 'Neighborhood Sentiment': '', 'Development and Infrastructure': '' },
  };
  const plan = buildSentimentSourcePlan(report, context);
  const googleMaps = plan.entries.find((entry) => entry.key === 'google_maps');
  assert.ok(googleMaps.recommendedQueries.length > 0, 'a home with no local hints must still get a fallback query set, never silence');
}

console.log('test-sentiment-google-maps: no-hints fallback OK');

// ── Task 4.3: real review text maps onto the scoring dimensions with a
// meaningful recency flag ────────────────────────────────────────────────

{
  const trafficReview = 'Traffic on Laura Duncan Rd backs up every morning during school pickup. 3 days ago';
  const classified = classifySnippet(trafficReview);
  assert.ok(classified.categories.includes('traffic_commute'), 'a traffic complaint must map to traffic_commute');
  assert.ok(isRecent(trafficReview), 'a review dated "3 days ago" must be flagged recent');

  const staleReview = 'Nice quiet park, went there once. Visited 11 months ago';
  assert.equal(isRecent(staleReview), false, 'an 11-month-old review must not be flagged recent -- it is weak evidence about current conditions');

  const communityReview = 'Great community pool, the HOA runs fun block parties every summer. today';
  const communityClassified = classifySnippet(communityReview);
  assert.ok(communityClassified.categories.includes('community'), 'a pool/HOA/block-party review must map to community');
  assert.ok(communityClassified.positiveHits > 0);
}

console.log('test-sentiment-google-maps: review-text dimension mapping and recency OK');
console.log('test-sentiment-google-maps: all assertions passed');
