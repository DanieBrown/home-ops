#!/usr/bin/env node

/**
 * cache-utils.mjs - Simple JSON cache with TTL for expensive extraction work.
 *
 * Keeps one JSON file per cache name under output/cache/. Intended for cross-run
 * reuse of browser extractions and per-neighborhood sentiment rollups so the
 * evaluate and deep loops can skip re-scraping unchanged listings/areas.
 */

import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(ROOT, 'output', 'cache');
const SCHEMA_VERSION = 1;

function cachePath(name) {
  return join(CACHE_DIR, `${name}.json`);
}

export async function loadCache(name) {
  const filePath = cachePath(name);
  if (!existsSync(filePath)) {
    return { schemaVersion: SCHEMA_VERSION, entries: {} };
  }

  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
      return { schemaVersion: SCHEMA_VERSION, entries: {} };
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      return { schemaVersion: SCHEMA_VERSION, entries: {} };
    }
    return parsed;
  } catch {
    return { schemaVersion: SCHEMA_VERSION, entries: {} };
  }
}

export async function saveCache(name, cache) {
  await mkdir(CACHE_DIR, { recursive: true });
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    entries: cache.entries ?? {},
  };
  await writeFile(cachePath(name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export function isCacheFresh(entry, ttlMs) {
  if (!entry || !entry.cachedAt) {
    return false;
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return false;
  }
  const cachedAtMs = Date.parse(entry.cachedAt);
  if (!Number.isFinite(cachedAtMs)) {
    return false;
  }
  return Date.now() - cachedAtMs <= ttlMs;
}

export function putCacheEntry(cache, key, payload) {
  if (!cache.entries) {
    cache.entries = {};
  }
  cache.entries[key] = {
    ...payload,
    cachedAt: new Date().toISOString(),
  };
  return cache;
}

export function getCacheEntry(cache, key) {
  return cache?.entries?.[key] ?? null;
}

export function pruneCache(cache, maxAgeMs) {
  if (!cache?.entries) {
    return cache;
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return cache;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, entry] of Object.entries(cache.entries)) {
    const cachedAtMs = Date.parse(entry?.cachedAt ?? '');
    if (!Number.isFinite(cachedAtMs) || cachedAtMs < cutoff) {
      delete cache.entries[key];
    }
  }
  return cache;
}

export const CACHE_TTL = {
  EXTRACTION_ACTIVE_MS: 24 * 60 * 60 * 1000,
  EXTRACTION_INACTIVE_MS: 30 * 24 * 60 * 60 * 1000,
  EXTRACTION_BLOCKED_MS: 15 * 60 * 1000,
  SENTIMENT_MS: 6 * 60 * 60 * 1000,
  DEFAULT_PRUNE_MS: 90 * 24 * 60 * 60 * 1000,
};

export function ttlForVerification(status) {
  if (status === 'active' || status === 'report') {
    return CACHE_TTL.EXTRACTION_ACTIVE_MS;
  }
  if (status === 'inactive') {
    return CACHE_TTL.EXTRACTION_INACTIVE_MS;
  }
  return CACHE_TTL.EXTRACTION_BLOCKED_MS;
}

function parseArgs(argv) {
  const args = { command: '' };
  for (const value of argv) {
    if (value === '--help' || value === '-h') {
      args.command = 'help';
    } else if (value === '--stats') {
      args.command = 'stats';
    } else if (value === '--clear') {
      args.command = 'clear';
    } else if (!args.name) {
      args.name = value;
    }
  }
  if (!args.command) {
    args.command = 'help';
  }
  return args;
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    console.log('Usage: node cache-utils.mjs [--stats|--clear] <cacheName>');
    console.log('Named caches:');
    console.log('  extraction  URL-keyed listing extractions for evaluate-pending');
    console.log('  sentiment   Subdivision-keyed sentiment rollups for deep mode');
    return;
  }

  const name = args.name || 'extraction';
  if (args.command === 'stats') {
    const cache = await loadCache(name);
    const count = Object.keys(cache.entries ?? {}).length;
    console.log(`${name}: ${count} entry(ies)`);
    return;
  }

  if (args.command === 'clear') {
    await saveCache(name, { entries: {} });
    console.log(`Cleared cache: ${name}`);
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch((error) => {
    console.error(`cache-utils.mjs failed: ${error.message}`);
    process.exit(1);
  });
}
