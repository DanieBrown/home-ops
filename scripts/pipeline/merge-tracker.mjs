#!/usr/bin/env node

/**
 * merge-tracker.mjs -- Merge batch tracker additions into data/listings.md.
 *
 * Supported formats:
 * - 11-column TSV: num, date, address, city, price, beds/baths, sqft, score, status, report, notes
 * - 11-column TSV with score/status swapped
 * - Markdown row using the listings table format
 *
 * Dedup strategy:
 * 1. Matching report number
 * 2. Matching tracker row number
 * 3. Matching normalized address + city
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { normalizeAddress, normalizeCity } from '../shared/text-utils.mjs';
import {
  chooseBetterStatus as chooseBetterStatusBase,
  mergeNotes,
  parseListingRow as parseListingRowRaw,
  parseReportNumber,
  parseScore,
  serializeListing,
} from '../shared/listings.mjs';
import { buildCanonicalLookup, readCanonicalStatuses } from '../shared/states.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LISTINGS_FILE = join(ROOT, 'data', 'listings.md');
const ADDITIONS_DIR = join(ROOT, 'batch', 'tracker-additions');
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');
const STATES_FILE = join(ROOT, 'templates', 'states.yml');
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');

const CANONICAL_STATUSES = readCanonicalStatuses(STATES_FILE);
const CANONICAL_LOOKUP = buildCanonicalLookup(CANONICAL_STATUSES);

function chooseBetterStatus(left, right) {
  return chooseBetterStatusBase(canonicalizeStatus(left), canonicalizeStatus(right));
}

function looksLikeScore(value) {
  return /^\d+(?:\.\d+)?\/5$/.test(value.trim()) || value.trim() === 'N/A';
}

function canonicalizeStatus(value) {
  const clean = value.replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  if (!clean) {
    return 'Evaluated';
  }

  const lower = clean.toLowerCase();
  if (CANONICAL_LOOKUP.has(lower)) {
    return CANONICAL_LOOKUP.get(lower);
  }

  const aliases = {
    discovered: 'New',
    scraped: 'New',
    shortlisted: 'Interested',
    favorite: 'Interested',
    showing: 'Tour Scheduled',
    scheduled: 'Tour Scheduled',
    viewing: 'Tour Scheduled',
    toured: 'Toured',
    visited: 'Toured',
    seen: 'Toured',
    offered: 'Offer Submitted',
    bid: 'Offer Submitted',
    pending: 'Under Contract',
    contract: 'Under Contract',
    purchased: 'Closed',
    bought: 'Closed',
    declined: 'Passed',
    not_interested: 'Passed',
    'not interested': 'Passed',
    off_market: 'Sold',
    'off market': 'Sold',
    delisted: 'Sold',
    unavailable: 'Sold',
    expired: 'Sold',
    filtered: 'SKIP',
    'no fit': 'SKIP',
    no_fit: 'SKIP',
    skip: 'SKIP',
  };

  if (aliases[lower]) {
    return aliases[lower];
  }

  console.warn(`⚠️  Non-canonical status "${value}" -> defaulting to "Evaluated"`);
  return 'Evaluated';
}

function parseListingRow(line, lineIndex = -1) {
  const entry = parseListingRowRaw(line, lineIndex);
  if (!entry) {
    return null;
  }
  entry.status = canonicalizeStatus(entry.status);
  return entry;
}

function parseAdditionLine(content, filename, lineNumber) {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('|')) {
    return parseListingRow(trimmed);
  }

  const columns = trimmed.split('\t').map((value) => value.trim());
  if (columns.length < 10) {
    console.warn(`⚠️  Skipping malformed TSV ${filename}:${lineNumber}: ${columns.length} columns`);
    return null;
  }

  const num = Number.parseInt(columns[0], 10);
  if (Number.isNaN(num)) {
    console.warn(`⚠️  Skipping ${filename}:${lineNumber}: invalid row number`);
    return null;
  }

  const rawScore = columns[7] ?? '';
  const rawStatus = columns[8] ?? '';
  const score = looksLikeScore(rawScore)
    ? rawScore
    : (looksLikeScore(rawStatus) ? rawStatus : 'N/A');
  const status = looksLikeScore(rawScore)
    ? canonicalizeStatus(rawStatus || 'Evaluated')
    : canonicalizeStatus(rawScore || 'Evaluated');

  return {
    num,
    date: columns[1],
    address: columns[2],
    city: columns[3],
    price: columns[4],
    bedsBaths: columns[5],
    sqft: columns[6],
    score,
    status,
    report: columns[9] ?? '',
    notes: columns[10] ?? '',
  };
}

function parseAdditionFile(content, filename) {
  const additions = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const addition = parseAdditionLine(lines[index], filename, index + 1);
    if (addition) {
      additions.push(addition);
    }
  }

  return additions;
}

function findDuplicate(entries, addition) {
  const reportNumber = parseReportNumber(addition.report);
  if (reportNumber) {
    const byReport = entries.find((entry) => parseReportNumber(entry.report) === reportNumber);
    if (byReport) {
      return byReport;
    }
  }

  const byNumber = entries.find((entry) => entry.num === addition.num);
  if (byNumber) {
    return byNumber;
  }

  const normalizedAddress = normalizeAddress(addition.address);
  const normalizedCity = normalizeCity(addition.city);
  return entries.find((entry) => normalizeAddress(entry.address) === normalizedAddress && normalizeCity(entry.city) === normalizedCity);
}

function mergeEntry(existing, incoming) {
  const incomingScore = parseScore(incoming.score);
  const existingScore = parseScore(existing.score);
  const useIncomingScore = incomingScore >= existingScore;

  return {
    ...existing,
    date: incoming.date || existing.date,
    address: incoming.address || existing.address,
    city: incoming.city || existing.city,
    price: incoming.price || existing.price,
    bedsBaths: incoming.bedsBaths || existing.bedsBaths,
    sqft: incoming.sqft || existing.sqft,
    score: useIncomingScore ? incoming.score : existing.score,
    status: chooseBetterStatus(existing.status, incoming.status),
    report: useIncomingScore ? (incoming.report || existing.report) : (existing.report || incoming.report),
    notes: mergeNotes(existing.notes, incoming.notes),
  };
}

if (!existsSync(LISTINGS_FILE)) {
  console.log('No data/listings.md found. Nothing to merge into.');
  process.exit(0);
}

if (!existsSync(ADDITIONS_DIR)) {
  console.log('No tracker-additions directory found.');
  process.exit(0);
}

const listingLines = readFileSync(LISTINGS_FILE, 'utf-8').split('\n');
const entries = [];
let maxNumber = 0;

for (let index = 0; index < listingLines.length; index += 1) {
  const entry = parseListingRow(listingLines[index], index);
  if (!entry) {
    continue;
  }
  entries.push(entry);
  maxNumber = Math.max(maxNumber, entry.num);
}

const additionFiles = readdirSync(ADDITIONS_DIR)
  .filter((file) => file.endsWith('.tsv'))
  .sort((left, right) => {
    const leftNum = Number.parseInt(left, 10) || 0;
    const rightNum = Number.parseInt(right, 10) || 0;
    return leftNum - rightNum;
  });

if (additionFiles.length === 0) {
  console.log('✅ No pending additions to merge.');
  process.exit(0);
}

console.log(`📥 Found ${additionFiles.length} pending additions`);

let added = 0;
let updated = 0;
let skipped = 0;

for (const file of additionFiles) {
  const additions = parseAdditionFile(readFileSync(join(ADDITIONS_DIR, file), 'utf-8'), file);
  if (additions.length === 0) {
    skipped += 1;
    continue;
  }

  if (additions.length > 1) {
    console.log(`  ${file}: ${additions.length} staged rows`);
  }

  for (const addition of additions) {
    const duplicate = findDuplicate(entries, addition);
    if (duplicate) {
      const merged = mergeEntry(duplicate, addition);
      const currentLine = serializeListing(duplicate);
      const nextLine = serializeListing(merged);
      if (currentLine !== nextLine && duplicate.lineIndex >= 0) {
        listingLines[duplicate.lineIndex] = nextLine;
        Object.assign(duplicate, merged);
        updated += 1;
        console.log(`🔄 Update: #${duplicate.num} ${duplicate.address}, ${duplicate.city}`);
      } else {
        skipped += 1;
        console.log(`⏭️  Skip: ${addition.address}, ${addition.city} (no net change)`);
      }
      continue;
    }

    const nextNumber = addition.num > maxNumber ? addition.num : maxNumber + 1;
    maxNumber = Math.max(maxNumber, nextNumber);
    const row = {
      ...addition,
      num: nextNumber,
      status: canonicalizeStatus(addition.status),
    };
    entries.push({ ...row, lineIndex: -1 });
    added += 1;
    console.log(`➕ Add #${nextNumber}: ${row.address}, ${row.city}`);
  }
}

if (added > 0 || updated > 0) {
  const headerIndex = listingLines.findIndex((line) => line.startsWith('|---'));
  const tableStart = headerIndex >= 0 ? headerIndex + 1 : listingLines.length;
  let tableEnd = tableStart;
  while (tableEnd < listingLines.length && parseListingRow(listingLines[tableEnd], tableEnd)) {
    tableEnd += 1;
  }

  const sortedRows = entries
    .map((entry) => ({
      ...entry,
      status: canonicalizeStatus(entry.status),
    }))
    .sort((left, right) => left.num - right.num)
    .map(serializeListing);

  listingLines.splice(tableStart, tableEnd - tableStart, ...sortedRows);
}

if (!DRY_RUN) {
  writeFileSync(LISTINGS_FILE, listingLines.join('\n'));
  mkdirSync(MERGED_DIR, { recursive: true });
  for (const file of additionFiles) {
    renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file));
  }
  console.log(`\n✅ Moved ${additionFiles.length} TSVs to merged/`);
}

console.log(`\n📊 Summary: +${added} added, 🔄${updated} updated, ⏭️${skipped} skipped`);
if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
}

if (VERIFY && !DRY_RUN) {
  console.log('\n--- Running verification ---');
  execSync(`node "${join(ROOT, 'verify-pipeline.mjs')}"`, { stdio: 'inherit' });
}
