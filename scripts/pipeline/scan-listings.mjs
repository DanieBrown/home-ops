#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import YAML from 'yaml';
import { readSessionState } from '../browser/browser-session.mjs';
import {
  normalizeAddress,
  normalizeCity,
  normalizeStreetSuffixes,
} from '../shared/text-utils.mjs';
import { parseListingRow as parseListingRowFull } from '../shared/listings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOME_OPS_DIR = join(ROOT, '.home-ops');
const SCAN_RUNNING_PATH = join(HOME_OPS_DIR, 'scan-running.json');
const SCAN_COMPLETE_PATH = join(HOME_OPS_DIR, 'scan-complete.json');
const PORTALS_PATH = join(ROOT, 'portals.yml');
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const SCAN_HISTORY_PATH = join(ROOT, 'data', 'scan-history.tsv');
const LISTINGS_PATH = join(ROOT, 'data', 'listings.md');
const DEFAULT_PROFILE = 'chrome-host';
const DEFAULT_MAX_PENDING_PER_SOURCE_AREA = 3;
const HISTORY_HEADER = 'url\tfirst_seen\tplatform\tarea\taddress\tstatus\n';
const PIPELINE_TEMPLATE = [
  '## Pending',
  '',
  'Add listing URLs here, one per line. Accepted inputs:',
  '- Direct Zillow, Redfin, or Realtor.com listing URLs',
  '- local:reports/<file>.md for reprocessing an existing report later',
  '',
  'Example:',
  '- https://www.zillow.com/homedetails/123-Main-St-Holly-Springs-NC-27540/12345678_zpid/',
  '- https://www.redfin.com/NC/Apex/123-Main-St-27502/home/123456789',
  '',
  '## Processed',
  '',
].join('\n');
const NAVIGATION_TIMEOUT_MS = 15000;
const SETTLE_TIMEOUT_MS = 2500;
const SEARCH_PAGE_BUDGET_MS = 45000;
const PLATFORM_BUDGET_MS = 150000;
const DEFAULT_ACTION_TIMEOUT_MS = 15000;

const PLATFORM_FLAG_MAP = {
  '--zillow': 'zillow',
  '--redfin': 'redfin',
  '--realtor': 'realtor',
  '--realtor.com': 'realtor',
  '--relator': 'realtor',
  '--homes': 'homes',
  '--homes.com': 'homes',
};

const DETAIL_URL_PATTERNS = {
  zillow: /\/homedetails\//i,
  redfin: /\/home\//i,
  realtor: /\/realestateandhomes-detail\//i,
  homes: /\/property\//i,
};

const BLOCK_PATTERNS = [
  /press\s*&?\s*hold/i,
  /access to this page has been denied/i,
  /verify you are a human/i,
  /captcha/i,
  /reference id/i,
  /processing your request/i,
  /unblock/i,
  /unusual traffic/i,
  /err_blocked_by_response/i,
  /just a moment/i,
  /checking your browser/i,
  /enable javascript and cookies/i,
  /one more step/i,
  /are you a robot/i,
  /perimeterx/i,
];

const SOLD_PATTERNS = [
  /\boff market\b/i,
  /\bno longer available\b/i,
  /\bdelisted\b/i,
  /\bpending\b/i,
  /\bunder contract\b/i,
  /\bcontingent\b/i,
  /\bsold\b/i,
];

const ADDRESS_PATTERN = /\b\d{1,5}\s+[^|,]+(?:\s+[^|,]+)*,\s*[A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5})?\b/;

const ZILLOW_BLOCKED_PATH = join(HOME_OPS_DIR, 'zillow-session-blocked.json');

const HELP_TEXT = `Usage:
  node scan-listings.mjs
  node scan-listings.mjs --zillow --redfin --relator --homes
  node scan-listings.mjs --no-zillow --redfin --relator --homes
  node scan-listings.mjs --profile chrome-host

Options:
  --zillow      Scan Zillow only.
  --redfin      Scan Redfin only.
  --relator     Scan Realtor.com only.
  --realtor     Backward-compatible alias for --relator.
  --homes       Scan Homes.com only.
  --no-zillow   Skip Zillow entirely (useful when Zillow bot detection is active).
  --profile     Hosted browser profile to reuse. Defaults to chrome-host.
  --help        Show this help text.`;

function platformHost(platform) {
  if (platform === 'zillow') {
    return 'zillow.com';
  }

  if (platform === 'redfin') {
    return 'redfin.com';
  }

  if (platform === 'realtor') {
    return 'realtor.com';
  }

  if (platform === 'homes') {
    return 'homes.com';
  }

  return '';
}

function canonicalPlatformKey(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'relator' || normalized === 'realtor.com') {
    return 'realtor';
  }
  return normalized;
}

function parseArgs(argv) {
  const config = {
    profileName: DEFAULT_PROFILE,
    selectedPlatforms: new Set(),
    excludedPlatforms: new Set(),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      config.help = true;
      continue;
    }

    if (arg === '--profile') {
      config.profileName = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--no-zillow') {
      config.excludedPlatforms.add('zillow');
      continue;
    }

    if (PLATFORM_FLAG_MAP[arg]) {
      config.selectedPlatforms.add(PLATFORM_FLAG_MAP[arg]);
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (!config.profileName) {
    throw new Error('Expected a profile name after --profile.');
  }

  return config;
}

function readYamlFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing required file: ${filePath}`);
  }

  return YAML.parse(readFileSync(filePath, 'utf8')) ?? {};
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeArea(value) {
  return normalizeCity(value);
}

function buildPendingBucketKey(platformKey, area) {
  const normalizedPlatformKey = canonicalPlatformKey(platformKey);
  const normalizedArea = normalizeArea(area);
  if (!normalizedPlatformKey || !normalizedArea) {
    return null;
  }

  return `${normalizedPlatformKey}::${normalizedArea}`;
}

function buildComparableAddressKey(fullAddress, address = null, city = null) {
  const normalizedFullAddress = normalizeStreetSuffixes(String(fullAddress ?? '').toLowerCase())
    .replace(/\btrl\b/g, 'trail')
    .replace(/\bter\b/g, 'terrace')
    .replace(/\bbnd\b/g, 'bend')
    .replace(/\bgrv\b/g, 'grove')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalizedFullAddress) {
    return normalizedFullAddress;
  }

  return buildAddressKey(address, city);
}

function buildAddressKey(address, city) {
  if (!address || !city) {
    return null;
  }
  return `${normalizeAddress(address)}::${normalizeCity(city)}`;
}

function canonicalizeUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return String(rawUrl ?? '').trim();
  }
}

function normalizeSearchPageKey(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${pathname}`;
  } catch {
    return String(rawUrl ?? '').trim();
  }
}

function normalizeExactUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return String(rawUrl ?? '').trim();
  }
}

function urlMatchesPlatform(rawUrl, platform) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    const host = parsed.hostname.replace(/^www\./i, '');
    return host === platformHost(platform);
  } catch {
    return false;
  }
}

function findReusableSearchPage(context, platform, targetUrl) {
  const targetKey = normalizeSearchPageKey(targetUrl);

  return context.pages().find((page) => {
    const currentUrl = page.url();
    return currentUrl
      && urlMatchesPlatform(currentUrl, platform)
      && !DETAIL_URL_PATTERNS[platform].test(currentUrl)
      && normalizeSearchPageKey(currentUrl) === targetKey;
  }) ?? null;
}

