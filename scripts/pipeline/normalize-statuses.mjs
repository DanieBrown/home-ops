#!/usr/bin/env node

/**
 * normalize-statuses.mjs -- Normalize listing statuses in data/listings.md.
 *
 * Strips markdown, fixes aliases, removes dates from the status cell, and
 * maps non-canonical real-estate workflow labels onto templates/states.yml.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LISTINGS_FILE = join(ROOT, 'data', 'listings.md');
const STATES_FILE = join(ROOT, 'templates', 'states.yml');
const DRY_RUN = process.argv.includes('--dry-run');

function readCanonicalStatuses() {
  const defaults = ['New', 'Evaluated', 'Interested', 'Tour Scheduled', 'Toured', 'Offer Submitted', 'Under Contract', 'Closed', 'Passed', 'Sold', 'SKIP'];
  if (!existsSync(STATES_FILE)) {
    return defaults;
  }

  const labels = [];
  const content = readFileSync(STATES_FILE, 'utf-8');
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*label:\s*(.+)$/);
    if (match) {
      labels.push(match[1].trim().replace(/^['"]|['"]$/g, ''));
    }
  }
  return labels.length > 0 ? labels : defaults;
}

const canonicalStatuses = readCanonicalStatuses();
const canonicalLookup = new Map(canonicalStatuses.map((label) => [label.toLowerCase(), label]));

function normalizeStatus(raw) {
  const stripped = raw.replace(/\*\*/g, '').trim();
  const clean = stripped.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  const lower = clean.toLowerCase();

  if (!clean || clean === '-' || clean === '—') {
    return { status: 'SKIP' };
  }

  if (canonicalLookup.has(lower)) {
    return { status: canonicalLookup.get(lower) };
  }

  const aliases = {
    discovered: 'New',
    scraped: 'New',
    favorite: 'Interested',
    shortlist: 'Interested',
    shortlisted: 'Interested',
    watchlist: 'Interested',
    showing: 'Tour Scheduled',
    scheduled: 'Tour Scheduled',
    viewing: 'Tour Scheduled',
    toured: 'Toured',
    visited: 'Toured',
    seen: 'Toured',
    offered: 'Offer Submitted',
    bid: 'Offer Submitted',
    'offer sent': 'Offer Submitted',
    pending: 'Under Contract',
    contract: 'Under Contract',
    'under contract': 'Under Contract',
    purchased: 'Closed',
    bought: 'Closed',
    closed: 'Closed',
    declined: 'Passed',
    rejected: 'Passed',
    'not interested': 'Passed',
    not_interested: 'Passed',
    sold: 'Sold',
    expired: 'Sold',
    delisted: 'Sold',
    unavailable: 'Sold',
    withdrawn: 'Sold',
    'off market': 'Sold',
    off_market: 'Sold',
    filtered: 'SKIP',
    'no fit': 'SKIP',
    no_fit: 'SKIP',
    skip: 'SKIP',
  };

  if (aliases[lower]) {
    return { status: aliases[lower] };
  }

  if (/duplicado|duplicate|repost/i.test(lower)) {
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
