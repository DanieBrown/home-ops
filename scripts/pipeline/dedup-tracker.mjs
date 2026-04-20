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

import { normalizeAddress, normalizeCity } from '../shared/text-utils.mjs';
import {
  STATUS_RANK,
  chooseBetterStatus,
  mergeNotes,
  parseListingRow,
  parseScore,
  serializeListing,
} from '../shared/listings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LISTINGS_FILE = join(ROOT, 'data', 'listings.md');
const DRY_RUN = process.argv.includes('--dry-run');

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