async function openOrRefreshSearchPage(context, platform, targetUrl) {
  const reusablePage = findReusableSearchPage(context, platform, targetUrl);
  const page = reusablePage ?? await context.newPage();

  await page.bringToFront().catch(() => {});

  if (reusablePage && normalizeExactUrl(reusablePage.url()) === normalizeExactUrl(targetUrl)) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_TIMEOUT_MS);
    return {
      page,
      action: 'refreshed-existing-search-tab',
    };
  }

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_TIMEOUT_MS);
  return {
    page,
    action: reusablePage ? 'updated-existing-search-tab' : 'opened-new-search-tab',
  };
}

function isLikelyListingUrl(url) {
  const normalized = canonicalizeUrl(url);
  return Object.values(DETAIL_URL_PATTERNS).some((pattern) => pattern.test(normalized));
}

function parseListingRow(line) {
  const entry = parseListingRowFull(line);
  if (!entry) {
    return null;
  }
  return { num: entry.num, address: entry.address, city: entry.city };
}

function parsePipelineChecklistLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed.startsWith('- [ ]') && !trimmed.toLowerCase().startsWith('- [x]')) {
    return null;
  }

  const columns = trimmed.split('|').map((value) => value.trim());
  if (columns.length < 3) {
    return null;
  }

  const url = columns[0].replace(/^- \[[ x]\]\s*/, '').trim();
  const address = columns[3] ?? '';

  return {
    checked: trimmed.toLowerCase().startsWith('- [x]'),
    url,
    canonicalUrl: canonicalizeUrl(url),
    platform: columns[1] ?? '',
    platformKey: canonicalPlatformKey(columns[1] ?? ''),
    area: columns[2] ?? '',
    address,
    addressKey: buildComparableAddressKey(address),
    price: columns[4] ?? '',
  };
}

function getPipelineDocument() {
  if (!existsSync(PIPELINE_PATH)) {
    return PIPELINE_TEMPLATE;
  }

  const content = readFileSync(PIPELINE_PATH, 'utf8');
  if (!content.includes('## Pending') || !content.includes('## Processed')) {
    return PIPELINE_TEMPLATE;
  }

  return content;
}

function getPipelineSectionIndices(lines) {
  const pendingIndex = lines.findIndex((line) => line.trim() === '## Pending');
  const processedIndex = lines.findIndex((line, index) => index > pendingIndex && line.trim() === '## Processed');
  return { pendingIndex, processedIndex };
}

function loadPendingBucketCounts() {
  const lines = getPipelineDocument().split(/\r?\n/);
  const { pendingIndex, processedIndex } = getPipelineSectionIndices(lines);
  const counts = new Map();

  if (pendingIndex === -1 || processedIndex === -1) {
    return counts;
  }

  for (let index = pendingIndex + 1; index < processedIndex; index += 1) {
    const entry = parsePipelineChecklistLine(lines[index]);
    if (!entry || entry.checked) {
      continue;
    }

    const bucketKey = buildPendingBucketKey(entry.platformKey, entry.area);
    if (!bucketKey) {
      continue;
    }

    const existing = counts.get(bucketKey) ?? {
      platformLabel: entry.platform || entry.platformKey,
      areaLabel: entry.area || 'Unknown area',
      count: 0,
    };
    existing.count += 1;
    counts.set(bucketKey, existing);
  }

  return counts;
}

function collectConfiguredBuckets(portals) {
  const buckets = new Map();

  for (const [platformKey, config] of Object.entries(portals)) {
    const sourceKey = canonicalPlatformKey(platformKey);
    for (const search of config.searchUrls ?? []) {
      const bucketKey = buildPendingBucketKey(sourceKey, search.area);
      if (!bucketKey || buckets.has(bucketKey)) {
        continue;
      }

      buckets.set(bucketKey, {
        platformKey: sourceKey,
        platformLabel: String(config.name ?? platformKey).trim() || sourceKey,
        areaLabel: search.area || 'Unknown area',
      });
    }
  }

  return buckets;
}

function refreshPendingBuckets(targetBuckets, maxPendingPerBucket, bucketsToRefresh = null) {
  const lines = getPipelineDocument().split(/\r?\n/);
  const { pendingIndex, processedIndex } = getPipelineSectionIndices(lines);
  if (pendingIndex === -1 || processedIndex === -1) {
    writeFileSync(PIPELINE_PATH, PIPELINE_TEMPLATE, 'utf8');
    return {
      refreshedBuckets: new Map(),
      pendingCounts: new Map(),
      duplicatesRemoved: 0,
    };
  }

  const pendingRecords = [];
  const seenUrls = new Set();
  const seenSourceAddressKeys = new Map();
  const bucketCounts = new Map();
  let duplicatesRemoved = 0;

  for (let index = pendingIndex + 1; index < processedIndex; index += 1) {
    const line = lines[index];
    const entry = parsePipelineChecklistLine(line);
    if (!entry || entry.checked) {
      pendingRecords.push({ keep: true, line, entry: null });
      continue;
    }

    const sourceAddressKeys = entry.platformKey
      ? (seenSourceAddressKeys.get(entry.platformKey) ?? new Set())
      : null;
    const duplicateByUrl = entry.canonicalUrl && seenUrls.has(entry.canonicalUrl);
    const duplicateBySourceAddress = Boolean(entry.addressKey && sourceAddressKeys && sourceAddressKeys.has(entry.addressKey));
    if (duplicateByUrl || duplicateBySourceAddress) {
      duplicatesRemoved += 1;
      pendingRecords.push({ keep: false, line, entry });
      continue;
    }

    if (entry.canonicalUrl) {
      seenUrls.add(entry.canonicalUrl);
    }
    if (entry.platformKey && entry.addressKey) {
      sourceAddressKeys.add(entry.addressKey);
      seenSourceAddressKeys.set(entry.platformKey, sourceAddressKeys);
    }

    const bucketKey = buildPendingBucketKey(entry.platformKey, entry.area);
    if (bucketKey) {
      const existing = bucketCounts.get(bucketKey) ?? {
        platformLabel: entry.platform || entry.platformKey,
        areaLabel: entry.area || 'Unknown area',
        count: 0,
      };
      existing.count += 1;
      bucketCounts.set(bucketKey, existing);
    }

    pendingRecords.push({ keep: true, line, entry });
  }

  const refreshedBuckets = new Map();
  for (const [bucketKey, bucket] of targetBuckets.entries()) {
    const existing = bucketCounts.get(bucketKey);
    const shouldRefresh = bucketsToRefresh instanceof Set
      ? bucketsToRefresh.has(bucketKey)
      : existing && existing.count >= maxPendingPerBucket;
    if (existing && shouldRefresh) {
      refreshedBuckets.set(bucketKey, {
        platformLabel: existing.platformLabel || bucket.platformLabel,
        areaLabel: existing.areaLabel || bucket.areaLabel,
        removedCount: existing.count,
      });
    }
  }

  if (duplicatesRemoved === 0 && refreshedBuckets.size === 0) {
    return {
      refreshedBuckets,
      pendingCounts: bucketCounts,
      duplicatesRemoved,
    };
  }

  const keptPendingLines = [];
  for (const record of pendingRecords) {
    if (!record.entry) {
      keptPendingLines.push(record.line);
      continue;
    }

    if (!record.keep) {
      continue;
    }

    const bucketKey = buildPendingBucketKey(record.entry.platformKey, record.entry.area);
    if (bucketKey && refreshedBuckets.has(bucketKey)) {
      continue;
    }

    keptPendingLines.push(record.line);
  }

  const updated = [
    ...lines.slice(0, pendingIndex + 1),
    ...keptPendingLines,
    ...lines.slice(processedIndex),
  ].join('\n');
  writeFileSync(PIPELINE_PATH, updated, 'utf8');

  return {
    refreshedBuckets,
    pendingCounts: loadPendingBucketCounts(),
    duplicatesRemoved,
  };
}

