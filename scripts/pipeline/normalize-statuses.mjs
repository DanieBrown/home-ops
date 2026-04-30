#!/usr/bin/env node

/**
 * normalize-statuses.mjs -- Normalize listing statuses in data/listings.md.
 *
 * Strips markdown, fixes aliases, removes dates from the status cell, and
 * maps non-canonical real-estate workflow labels onto templates/states.yml.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';

import { buildCanonicalLookup, readCanonicalStatuses, normalizeStatus as resolveStatus } from '../shared/states.mjs';
import { LISTINGS_FILE, STATES_FILE } from '../shared/paths.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

const canonicalStatuses = readCanonicalStatuses(STATES_FILE);
const canonicalLookup = buildCanonicalLookup(canonicalStatuses);

function normalizeStatus(raw) {
  const clean = String(raw ?? '')
    .replace(/\*\*/g, '')
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '')
    .trim();

  if (!clean || clean === '-' || clean === '—') {
    return { status: 'SKIP' };
  }

  const resolved = resolveStatus(raw, canonicalLookup);
  if (resolved) return { status: resolved };

  if (/duplicado|duplicate|repost/i.test(clean.toLowerCase())) {
    return { status: 'SKIP', moveToNotes: raw.trim() };
  }

  return { status: null, unknown: true };
}

function parseListingRow(line) {
  const columns = line.split('|').map((value) => value.trim()).filter(Boolean);
  if (columns.length !== 11) {
    return null;
  }

  const num = Number.parseInt(columns[0], 10);
  if (Number.isNaN(num)) {
    return null;
  }

  return { num, columns };
}

function serializeColumns(columns) {
  return `| ${columns.join(' | ')} |`;
}

if (!existsSync(LISTINGS_FILE)) {
  console.log('No data/listings.md found. Nothing to normalize.');
  process.exit(0);
}

const lines = readFileSync(LISTINGS_FILE, 'utf-8').split('\n');
let changes = 0;
const unknowns = [];

for (let index = 0; index < lines.length; index += 1) {
  const row = parseListingRow(lines[index]);
  if (!row) {
    continue;
  }

  const { num, columns } = row;
  const rawStatus = columns[8];
  const result = normalizeStatus(rawStatus);

  if (result.unknown) {
    unknowns.push({ num, rawStatus, line: index + 1 });
    continue;
  }

  const nextStatus = result.status;
  const nextScore = columns[7].replace(/\*\*/g, '');
  let nextNotes = columns[10] || '';

  if (result.moveToNotes && !nextNotes.toLowerCase().includes(result.moveToNotes.toLowerCase())) {
    nextNotes = result.moveToNotes + (nextNotes ? `. ${nextNotes}` : '');
  }

  if (nextStatus === columns[8] && nextScore === columns[7] && nextNotes === columns[10]) {
    continue;
  }

  columns[7] = nextScore;
  columns[8] = nextStatus;
  columns[10] = nextNotes;
  lines[index] = serializeColumns(columns);
  changes += 1;

  console.log(`#${num}: "${rawStatus}" -> "${nextStatus}"`);
}

if (unknowns.length > 0) {
  console.log(`\n⚠️  ${unknowns.length} unknown status value(s):`);
  unknowns.forEach((entry) => {
    console.log(`  #${entry.num} (line ${entry.line}): "${entry.rawStatus}"`);
  });
}

console.log(`\n📊 ${changes} status value(s) normalized`);

if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
  process.exit(0);
}

if (changes > 0) {
  copyFileSync(LISTINGS_FILE, `${LISTINGS_FILE}.bak`);
  writeFileSync(LISTINGS_FILE, lines.join('\n'));
  console.log('✅ Written to data/listings.md (backup: data/listings.md.bak)');
} else {
  console.log('✅ No changes needed');
}
