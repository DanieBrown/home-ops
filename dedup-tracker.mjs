#!/usr/bin/env node

/**
 * dedup-tracker.mjs -- Remove duplicate rows from data/listings.md.
 *
 * Duplicate identity is normalized address + city.
 * The keeper row preserves the most advanced status while also retaining
 * the highest score and merged notes.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LISTINGS_FILE = join(ROOT, 'data', 'listings.md');
const DRY_RUN = process.argv.includes('--dry-run');

const STATUS_RANK = {
  'new': 0,
  'evaluated': 1,
  'passed': 1,
  'skip': 0,
  'interested': 2,
  'tour scheduled': 3,
  'toured': 4,
  'offer submitted': 5,
  'under contract': 6,
  'closed': 7,
  'sold': 7,
};

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

function parseScore(value) {
  const match = value.replace(/\*\*/g, '').match(/([\d.]+)/);
  return match ? Number.parseFloat(match[1]) : 0;
}

function mergeNotes(...values) {
  const seen = new Set();
  const merged = [];

  values
    .flatMap((value) => (value || '').split(/\s*\.\s*/))
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      merged.push(value);
    });

  return merged.join('. ');
}

function chooseBetterStatus(left, right) {
  const leftRank = STATUS_RANK[left.toLowerCase()] ?? 0;
  const rightRank = STATUS_RANK[right.toLowerCase()] ?? 0;
  return rightRank > leftRank ? right : left;
}

function parseListingRow(line, lineIndex = -1) {
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
    lineIndex,
  };
}

function serializeListing(entry) {
  return `| ${entry.num} | ${entry.date} | ${entry.address} | ${entry.city} | ${entry.price} | ${entry.bedsBaths} | ${entry.sqft} | ${entry.score} | ${entry.status} | ${entry.report} | ${entry.notes} |`;
}

if (!existsSync(LISTINGS_FILE)) {
  console.log('No data/listings.md found. Nothing to deduplicate.');
  process.exit(0);
}

const lines = readFileSync(LISTINGS_FILE, 'utf-8').split('\n');
const entries = [];
for (let index = 0; index < lines.length; index += 1) {
  const entry = parseListingRow(lines[index], index);
  if (entry) {
    entries.push(entry);
  }
}

console.log(`📊 ${entries.length} listing rows loaded`);

const groups = new Map();
for (const entry of entries) {
  const key = `${normalizeAddress(entry.address)}::${normalizeCity(entry.city)}`;
  if (!groups.has(key)) {
    groups.set(key, []);
  }
  groups.get(key).push(entry);
}

const linesToRemove = new Set();
let removed = 0;

for (const [, group] of groups) {
  if (group.length < 2) {
    continue;
  }

  const ranked = [...group].sort((left, right) => {
    const statusDelta = (STATUS_RANK[right.status.toLowerCase()] ?? 0) - (STATUS_RANK[left.status.toLowerCase()] ?? 0);
    if (statusDelta !== 0) {
      return statusDelta;
    }
    const scoreDelta = parseScore(right.score) - parseScore(left.score);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return right.num - left.num;
  });

  const keeper = { ...ranked[0] };
  const highestScoreEntry = [...group].sort((left, right) => parseScore(right.score) - parseScore(left.score))[0];

  keeper.score = highestScoreEntry.score;
  keeper.report = highestScoreEntry.report || keeper.report;
  keeper.status = group.reduce((best, entry) => chooseBetterStatus(best, entry.status), keeper.status);
  keeper.notes = mergeNotes(...group.map((entry) => entry.notes));
  keeper.date = [...group.map((entry) => entry.date)].sort().at(-1) || keeper.date;

  for (const entry of group) {
    if (!keeper.price && entry.price) keeper.price = entry.price;
    if (!keeper.bedsBaths && entry.bedsBaths) keeper.bedsBaths = entry.bedsBaths;
    if (!keeper.sqft && entry.sqft) keeper.sqft = entry.sqft;
  }

  lines[keeper.lineIndex] = serializeListing(keeper);

  for (const duplicate of group) {
    if (duplicate.num === keeper.num) {
      continue;
    }
    linesToRemove.add(duplicate.lineIndex);
    removed += 1;
    console.log(`🗑️  Remove #${duplicate.num} (${duplicate.address}, ${duplicate.city}) -> kept #${keeper.num}`);
  }
}

for (const index of [...linesToRemove].sort((left, right) => right - left)) {
  lines.splice(index, 1);
}

console.log(`\n📊 ${removed} duplicate row(s) removed`);

if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
  process.exit(0);
}

if (removed > 0) {
  copyFileSync(LISTINGS_FILE, `${LISTINGS_FILE}.bak`);
  writeFileSync(LISTINGS_FILE, lines.join('\n'));
  console.log('✅ Written to data/listings.md (backup: data/listings.md.bak)');
} else {
  console.log('✅ No duplicates found');
}