function loadSeenListingUrls() {
  const seen = new Set();

  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      if (isLikelyListingUrl(match[0])) {
        seen.add(canonicalizeUrl(match[0]));
      }
    }
  }

  return seen;
}

function loadSeenAddressKeys() {
  const keys = new Set();

  if (!existsSync(LISTINGS_PATH)) {
    return keys;
  }

  const content = readFileSync(LISTINGS_PATH, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const entry = parseListingRow(line);
    if (!entry) {
      continue;
    }

    const key = buildComparableAddressKey(null, entry.address, entry.city);
    if (key) {
      keys.add(key);
    }
  }

  return keys;
}

function loadPendingSourceAddressKeys() {
  const keysBySource = new Map();

  if (!existsSync(PIPELINE_PATH)) {
    return keysBySource;
  }

  const content = readFileSync(PIPELINE_PATH, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const entry = parsePipelineChecklistLine(line);
    if (!entry) {
      continue;
    }

    if (!entry.addressKey || !entry.platformKey) {
      continue;
    }

    const existingKeys = keysBySource.get(entry.platformKey) ?? new Set();
    existingKeys.add(entry.addressKey);
    keysBySource.set(entry.platformKey, existingKeys);
  }

  return keysBySource;
}

function formatPrice(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

function parsePrice(text) {
  const match = normalizeText(text).match(/\$\s*([\d,]+)/);
  if (!match) {
    return null;
  }
  const amount = Number.parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(amount) ? amount : null;
}

function parseBeds(text) {
  const match = normalizeText(text).match(/(\d+(?:\.\d+)?)\s*(?:bd|bds|bed|beds)\b/i);
  return match ? Number.parseFloat(match[1]) : null;
}

function parseBaths(text) {
  const match = normalizeText(text).match(/(\d+(?:\.\d+)?)\s*(?:ba|bath|baths)\b/i);
  return match ? Number.parseFloat(match[1]) : null;
}

function parseSqft(text) {
  const match = normalizeText(text).match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft)\b/i);
  if (!match) {
    return null;
  }
  const amount = Number.parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(amount) ? amount : null;
}

function parseAgeDays(text) {
  const normalized = normalizeText(text);
  const dayMatch = normalized.match(/(\d+)\s*(?:day|days)\s*(?:on|ago)?/i);
  if (dayMatch) {
    return Number.parseInt(dayMatch[1], 10);
  }

  const hourMatch = normalized.match(/(\d+)\s*(?:hr|hrs|hour|hours)\s+ago/i);
  if (hourMatch) {
    return Number.parseInt(hourMatch[1], 10) / 24;
  }

  if (/\b(new|just listed|today|coming soon)\b/i.test(normalized)) {
    return 0;
  }

  return null;
}

function inferPropertyType(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (normalized.includes('townhome') || normalized.includes('townhouse')) {
    return 'townhouse';
  }
  if (normalized.includes('condo') || normalized.includes('condominium')) {
    return 'condo';
  }
  if (normalized.includes('single family') || normalized.includes('single-family') || normalized.includes('house for sale')) {
    return 'house';
  }
  return null;
}

function parseAddressFromText(text) {
  const match = normalizeText(text).match(ADDRESS_PATTERN);
  return match ? match[0] : null;
}

function splitAddress(address) {
  const clean = normalizeText(address);
  const segments = clean.split(',').map((segment) => segment.trim()).filter(Boolean);
  return {
    address: segments[0] ?? clean,
    city: segments[1] ?? null,
    stateZip: segments[2] ?? null,
  };
}

function deriveAddressFromUrl(platform, url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);

    if (platform === 'zillow') {
      const slug = segments[1] ?? '';
      if (!slug) {
        return null;
      }
      return slug.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    }

    if (platform === 'redfin') {
      const city = segments[2]?.replace(/-/g, ' ') ?? '';
      const slug = segments[3] ?? '';
      if (!slug) {
        return null;
      }
      return `${slug.replace(/-/g, ' ')}, ${city}, NC`;
    }

    if (platform === 'realtor') {
      const slug = segments[1] ?? '';
      if (!slug) {
        return null;
      }

      const parts = slug.split('_').filter(Boolean);
      if (parts.length < 5) {
        return slug.replace(/-/g, ' ').replace(/_/g, ' ');
      }

      const zip = parts[parts.length - 2];
      const state = parts[parts.length - 3];
      const city = parts[parts.length - 4].replace(/-/g, ' ');
      const address = parts[parts.length - 5].replace(/-/g, ' ');
      return `${address}, ${city}, ${state} ${zip}`;
    }

    // homes.com URL format: /property/<address-city-state-zip>/<id>/
    // e.g. /property/123-main-st-apex-nc-27502/12345678/
    if (platform === 'homes') {
      const slug = segments[1] ?? '';
      if (!slug) {
        return null;
      }
      return slug.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    }
  } catch {
    return null;
  }

  return null;
}

function parseCandidate(platform, area, rawItem) {
  const href = canonicalizeUrl(rawItem.href);
  const combinedText = normalizeText([
    rawItem.anchorText,
    rawItem.priceText,
    rawItem.addressText,
    rawItem.metaText,
    rawItem.ariaLabel,
    rawItem.text,
  ].filter(Boolean).join(' '));
  const explicitAddress = parseAddressFromText([
    rawItem.anchorText,
    rawItem.addressText,
    rawItem.text,
    rawItem.ariaLabel,
  ].filter(Boolean).join(' '));
  const fallbackAddress = deriveAddressFromUrl(platform, href);
  const resolvedAddress = explicitAddress ?? fallbackAddress;
  const addressParts = resolvedAddress ? splitAddress(resolvedAddress) : { address: null, city: null, stateZip: null };
  const price = parsePrice(rawItem.priceText ?? combinedText);
  const beds = parseBeds(rawItem.metaText ?? combinedText) ?? parseBeds(rawItem.ariaLabel ?? combinedText);
  const baths = parseBaths(rawItem.metaText ?? combinedText) ?? parseBaths(rawItem.ariaLabel ?? combinedText);
  const sqft = parseSqft(rawItem.metaText ?? combinedText) ?? parseSqft(combinedText);
  const ageDays = parseAgeDays(combinedText);
  const propertyType = inferPropertyType(combinedText);

  return {
    url: href,
    platform,
    area,
    address: addressParts.address,
    city: addressParts.city,
    fullAddress: resolvedAddress,
    price,
    priceText: formatPrice(price),
    beds,
    baths,
    sqft,
    ageDays,
    propertyType,
    rawText: combinedText,
  };
}

function filterCandidate(candidate, requirements) {
  if (candidate.price !== null && (candidate.price < requirements.priceMin || candidate.price > requirements.priceMax)) {
    return 'price outside range';
  }

  if (candidate.beds !== null && candidate.beds < requirements.bedsMin) {
    return 'beds below minimum';
  }

  if (candidate.sqft !== null && candidate.sqft < requirements.sqftMin) {
    return 'square footage below minimum';
  }

  if (candidate.ageDays !== null && candidate.ageDays > requirements.maxListingAgeDays) {
    return 'listing age outside window';
  }

  if (candidate.propertyType && candidate.propertyType !== 'house') {
    return `property type ${candidate.propertyType}`;
  }

  return null;
}

