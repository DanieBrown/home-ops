#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import YAML from 'yaml';
import { readSessionState } from './browser-session.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
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
const NAVIGATION_TIMEOUT_MS = 20000;
const SETTLE_TIMEOUT_MS = 2500;

const PLATFORM_FLAG_MAP = {
  '--zillow': 'zillow',
  '--redfin': 'redfin',
  '--realtor': 'realtor',
  '--realtor.com': 'realtor',
  '--relator': 'realtor',
};

const DETAIL_URL_PATTERNS = {
  zillow: /\/homedetails\//i,
  redfin: /\/home\//i,
  realtor: /\/realestateandhomes-detail\//i,
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

const HELP_TEXT = `Usage:
  node scan-listings.mjs
  node scan-listings.mjs --zillow --redfin --relator
  node scan-listings.mjs --profile chrome-host

Options:
  --zillow      Scan Zillow only.
  --redfin      Scan Redfin only.
  --relator     Scan Realtor.com only.
  --realtor     Backward-compatible alias for --relator.
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

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeAddress(value) {
  return normalizeStreetSuffixes(String(value ?? '').toLowerCase())
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCity(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
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
    address: columns[2],
    city: columns[3],
  };
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
  const before = current.slice(0, insertAt).replace(/\s*$/, '\n');
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

function loadPortalsConfig(selectedPlatforms) {
  const parsed = readYamlFile(PORTALS_PATH);
  const platformsNode = parsed.platforms ?? {};
  const configured = {};

  for (const [rawKey, rawValue] of Object.entries(platformsNode)) {
    const key = canonicalPlatformKey(rawKey);
    if (selectedPlatforms.size > 0 && !selectedPlatforms.has(key)) {
      continue;
    }

    if (!rawValue || typeof rawValue !== 'object') {
      continue;
    }

    const searchUrls = Array.isArray(rawValue.search_urls)
      ? rawValue.search_urls
        .map((entry) => ({
          area: String(entry?.area ?? '').trim(),
          url: String(entry?.url ?? '').trim(),
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

function loadRequirements() {
  const parsed = readYamlFile(PROFILE_PATH);
  const hard = parsed.search?.hard_requirements ?? {};

  return {
    priceMin: Number.parseInt(hard.price_min ?? 0, 10),
    priceMax: Number.parseInt(hard.price_max ?? Number.MAX_SAFE_INTEGER, 10),
    bedsMin: Number.parseFloat(hard.beds_min ?? 0),
    sqftMin: Number.parseInt(hard.sqft_min ?? 0, 10),
    maxListingAgeDays: Number.parseInt(hard.max_listing_age_days ?? Number.MAX_SAFE_INTEGER, 10),
  };
}

function formatRerunCommand(platform) {
  if (platform === 'zillow') {
    return '/home-ops scan --zillow';
  }

  if (platform === 'redfin') {
    return '/home-ops scan --redfin';
  }

  return '/home-ops scan --relator';
}

function buildManualActionMessage(platform, platformName, area, loginPrompt) {
  if (platform === 'zillow') {
    const prompt = loginPrompt || 'I need the saved Zillow browser session. Run /home-ops init --zillow if needed, sign in manually in the hosted Chrome window, then confirm.';
    return `${platformName} | ${area} | Zillow requires manual sign-in confirmation before scan continues. ${prompt} Clear any press-and-hold or human-verification prompt in the active Zillow tab, then rerun ${formatRerunCommand(platform)}.`;
  }

  return `${platformName} | ${area} | check the refreshed hosted browser tab for a press-and-hold or similar verification prompt, complete it manually, then rerun ${formatRerunCommand(platform)}.`;
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

  const session = await ensureHostedSession(options.profileName);
  const requirements = loadRequirements();
  const portals = loadPortalsConfig(options.selectedPlatforms);
  const selectedPlatforms = Object.keys(portals);

  if (selectedPlatforms.length === 0) {
    console.log('No configured platforms matched the requested flags.');
    return;
  }

  console.log(`Reusing hosted Chrome session: ${options.profileName}`);
  console.log(`Platforms requested: ${selectedPlatforms.map((platform) => portals[platform].name).join(', ')}`);

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
  let manualActionRequired = null;

  const browser = await chromium.connectOverCDP(session.cdpUrl, { timeout: 30000, isLocal: true });
  try {
    console.log(`Connected to hosted Chrome session at ${session.cdpUrl}`);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('Hosted browser session is running, but no default context was exposed.');
    }

    outerLoop:
    for (const platform of selectedPlatforms) {
      const config = portals[platform];
      const sourceKey = canonicalPlatformKey(platform);
      for (const search of config.searchUrls) {
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
        const result = await scanSearchPage(
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

        extractedCount += result.extracted;
        duplicateCount += result.duplicates;
        filteredCount += result.filtered;
        blockers.push(...result.blockers);
        addedCandidates.push(...result.added.map((candidate) => ({ ...candidate, platformName: config.name })));
        if (bucketKey) {
          addedCountsByBucket.set(bucketKey, addedCount + result.added.length);
        }

        if (result.manualActionRequired) {
          manualActionRequired = result.manualActionRequired;
          break outerLoop;
        }
      }
    }
  } finally {
    await closeBrowserConnection(browser);
  }

  appendPipelineEntries(addedCandidates.map((candidate) => buildPipelineLine(candidate, candidate.platformName)));
  appendScanHistory(historyRows);

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

  if (manualActionRequired) {
    console.log('\nManual browser check required:');
    console.log(`- ${manualActionRequired.message}`);
    process.exit(2);
  }

  if (!manualActionRequired && addedCandidates.length === 0) {
    console.log('\nNo new listings qualify.');
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exit(1);
});