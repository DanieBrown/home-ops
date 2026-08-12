#!/usr/bin/env node

/**
 * test-sentiment-tiers.mjs -- Phase 3 of the sentiment-capture goal prompt:
 * the specificity ladder. A missing subdivision must degrade precision, not
 * eliminate the dimension. No network.
 */

import assert from 'node:assert/strict';
import {
  buildBrowserSourceUrl,
  buildTierTerms,
  selectTier,
} from '../research/sentiment-browser-extract.mjs';
import {
  classifyProximity,
  DEFAULT_PROXIMITY_TIER_MULTIPLIERS,
  PROXIMITY_TIER_ORDER,
  resolveProximityTierMultipliers,
} from '../research/sentiment-scoring.mjs';

// ── tier order and multipliers ────────────────────────────────────────

assert.deepEqual(PROXIMITY_TIER_ORDER, ['subdivision', 'street', 'school-zone', 'municipal']);
assert.equal(DEFAULT_PROXIMITY_TIER_MULTIPLIERS.subdivision, 1.0);
assert.equal(DEFAULT_PROXIMITY_TIER_MULTIPLIERS.municipal > 0, true, 'municipal must be a real, nonzero multiplier -- it is the floor, never silence');

assert.deepEqual(
  resolveProximityTierMultipliers({ sentiment: { proximity_tiers: { subdivision: 1, street: 0.9, school_zone: 0.5, municipal: 0.2 } } }),
  { subdivision: 1, street: 0.9, 'school-zone': 0.5, municipal: 0.2 },
);
assert.deepEqual(resolveProximityTierMultipliers({}), DEFAULT_PROXIMITY_TIER_MULTIPLIERS, 'a profile with no override must fall back to the suggested ladder');

// ── classifyProximity walks the ladder, never returns silence when the
// city is known ─────────────────────────────────────────────────────────

{
  const hints = { subdivision: ['Wheeler Woods'], street: ['Laura Duncan Rd'], schoolZone: ['West Lake Elementary'], municipal: ['Apex'] };
  assert.equal(classifyProximity('Loved the Wheeler Woods pool party', hints).level, 'subdivision');
  assert.equal(classifyProximity('Laura Duncan Rd traffic is bad at 5pm', hints).level, 'street');
  assert.equal(classifyProximity('West Lake Elementary pickup line', hints).level, 'school-zone');
  assert.equal(classifyProximity('Apex is a great town', hints).level, 'municipal');
  assert.equal(classifyProximity('completely unrelated text', hints).level, 'none');
  assert.equal(classifyProximity('completely unrelated text', hints).multiplier, 0);
}

// A snippet matching both a subdivision hint and the city name is tagged at
// the more specific tier, not the weaker one.
{
  const hints = { subdivision: ['Wheeler Woods'], street: [], schoolZone: [], municipal: ['Apex'] };
  const result = classifyProximity('Wheeler Woods in Apex is quiet', hints);
  assert.equal(result.level, 'subdivision');
}

console.log('test-sentiment-tiers: classifyProximity ladder OK');

// ── buildTierTerms / selectTier: the browser-extract query-tier gate ───

{
  const target = { address: '8121 Wheeler Woods Dr', city: 'Apex', state: 'NC' };
  const sentimentPlan = { roadHints: ['Laura Duncan Rd'], schoolNames: ['West Lake Elementary'] };

  // Full resolution: subdivision wins.
  const full = buildTierTerms({ community: 'Wheeler Woods' }, sentimentPlan, target);
  assert.deepEqual(selectTier(full), { tier: 'subdivision', term: 'Wheeler Woods' });

  // Forced community-resolution failure (Definition of Done #3): street tier next.
  const noCommunity = buildTierTerms(null, sentimentPlan, target);
  assert.deepEqual(selectTier(noCommunity), { tier: 'street', term: 'Laura Duncan Rd' });

  // No road hint either: school-zone.
  const noRoad = buildTierTerms(null, { roadHints: [], schoolNames: ['West Lake Elementary'] }, target);
  assert.deepEqual(selectTier(noRoad), { tier: 'school-zone', term: 'West Lake Elementary' });

  // Nothing but the city: municipal is the floor, and it always exists.
  const nothing = buildTierTerms(null, { roadHints: [], schoolNames: [] }, target);
  assert.deepEqual(selectTier(nothing), { tier: 'municipal', term: 'Apex' });
  assert.notEqual(selectTier(nothing), null, 'municipal tier must always resolve when the target has a city -- this is the "never silence" guarantee');
}

console.log('test-sentiment-tiers: buildTierTerms/selectTier degrade through the ladder OK');

// ── Nextdoor is the one source that may still skip below subdivision ───

{
  const target = { address: '8121 Wheeler Woods Dr', city: 'Apex', state: 'NC' };
  const tierTerms = buildTierTerms(null, { roadHints: ['Laura Duncan Rd'], schoolNames: [] }, target);

  // Facebook/Twitter accept any tier, including street.
  assert.deepEqual(selectTier(tierTerms, { requireSubdivision: false }), { tier: 'street', term: 'Laura Duncan Rd' });

  // Nextdoor requires subdivision specifically -- street-tier data cannot
  // satisfy its neighborhood-feed URL, so it must report "no selection"
  // (the caller then records skipped-below-tier, not a bare no-community-match).
  assert.equal(selectTier(tierTerms, { requireSubdivision: true }), null);

  // Even with nothing but a city, Nextdoor still cannot degrade further.
  const cityOnly = buildTierTerms(null, { roadHints: [], schoolNames: [] }, target);
  assert.equal(selectTier(cityOnly, { requireSubdivision: true }), null);
}

console.log('test-sentiment-tiers: Nextdoor below-subdivision-tier gate OK');

// ── buildBrowserSourceUrl builds a real URL at every reachable tier ────

{
  assert.match(buildBrowserSourceUrl('nextdoor', 'subdivision', 'Wheeler Woods', 'Apex', 'NC'), /nextdoor\.com\/neighborhood\/wheelerwoods--apex--nc/);
  assert.equal(buildBrowserSourceUrl('nextdoor', 'street', 'Laura Duncan Rd', 'Apex', 'NC'), null, 'nextdoor has no URL shape below subdivision tier');

  const fbSubdivision = buildBrowserSourceUrl('facebook', 'subdivision', 'Wheeler Woods', 'Apex', 'NC');
  assert.match(decodeURIComponent(fbSubdivision), /Wheeler Woods neighborhood Apex/);

  const fbMunicipal = buildBrowserSourceUrl('facebook', 'municipal', 'Apex', 'Apex', 'NC');
  assert.doesNotMatch(decodeURIComponent(fbMunicipal), /Apex neighborhood Apex/, 'the municipal-tier query must not repeat the city name');

  const twitterMunicipal = buildBrowserSourceUrl('twitter', 'municipal', 'Apex', 'Apex', 'NC');
  assert.match(decodeURIComponent(twitterMunicipal), /q=Apex&/);
}

console.log('test-sentiment-tiers: buildBrowserSourceUrl per-tier URLs OK');
console.log('test-sentiment-tiers: all assertions passed');