function detectBlockedOrChallenged({ title, bodyText, errorMessage }) {
  const combined = `${title ?? ''}\n${bodyText ?? ''}\n${errorMessage ?? ''}`;
  return BLOCK_PATTERNS.find((pattern) => pattern.test(combined)) ?? null;
}

function buildPipelineLine(candidate, platformName) {
  const fields = [`- [ ] ${candidate.url}`, platformName, candidate.area];
  if (candidate.fullAddress) {
    fields.push(candidate.fullAddress);
  }
  if (candidate.priceText) {
    fields.push(candidate.priceText);
  }
  return fields.join(' | ');
}

function appendPipelineEntries(lines) {
  if (lines.length === 0) {
    return;
  }

  const current = getPipelineDocument();
  const pendingIndex = current.indexOf('## Pending');
  const processedIndex = current.indexOf('\n## Processed', pendingIndex === -1 ? 0 : pendingIndex);

  if (pendingIndex === -1) {
    const updated = `${PIPELINE_TEMPLATE.trimEnd()}\n${lines.join('\n')}\n\n## Processed\n`;
    writeFileSync(PIPELINE_PATH, updated, 'utf8');
    return;
  }

  const insertAt = processedIndex === -1 ? current.length : processedIndex;
  const pendingSection = processedIndex === -1
    ? current.slice(pendingIndex)
    : current.slice(pendingIndex, processedIndex);
  const hasExistingChecklistEntries = /(^|\n)- \[[ x]\]/i.test(pendingSection);
  const before = current.slice(0, insertAt).replace(/\s*$/, hasExistingChecklistEntries ? '\n' : '\n\n');
  const after = current.slice(insertAt).replace(/^\n*/, '\n');
  const updated = `${before}${lines.join('\n')}\n${after}`;
  writeFileSync(PIPELINE_PATH, updated, 'utf8');
}

function appendScanHistory(rows) {
  if (rows.length === 0) {
    return;
  }

  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, HISTORY_HEADER, 'utf8');
  }

  const lines = rows
    .map((row) => [row.url, row.firstSeen, row.platform, row.area, row.address ?? '', row.status].join('\t'))
    .join('\n');

  appendFileSync(SCAN_HISTORY_PATH, `${lines}\n`, 'utf8');
}

function formatCompactThousands(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  if (numeric % 1000 === 0) {
    return String(Math.round(numeric / 1000));
  }

  return Number((numeric / 1000).toFixed(1)).toString();
}

function syncZillowSearchUrl(rawUrl, requirements) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    const rawState = parsed.searchParams.get('searchQueryState');
    const state = rawState
      ? JSON.parse(rawState)
      : { pagination: {}, filterState: {} };
    const filterState = state.filterState ?? {};

    if (requirements.priceMin > 0 || requirements.priceMax < Number.MAX_SAFE_INTEGER) {
      filterState.price = {
        ...(filterState.price ?? {}),
        ...(requirements.priceMin > 0 ? { min: requirements.priceMin } : {}),
        ...(requirements.priceMax < Number.MAX_SAFE_INTEGER ? { max: requirements.priceMax } : {}),
      };
    }

    if (requirements.bedsMin > 0) {
      filterState.beds = {
        ...(filterState.beds ?? {}),
        min: requirements.bedsMin,
      };
    }

    if (requirements.bathsMin > 0) {
      filterState.baths = {
        ...(filterState.baths ?? {}),
        min: requirements.bathsMin,
      };
    }

    if (requirements.sqftMin > 0) {
      filterState.sqft = {
        ...(filterState.sqft ?? {}),
        min: requirements.sqftMin,
      };
    }

    if (requirements.garageMin > 0) {
      filterState.garSp = {
        ...(filterState.garSp ?? {}),
        min: requirements.garageMin,
      };
    }

    if (requirements.maxListingAgeDays < Number.MAX_SAFE_INTEGER) {
      filterState.doz = {
        ...(filterState.doz ?? {}),
        value: String(requirements.maxListingAgeDays),
      };
    }

    if (requirements.hoaMaxMonthly > 0) {
      filterState.hoa = {
        ...(filterState.hoa ?? {}),
        max: requirements.hoaMaxMonthly,
      };
    }

    if (requirements.yearBuiltMin > 0) {
      filterState.built = {
        ...(filterState.built ?? {}),
        min: requirements.yearBuiltMin,
      };
    }

    if (requirements.homeTypePreference === 'resale_only') {
      filterState.isMultiFamily = { value: false };
      filterState.isApartment = { value: false };
      filterState.isCondo = { value: false };
      filterState.isTownhouse = { value: false };
      filterState.isManufactured = { value: false };
      filterState.isLotLand = { value: false };
      filterState.nc = { value: false };
    }

    state.filterState = filterState;
    parsed.searchParams.set('searchQueryState', JSON.stringify(state));
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function redfinDaysOnMarketToken(days) {
  if (days <= 1) return '1day';
  if (days <= 7) return '1wk';
  if (days <= 14) return '2wk';
  if (days <= 30) return '1mo';
  if (days <= 90) return '3mo';
  if (days <= 180) return '6mo';
  return null;
}

