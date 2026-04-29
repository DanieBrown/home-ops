#!/usr/bin/env node

/**
 * geocode.mjs -- Resolve a home's street address to a (lng, lat) point using
 * the free U.S. Census Geocoder. Writes one cache file per home under
 * output/geocode/{slug}.json so repeated lookups are free.
 *
 * Used by county-permits-check.mjs for the 1-mile spatial query against
 * county GIS feature services. Failures are tolerated: the cache file
 * records status: "not-found" and downstream callers should skip spatial
 * filtering for that home rather than fabricating coordinates.
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { ROOT, parseReport, parseShortlist } from './research-utils.mjs';
import { slugify } from '../shared/text-utils.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'geocode');
const DEFAULT_TIMEOUT_MS = 15000;
const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
// Census records refresh on a slow cycle; a year is more than enough for
// permit-radius queries that don't care about millimeter precision.
const CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export function geocodeOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'geocode-target';
  return join(OUTPUT_DIR, `${slug}.json`);
}

export function readGeocodeRecord(target) {
  const path = geocodeOutputPath(target);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function isFresh(record) {
  if (!record?.generatedAt) return false;
  const age = Date.now() - new Date(record.generatedAt).getTime();
  return Number.isFinite(age) && age < CACHE_TTL_MS;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'home-ops/geocode (+https://github.com/)' },
    });
    if (!response.ok) {
      return { ok: false, status: response.status };
    }
    return { ok: true, status: response.status, body: await response.json() };
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

async function geocodeOne(target) {
  const oneLine = [target.address, target.city, target.state || 'NC'].filter(Boolean).join(', ');
  if (!oneLine) {
    return { status: 'invalid-address', oneLine, lat: null, lng: null, source: null };
  }

  const params = new URLSearchParams({
    address: oneLine,
    benchmark: 'Public_AR_Current',
    format: 'json',
  });
  const result = await fetchJson(`${CENSUS_URL}?${params.toString()}`);

  if (!result.ok) {
    return {
      status: 'fetch-error',
      oneLine,
      lat: null,
      lng: null,
      source: 'us-census-geocoder',
      error: result.error ?? `HTTP ${result.status}`,
    };
  }

  const match = result.body?.result?.addressMatches?.[0];
  if (!match?.coordinates) {
    return { status: 'not-found', oneLine, lat: null, lng: null, source: 'us-census-geocoder' };
  }

  return {
    status: 'ok',
    oneLine,
    lat: Number(match.coordinates.y),
    lng: Number(match.coordinates.x),
    matchedAddress: match.matchedAddress ?? null,
    source: 'us-census-geocoder',
  };
}

export async function ensureGeocode(target, { force = false } = {}) {
  const cached = readGeocodeRecord(target);
  if (!force && cached && isFresh(cached) && cached.status === 'ok') {
    return cached;
  }

  const result = await geocodeOne(target);
  const record = {
    generatedAt: new Date().toISOString(),
    address: target.address,
    city: target.city,
    state: target.state || 'NC',
    ...result,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(geocodeOutputPath(target), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

const HELP_TEXT = `Usage:
  node geocode.mjs reports/001-foo.md
  node geocode.mjs --shortlist
  node geocode.mjs --top3

Options:
  --shortlist   Use the current Top 10 cohort.
  --top3        Use the refined Top 3.
  --force       Re-geocode even if a fresh cache exists.
  --json        Print JSON instead of human-readable text.`;

function parseArgs(argv) {
  const config = { shortlist: false, top3: false, force: false, json: false, help: false, files: [] };
  for (const arg of argv) {
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--force') { config.force = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    config.files.push(arg);
  }
  return config;
}

function resolveTargets(config) {
  if (config.shortlist || config.top3) {
    const shortlist = parseShortlist(ROOT);
    const rows = config.top3 ? shortlist.refinedTop3 : shortlist.top10;
    if (rows.length === 0) {
      throw new Error(config.top3 ? 'No refined top-3 homes.' : 'No populated top-10 homes.');
    }
    return rows.map((row) => parseReport(ROOT, row.reportPath));
  }
  if (config.files.length === 0) {
    throw new Error('Provide a report path, or use --shortlist / --top3.');
  }
  return config.files.map((filePath) => parseReport(ROOT, filePath));
}

async function run() {
  let config;
  try { config = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(e.message); console.error(''); console.error(HELP_TEXT); process.exit(1);
  }
  if (config.help) { console.log(HELP_TEXT); return; }

  const targets = resolveTargets(config);
  const records = [];
  for (const target of targets) {
    records.push(await ensureGeocode(target, { force: config.force }));
  }

  if (config.json) {
    console.log(JSON.stringify({ count: records.length, records }, null, 2));
    return;
  }
  console.log('\nGeocode results\n');
  for (const r of records) {
    console.log(`${r.address}, ${r.city} -> ${r.status}${r.lat ? ` (${r.lat.toFixed(5)}, ${r.lng.toFixed(5)})` : ''}`);
  }
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  run().catch((error) => { console.error(`Fatal: ${error.message}`); process.exit(1); });
}
