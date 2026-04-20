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