function syncRedfinSearchUrl(rawUrl, requirements) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    const [pathnameRoot, rawFilterSegment] = parsed.pathname.split('/filter/');
    const existingTokens = rawFilterSegment ? rawFilterSegment.split(',').filter(Boolean) : [];
    const managedPrefixes = [
      'min-price=', 'max-price=', 'min-beds=', 'min-baths=', 'min-sqft=', 'hoa=',
      'min-parking=', 'min-year-built=', 'max-days-on-market=', 'property-type=', 'include=',
    ];
    const unmanagedTokens = existingTokens.filter((token) => !managedPrefixes.some((prefix) => token.startsWith(prefix)));
    const syncedTokens = [...unmanagedTokens];
    const minPrice = formatCompactThousands(requirements.priceMin);
    const maxPrice = formatCompactThousands(requirements.priceMax);
    const minSqft = formatCompactThousands(requirements.sqftMin);

    if (minPrice) {
      syncedTokens.push(`min-price=${minPrice}k`);
    }

    if (maxPrice && requirements.priceMax < Number.MAX_SAFE_INTEGER) {
      syncedTokens.push(`max-price=${maxPrice}k`);
    }

    if (requirements.bedsMin > 0) {
      syncedTokens.push(`min-beds=${Math.ceil(requirements.bedsMin)}`);
    }

    if (requirements.bathsMin > 0) {
      syncedTokens.push(`min-baths=${requirements.bathsMin}`);
    }

    if (minSqft) {
      syncedTokens.push(`min-sqft=${minSqft}k-sqft`);
    }

    if (requirements.hoaMaxMonthly > 0) {
      syncedTokens.push(`hoa=${requirements.hoaMaxMonthly}`);
    }

    if (requirements.garageMin > 0) {
      syncedTokens.push(`min-parking=${requirements.garageMin}`);
    }

    if (requirements.yearBuiltMin > 0) {
      syncedTokens.push(`min-year-built=${requirements.yearBuiltMin}`);
    }

    if (requirements.maxListingAgeDays < Number.MAX_SAFE_INTEGER) {
      const domToken = redfinDaysOnMarketToken(requirements.maxListingAgeDays);
      if (domToken) {
        syncedTokens.push(`max-days-on-market=${domToken}`);
      }
    }

    if (requirements.homeTypePreference === 'resale_only') {
      syncedTokens.push('property-type=house');
    }

    syncedTokens.push('include=forsale+fsbo');

    parsed.pathname = syncedTokens.length > 0
      ? `${pathnameRoot.replace(/\/+$/, '')}/filter/${syncedTokens.join(',')}`
      : pathnameRoot;
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function syncRealtorSearchUrl(rawUrl, requirements) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) {
      return rawUrl;
    }

    const [searchRoot, areaSegment, ...existingSegments] = segments;
    const managedPrefixes = ['beds-', 'baths-', 'price-', 'sqft-', 'garage-', 'age-', 'hoa-', 'built-after-', 'type-'];
    const unmanagedSegments = existingSegments.filter((segment) => !managedPrefixes.some((prefix) => segment.startsWith(prefix)));
    const syncedSegments = [...unmanagedSegments];

    if (requirements.bedsMin > 0) {
      syncedSegments.push(`beds-${Math.ceil(requirements.bedsMin)}`);
    }

    if (requirements.bathsMin > 0) {
      syncedSegments.push(`baths-${requirements.bathsMin}`);
    }

    if (requirements.priceMin > 0 || requirements.priceMax < Number.MAX_SAFE_INTEGER) {
      const priceMin = requirements.priceMin > 0 ? requirements.priceMin : 0;
      const priceMax = requirements.priceMax < Number.MAX_SAFE_INTEGER ? requirements.priceMax : requirements.priceMin;
      syncedSegments.push(`price-${priceMin}-${priceMax}`);
    }

    if (requirements.sqftMin > 0) {
      syncedSegments.push(`sqft-${requirements.sqftMin}`);
    }

    if (requirements.garageMin > 0) {
      syncedSegments.push(`garage-${requirements.garageMin}`);
    }

    if (requirements.maxListingAgeDays < Number.MAX_SAFE_INTEGER) {
      syncedSegments.push(`age-${requirements.maxListingAgeDays}`);
    }

    if (requirements.hoaMaxMonthly > 0) {
      syncedSegments.push(`hoa-${requirements.hoaMaxMonthly}`);
    }

    if (requirements.yearBuiltMin > 0) {
      syncedSegments.push(`built-after-${requirements.yearBuiltMin}`);
    }

    if (requirements.homeTypePreference === 'resale_only') {
      syncedSegments.push('type-single-family-home');
    }

    parsed.pathname = `/${[searchRoot, areaSegment, ...syncedSegments].join('/')}`;
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function syncHomesSearchUrl(rawUrl, requirements) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    const params = parsed.searchParams;

    const HOMES_QUERY_KEYS = [
      'price-min', 'price-max', 'bath-min', 'bath-max', 'sfmin',
      'yb-min', 'hoa-max', 'gsr-min', 'gsr-max', 'parking', 'dom-max', 'ssit',
    ];
    for (const key of HOMES_QUERY_KEYS) {
      params.delete(key);
    }

    if (requirements.priceMin > 0) {
      params.set('price-min', String(requirements.priceMin));
    }

    if (requirements.priceMax < Number.MAX_SAFE_INTEGER) {
      params.set('price-max', String(requirements.priceMax));
    }

    if (requirements.bathsMin > 0) {
      params.set('bath-min', String(Math.ceil(requirements.bathsMin)));
    }

    if (requirements.sqftMin > 0) {
      params.set('sfmin', String(requirements.sqftMin));
    }

    if (requirements.yearBuiltMin > 0) {
      params.set('yb-min', String(requirements.yearBuiltMin));
    }

    if (requirements.hoaMaxMonthly > 0) {
      params.set('hoa-max', String(requirements.hoaMaxMonthly));
    }

    if (requirements.schoolsMinRating > 0) {
      params.set('gsr-min', String(requirements.schoolsMinRating));
      params.set('gsr-max', '10');
    }

    if (requirements.garageMin > 0) {
      params.set('parking', String(requirements.garageMin));
    }

    if (requirements.maxListingAgeDays < Number.MAX_SAFE_INTEGER) {
      params.set('dom-max', `${requirements.maxListingAgeDays}d`);
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    const baseSegments = [];
    for (const segment of segments) {
      if (segment === 'houses-for-sale') continue;
      if (segment === 'resale' || segment === 'new-construction') continue;
      if (/^\d+(?:-to-\d+)?-bedroom$/.test(segment)) continue;
      baseSegments.push(segment);
    }
    if (requirements.homeTypePreference === 'resale_only') {
      baseSegments.push('resale');
    }
    if (requirements.bedsMin > 0) {
      const min = Math.ceil(requirements.bedsMin);
      baseSegments.push(`${min}-to-${Math.max(min + 1, 5)}-bedroom`);
    }
    parsed.pathname = `/${baseSegments.join('/')}/`;

    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function syncPlatformSearchUrl(platform, rawUrl, requirements) {
  if (platform === 'zillow') {
    return syncZillowSearchUrl(rawUrl, requirements);
  }

  if (platform === 'redfin') {
    return syncRedfinSearchUrl(rawUrl, requirements);
  }

  if (platform === 'realtor') {
    return syncRealtorSearchUrl(rawUrl, requirements);
  }

  if (platform === 'homes') {
    return syncHomesSearchUrl(rawUrl, requirements);
  }

  return rawUrl;
}

function loadPortalsConfig(selectedPlatforms, requirements, excludedPlatforms = new Set()) {
  const parsed = readYamlFile(PORTALS_PATH);
  const platformsNode = parsed.platforms ?? {};
  const configured = {};

  for (const [rawKey, rawValue] of Object.entries(platformsNode)) {
    const key = canonicalPlatformKey(rawKey);
    if (selectedPlatforms.size > 0 && !selectedPlatforms.has(key)) {
      continue;
    }
    if (excludedPlatforms.has(key)) {
      continue;
    }

    if (!rawValue || typeof rawValue !== 'object') {
      continue;
    }

    const searchUrls = Array.isArray(rawValue.search_urls)
      ? rawValue.search_urls
        .map((entry) => ({
          area: String(entry?.area ?? '').trim(),
          url: syncPlatformSearchUrl(key, String(entry?.url ?? '').trim(), requirements),
        }))
        .filter((entry) => entry.url)
      : [];

    if (searchUrls.length === 0) {
      continue;
    }

    configured[key] = {
      name: String(rawValue.name ?? rawKey).trim(),
      loginRequired: rawValue.login_required !== false,
      loginPrompt: String(rawValue.login_prompt ?? '').trim(),
      searchUrls,
    };
  }

  return configured;
}

function loadRequirements(parsed = readYamlFile(PROFILE_PATH)) {
  const hard = parsed.search?.hard_requirements ?? {};
  const soft = parsed.search?.soft_preferences ?? {};

  return {
    priceMin: Number.parseInt(hard.price_min ?? 0, 10),
    priceMax: Number.parseInt(hard.price_max ?? Number.MAX_SAFE_INTEGER, 10),
    bedsMin: Number.parseFloat(hard.beds_min ?? 0),
    bathsMin: Number.parseFloat(hard.baths_min ?? 0),
    garageMin: Number.parseInt(hard.garage_min ?? 0, 10),
    sqftMin: Number.parseInt(hard.sqft_min ?? 0, 10),
    maxListingAgeDays: Number.parseInt(hard.max_listing_age_days ?? Number.MAX_SAFE_INTEGER, 10),
    hoaMaxMonthly: Number.parseInt(soft.hoa_max_monthly ?? 0, 10),
    yearBuiltMin: Number.parseInt(soft.year_built_min ?? 0, 10),
    homeTypePreference: String(hard.home_type_preference ?? '').trim().toLowerCase(),
    schoolsMinRating: Number.parseInt(hard.schools_min_rating ?? 0, 10),
  };
}

function formatRerunCommand(platform) {
  if (platform === 'zillow') {
    return '/home-ops scan --zillow';
  }

  if (platform === 'redfin') {
    return '/home-ops scan --redfin';
  }

  if (platform === 'homes') {
    return '/home-ops scan --homes';
  }

  return '/home-ops scan --relator';
}

function buildManualActionMessage(platform, platformName, area, loginPrompt) {
  if (platform === 'zillow') {
    const prompt = loginPrompt || 'I need the saved Zillow browser session. Run /home-ops init --zillow if needed, sign in manually in the hosted Chrome window, then confirm.';
    return `${platformName} | ${area} | Zillow was skipped for the rest of this scan after a manual sign-in or verification blocker. ${prompt} Clear any press-and-hold or human-verification prompt in the active Zillow tab, then rerun ${formatRerunCommand(platform)}.`;
  }

  return `${platformName} | ${area} | this platform was skipped for the rest of this scan after a login or verification blocker. Check the refreshed hosted browser tab, complete any prompt manually, then rerun ${formatRerunCommand(platform)}.`;
}

function buildBudgetTimeoutResult(platform, platformName, area, url, loginPrompt, budgetMs) {
  return {
    extracted: 0,
    duplicates: 0,
    filtered: 0,
    added: [],
    blockers: [`${platformName} | ${area} | wall-clock budget of ${budgetMs}ms exceeded -- treating as a navigation block`],
    pageAction: 'budget-timeout',
    manualActionRequired: {
      platform,
      platformName,
      area,
      url,
      message: buildManualActionMessage(platform, platformName, area, loginPrompt),
    },
  };
}

async function raceWithBudget(workPromise, budgetMs) {
  let timeoutHandle = null;
  const budgetPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ __budgetExceeded: true }), budgetMs);
  });

  try {
    const winner = await Promise.race([workPromise, budgetPromise]);
    if (winner && winner.__budgetExceeded) {
      workPromise.catch(() => {});
      return null;
    }
    return winner;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function closeBrowserConnection(browser) {
  if (!browser) {
    return;
  }

  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
}

async function scrollToRevealListings(page) {
  try {
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const step = window.innerHeight || 800;
      for (let i = 0; i < 6; i += 1) {
        window.scrollBy(0, step);
        await sleep(350);
      }
      window.scrollTo(0, 0);
      await sleep(200);
    });
  } catch {}
}

