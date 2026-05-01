#!/usr/bin/env node

/**
 * test-cache-loop.mjs - Unit tests for cache-utils.mjs.
 *
 * Validates TTL logic, load/save round-trip, and prune behavior without
 * touching the hosted browser. Run directly: `node test-cache-loop.mjs`.
 */

import { mkdir, rm, readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  CACHE_TTL,
  getCacheEntry,
  isCacheFresh,
  loadCache,
  pruneCache,
  putCacheEntry,
  saveCache,
  ttlForVerification,
} from './cache-utils.mjs';
import { ROOT } from '../shared/paths.mjs';
const CACHE_DIR = join(ROOT, 'output', 'cache');
const TEST_CACHE_NAME = '__test_cache_loop__';
const TEST_CACHE_FILE = join(CACHE_DIR, `${TEST_CACHE_NAME}.json`);

let passed = 0;
let failed = 0;

function ok(name) {
  passed += 1;
  console.log(`  PASS ${name}`);
}

function no(name, detail) {
  failed += 1;
  console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function cleanup() {
  if (existsSync(TEST_CACHE_FILE)) {
    await rm(TEST_CACHE_FILE);
  }
}

async function testLoadEmpty() {
  await cleanup();
  const cache = await loadCache(TEST_CACHE_NAME);
  if (cache && cache.entries && Object.keys(cache.entries).length === 0) {
    ok('loadCache returns empty cache when file missing');
  } else {
    no('loadCache returns empty cache when file missing', JSON.stringify(cache));
  }
}

async function testRoundTrip() {
  await cleanup();
  const cache = { entries: {} };
  putCacheEntry(cache, 'key-one', { verification: { status: 'active' }, facts: { address: '1 Main St' } });
  await saveCache(TEST_CACHE_NAME, cache);

  const reloaded = await loadCache(TEST_CACHE_NAME);
  const entry = getCacheEntry(reloaded, 'key-one');
  if (entry && entry.verification?.status === 'active' && entry.facts?.address === '1 Main St') {
    ok('save/load round-trip preserves entry fields');
  } else {
    no('save/load round-trip preserves entry fields', JSON.stringify(entry));
  }
  if (entry && typeof entry.cachedAt === 'string' && Date.parse(entry.cachedAt)) {
    ok('putCacheEntry stamps cachedAt ISO timestamp');
  } else {
    no('putCacheEntry stamps cachedAt ISO timestamp', JSON.stringify(entry));
  }
}

function testFreshness() {
  const fresh = { cachedAt: new Date().toISOString() };
  if (isCacheFresh(fresh, 60 * 1000)) {
    ok('isCacheFresh true for recent entry inside TTL');
  } else {
    no('isCacheFresh true for recent entry inside TTL');
  }

  const stale = { cachedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString() };
  if (!isCacheFresh(stale, 60 * 1000)) {
    ok('isCacheFresh false for entry past TTL');
  } else {
    no('isCacheFresh false for entry past TTL');
  }

  if (!isCacheFresh(null, 1000)) {
    ok('isCacheFresh false for null entry');
  } else {
    no('isCacheFresh false for null entry');
  }

  if (!isCacheFresh({ cachedAt: 'not-a-date' }, 1000)) {
    ok('isCacheFresh false for unparseable cachedAt');
  } else {
    no('isCacheFresh false for unparseable cachedAt');
  }
}

function testTtlForVerification() {
  if (ttlForVerification('active') === CACHE_TTL.EXTRACTION_ACTIVE_MS) {
    ok('ttlForVerification(active) returns 24h');
  } else {
    no('ttlForVerification(active) returns 24h', String(ttlForVerification('active')));
  }

  if (ttlForVerification('inactive') === CACHE_TTL.EXTRACTION_INACTIVE_MS) {
    ok('ttlForVerification(inactive) returns 30d');
  } else {
    no('ttlForVerification(inactive) returns 30d');
  }

  if (ttlForVerification('blocked') === CACHE_TTL.EXTRACTION_BLOCKED_MS) {
    ok('ttlForVerification(blocked) returns 15m');
  } else {
    no('ttlForVerification(blocked) returns 15m');
  }

  if (ttlForVerification('report') === CACHE_TTL.EXTRACTION_ACTIVE_MS) {
    ok('ttlForVerification(report) returns active TTL');
  } else {
    no('ttlForVerification(report) returns active TTL');
  }
}

async function testPrune() {
  await cleanup();
  const cache = { entries: {} };
  putCacheEntry(cache, 'fresh', { verification: { status: 'active' } });
  cache.entries.old = {
    verification: { status: 'active' },
    cachedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  };
  pruneCache(cache, 24 * 60 * 60 * 1000);

  if (cache.entries.fresh && !cache.entries.old) {
    ok('pruneCache drops entries older than maxAgeMs');
  } else {
    no('pruneCache drops entries older than maxAgeMs', JSON.stringify(Object.keys(cache.entries)));
  }
}

async function testCorruptFile() {
  await cleanup();
  await mkdir(CACHE_DIR, { recursive: true });
  await fsWriteFile(TEST_CACHE_FILE, '{this is not valid json', 'utf8');
  const cache = await loadCache(TEST_CACHE_NAME);
  if (cache && cache.entries && Object.keys(cache.entries).length === 0) {
    ok('loadCache recovers from corrupt JSON with empty cache');
  } else {
    no('loadCache recovers from corrupt JSON with empty cache', JSON.stringify(cache));
  }
}

async function testSchemaMismatch() {
  await cleanup();
  await mkdir(CACHE_DIR, { recursive: true });
  await fsWriteFile(TEST_CACHE_FILE, JSON.stringify({ schemaVersion: 999, entries: { a: {} } }), 'utf8');
  const cache = await loadCache(TEST_CACHE_NAME);
  if (cache && cache.entries && Object.keys(cache.entries).length === 0) {
    ok('loadCache drops entries when schemaVersion mismatches');
  } else {
    no('loadCache drops entries when schemaVersion mismatches', JSON.stringify(cache));
  }
}

async function run() {
  console.log('\nCache utility test suite\n');
  await testLoadEmpty();
  await testRoundTrip();
  testFreshness();
  testTtlForVerification();
  await testPrune();
  await testCorruptFile();
  await testSchemaMismatch();
  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(`test-cache-loop.mjs crashed: ${error.message}`);
  process.exit(1);
});
