/**
 * parse-narrative.mjs -- Keyword-match buyer narrative text against the
 * feature-keywords.json map and produce structured profile additions.
 *
 * Input: { wants, avoids, notes } (any strings). Output:
 *   {
 *     features: [canonical phrase],
 *     deal_breakers: [canonical phrase],
 *     scan_keywords: [keyword strings to bias portal search],
 *     scan_negative_keywords: [terms to discourage],
 *     profile_fields: { ... merged profile flag overrides ... },
 *     matches: [{ phrase, matchedAlias, source }]
 *   }
 *
 * Matching is case-insensitive with word-boundary-ish guards. Aliases are
 * matched as whole phrases so "no hoa" in `avoids` does not trigger a
 * feature phrase.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const KEYWORDS_PATH = join(__dirname, 'feature-keywords.json');

let cachedMap = null;

function loadMap() {
  if (cachedMap) return cachedMap;
  cachedMap = JSON.parse(readFileSync(KEYWORDS_PATH, 'utf8'));
  return cachedMap;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasMatches(text, alias) {
  if (!text || !alias) return false;
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(alias.toLowerCase())}(?:[^a-z0-9]|$)`, 'i');
  return pattern.test(text);
}

function collectMatches(text, entries, sourceLabel) {
  const hits = [];
  if (!text) return hits;
  const lower = text.toLowerCase();
  for (const entry of entries) {
    const aliases = Array.isArray(entry.aliases) && entry.aliases.length > 0
      ? entry.aliases
      : [entry.phrase];
    for (const alias of aliases) {
      if (aliasMatches(lower, alias)) {
        hits.push({ entry, matchedAlias: alias, source: sourceLabel });
        break;
      }
    }
  }
  return hits;
}

function mergeArrays(target, values) {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (!target.includes(value)) target.push(value);
  }
}

function mergeProfileFields(target, fields) {
  if (!fields || typeof fields !== 'object') return;
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      const existing = Array.isArray(target[key]) ? target[key] : [];
      mergeArrays(existing, value);
      target[key] = existing;
      continue;
    }
    if (key === 'lot_min_acres_floor') {
      const existing = Number.isFinite(target.lot_min_acres_floor) ? target.lot_min_acres_floor : 0;
      target.lot_min_acres_floor = Math.max(existing, Number(value) || 0);
      continue;
    }
    target[key] = value;
  }
}

export function parseNarrative({ wants = '', avoids = '', notes = '' } = {}) {
  const map = loadMap();
  const featureEntries = Array.isArray(map.features) ? map.features : [];
  const dealBreakerEntries = Array.isArray(map.deal_breakers) ? map.deal_breakers : [];

  const wantsHits = [
    ...collectMatches(wants, featureEntries, 'wants'),
    ...collectMatches(notes, featureEntries, 'notes'),
  ];

  const avoidsHits = [
    ...collectMatches(avoids, dealBreakerEntries, 'avoids'),
    ...collectMatches(notes, dealBreakerEntries, 'notes'),
  ];

  const features = [];
  const dealBreakers = [];
  const scanKeywords = [];
  const scanNegativeKeywords = [];
  const profileFields = {};
  const matches = [];

  const seenFeatures = new Set();
  for (const hit of wantsHits) {
    const phrase = hit.entry.phrase;
    if (!seenFeatures.has(phrase)) {
      features.push(phrase);
      seenFeatures.add(phrase);
    }
    mergeArrays(scanKeywords, hit.entry.scan_keywords);
    mergeProfileFields(profileFields, hit.entry.profile_fields);
    matches.push({ phrase, matchedAlias: hit.matchedAlias, source: hit.source, kind: 'feature' });
  }

  const seenDealBreakers = new Set();
  for (const hit of avoidsHits) {
    const canonical = hit.entry.canonical ?? hit.entry.phrase;
    if (!seenDealBreakers.has(canonical)) {
      dealBreakers.push(canonical);
      seenDealBreakers.add(canonical);
    }
    mergeArrays(scanNegativeKeywords, hit.entry.scan_negative_keywords);
    mergeProfileFields(profileFields, hit.entry.profile_fields);
    matches.push({ phrase: canonical, matchedAlias: hit.matchedAlias, source: hit.source, kind: 'deal_breaker' });
  }

  return {
    features,
    deal_breakers: dealBreakers,
    scan_keywords: scanKeywords,
    scan_negative_keywords: scanNegativeKeywords,
    profile_fields: profileFields,
    matches,
  };
}