async function ensureHostedSession(profileName) {
  const session = await readSessionState(ROOT, profileName);
  if (!session?.data) {
    throw new Error(`No hosted browser session found for profile ${profileName}. Run /home-ops init first.`);
  }

  if (session.data.mode !== 'hosted' || session.data.status !== 'open' || !session.data.cdpUrl) {
    throw new Error(`Hosted browser session ${profileName} is not ready. Run /home-ops init first.`);
  }

  try {
    const response = await fetch(`${session.data.cdpUrl}/json/version`);
    if (!response.ok) {
      throw new Error(`CDP endpoint returned HTTP ${response.status}`);
    }
  } catch (error) {
    throw new Error(`Hosted browser session ${profileName} is not reachable: ${error.message}`);
  }

  return session.data;
}

async function extractRawItems(page, platform) {
  return page.evaluate((activePlatform) => {
    const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const uniqueByHref = new Map();
    const title = document.title ?? '';
    const bodyText = document.body?.innerText ?? '';

    const builders = {
      zillow: () => [...document.querySelectorAll('a[href*="/homedetails/"]')].map((anchor) => {
        const card = anchor.closest('article, li, [data-test*="property-card"], [data-test*="search-card"], [class*="StyledPropertyCard"], [class*="ListItem"]') ?? anchor.parentElement;
        return {
          href: anchor.href,
          anchorText: normalize(anchor.textContent),
          addressText: normalize(card?.querySelector('address')?.textContent),
          priceText: normalize(card?.querySelector('[data-test*="price"], [class*="PropertyCardWrapper__StyledPriceLine"]')?.textContent),
          metaText: normalize(card?.querySelector('[data-test*="property-meta"], [class*="StyledPropertyCardHomeDetails"]')?.textContent),
          ariaLabel: normalize(anchor.getAttribute('aria-label')),
          text: normalize(card?.innerText),
        };
      }),
      redfin: () => [...document.querySelectorAll('a[href*="/home/"]')].map((anchor) => {
        const card = anchor.closest('.HomeCardContainer, .MapHomeCardReact, .bp-Homecard, [class*="Homecard"]') ?? anchor.parentElement;
        const interactive = card?.querySelector('.bp-InteractiveHomecard');
        return {
          href: anchor.href,
          anchorText: normalize(anchor.textContent),
          addressText: normalize(card?.querySelector('.bp-Homecard__Address')?.textContent),
          priceText: normalize(card?.querySelector('[class*="price"], [data-rf-test-id*="price"]')?.textContent),
          metaText: normalize(card?.querySelector('[class*="Stats"], [class*="KeyDetails"], [data-rf-test-id*="abp-beds"], [data-rf-test-id*="abp-sqFt"]')?.textContent),
          ariaLabel: normalize(interactive?.getAttribute('aria-label') ?? card?.getAttribute('aria-label')),
          text: normalize(card?.innerText),
        };
      }),
      realtor: () => [...document.querySelectorAll('a[href*="/realestateandhomes-detail/"]')].map((anchor) => {
        const card = anchor.closest('article, li, section, [data-testid*="card"], [data-testid*="property"], [class*="card"], [class*="property"]') ?? anchor.parentElement;
        return {
          href: anchor.href,
          anchorText: normalize(anchor.textContent),
          addressText: normalize(card?.querySelector('[data-testid*="card-address"], [class*="address"]')?.textContent),
          priceText: normalize(card?.querySelector('[data-testid*="card-price"], [class*="price"]')?.textContent),
          metaText: normalize(card?.querySelector('[data-testid*="property-meta"], [class*="meta"]')?.textContent),
          ariaLabel: normalize(anchor.getAttribute('aria-label')),
          text: normalize(card?.innerText),
        };
      }),
      homes: () => [...document.querySelectorAll('a[href*="/property/"]')].map((anchor) => {
        const card = anchor.closest('article, li, section, [class*="placard"], [class*="property-card"], [class*="PropertyCard"], [class*="listing-card"]') ?? anchor.parentElement;
        return {
          href: anchor.href,
          anchorText: normalize(anchor.textContent),
          addressText: normalize(card?.querySelector('[class*="address"], [class*="Address"]')?.textContent),
          priceText: normalize(card?.querySelector('[class*="price"], [class*="Price"]')?.textContent),
          metaText: normalize(card?.querySelector('[class*="detailed-info"], [class*="property-details"], [class*="PropertyDetails"]')?.textContent),
          ariaLabel: normalize(anchor.getAttribute('aria-label')),
          text: normalize(card?.innerText),
        };
      }),
    };

    const rawItems = builders[activePlatform]?.() ?? [];
    for (const item of rawItems) {
      if (!item.href || uniqueByHref.has(item.href)) {
        continue;
      }
      uniqueByHref.set(item.href, item);
    }

    return {
      title,
      bodyText,
      items: [...uniqueByHref.values()],
    };
  }, platform);
}

