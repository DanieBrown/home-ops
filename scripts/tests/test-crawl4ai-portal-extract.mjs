#!/usr/bin/env node
/**
 * Unit and fixture tests for the Crawl4AI portal extraction bridge.
 * Run: node scripts/tests/test-crawl4ai-portal-extract.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { normalizeCrawl4aiPortalResult } from '../research/crawl4ai-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const SIDE_CAR = join(ROOT, 'scripts', 'research', 'python', 'crawl4ai_portal_extract.py');
const FIXTURES = join(ROOT, 'scripts', 'tests', 'fixtures');
const PYTHON = process.platform === 'win32' ? ['py', ['-3']] : ['python3', []];

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL ${name}: ${error.message}`);
    failed += 1;
  }
}

function runSidecar({ mode = 'detail', platform, fixture, url }) {
  const [bin, baseArgs] = PYTHON;
  const result = spawnSync(bin, [
    ...baseArgs,
    SIDE_CAR,
    '--mode', mode,
    '--platform', platform,
    '--url', url,
    '--html-file', join(FIXTURES, fixture),
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test('normalize: captured result stays captured', () => {
  const result = normalizeCrawl4aiPortalResult({
    mode: 'detail',
    platform: 'realtor',
    url: 'https://www.realtor.com/example',
    finalUrl: 'https://www.realtor.com/example',
    statusCode: 200,
    captureStatus: 'captured',
    listing: { address: '1 Main St' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.captureStatus, 'captured');
  assert.equal(result.statusCode, 200);
});

test('normalize: empty result stays empty', () => {
  const result = normalizeCrawl4aiPortalResult({
    mode: 'search',
    platform: 'zillow',
    url: 'https://www.zillow.com/homes/Apex-NC/',
    captureStatus: 'empty',
    items: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.captureStatus, 'empty');
});

test('normalize: 429 result is blocked', () => {
  const result = normalizeCrawl4aiPortalResult({
    mode: 'search',
    platform: 'realtor',
    url: 'https://www.realtor.com/realestateandhomes-search/Apex_NC',
    statusCode: 429,
    captureStatus: 'blocked',
    error: 'http-429',
  });
  assert.equal(result.ok, false);
  assert.equal(result.captureStatus, 'blocked');
  assert.equal(result.statusCode, 429);
});

test('normalize: missing crawl4ai is an unavailable error', () => {
  const result = normalizeCrawl4aiPortalResult({
    mode: 'detail',
    platform: 'homes',
    url: 'https://www.homes.com/property/example/',
    error: 'crawl4ai-not-installed',
    unavailable: true,
  });
  assert.equal(result.captureStatus, 'error');
  assert.equal(result.unavailable, true);
});

test('fixture: blocked page is classified as blocked', () => {
  const result = runSidecar({
    mode: 'search',
    platform: 'realtor',
    fixture: 'crawl4ai-blocked.html',
    url: 'https://www.realtor.com/realestateandhomes-search/Apex_NC',
  });
  assert.equal(result.captureStatus, 'blocked');
});

test('fixture: zillow detail extracts JSON-LD facts', () => {
  const result = runSidecar({
    platform: 'zillow',
    fixture: 'crawl4ai-zillow-detail.html',
    url: 'https://www.zillow.com/homedetails/123-Pine-View-Dr-Apex-NC-27502/111_zpid/',
  });
  assert.equal(result.captureStatus, 'captured');
  assert.equal(result.listing.address, '123 Pine View Dr');
  assert.equal(result.listing.city, 'Apex');
  assert.equal(result.listing.price, 650000);
  assert.equal(result.listing.beds, 4);
  assert.equal(result.listing.sqftFinished, 3050);
});

test('fixture: redfin detail extracts JSON-LD facts', () => {
  const result = runSidecar({
    platform: 'redfin',
    fixture: 'crawl4ai-redfin-detail.html',
    url: 'https://www.redfin.com/NC/Cary/456-Oak-Meadow-Ln-27519/home/123',
  });
  assert.equal(result.captureStatus, 'captured');
  assert.equal(result.listing.address, '456 Oak Meadow Ln');
  assert.equal(result.listing.city, 'Cary');
  assert.equal(result.listing.baths, 3.5);
  assert.equal(result.listing.yearBuilt, 2017);
});

test('fixture: realtor detail extracts __NEXT_DATA__ facts', () => {
  const result = runSidecar({
    platform: 'realtor',
    fixture: 'crawl4ai-realtor-detail.html',
    url: 'https://www.realtor.com/realestateandhomes-detail/789-Jewell-Farm-Ln_Holly-Springs_NC_27540_M12345-67890',
  });
  assert.equal(result.captureStatus, 'captured');
  assert.equal(result.listing.address, '789 Jewell Farm Ln');
  assert.equal(result.listing.baths, 3.5);
  assert.equal(result.listing.mls, 'NC10058399');
  assert.equal(result.listing.listingAgent, 'Erica Anderson');
  assert.equal(result.listing.assignedSchools[0].rating, 8);
});

test('fixture: homes detail extracts @graph JSON-LD facts', () => {
  const result = runSidecar({
    platform: 'homes',
    fixture: 'crawl4ai-homes-detail.html',
    url: 'https://www.homes.com/property/4404-clarkdale-ct-fuquay-varina-nc/bm457fnk52lm0/',
  });
  assert.equal(result.captureStatus, 'captured');
  assert.equal(result.listing.address, '4404 Clarkdale Ct');
  assert.equal(result.listing.city, 'Fuquay Varina');
  assert.equal(result.listing.price, 750000);
  assert.equal(result.listing.beds, 5);
  assert.equal(result.listing.sqftFinished, 3716);
});

test('fixture: search extraction returns detail-card items', () => {
  const result = runSidecar({
    mode: 'search',
    platform: 'zillow',
    fixture: 'crawl4ai-zillow-search.html',
    url: 'https://www.zillow.com/homes/Apex-NC/',
  });
  assert.equal(result.captureStatus, 'captured');
  assert.equal(result.items.length, 2);
  assert.match(result.items[0].href, /\/homedetails\//);
  assert.match(result.items[0].text, /\$650,000/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
