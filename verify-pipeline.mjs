#!/usr/bin/env node

/**
 * verify-pipeline.mjs -- Health check for the home-ops listing pipeline.
 *
 * Checks:
 * 1. All statuses are canonical per templates/states.yml
 * 2. No duplicate address + city rows exist
 * 3. All report links point to existing files
 * 4. Scores match X.X/5 or N/A
 * 5. Listing rows use the expected 11-column table format
 * 6. Pending TSV additions are surfaced
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LISTINGS_FILE = join(ROOT, 'data', 'listings.md');
const PIPELINE_FILE = join(ROOT, 'data', 'pipeline.md');
const ADDITIONS_DIR = join(ROOT, 'batch', 'tracker-additions');
const STATES_FILE = join(ROOT, 'templates', 'states.yml');

let errors = 0;
let warnings = 0;

function fail(message) {
  console.log(`❌ ${message}`);
  errors += 1;
}

function warn(message) {
  console.log(`⚠️  ${message}`);
  warnings += 1;
}

function ok(message) {
  console.log(`✅ ${message}`);
}

function readCanonicalStatuses() {
  const defaults = ['New', 'Evaluated', 'Interested', 'Tour Scheduled', 'Toured', 'Offer Submitted', 'Under Contract', 'Closed', 'Passed', 'Sold', 'SKIP'];
  if (!existsSync(STATES_FILE)) {
    warn('templates/states.yml not found, using fallback status list');
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

function normalizeStreetSuffixes(value) {
  return value
    .replace(/\bst\b/g, 'street')
    .replace(/\brd\b/g, 'road')
    .replace(/\bave\b/g, 'avenue')
    .replace(/\bblvd\b/g, 'boulevard')
    .replace(/\bdr\b/g, 'drive')
    .replace(/\bln\b/g, 'lane')
    .replace(/\bct\b/g, 'court')
    .replace(/\bcir\b/g, 'circle')
    .replace(/\bpkwy\b/g, 'parkway')
    .replace(/\bpl\b/g, 'place')
    .replace(/\bhwy\b/g, 'highway');
}

function normalizeAddress(value) {
  return normalizeStreetSuffixes(value.toLowerCase())
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCity(value) {
  return value.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
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

  return {
    num,
    date: columns[1],
    address: columns[2],
    city: columns[3],
    price: columns[4],
    bedsBaths: columns[5],
    sqft: columns[6],
    score: columns[7],
    status: columns[8],
    report: columns[9],
    notes: columns[10] || '',
  };
}

const canonicalStatuses = new Set(readCanonicalStatuses().map((value) => value.toLowerCase()));

if (!existsSync(LISTINGS_FILE)) {
  console.log('\n📊 No data/listings.md found. This is normal for a fresh setup.\n');
  process.exit(0);
}

const listingContent = readFileSync(LISTINGS_FILE, 'utf-8');
const listingLines = listingContent.split('\n');
const entries = [];

for (const line of listingLines) {
  const entry = parseListingRow(line);
  if (entry) {
    entries.push(entry);
  }
}

console.log(`\n📊 Checking ${entries.length} entries in data/listings.md\n`);

let malformedRows = 0;
for (const line of listingLines) {
  if (!line.startsWith('|') || line.includes('---') || line.includes('| # |')) {
    continue;
  }
  const columns = line.split('|').map((value) => value.trim()).filter(Boolean);
  if (columns.length !== 11) {
    fail(`Malformed tracker row: ${line.slice(0, 100)}${line.length > 100 ? '...' : ''}`);
    malformedRows += 1;
  }
}
if (malformedRows === 0) {
  ok('All listing rows use the expected 11-column format');
}

let badStatuses = 0;
for (const entry of entries) {
  const clean = entry.status.replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim().toLowerCase();
  if (!canonicalStatuses.has(clean)) {
    fail(`#${entry.num}: Non-canonical status "${entry.status}"`);
    badStatuses += 1;
  }
  if (entry.status.includes('**')) {
    fail(`#${entry.num}: Status contains markdown bold`);
    badStatuses += 1;
  }
}
if (badStatuses === 0) {
  ok('All statuses are canonical');
}

const duplicateMap = new Map();
let duplicates = 0;
for (const entry of entries) {
  const key = `${normalizeAddress(entry.address)}::${normalizeCity(entry.city)}`;
  if (!duplicateMap.has(key)) {
    duplicateMap.set(key, []);
  }
  duplicateMap.get(key).push(entry);
}

for (const [, group] of duplicateMap) {
  if (group.length > 1) {
    duplicates += 1;
    warn(`Possible duplicates: ${group.map((entry) => `#${entry.num}`).join(', ')} (${group[0].address}, ${group[0].city})`);
  }
}
if (duplicates === 0) {
  ok('No duplicate address + city rows found');
}

let brokenReports = 0;
for (const entry of entries) {
  const match = entry.report.match(/\]\(([^)]+)\)/);
  if (!match) {
    fail(`#${entry.num}: Invalid report link format`);
    brokenReports += 1;
    continue;
  }
  const reportPath = join(ROOT, match[1]);
  if (!existsSync(reportPath)) {
    fail(`#${entry.num}: Missing report file ${match[1]}`);
    brokenReports += 1;
  }
}
if (brokenReports === 0) {
  ok('All report links resolve to files');
}

let badScores = 0;
for (const entry of entries) {
  const value = entry.score.replace(/\*\*/g, '').trim();
  if (!/^\d+(?:\.\d+)?\/5$/.test(value) && value !== 'N/A') {
    fail(`#${entry.num}: Invalid score format "${entry.score}"`);
    badScores += 1;
  }
}
if (badScores === 0) {
  ok('All scores use a valid format');
}

if (existsSync(PIPELINE_FILE)) {
  const pipeline = readFileSync(PIPELINE_FILE, 'utf-8');
  if (pipeline.includes('## Pending') && pipeline.includes('## Processed')) {
    ok('Pipeline file has Pending and Processed sections');
  } else {
    warn('data/pipeline.md does not contain the expected Pending and Processed sections');
  }
}

const pendingTsvs = existsSync(ADDITIONS_DIR)
  ? readdirSync(ADDITIONS_DIR).filter((file) => file.endsWith('.tsv')).length
  : 0;

if (pendingTsvs > 0) {
  warn(`${pendingTsvs} pending TSV addition(s) found in batch/tracker-additions/`);
} else {
  ok('No pending TSV additions found');
}

console.log(`\n${'='.repeat(50)}`);
console.log(`📊 Pipeline Health: ${errors} errors, ${warnings} warnings`);
if (errors === 0 && warnings === 0) {
  console.log('🟢 Pipeline is clean');
} else if (errors === 0) {
  console.log('🟡 Pipeline is usable with warnings');
} else {
  console.log('🔴 Pipeline has errors that should be fixed');
}

process.exit(errors > 0 ? 1 : 0);