async function scanSearchPage(context, platform, platformName, area, url, loginPrompt, requirements, seenUrls, seenTrackedAddressKeys, seenPendingSourceAddressKeys, historyRows, remainingSlots = Number.POSITIVE_INFINITY) {
  let preparedPage;
  try {
    preparedPage = await openOrRefreshSearchPage(context, platform, url);
  } catch (error) {
    const fallbackPage = findReusableSearchPage(context, platform, url);
    await fallbackPage?.bringToFront().catch(() => {});

    historyRows.push({
      url,
      firstSeen: new Date().toISOString().slice(0, 10),
      platform: platformName,
      area,
      address: '',
      status: 'skipped_blocked',
    });
    return {
      extracted: 0,
      duplicates: 0,
      filtered: 0,
      added: [],
      blockers: [`${platformName} | ${area} | ${error.message.split('\n')[0]}`],
      pageAction: 'manual-review-needed',
      manualActionRequired: {
        platform,
        platformName,
        area,
        url,
        message: buildManualActionMessage(platform, platformName, area, loginPrompt),
      },
    };
  }

  const page = preparedPage.page;
  await scrollToRevealListings(page);
  const extracted = await extractRawItems(page, platform);
  const blockMatch = detectBlockedOrChallenged({ title: extracted.title, bodyText: extracted.bodyText });
  if (blockMatch || extracted.items.length === 0) {
    const bodyPreview = normalizeText(extracted.bodyText).slice(0, 140);
    await page.bringToFront().catch(() => {});

    historyRows.push({
      url,
      firstSeen: new Date().toISOString().slice(0, 10),
      platform: platformName,
      area,
      address: '',
      status: 'skipped_blocked',
    });
    return {
      extracted: 0,
      duplicates: 0,
      filtered: 0,
      added: [],
      blockers: [`${platformName} | ${area} | ${bodyPreview || extracted.title || 'no listing cards found'}`],
      pageAction: preparedPage.action,
      manualActionRequired: {
        platform,
        platformName,
        area,
        url,
        message: buildManualActionMessage(platform, platformName, area, loginPrompt),
      },
    };
  }

  let duplicates = 0;
  let filtered = 0;
  const added = [];
  const seenThisPage = new Set();
  const sourceAddressKeys = seenPendingSourceAddressKeys.get(platform) ?? new Set();
  seenPendingSourceAddressKeys.set(platform, sourceAddressKeys);

  for (const rawItem of extracted.items) {
    if (added.length >= remainingSlots) {
      break;
    }

    const candidate = parseCandidate(platform, area, rawItem);
    if (!candidate.url || seenThisPage.has(candidate.url)) {
      continue;
    }
    seenThisPage.add(candidate.url);

    if (SOLD_PATTERNS.some((pattern) => pattern.test(candidate.rawText))) {
      historyRows.push({
        url: candidate.url,
        firstSeen: new Date().toISOString().slice(0, 10),
        platform: platformName,
        area,
        address: candidate.fullAddress ?? '',
        status: 'skipped_sold',
      });
      filtered += 1;
      continue;
    }

    const addressKey = buildAddressKey(candidate.address, candidate.city);
    if (seenUrls.has(candidate.url) || (addressKey && (seenTrackedAddressKeys.has(addressKey) || sourceAddressKeys.has(addressKey)))) {
      duplicates += 1;
      historyRows.push({
        url: candidate.url,
        firstSeen: new Date().toISOString().slice(0, 10),
        platform: platformName,
        area,
        address: candidate.fullAddress ?? '',
        status: 'skipped_dup',
      });
      continue;
    }

    const filterReason = filterCandidate(candidate, requirements);
    if (filterReason) {
      filtered += 1;
      historyRows.push({
        url: candidate.url,
        firstSeen: new Date().toISOString().slice(0, 10),
        platform: platformName,
        area,
        address: candidate.fullAddress ?? '',
        status: 'skipped_filtered',
      });
      continue;
    }

    seenUrls.add(candidate.url);
    if (addressKey) {
      sourceAddressKeys.add(addressKey);
    }
    added.push(candidate);
    historyRows.push({
      url: candidate.url,
      firstSeen: new Date().toISOString().slice(0, 10),
      platform: platformName,
      area,
      address: candidate.fullAddress ?? '',
      status: 'added',
    });
  }

  return {
    extracted: extracted.items.length,
    duplicates,
    filtered,
    added,
    blockers: [],
    pageAction: preparedPage.action,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(HELP_TEXT);
    process.exit(1);
  }

  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  mkdirSync(HOME_OPS_DIR, { recursive: true });
  if (existsSync(SCAN_COMPLETE_PATH)) unlinkSync(SCAN_COMPLETE_PATH);
  writeFileSync(SCAN_RUNNING_PATH, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));

  const session = await ensureHostedSession(options.profileName);
  const profile = readYamlFile(PROFILE_PATH);
  const requirements = loadRequirements(profile);

  // If Zillow was blocked in a previous scan this session, auto-exclude it unless --zillow was explicitly requested
  const autoExcluded = new Set(options.excludedPlatforms);
  if (!options.selectedPlatforms.has('zillow') && existsSync(ZILLOW_BLOCKED_PATH)) {
    try {
      const blockedData = JSON.parse(readFileSync(ZILLOW_BLOCKED_PATH, 'utf8'));
      const ageMs = Date.now() - new Date(blockedData.blocked_at ?? 0).getTime();
      if (ageMs < 24 * 60 * 60 * 1000) { // 24-hour TTL
        console.log('Zillow auto-skipped: bot detection was active in a recent scan. Use --zillow to override.');
        autoExcluded.add('zillow');
      } else {
        unlinkSync(ZILLOW_BLOCKED_PATH); // expired, remove it
      }
    } catch {
      // ignore malformed file
    }
  }

  const portals = loadPortalsConfig(options.selectedPlatforms, requirements, autoExcluded);
  const selectedPlatforms = Object.keys(portals);

  if (selectedPlatforms.length === 0) {
    console.log('No configured platforms matched the requested flags.');
    return;
  }

  console.log(`Reusing hosted Chrome session: ${options.profileName}`);
  console.log(`Platforms requested: ${selectedPlatforms.map((platform) => portals[platform].name).join(', ')}`);
  console.log('Portal search filters synced from config/profile.yml before scanning each configured area.');

  const targetBuckets = collectConfiguredBuckets(portals);
  const refreshResult = refreshPendingBuckets(targetBuckets, DEFAULT_MAX_PENDING_PER_SOURCE_AREA, new Set());
  console.log(`Per-source per-area pending cap: ${DEFAULT_MAX_PENDING_PER_SOURCE_AREA}`);
  console.log('Bucket refill uses current search results rather than scan-history suppression.');
  if (refreshResult.duplicatesRemoved > 0) {
    console.log(`Duplicate pending homes removed before scan: ${refreshResult.duplicatesRemoved}`);
  }

  const seenUrls = loadSeenListingUrls();
  const seenTrackedAddressKeys = loadSeenAddressKeys();
  const seenPendingSourceAddressKeys = loadPendingSourceAddressKeys();
  let pendingCountsByBucket = refreshResult.pendingCounts;
  const addedCountsByBucket = new Map();
  const historyRows = [];
  const addedCandidates = [];
  const blockers = [];
  let extractedCount = 0;
  let duplicateCount = 0;
  let filteredCount = 0;
  const manualActionsRequired = [];
  const blockedPlatforms = new Set();

  const browser = await chromium.connectOverCDP(session.cdpUrl, { timeout: 30000, isLocal: true });
  try {
    console.log(`Connected to hosted Chrome session at ${session.cdpUrl}`);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('Hosted browser session is running, but no default context was exposed.');
    }

    context.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    for (const platform of selectedPlatforms) {
      if (blockedPlatforms.has(platform)) {
        continue;
      }

      const config = portals[platform];
      const sourceKey = canonicalPlatformKey(platform);
      const platformStartedAt = Date.now();
      for (const search of config.searchUrls) {
        if (Date.now() - platformStartedAt > PLATFORM_BUDGET_MS) {
          const areaLabel = search.area || 'Unknown area';
          const blockerMessage = `${config.name} | ${areaLabel} | platform wall-clock budget of ${PLATFORM_BUDGET_MS}ms exceeded -- skipping remaining areas`;
          blockers.push(blockerMessage);
          historyRows.push({
            url: search.url,
            firstSeen: new Date().toISOString().slice(0, 10),
            platform: config.name,
            area: areaLabel,
            address: '',
            status: 'skipped_blocked',
          });
          manualActionsRequired.push({
            platform,
            platformName: config.name,
            area: areaLabel,
            url: search.url,
            message: buildManualActionMessage(platform, config.name, areaLabel, config.loginPrompt),
          });
          blockedPlatforms.add(platform);
          console.log(`Skipping remaining ${config.name} areas for this scan after exceeding the ${PLATFORM_BUDGET_MS}ms platform budget.`);
          break;
        }

        const areaLabel = search.area || 'Unknown area';
        const bucketKey = buildPendingBucketKey(sourceKey, areaLabel);
        let pendingCount = bucketKey ? (pendingCountsByBucket.get(bucketKey)?.count ?? 0) : 0;
        const addedCount = bucketKey ? (addedCountsByBucket.get(bucketKey) ?? 0) : 0;

        if (bucketKey && pendingCount >= DEFAULT_MAX_PENDING_PER_SOURCE_AREA && targetBuckets.has(bucketKey)) {
          const bucketRefreshResult = refreshPendingBuckets(
            new Map([[bucketKey, targetBuckets.get(bucketKey)]]),
            DEFAULT_MAX_PENDING_PER_SOURCE_AREA,
            new Set([bucketKey]),
          );
          pendingCountsByBucket = bucketRefreshResult.pendingCounts;
          pendingCount = pendingCountsByBucket.get(bucketKey)?.count ?? 0;

          const refreshedBucket = bucketRefreshResult.refreshedBuckets.get(bucketKey);
          if (refreshedBucket) {
            const noun = refreshedBucket.removedCount === 1 ? 'entry' : 'entries';
            console.log(`Refreshing ${refreshedBucket.platformLabel} | ${refreshedBucket.areaLabel}: removed ${refreshedBucket.removedCount} pending ${noun} before scanning this area bucket.`);
          }
        }

        const remainingSlots = DEFAULT_MAX_PENDING_PER_SOURCE_AREA - pendingCount - addedCount;

        if (remainingSlots <= 0) {
          console.log(`Skipping ${config.name} | ${areaLabel} because ${config.name} already has ${DEFAULT_MAX_PENDING_PER_SOURCE_AREA} pending slots filled for that area.`);
          continue;
        }

        console.log(`Scanning ${config.name} | ${areaLabel} | remaining slots: ${remainingSlots}`);
        const scanPromise = scanSearchPage(
          context,
          platform,
          config.name,
          areaLabel,
          search.url,
          config.loginPrompt,
          requirements,
          seenUrls,
          seenTrackedAddressKeys,
          seenPendingSourceAddressKeys,
          historyRows,
          remainingSlots,
        );
        let result = await raceWithBudget(scanPromise, SEARCH_PAGE_BUDGET_MS);
        if (result === null) {
          console.log(`Scan of ${config.name} | ${areaLabel} exceeded the ${SEARCH_PAGE_BUDGET_MS}ms per-page budget -- treating as a navigation block.`);
          result = buildBudgetTimeoutResult(platform, config.name, areaLabel, search.url, config.loginPrompt, SEARCH_PAGE_BUDGET_MS);
        }

        extractedCount += result.extracted;
        duplicateCount += result.duplicates;
        filteredCount += result.filtered;
        blockers.push(...result.blockers);
        addedCandidates.push(...result.added.map((candidate) => ({ ...candidate, platformName: config.name })));
        if (bucketKey) {
          addedCountsByBucket.set(bucketKey, addedCount + result.added.length);
        }

        if (result.manualActionRequired) {
          manualActionsRequired.push(result.manualActionRequired);
          blockedPlatforms.add(platform);
          console.log(`Skipping remaining ${config.name} areas for this scan after blocker in ${areaLabel}.`);
          // Write a session-level flag so the next scan auto-skips Zillow (24-hour TTL)
          if (platform === 'zillow') {
            try {
              writeFileSync(ZILLOW_BLOCKED_PATH, JSON.stringify({ blocked_at: new Date().toISOString(), area: areaLabel }));
            } catch { /* non-fatal */ }
          }
          break;
        }
      }
    }
  } finally {
    await closeBrowserConnection(browser);
  }

  const newPipelineLines = addedCandidates.map((candidate) => buildPipelineLine(candidate, candidate.platformName));
  appendPipelineEntries(newPipelineLines);
  appendScanHistory(historyRows);

  if (newPipelineLines.length > 0) {
    console.log(`Pipeline file updated: ${PIPELINE_PATH} (+${newPipelineLines.length} entries)`);
  } else if (refreshResult.duplicatesRemoved > 0) {
    console.log(`Pipeline file updated: ${PIPELINE_PATH} (duplicates removed, no new entries appended)`);
  } else {
    console.log(`Pipeline file not modified: no new entries passed filters (${PIPELINE_PATH})`);
  }

  console.log(`Platforms scanned: ${selectedPlatforms.map((platform) => portals[platform].name).join(', ')}`);
  console.log('Session bootstrap actions taken: reused existing hosted Chrome session and refreshed reusable search tabs');
  console.log(`Candidate listings found: ${extractedCount}`);
  console.log(`Duplicates skipped: ${duplicateCount}`);
  console.log(`Filtered-out listings: ${filteredCount}`);
  console.log(`Listings added to the pipeline: ${addedCandidates.length}`);

  if (addedCandidates.length > 0) {
    console.log('\nAdded listings:');
    for (const candidate of addedCandidates) {
      console.log(`- ${candidate.platformName} | ${candidate.area} | ${candidate.fullAddress ?? candidate.url} | ${candidate.priceText ?? 'price unavailable'}`);
    }
  }

  if (blockers.length > 0) {
    console.log('\nLogin or anti-bot blockers:');
    for (const blocker of blockers) {
      console.log(`- ${blocker}`);
    }
  }

  if (manualActionsRequired.length > 0) {
    console.log('\nManual browser follow-up suggested:');
    for (const action of manualActionsRequired) {
      console.log(`- ${action.message}`);
    }
  }

  if (blockedPlatforms.size > 0) {
    const blockedPlatformLabels = [...blockedPlatforms]
      .map((platform) => portals[platform]?.name ?? platform)
      .join(', ');
    console.log(`\nPlatforms skipped for the rest of this scan after blockers: ${blockedPlatformLabels}`);
  }

  if (addedCandidates.length === 0) {
    console.log(blockedPlatforms.size > 0
      ? '\nNo new listings qualify from unblocked platforms.'
      : '\nNo new listings qualify.');
  }

  writeFileSync(SCAN_COMPLETE_PATH, JSON.stringify({ completed_at: new Date().toISOString(), added: addedCandidates.length }));
  process.exit(0);
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exit(1);
});