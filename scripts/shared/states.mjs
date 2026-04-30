/**
 * Shared canonical-status helpers.
 *
 * Reads templates/states.yml when available; falls back to a hard-coded list
 * that matches the bundled template so a fresh checkout still works before
 * the user customizes states.
 *
 * Alias maps and per-script normalization logic stay in their callers --
 * merge-tracker and normalize-statuses each apply different aliases on top
 * of the canonical lookup.
 */

import { existsSync, readFileSync } from 'fs';

export const DEFAULT_STATUSES = [
  'New',
  'Evaluated',
  'Interested',
  'Tour Scheduled',
  'Toured',
  'Offer Submitted',
  'Under Contract',
  'Closed',
  'Passed',
  'Sold',
  'SKIP',
];

export function readCanonicalStatuses(statesFile) {
  if (!existsSync(statesFile)) {
    return DEFAULT_STATUSES;
  }

  const labels = [];
  const content = readFileSync(statesFile, 'utf-8');
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*label:\s*(.+)$/);
    if (!match) {
      continue;
    }
    labels.push(match[1].trim().replace(/^['"]|['"]$/g, ''));
  }

  return labels.length > 0 ? labels : DEFAULT_STATUSES;
}

export function buildCanonicalLookup(labels) {
  return new Map(labels.map((label) => [label.toLowerCase(), label]));
}

// Unified alias map — union of all per-script alias maps previously in
// merge-tracker.mjs and normalize-statuses.mjs.
export const CANONICAL_ALIASES = new Map([
  ['discovered',      'New'],
  ['scraped',         'New'],
  ['favorite',        'Interested'],
  ['shortlist',       'Interested'],
  ['shortlisted',     'Interested'],
  ['watchlist',       'Interested'],
  ['showing',         'Tour Scheduled'],
  ['scheduled',       'Tour Scheduled'],
  ['viewing',         'Tour Scheduled'],
  ['toured',          'Toured'],
  ['visited',         'Toured'],
  ['seen',            'Toured'],
  ['offered',         'Offer Submitted'],
  ['bid',             'Offer Submitted'],
  ['offer sent',      'Offer Submitted'],
  ['pending',         'Under Contract'],
  ['contract',        'Under Contract'],
  ['under contract',  'Under Contract'],
  ['purchased',       'Closed'],
  ['bought',          'Closed'],
  ['closed',          'Closed'],
  ['declined',        'Passed'],
  ['rejected',        'Passed'],
  ['not interested',  'Passed'],
  ['not_interested',  'Passed'],
  ['sold',            'Sold'],
  ['expired',         'Sold'],
  ['delisted',        'Sold'],
  ['unavailable',     'Sold'],
  ['withdrawn',       'Sold'],
  ['off market',      'Sold'],
  ['off_market',      'Sold'],
  ['filtered',        'SKIP'],
  ['no fit',          'SKIP'],
  ['no_fit',          'SKIP'],
  ['skip',            'SKIP'],
]);

/**
 * Resolve a raw status cell value to a canonical label.
 * Strips markdown bold (**), trailing date suffixes, and leading/trailing whitespace.
 * Returns the canonical label string, or null if unrecognised.
 * Callers decide the fallback for null (e.g. default to 'Evaluated' or flag as unknown).
 */
export function normalizeStatus(raw, canonicalLookup) {
  const stripped = String(raw ?? '')
    .replace(/\*\*/g, '')
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '')
    .trim();
  const lower = stripped.toLowerCase();
  if (canonicalLookup.has(lower)) return canonicalLookup.get(lower);
  const aliased = CANONICAL_ALIASES.get(lower);
  if (aliased) return canonicalLookup.get(aliased.toLowerCase()) ?? aliased;
  return null;
}
