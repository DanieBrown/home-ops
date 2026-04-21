#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  connectToSavedBrowserSession,
  readSessionState,
} from '../browser/browser-session.mjs';
import {
  extractRoadHints,
  extractSchoolNames,
  extractSubdivisionHints,
  loadResearchConfig,
  normalizeKey,
  parseReport,
  parseShortlist,
} from '../research/research-utils.mjs';
import {
  CACHE_TTL,
  getCacheEntry,
  isCacheFresh,
  loadCache,
  pruneCache,
  putCacheEntry,
  saveCache,
  ttlForVerification,
} from '../system/cache-utils.mjs';
import { slugify as slugifyBase } from '../shared/text-utils.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const LISTINGS_PATH = join(ROOT, 'data', 'listings.md');
const REPORTS_DIR = join(ROOT, 'reports');
const SHORTLIST_PATH = join(ROOT, 'data', 'shortlist.md');
const ADDITIONS_DIR = join(ROOT, 'batch', 'tracker-additions');
const PACKETS_DIR = join(ROOT, 'output', 'evaluate-packets');

const DEFAULT_PROFILE = 'chrome-host';
const DEFAULT_LIMIT = 0;
const NAVIGATION_TIMEOUT_MS = 20000;
const SETTLE_TIMEOUT_MS = 1500;

const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US');

const PLATFORM_LABELS = {
  zillow: 'Zillow',
  redfin: 'Redfin',
  realtor: 'Realtor.com',
  'local-report': 'Local report',
  other: 'Other source',
};

const PLATFORM_PRIORITY = {
  'local-report': 0,
  zillow: 1,
  redfin: 2,
  realtor: 3,
  other: 4,
};

const BLOCK_PATTERNS = [
  /press\s*&?\s*hold/i,
  /access to this page has been denied/i,
  /verify you are a human/i,
  /captcha/i,
  /reference id/i,
  /processing your request/i,
  /unusual traffic/i,
  /pardon our interruption/i,
  /request unsuccessful/i,
  /err_blocked_by_response/i,
  /temporarily unavailable/i,
  /challenge/i,
];

const BLOCK_ERROR_PATTERNS = [
  /ERR_BLOCKED_BY_RESPONSE/i,
  /ERR_HTTP2_PROTOCOL_ERROR/i,
  /ERR_ABORTED/i,
  /Timeout .* exceeded/i,
];

const INACTIVE_URL_PATTERNS = [
  /off-market/i,
  /sold/i,
  /pending/i,
  /delisted/i,
  /removed/i,
];

const INACTIVE_HEADLINE_PATTERNS = [
  /off market/i,
  /no longer available/i,
  /listing (has been )?removed/i,
  /property (is )?no longer available/i,
  /this home is no longer/i,
  /delisted/i,
  /withdrawn from market/i,
  /sold\s+on\s+/i,
  /pending/i,
  /under contract/i,
  /contingent/i,
  /page not found/i,
  /404/i,
];

const ACTIVE_PATTERNS = [
  /schedule (a )?tour/i,
  /request (a )?tour/i,
  /contact (an )?(agent|realtor)/i,
  /ask a question/i,
  /save (this )?(home|listing)/i,
  /facts and features/i,
  /property details/i,
  /est\.? payment/i,
  /monthly payment/i,
  /get pre-?qualified/i,
  /for sale/i,
  /open house/i,
];

const ADDRESS_PATTERN = /\b\d{1,5}\s+[A-Za-z0-9.'# -]+\s+(street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|circle|cir|boulevard|blvd|way|place|pl|parkway|pkwy|trail|trl|terrace|ter|highway|hwy)\b/i;
const FULL_ADDRESS_PATTERN = /(\d{1,5}\s+[A-Za-z0-9.'# -]+?),\s*([A-Za-z .'-]+),\s*([A-Z]{2})(?:\s+(\d{5}))?/i;
const INLINE_ADDRESS_PATTERN = /(\d{1,5}\s+[A-Za-z0-9.'# -]+?)\s+([A-Za-z .'-]+)\s+(NC|SC|VA|GA|TN)\s+(\d{5})/i;
const REPORT_FILENAME_PATTERN = /^(\d+)-(.+)-(\d{4}-\d{2}-\d{2})\.md$/i;

const HELP_TEXT = `Usage:
  node evaluate-pending.mjs
  node evaluate-pending.mjs --profile chrome-host
  node evaluate-pending.mjs --packets-only --limit 5

Processes unchecked entries in data/pipeline.md as one canonical home per property.

Options:
  --profile <name>       Hosted browser profile to reuse. Defaults to chrome-host.
  --limit <count>        Process at most this many canonical homes. Defaults to all.
  --packets-only         Prepare one packet per canonical home without writing reports or tracker updates.
  --skip-merge           Leave staged TSV additions in batch/tracker-additions/ without merging them.
  --skip-review-tabs     Do not open shortlist review tabs after writing data/shortlist.md.
  --skip-audit           Do not run research-coverage-audit.mjs on newly written reports.
  --no-cache             Skip the extraction cache so every URL is freshly scraped.
  --refresh-cache        Re-scrape every URL but still update the cache with the new result.
  --help                 Show this help text.
`;

function canonicalizeUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl ?? '').trim());
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return String(rawUrl ?? '').trim();
  }
}

function normalizeStreetSuffixes(value) {
  return String(value ?? '')
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
    .replace(/\btrl\b/g, 'trail')
    .replace(/\bter\b/g, 'terrace')
    .replace(/\bbnd\b/g, 'bend')
    .replace(/\bgrv\b/g, 'grove')
    .replace(/\bhwy\b/g, 'highway');
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

function buildAddressKey(address, city) {
  if (!address || !city) {
    return null;
  }

  return `${normalizeAddress(address)}::${normalizeCity(city)}`;
}

function formatDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function formatRunId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function slugify(value) {
  return slugifyBase(value).slice(0, 80) || 'listing';
}

function detectPlatformFromUrl(value) {
  const url = String(value ?? '').toLowerCase();
  if (url.includes('zillow.com')) {
    return 'zillow';
  }
  if (url.includes('redfin.com')) {
    return 'redfin';
  }
  if (url.includes('realtor.com')) {
    return 'realtor';
  }
  return 'other';
}

function platformLabel(platformKey) {
  return PLATFORM_LABELS[platformKey] ?? PLATFORM_LABELS.other;
}

function parseArgs(argv) {
  const config = {
    profileName: DEFAULT_PROFILE,
    limit: DEFAULT_LIMIT,
    packetsOnly: false,
    skipMerge: false,
    skipReviewTabs: false,
    skipAudit: false,
    noCache: false,
    refreshCache: false,
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

    if (arg === '--limit') {
      const value = Number.parseInt(argv[index + 1] ?? '', 10);
      if (Number.isNaN(value) || value < 0) {
        throw new Error('Expected a non-negative integer after --limit.');
      }
      config.limit = value;
      index += 1;
      continue;
    }

    if (arg === '--packets-only') {
      config.packetsOnly = true;
      continue;
    }

    if (arg === '--skip-merge') {
      config.skipMerge = true;
      continue;
    }

    if (arg === '--skip-review-tabs') {
      config.skipReviewTabs = true;
      continue;
    }

    if (arg === '--skip-audit') {
      config.skipAudit = true;
      continue;
    }

    if (arg === '--no-cache') {
      config.noCache = true;
      continue;
    }

    if (arg === '--refresh-cache') {
      config.refreshCache = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (!config.profileName) {
    throw new Error('Expected a profile name after --profile.');
  }

  return config;
}

function safeParseNumber(value) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).replace(/[^0-9.]+/g, ' ').trim();
  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }

  const number = Number.parseFloat(match[0]);
  return Number.isFinite(number) ? number : null;
}

function parseCurrency(value) {
  if (value == null) {
    return null;
  }

  const match = String(value).replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)/);
  if (!match) {
    return null;
  }

  const number = Number.parseFloat(match[1]);
  return Number.isFinite(number) ? number : null;
}

function parseBedsBaths(value) {
  const text = String(value ?? '');
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g)];
  if (matches.length > 0) {
    return {
      beds: Number.parseFloat(matches[0][1]),
      baths: Number.parseFloat(matches[0][2]),
    };
  }

  const bedMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:bd|beds?|bedrooms?)/i);
  const bathMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:ba|baths?|bathrooms?)/i);
  return {
    beds: bedMatch ? Number.parseFloat(bedMatch[1]) : null,
    baths: bathMatch ? Number.parseFloat(bathMatch[1]) : null,
  };
}

function formatCurrency(number) {
  if (!Number.isFinite(number)) {
    return 'Unknown';
  }

  return `$${CURRENCY_FORMATTER.format(Math.round(number))}`;
}

function formatNumber(number) {
  if (!Number.isFinite(number)) {
    return 'Unknown';
  }

  if (Number.isInteger(number)) {
    return CURRENCY_FORMATTER.format(number);
  }

  return String(number);
}

function formatBedsBaths(beds, baths) {
  if (!Number.isFinite(beds) && !Number.isFinite(baths)) {
    return 'Unknown';
  }

  const bedText = Number.isFinite(beds) ? String(Number.isInteger(beds) ? beds : beds.toFixed(1)) : '?';
  const bathText = Number.isFinite(baths) ? String(Number.isInteger(baths) ? baths : baths.toFixed(1)) : '?';
  return `${bedText}/${bathText}`;
}

function formatSqft(value) {
  return Number.isFinite(value) ? CURRENCY_FORMATTER.format(Math.round(value)) : 'Unknown';
}

function formatScore(score) {
  if (!Number.isFinite(score)) {
    return 'Unknown';
  }

  return `${score.toFixed(1)}/5`;
}

function capitalizeWords(value) {
  return String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function splitAddressParts(value, fallbackCity = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return {
      address: '',
      city: fallbackCity,
      state: '',
      zip: '',
    };
  }

  let match = text.match(FULL_ADDRESS_PATTERN);
  if (match) {
    return {
      address: match[1].trim(),
      city: match[2].trim(),
      state: match[3].trim().toUpperCase(),
      zip: match[4] ?? '',
    };
  }

  match = text.match(INLINE_ADDRESS_PATTERN);
  if (match) {
    return {
      address: match[1].trim(),
      city: match[2].trim(),
      state: match[3].trim().toUpperCase(),
      zip: match[4] ?? '',
    };
  }

  return {
    address: text,
    city: fallbackCity,
    state: '',
    zip: '',
  };
}

function formatFullAddress(facts) {
  const address = String(facts.address ?? '').trim();
  const city = String(facts.city ?? '').trim();
  const state = String(facts.state ?? '').trim();
  const zip = String(facts.zip ?? '').trim();
  return [
    address,
    [city, state].filter(Boolean).join(', '),
    zip,
  ].filter(Boolean).join(' ').replace(/\s+,/g, ',').trim();
}

function chooseFirst(...values) {
  for (const value of values) {
    if (value == null) {
      continue;
    }

    if (typeof value === 'string' && !value.trim()) {
      continue;
    }

    return value;
  }

  return null;
}

function extractMeta(snapshot, key) {
  return snapshot.meta?.[key] ?? '';
}

function collectObjects(node, bucket = []) {
  if (Array.isArray(node)) {
    node.forEach((entry) => collectObjects(entry, bucket));
    return bucket;
  }

  if (!node || typeof node !== 'object') {
    return bucket;
  }

  bucket.push(node);
  for (const value of Object.values(node)) {
    collectObjects(value, bucket);
  }
  return bucket;
}

function getNumericField(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      const value = object?.[key];
      if (value == null) {
        continue;
      }

      if (typeof value === 'object') {
        const nested = chooseFirst(value.value, value.maxValue, value.minValue, value.amount, value.price);
        const parsed = safeParseNumber(nested);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }

      const parsed = safeParseNumber(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function getStringField(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      const value = object?.[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }

      if (value && typeof value === 'object') {
        const nested = chooseFirst(value.name, value.text, value.value);
        if (typeof nested === 'string' && nested.trim()) {
          return nested.trim();
        }
      }
    }
  }

  return '';
}

function extractStructuredData(jsonLd) {
  const objects = collectObjects(jsonLd, []);
  const addressObject = objects
    .map((entry) => entry?.address)
    .find((entry) => entry && typeof entry === 'object');

  const offerObjects = objects.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    if (Array.isArray(entry.offers)) {
      return entry.offers.filter((offer) => offer && typeof offer === 'object');
    }
    return entry.offers && typeof entry.offers === 'object' ? [entry.offers] : [];
  });

  const floorSize = getNumericField(objects, ['floorSize', 'livingArea', 'floor_size', 'size']);
  const price = getNumericField([...offerObjects, ...objects], ['price', 'lowPrice', 'highPrice']);

  return {
    address: addressObject?.streetAddress ?? '',
    city: addressObject?.addressLocality ?? '',
    state: addressObject?.addressRegion ?? '',
    zip: addressObject?.postalCode ?? '',
    price,
    beds: getNumericField(objects, ['numberOfBedrooms', 'bedrooms', 'beds', 'numberOfRooms']),
    baths: getNumericField(objects, ['numberOfBathroomsTotal', 'numberOfBathrooms', 'bathrooms', 'baths']),
    sqft: floorSize,
    lotSize: getStringField(objects, ['lotSize', 'lot_size', 'lotArea', 'lot']),
    yearBuilt: getNumericField(objects, ['yearBuilt']),
    propertyType: getStringField(objects, ['@type', 'propertyType', 'additionalType']),
    description: chooseFirst(getStringField(objects, ['description']), ''),
  };
}

function parseSchoolRatings(text) {
  const matches = [];
  const seen = new Set();
  const regex = /([A-Z][A-Za-z0-9.'& -]+?(?:Elementary|Middle|High|Academy|School))[^\n]{0,80}?(\d{1,2})\s*\/\s*10/g;
  for (const match of text.matchAll(regex)) {
    const key = match[1].trim().toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    matches.push({ name: match[1].trim(), rating: Number.parseInt(match[2], 10) });
  }
  return matches.slice(0, 5);
}

function parseDaysOnMarket(text) {
  const content = String(text ?? '');
  const hoursMatch = content.match(/(\d+)\s+hours?\s+(?:on\s+(?:zillow|redfin|realtor)|on\s+market|ago)/i);
  if (hoursMatch) {
    return {
      text: `${hoursMatch[1]} hours on market`,
      days: Number.parseInt(hoursMatch[1], 10) / 24,
    };
  }

  const daysMatch = content.match(/(\d+)\s+days?\s+(?:on\s+(?:zillow|redfin|realtor)|on\s+market|ago)/i);
  if (daysMatch) {
    return {
      text: `${daysMatch[1]} days on market`,
      days: Number.parseInt(daysMatch[1], 10),
    };
  }

  return { text: '', days: null };
}

const HOA_LABEL = '(?:monthly\\s+hoa|hoa(?:\\s+(?:fee|fees|dues))?|association\\s+fee)';

function parseHoa(text) {
  const content = String(text ?? '');

  if (/\b(?:no\s+hoa|hoa(?:\s+(?:fee|fees|dues))?\s*[\s:\-]+(?:none|\$0(?:\.00)?\b))/i.test(content)) {
    return { text: 'No HOA', monthly: 0 };
  }

  const annualMatch = content.match(new RegExp(`${HOA_LABEL}[\\s\\S]{0,80}?\\$\\s*([\\d,]+(?:\\.\\d+)?)\\s*(?:annually|yearly|a year|\\/yr|\\/year|per\\s+year)`, 'i'));
  if (annualMatch) {
    const annual = Number.parseFloat(annualMatch[1].replace(/,/g, ''));
    return {
      text: `$${CURRENCY_FORMATTER.format(Math.round(annual))} annually ($${Math.round(annual / 12)}/mo)`,
      monthly: annual / 12,
    };
  }

  const monthlyMatch = content.match(new RegExp(`${HOA_LABEL}[\\s\\S]{0,80}?\\$\\s*([\\d,]+(?:\\.\\d+)?)\\s*(?:monthly|month|\\/mo|\\/month|per\\s+month|a\\s+month)`, 'i'));
  if (monthlyMatch) {
    const monthly = Number.parseFloat(monthlyMatch[1].replace(/,/g, ''));
    return {
      text: `$${CURRENCY_FORMATTER.format(Math.round(monthly))}/mo`,
      monthly,
    };
  }

  const bareMatch = content.match(new RegExp(`${HOA_LABEL}[\\s\\S]{0,40}?\\$\\s*([\\d,]+(?:\\.\\d+)?)\\b`, 'i'));
  if (bareMatch) {
    const amount = Number.parseFloat(bareMatch[1].replace(/,/g, ''));
    if (Number.isFinite(amount) && amount > 0 && amount < 2000) {
      return {
        text: `$${CURRENCY_FORMATTER.format(Math.round(amount))}/mo (assumed monthly, no explicit cadence)`,
        monthly: amount,
      };
    }
  }

  return { text: '', monthly: null };
}

function parseGarageSpaces(text) {
  const match = String(text ?? '').match(/(\d+)\s*(?:car|garage)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseLot(text) {
  const lotMatch = String(text ?? '').match(/([\d,.]+\s*(?:sq\.?\s*ft|sqft|square feet|acres?))/i);
  return lotMatch ? lotMatch[1].replace(/\s+/g, ' ').trim() : '';
}

function normalizePropertyType(value, text) {
  const candidate = `${String(value ?? '')} ${String(text ?? '')}`.toLowerCase();
  if (candidate.includes('townhome') || candidate.includes('townhouse')) {
    return 'Townhome';
  }
  if (candidate.includes('condo') || candidate.includes('condominium')) {
    return 'Condo';
  }
  if (candidate.includes('single family') || candidate.includes('single-family') || candidate.includes('house')) {
    return 'Single-family';
  }
  if (candidate.includes('new construction') || candidate.includes('to be built')) {
    return 'New construction';
  }
  return capitalizeWords(String(value ?? '').replace(/https?:\/\/schema\.org\//i, '').replace(/[-_]/g, ' ').trim());
}

function parseListingFacts(snapshot, entry) {
  const structured = extractStructuredData(snapshot.jsonLd ?? []);
  const combined = [
    snapshot.title,
    snapshot.headings.join('\n'),
    extractMeta(snapshot, 'og:title'),
    extractMeta(snapshot, 'description'),
    extractMeta(snapshot, 'og:description'),
    snapshot.bodyText,
  ].join('\n');

  const addressParts = splitAddressParts(
    chooseFirst(
      [structured.address, structured.city, structured.state, structured.zip].filter(Boolean).join(', '),
      extractMeta(snapshot, 'og:title'),
      snapshot.title,
      entry.addressLine,
      entry.address,
    ) ?? '',
    entry.city || entry.area,
  );

  const explicitAddressMatch = combined.match(FULL_ADDRESS_PATTERN) ?? combined.match(INLINE_ADDRESS_PATTERN);
  if (!addressParts.address && explicitAddressMatch) {
    addressParts.address = explicitAddressMatch[1].trim();
    addressParts.city = explicitAddressMatch[2].trim();
    addressParts.state = explicitAddressMatch[3].trim().toUpperCase();
    addressParts.zip = explicitAddressMatch[4] ?? '';
  }

  if (!addressParts.city && entry.area) {
    addressParts.city = entry.area;
  }

  const priceNumber = chooseFirst(
    structured.price,
    parseCurrency(extractMeta(snapshot, 'og:description')),
    parseCurrency(extractMeta(snapshot, 'description')),
    parseCurrency(snapshot.title),
    parseCurrency(snapshot.bodyText),
    parseCurrency(entry.price),
  );

  const cardFacts = `${extractMeta(snapshot, 'og:description')} ${extractMeta(snapshot, 'description')} ${snapshot.headings.join(' ')} ${snapshot.bodyText.slice(0, 8000)}`;
  const bedBathFacts = parseBedsBaths(cardFacts);
  const sqft = chooseFirst(
    structured.sqft,
    safeParseNumber(cardFacts.match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft|square feet)/i)?.[1]),
  );
  const yearBuilt = chooseFirst(
    structured.yearBuilt,
    safeParseNumber(cardFacts.match(/(?:built\s+in|year built[:\s]+)(\d{4})/i)?.[1]),
  );
  const garageSpaces = parseGarageSpaces(cardFacts);
  const hoaSearchText = `${extractMeta(snapshot, 'og:description')} ${extractMeta(snapshot, 'description')} ${snapshot.headings.join(' ')} ${snapshot.bodyText}`;
  const hoa = parseHoa(hoaSearchText);
  const daysOnMarket = parseDaysOnMarket(cardFacts);
  const schoolRatings = parseSchoolRatings(cardFacts);
  const description = chooseFirst(structured.description, extractMeta(snapshot, 'description'), extractMeta(snapshot, 'og:description'), '').trim();
  const subdivisionMatch = cardFacts.match(/(?:subdivision|community|neighborhood)[:\s]+([A-Z][A-Za-z0-9'& -]+)/i);

  return {
    address: addressParts.address,
    city: addressParts.city,
    state: addressParts.state || 'NC',
    zip: addressParts.zip,
    fullAddress: formatFullAddress(addressParts),
    priceNumber: Number.isFinite(priceNumber) ? priceNumber : null,
    priceText: Number.isFinite(priceNumber) ? formatCurrency(priceNumber) : String(entry.price ?? '').trim() || 'Unknown',
    beds: Number.isFinite(bedBathFacts.beds) ? bedBathFacts.beds : Number.isFinite(structured.beds) ? structured.beds : null,
    baths: Number.isFinite(bedBathFacts.baths) ? bedBathFacts.baths : Number.isFinite(structured.baths) ? structured.baths : null,
    sqft: Number.isFinite(sqft) ? sqft : null,
    lotText: chooseFirst(structured.lotSize, parseLot(cardFacts), ''),
    yearBuilt: Number.isFinite(yearBuilt) ? yearBuilt : null,
    garageSpaces: Number.isFinite(garageSpaces) ? garageSpaces : null,
    hoaText: hoa.text,
    hoaMonthly: Number.isFinite(hoa.monthly) ? hoa.monthly : null,
    daysOnMarketText: daysOnMarket.text,
    daysOnMarket: Number.isFinite(daysOnMarket.days) ? daysOnMarket.days : null,
    schoolRatings,
    propertyType: normalizePropertyType(structured.propertyType, cardFacts),
    subdivision: subdivisionMatch ? subdivisionMatch[1].trim() : '',
    description,
    rawText: cardFacts,
  };
}

function countCoreFacts(facts) {
  return [facts.priceNumber, facts.beds, facts.baths, facts.sqft, facts.yearBuilt]
    .filter((value) => Number.isFinite(value)).length;
}

function classifyVerification(snapshot, response, navigationError, facts, entry) {
  const finalUrl = snapshot.url || entry.url;
  const combined = [
    snapshot.title,
    snapshot.headings.join('\n'),
    extractMeta(snapshot, 'og:title'),
    extractMeta(snapshot, 'description'),
    extractMeta(snapshot, 'og:description'),
    snapshot.bodyText,
    navigationError?.message ?? '',
  ].join('\n');
  const headlineText = [
    snapshot.title,
    snapshot.headings.join('\n'),
    extractMeta(snapshot, 'og:title'),
    extractMeta(snapshot, 'description'),
    snapshot.bodyText.slice(0, 2500),
  ].join('\n');
  const hasAddress = Boolean(facts.address && facts.city) || ADDRESS_PATTERN.test(combined);
  const hasCoreFacts = countCoreFacts(facts) >= 2;
  const activeControls = ACTIVE_PATTERNS.some((pattern) => pattern.test(combined));
  const blockedByText = BLOCK_PATTERNS.some((pattern) => pattern.test(combined));
  const blockedByError = BLOCK_ERROR_PATTERNS.some((pattern) => pattern.test(navigationError?.message ?? ''));
  const inactiveByHeadline = INACTIVE_HEADLINE_PATTERNS.some((pattern) => pattern.test(headlineText));
  const responseStatus = response?.status() ?? 0;

  if (responseStatus === 404 || responseStatus === 410) {
    return { status: 'inactive', reason: `HTTP ${responseStatus}` };
  }

  if (blockedByText || blockedByError) {
    return { status: 'blocked', reason: 'portal access or anti-bot challenge blocked the detail page' };
  }

  if (INACTIVE_URL_PATTERNS.some((pattern) => pattern.test(finalUrl)) && !activeControls && !hasCoreFacts) {
    return { status: 'inactive', reason: `redirected to inactive URL: ${finalUrl}` };
  }

  if (inactiveByHeadline && !activeControls) {
    return { status: 'inactive', reason: 'inactive listing language detected near the page headline' };
  }

  if (activeControls && (hasAddress || hasCoreFacts)) {
    return { status: 'active', reason: 'active listing controls and core facts detected' };
  }

  if (hasAddress && hasCoreFacts) {
    return { status: 'active', reason: 'address and listing facts detected even without visible tour controls' };
  }

  if (navigationError && !hasAddress && !hasCoreFacts) {
    return { status: 'blocked', reason: `navigation error: ${navigationError.message.split('\n')[0]}` };
  }

  if (hasAddress || hasCoreFacts) {
    return { status: 'active', reason: 'partial listing detail detected; treating as active with low confidence' };
  }

  return { status: 'blocked', reason: 'insufficient listing detail detected' };
}

async function scrollToFullyLoad(page) {
  try {
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const step = window.innerHeight || 800;
      let lastHeight = -1;
      let stable = 0;
      for (let i = 0; i < 24; i += 1) {
        const docHeight = document.body?.scrollHeight ?? 0;
        if (docHeight === lastHeight) {
          stable += 1;
          if (stable >= 2) break;
        } else {
          stable = 0;
        }
        lastHeight = docHeight;
        window.scrollBy(0, step);
        await sleep(220);
      }
      window.scrollTo(0, 0);
      await sleep(120);
    });
  } catch {}
}

async function capturePageSnapshot(page) {
  return page.evaluate(() => {
    const meta = {};
    for (const element of document.querySelectorAll('meta[name], meta[property]')) {
      const key = element.getAttribute('property') || element.getAttribute('name');
      const value = element.getAttribute('content');
      if (!key || !value) {
        continue;
      }

      meta[key] = value;
    }

    const headings = Array.from(document.querySelectorAll('h1, h2'))
      .map((element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean)
      .slice(0, 12);

    const jsonLd = [];
    for (const element of document.querySelectorAll('script[type="application/ld+json"]')) {
      const raw = element.textContent?.trim();
      if (!raw) {
        continue;
      }

      try {
        jsonLd.push(JSON.parse(raw));
      } catch {
        continue;
      }
    }

    return {
      url: window.location.href,
      title: document.title ?? '',
      bodyText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 60000),
      headings,
      meta,
      jsonLd: jsonLd.slice(0, 25),
    };
  });
}

function buildEntryFromColumns(trimmed, columns, index) {
  const value = columns[0].replace(/^- \[[ x]\]\s*/i, '').trim();
  const platform = columns[1] ?? platformLabel(detectPlatformFromUrl(value));
  const area = columns[2] ?? '';
  const addressLine = columns[3] ?? '';
  const price = columns[4] ?? '';
  const parsedAddress = splitAddressParts(addressLine, area);

  if (!value || value.includes('<file>.md')) {
    return null;
  }

  return {
    index,
    originalLine: trimmed,
    checked: /^- \[x\]/i.test(trimmed),
    inputType: value.startsWith('local:reports/') ? 'local-report' : 'url',
    rawValue: value,
    url: value.startsWith('http') ? value : '',
    canonicalUrl: value.startsWith('http') ? canonicalizeUrl(value) : '',
    reportPath: value.startsWith('local:reports/') ? value.replace(/^local:/i, '') : '',
    platformKey: value.startsWith('local:reports/') ? 'local-report' : detectPlatformFromUrl(value),
    platformLabel: platform.trim() || platformLabel(detectPlatformFromUrl(value)),
    area,
    addressLine,
    address: parsedAddress.address,
    city: parsedAddress.city,
    state: parsedAddress.state,
    zip: parsedAddress.zip,
    price,
  };
}

function buildEntryFromBareLine(trimmed, index) {
  const value = trimmed.replace(/^-\s*/, '').trim();
  if (!value || value.includes('<file>.md')) {
    return null;
  }

  if (!value.startsWith('http') && !value.startsWith('local:reports/')) {
    return null;
  }

  return {
    index,
    originalLine: trimmed,
    checked: false,
    inputType: value.startsWith('local:reports/') ? 'local-report' : 'url',
    rawValue: value,
    url: value.startsWith('http') ? value : '',
    canonicalUrl: value.startsWith('http') ? canonicalizeUrl(value) : '',
    reportPath: value.startsWith('local:reports/') ? value.replace(/^local:/i, '') : '',
    platformKey: value.startsWith('local:reports/') ? 'local-report' : detectPlatformFromUrl(value),
    platformLabel: value.startsWith('local:reports/') ? platformLabel('local-report') : platformLabel(detectPlatformFromUrl(value)),
    area: '',
    addressLine: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    price: '',
  };
}

async function readPipelineDocument() {
  if (!existsSync(PIPELINE_PATH)) {
    throw new Error('data/pipeline.md is missing.');
  }

  const content = await readFile(PIPELINE_PATH, 'utf8');
  if (!content.includes('## Pending') || !content.includes('## Processed')) {
    throw new Error('data/pipeline.md does not contain the expected Pending and Processed sections.');
  }

  return content;
}

function getPipelineSectionIndices(lines) {
  const pendingIndex = lines.findIndex((line) => line.trim() === '## Pending');
  const processedIndex = lines.findIndex((line, index) => index > pendingIndex && line.trim() === '## Processed');
  return { pendingIndex, processedIndex };
}

function parsePendingEntries(content) {
  const lines = content.split(/\r?\n/);
  const { pendingIndex, processedIndex } = getPipelineSectionIndices(lines);
  if (pendingIndex === -1 || processedIndex === -1) {
    throw new Error('Unable to find Pending and Processed sections in data/pipeline.md.');
  }

  const templateLines = [];
  const entries = [];
  let inExampleBlock = false;

  for (let index = pendingIndex + 1; index < processedIndex; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === 'Example:') {
      inExampleBlock = true;
      templateLines.push(line);
      continue;
    }

    if (inExampleBlock) {
      templateLines.push(line);
      if (!trimmed) {
        inExampleBlock = false;
      }
      continue;
    }

    const checklistEntry = trimmed.startsWith('- [') ? buildEntryFromColumns(trimmed, trimmed.split('|').map((value) => value.trim()), index) : null;
    const entry = checklistEntry ?? buildEntryFromBareLine(trimmed, index);
    if (entry && !entry.checked) {
      entries.push(entry);
      continue;
    }

    templateLines.push(line);
  }

  return {
    lines,
    pendingIndex,
    processedIndex,
    templateLines,
    entries,
    processedLines: lines.slice(processedIndex + 1).filter((line) => line.trim()),
  };
}

function sortSources(entries) {
  return [...entries].sort((left, right) => {
    const leftRank = PLATFORM_PRIORITY[left.platformKey] ?? PLATFORM_PRIORITY.other;
    const rightRank = PLATFORM_PRIORITY[right.platformKey] ?? PLATFORM_PRIORITY.other;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return left.index - right.index;
  });
}

function groupPendingEntries(entries) {
  const groups = new Map();

  for (const entry of entries) {
    const key = buildAddressKey(entry.address, entry.city)
      ?? (entry.inputType === 'local-report' ? entry.reportPath.toLowerCase() : entry.canonicalUrl);
    if (!key) {
      continue;
    }

    const existing = groups.get(key) ?? {
      key,
      firstIndex: entry.index,
      entries: [],
    };
    existing.entries.push(entry);
    existing.firstIndex = Math.min(existing.firstIndex, entry.index);
    groups.set(key, existing);
  }

  return [...groups.values()]
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map((group, index) => ({
      workItemId: `work-${index + 1}`,
      firstIndex: group.firstIndex,
      entries: sortSources(group.entries),
    }));
}

function parseListingsTracker(content) {
  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || trimmed.includes('|---')) {
      continue;
    }

    const columns = trimmed.split('|').slice(1, -1).map((value) => value.trim());
    if (columns.length !== 11 || columns[0] === '#') {
      continue;
    }

    const reportMatch = columns[9].match(/\[(\d+)\]\(([^)]+)\)/);
    rows.push({
      trackerNumber: Number.parseInt(columns[0], 10),
      date: columns[1],
      address: columns[2],
      city: columns[3],
      price: columns[4],
      bedsBaths: columns[5],
      sqft: columns[6],
      score: columns[7],
      status: columns[8],
      reportNumber: reportMatch ? Number.parseInt(reportMatch[1], 10) : null,
      reportPath: reportMatch ? reportMatch[2] : '',
      notes: columns[10],
    });
  }
  return rows;
}

async function loadExistingContext() {
  const trackerMap = new Map();
  if (existsSync(LISTINGS_PATH)) {
    const trackerContent = await readFile(LISTINGS_PATH, 'utf8');
    for (const row of parseListingsTracker(trackerContent)) {
      const key = buildAddressKey(row.address, row.city);
      if (key) {
        trackerMap.set(key, row);
      }
    }
  }

  const reportMap = new Map();
  if (existsSync(REPORTS_DIR)) {
    for (const fileName of readdirSync(REPORTS_DIR).filter((name) => name.endsWith('.md') && !name.startsWith('deep-')).sort()) {
      const reportPath = join('reports', fileName).replace(/\\/g, '/');
      try {
        const report = parseReport(ROOT, reportPath);
        const key = buildAddressKey(report.address, report.city);
        const numberMatch = fileName.match(REPORT_FILENAME_PATTERN);
        const reportNumber = numberMatch ? Number.parseInt(numberMatch[1], 10) : null;
        if (!key) {
          continue;
        }

        const existing = reportMap.get(key);
        if (!existing || (reportNumber ?? 0) > (existing.reportNumber ?? 0)) {
          reportMap.set(key, { report, reportPath, reportNumber });
        }
      } catch {
        continue;
      }
    }
  }

  const shortlistMap = new Map();
  if (existsSync(SHORTLIST_PATH)) {
    try {
      const shortlist = parseShortlist(ROOT, SHORTLIST_PATH);
      shortlist.top10.forEach((row) => {
        shortlistMap.set(normalizeKey(row.address, row.city), row);
      });
    } catch {
      // Ignore malformed shortlist state.
    }
  }

  return {
    trackerMap,
    reportMap,
    shortlistMap,
  };
}

function getNextReportNumber(reportMap, trackerMap) {
  const numbers = [
    ...[...reportMap.values()].map((entry) => entry.reportNumber ?? 0),
    ...[...trackerMap.values()].map((entry) => entry.reportNumber ?? 0),
  ];
  return Math.max(0, ...numbers) + 1;
}

async function ensureHostedSession(profileName) {
  const savedState = await readSessionState(ROOT, profileName);
  if (!savedState?.data?.cdpUrl || savedState?.data?.mode !== 'hosted') {
    throw new Error(`Hosted browser session ${profileName} is not available. Run /home-ops init or npm.cmd run browser:setup first.`);
  }

  return connectToSavedBrowserSession({
    projectRoot: ROOT,
    profileName,
    targets: ['about:blank'],
  });
}

function summarizeSnapshot(snapshot) {
  return {
    title: snapshot.title,
    url: snapshot.url,
    headings: snapshot.headings,
    description: chooseFirst(extractMeta(snapshot, 'description'), extractMeta(snapshot, 'og:description'), ''),
    excerpt: snapshot.bodyText.slice(0, 1200),
  };
}

const EXTRACTION_CACHE_NAME = 'extraction';

function buildExtractionCacheKey(entry) {
  return canonicalizeUrl(entry.canonicalUrl || entry.url || '').toLowerCase();
}

function reviveCachedAttempt(cached, entry) {
  return {
    inputType: 'url',
    platformKey: entry.platformKey,
    platformLabel: entry.platformLabel,
    url: entry.url,
    canonicalUrl: entry.canonicalUrl,
    finalUrl: cached.finalUrl || entry.url,
    verification: cached.verification,
    responseStatus: cached.responseStatus ?? 0,
    navigationError: cached.navigationError ?? '',
    facts: cached.facts,
    snapshot: cached.snapshot,
    fromCache: true,
  };
}

async function extractFromBrowserCached(context, entry, cacheState) {
  const key = buildExtractionCacheKey(entry);
  const cache = cacheState?.cache;

  if (cache && !cacheState.disabled && !cacheState.refresh && key) {
    const existing = getCacheEntry(cache, key);
    const ttlMs = existing ? ttlForVerification(existing.verification?.status) : 0;
    if (existing && isCacheFresh(existing, ttlMs)) {
      cacheState.hits += 1;
      return reviveCachedAttempt(existing, entry);
    }
  }

  const attempt = await extractFromBrowser(context, entry);
  cacheState.misses += 1;

  if (cache && !cacheState.disabled && key && attempt?.verification?.status) {
    putCacheEntry(cache, key, {
      verification: attempt.verification,
      facts: attempt.facts,
      snapshot: attempt.snapshot,
      finalUrl: attempt.finalUrl,
      responseStatus: attempt.responseStatus,
      navigationError: attempt.navigationError,
    });
    cacheState.dirty = true;
  }

  return attempt;
}

async function extractFromBrowser(context, entry) {
  const page = await context.newPage();
  let response = null;
  let navigationError = null;

  try {
    try {
      response = await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    } catch (error) {
      navigationError = error;
    }

    await page.waitForTimeout(SETTLE_TIMEOUT_MS);
    await scrollToFullyLoad(page);
    const snapshot = await capturePageSnapshot(page);
    const facts = parseListingFacts(snapshot, entry);
    const verification = classifyVerification(snapshot, response, navigationError, facts, entry);

    return {
      inputType: 'url',
      platformKey: entry.platformKey,
      platformLabel: entry.platformLabel,
      url: entry.url,
      canonicalUrl: entry.canonicalUrl,
      finalUrl: snapshot.url || entry.url,
      verification,
      responseStatus: response?.status() ?? 0,
      navigationError: navigationError ? navigationError.message.split('\n')[0] : '',
      facts,
      snapshot: summarizeSnapshot(snapshot),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function parseReportMetadataNumber(value) {
  return safeParseNumber(String(value ?? '').replace(/,/g, ''));
}

function buildLocalReportFacts(report) {
  const metadata = report.metadata;
  const addressParts = {
    address: report.address,
    city: report.city,
    state: report.state,
    zip: '',
  };
  const bedBaths = parseBedsBaths(metadata.bedsBaths);
  return {
    address: addressParts.address,
    city: addressParts.city,
    state: addressParts.state,
    zip: addressParts.zip,
    fullAddress: formatFullAddress(addressParts),
    priceNumber: parseCurrency(metadata.price),
    priceText: metadata.price || 'Unknown',
    beds: bedBaths.beds,
    baths: bedBaths.baths,
    sqft: parseReportMetadataNumber(metadata.sqft),
    lotText: metadata.lot,
    yearBuilt: parseReportMetadataNumber(metadata.yearBuilt),
    garageSpaces: parseGarageSpaces(report.content),
    hoaText: metadata.hoa,
    hoaMonthly: parseHoa(metadata.hoa).monthly,
    daysOnMarketText: metadata.daysOnMarket,
    daysOnMarket: parseDaysOnMarket(metadata.daysOnMarket).days,
    schoolRatings: [],
    propertyType: '',
    subdivision: extractSubdivisionHints(report)[0] ?? '',
    description: report.sections['Quick Take'] || '',
    rawText: report.content,
  };
}

function buildResearchTargets(facts, portals, existingReport = null) {
  const subdivisionHints = existingReport ? extractSubdivisionHints(existingReport) : [facts.subdivision].filter(Boolean);
  const roadHints = existingReport ? extractRoadHints(existingReport) : [];
  const schoolNames = existingReport
    ? extractSchoolNames(existingReport)
    : facts.schoolRatings.map((entry) => entry.name).filter(Boolean);

  const neighborhood = [
    ...subdivisionHints,
    `${facts.city} neighborhood safety`,
    `${facts.city} traffic`,
  ].filter(Boolean);

  const schools = schoolNames.length > 0
    ? schoolNames
    : [`${facts.address} assigned schools`, `${facts.city} school ratings`].filter(Boolean);

  const development = [
    ...subdivisionHints.map((hint) => `${hint} site plan`),
    ...roadHints,
    `${facts.city} road widening`,
    `${facts.city} planning`,
  ].filter(Boolean);

  return {
    neighborhood: [...new Set(neighborhood)].slice(0, 6),
    schools: [...new Set(schools)].slice(0, 6),
    development: [...new Set(development)].slice(0, 6),
    sources: {
      neighborhood: Object.keys(portals.sentiment_sources ?? {}),
      schools: Object.keys(portals.school_sources ?? {}),
      development: Object.keys(portals.development_sources ?? {}),
    },
  };
}

function parseExistingReportNumber(reportPath) {
  const match = basename(reportPath).match(REPORT_FILENAME_PATTERN);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function extractFromLocalReport(entry, portals) {
  if (!existsSync(join(ROOT, entry.reportPath))) {
    return {
      inputType: 'local-report',
      platformKey: 'local-report',
      platformLabel: platformLabel('local-report'),
      url: '',
      canonicalUrl: '',
      finalUrl: '',
      verification: { status: 'blocked', reason: `Missing local report: ${entry.reportPath}` },
      responseStatus: 0,
      navigationError: '',
      facts: {
        address: entry.address,
        city: entry.city || entry.area,
        state: entry.state,
        zip: entry.zip,
        fullAddress: formatFullAddress(entry),
        priceNumber: parseCurrency(entry.price),
        priceText: entry.price || 'Unknown',
        beds: null,
        baths: null,
        sqft: null,
        lotText: '',
        yearBuilt: null,
        garageSpaces: null,
        hoaText: '',
        hoaMonthly: null,
        daysOnMarketText: '',
        daysOnMarket: null,
        schoolRatings: [],
        propertyType: '',
        subdivision: '',
        description: '',
        rawText: '',
      },
      snapshot: {
        title: '',
        url: '',
        headings: [],
        description: '',
        excerpt: '',
      },
      report: null,
      researchTargets: {
        neighborhood: [],
        schools: [],
        development: [],
        sources: {
          neighborhood: Object.keys(portals.sentiment_sources ?? {}),
          schools: Object.keys(portals.school_sources ?? {}),
          development: Object.keys(portals.development_sources ?? {}),
        },
      },
    };
  }

  const report = parseReport(ROOT, entry.reportPath);
  return {
    inputType: 'local-report',
    platformKey: 'local-report',
    platformLabel: platformLabel('local-report'),
    url: report.metadata.url,
    canonicalUrl: report.metadata.url ? canonicalizeUrl(report.metadata.url) : '',
    finalUrl: report.metadata.url,
    verification: { status: report.metadata.verification || 'report', reason: 'reused existing report content' },
    responseStatus: 0,
    navigationError: '',
    facts: buildLocalReportFacts(report),
    snapshot: {
      title: report.title,
      url: report.metadata.url,
      headings: [],
      description: report.sections['Quick Take'] || '',
      excerpt: report.sections['Quick Take'] || '',
    },
    report,
    researchTargets: buildResearchTargets(buildLocalReportFacts(report), portals, report),
  };
}

function verificationRank(status) {
  switch (String(status ?? '').toLowerCase()) {
    case 'active':
      return 4;
    case 'report':
      return 3;
    case 'inactive':
      return 2;
    case 'blocked':
      return 1;
    default:
      return 0;
  }
}

function evidenceRichness(evidence) {
  return countCoreFacts(evidence.facts) + (evidence.facts.schoolRatings?.length ?? 0);
}

function chooseBestAttempt(attempts) {
  return [...attempts].sort((left, right) => {
    const verificationDelta = verificationRank(right.verification.status) - verificationRank(left.verification.status);
    if (verificationDelta !== 0) {
      return verificationDelta;
    }

    const richnessDelta = evidenceRichness(right) - evidenceRichness(left);
    if (richnessDelta !== 0) {
      return richnessDelta;
    }

    const priorityDelta = (PLATFORM_PRIORITY[left.platformKey] ?? PLATFORM_PRIORITY.other) - (PLATFORM_PRIORITY[right.platformKey] ?? PLATFORM_PRIORITY.other);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return 0;
  })[0] ?? null;
}

function mergeCanonicalHomes(workItems) {
  const merged = new Map();

  for (const item of workItems) {
    const bestAttempt = chooseBestAttempt(item.attempts);
    const key = buildAddressKey(bestAttempt?.facts?.address, bestAttempt?.facts?.city) ?? item.workItemId;
    const existing = merged.get(key) ?? {
      workItemIds: [],
      entries: [],
      attempts: [],
      bestAttempt: null,
    };
    existing.workItemIds.push(item.workItemId);
    existing.entries.push(...item.entries);
    existing.attempts.push(...item.attempts);
    existing.bestAttempt = chooseBestAttempt(existing.attempts);
    merged.set(key, existing);
  }

  return [...merged.values()];
}

function detectAreaMatch(city, areas) {
  const normalizedCity = normalizeCity(city);
  if (!normalizedCity) {
    return null;
  }

  return areas.find((entry) => normalizeCity(entry.name) === normalizedCity) ?? null;
}

function detectSignals(facts) {
  const text = String(facts.rawText ?? '').toLowerCase();
  return {
    fencedYard: /fenced yard|fenced backyard|fenced in yard|fenced/i.test(text),
    usableYard: /backyard|yard|patio|deck|screened porch|fire pit|play/i.test(text),
    busyRoadRisk: /busy road|cut-through|high traffic|traffic noise|backs to .*road|backs to .*highway|adjacent to .*road/i.test(text),
    floodRisk: /flood zone|floodplain|drainage/i.test(text),
    commercialRisk: /backs to commercial|backs to retail|backs to highway/i.test(text),
    newConstruction: /new construction|to be built|proposed construction|under construction/i.test(text),
  };
}

function buildGateRows(facts, profile, areaMatch) {
  const requirements = profile.search?.hard_requirements ?? {};
  const softPreferences = profile.search?.soft_preferences ?? {};
  const schoolAverage = facts.schoolRatings.length > 0
    ? facts.schoolRatings.reduce((sum, entry) => sum + entry.rating, 0) / facts.schoolRatings.length
    : null;
  const signals = detectSignals(facts);

  const rows = [
    {
      label: 'Price',
      pass: Number.isFinite(facts.priceNumber) ? facts.priceNumber <= requirements.price_max && facts.priceNumber >= requirements.price_min : null,
      note: Number.isFinite(facts.priceNumber)
        ? `${formatCurrency(facts.priceNumber)} versus ${formatCurrency(requirements.price_min)} to ${formatCurrency(requirements.price_max)}`
        : 'Listing price still needs validation.',
      critical: true,
    },
    {
      label: 'Bedrooms',
      pass: Number.isFinite(facts.beds) ? facts.beds >= requirements.beds_min : null,
      note: Number.isFinite(facts.beds) ? `${facts.beds} bedrooms` : 'Bedroom count still needs validation.',
      critical: true,
    },
    {
      label: 'Garage',
      pass: Number.isFinite(facts.garageSpaces) ? facts.garageSpaces >= requirements.garage_min : null,
      note: Number.isFinite(facts.garageSpaces) ? `${facts.garageSpaces} garage spaces` : 'Garage count still needs validation.',
      critical: true,
    },
    {
      label: 'Living space',
      pass: Number.isFinite(facts.sqft) ? facts.sqft >= requirements.sqft_min : null,
      note: Number.isFinite(facts.sqft) ? `${formatSqft(facts.sqft)} sq ft` : 'Square footage still needs validation.',
      critical: true,
    },
    {
      label: 'Schools',
      pass: Number.isFinite(schoolAverage) ? schoolAverage >= requirements.schools_min_rating : null,
      note: Number.isFinite(schoolAverage)
        ? `Average visible school signal: ${schoolAverage.toFixed(1)}/10`
        : 'Assigned-school quality still needs direct confirmation.',
      critical: true,
    },
    {
      label: 'Listing age',
      pass: Number.isFinite(facts.daysOnMarket) ? facts.daysOnMarket <= requirements.max_listing_age_days : null,
      note: facts.daysOnMarketText || 'Listing freshness still needs validation.',
      critical: false,
    },
    {
      label: 'Home type',
      pass: facts.propertyType ? !/townhome|condo/i.test(facts.propertyType) : null,
      note: facts.propertyType || 'Home type still needs validation.',
      critical: true,
    },
    {
      label: 'Yard usability',
      pass: signals.usableYard ? true : null,
      note: signals.fencedYard
        ? 'Fenced-yard language is visible in the detail page.'
        : signals.usableYard
          ? 'Outdoor-use language is visible, but it still needs a tour-level check.'
          : requirements.yard || 'Yard fit still needs a direct site check.',
      critical: false,
    },
    {
      label: 'Target area fit',
      pass: areaMatch ? true : null,
      note: areaMatch ? `${areaMatch.name} is a configured search area (rank ${areaMatch.rank}).` : `${facts.city || 'This city'} is outside the named search-area list.`,
      critical: false,
    },
    {
      label: 'HOA burden',
      pass: Number.isFinite(facts.hoaMonthly) ? facts.hoaMonthly <= softPreferences.hoa_max_monthly : null,
      note: facts.hoaText || 'HOA terms still need validation.',
      critical: false,
    },
  ];

  return { rows, schoolAverage, signals };
}

function roundScore(value) {
  return Math.round(value * 10) / 10;
}

function scoreHome(facts, profile, areaMatch, verificationStatus) {
  const { rows, schoolAverage, signals } = buildGateRows(facts, profile, areaMatch);
  const requirements = profile.search?.hard_requirements ?? {};
  const softPreferences = profile.search?.soft_preferences ?? {};
  const criticalMisses = rows.filter((row) => row.critical && row.pass === false).length;
  const unknownCritical = rows.filter((row) => row.critical && row.pass == null).length;
  let score = 2.2;

  if (verificationStatus === 'inactive') {
    return {
      rows,
      schoolAverage,
      signals,
      score: 1.2,
      recommendation: 'Pass',
      status: 'Sold',
      confidence: 'High',
      criticalMisses,
      unknownCritical,
    };
  }

  if (verificationStatus === 'blocked') {
    score -= 0.4;
  }

  if (Number.isFinite(facts.priceNumber)) {
    if (facts.priceNumber >= requirements.price_min && facts.priceNumber <= requirements.price_max) {
      score += 0.45;
    } else if (facts.priceNumber > requirements.price_max) {
      score -= facts.priceNumber > requirements.price_max + 25000 ? 0.6 : 0.3;
    } else {
      score -= 0.2;
    }
  } else {
    score -= 0.1;
  }

  if (Number.isFinite(facts.beds)) {
    score += facts.beds >= requirements.beds_min ? 0.3 : -0.45;
  } else {
    score -= 0.1;
  }

  if (Number.isFinite(facts.garageSpaces)) {
    score += facts.garageSpaces >= requirements.garage_min ? 0.2 : -0.35;
  } else {
    score -= 0.05;
  }

  if (Number.isFinite(facts.sqft)) {
    score += facts.sqft >= requirements.sqft_min ? 0.35 : -0.35;
  } else {
    score -= 0.1;
  }

  if (Number.isFinite(schoolAverage)) {
    if (schoolAverage >= 8) {
      score += 0.45;
    } else if (schoolAverage >= requirements.schools_min_rating) {
      score += 0.2;
    } else {
      score -= 0.45;
    }
  } else {
    score -= 0.1;
  }

  if (Number.isFinite(facts.daysOnMarket)) {
    if (facts.daysOnMarket <= requirements.max_listing_age_days) {
      score += 0.2;
    } else if (facts.daysOnMarket > requirements.max_listing_age_days + 14) {
      score -= 0.25;
    }
  }

  if (Number.isFinite(facts.yearBuilt) && Number.isFinite(softPreferences.year_built_min)) {
    score += facts.yearBuilt >= softPreferences.year_built_min ? 0.15 : -0.2;
  }

  if (Number.isFinite(facts.hoaMonthly) && Number.isFinite(softPreferences.hoa_max_monthly)) {
    score += facts.hoaMonthly <= softPreferences.hoa_max_monthly ? 0.1 : -0.15;
  }

  if (areaMatch) {
    score += Math.max(0.05, 0.32 - ((areaMatch.rank - 1) * 0.08));
  } else {
    score -= 0.05;
  }

  if (signals.fencedYard) {
    score += 0.2;
  } else if (signals.usableYard) {
    score += 0.1;
  }

  if (/townhome|condo/i.test(facts.propertyType)) {
    score -= 0.9;
  }

  if (signals.newConstruction && requirements.home_type_preference === 'resale_preferred') {
    score -= 0.25;
  }

  if (signals.busyRoadRisk) {
    score -= 0.25;
  }

  if (signals.floodRisk) {
    score -= 0.25;
  }

  if (signals.commercialRisk) {
    score -= 0.2;
  }

  if (criticalMisses === 0 && verificationStatus === 'active' && Number.isFinite(schoolAverage) && schoolAverage >= 8) {
    score += 0.2;
  }

  score = Math.min(5, Math.max(1, roundScore(score)));

  let recommendation = 'Pass';
  let status = 'SKIP';
  if (criticalMisses === 0 && score >= 4.1 && verificationStatus !== 'blocked') {
    recommendation = 'Pursue now';
    status = 'Evaluated';
  } else if (criticalMisses <= 1 && score >= 3.5) {
    recommendation = 'Worth touring';
    status = 'Evaluated';
  } else if (score >= 2.8) {
    recommendation = 'Hold pending validation';
    status = 'Evaluated';
  }

  let confidence = 'Low';
  if (verificationStatus === 'active' && countCoreFacts(facts) >= 4 && facts.schoolRatings.length > 0) {
    confidence = 'High';
  } else if (verificationStatus !== 'blocked' && countCoreFacts(facts) >= 3) {
    confidence = 'Medium';
  }

  if (unknownCritical >= 3) {
    confidence = 'Low';
  }

  return {
    rows,
    schoolAverage,
    signals,
    score,
    recommendation,
    status,
    confidence,
    criticalMisses,
    unknownCritical,
  };
}

function buildTrackerNote(result) {
  if (result.status === 'Sold') {
    return 'Off-market listing with clear hard-requirement misses, so it is closed out.';
  }
  if (result.recommendation === 'Pursue now') {
    return 'Strong current fit with credible school signal and manageable remaining validation work.';
  }
  if (result.recommendation === 'Worth touring') {
    return 'Good overall fit, but still needs targeted follow-up on traffic, planning, or neighborhood signal.';
  }
  if (result.recommendation === 'Hold pending validation') {
    return result.criticalMisses > 0
      ? 'Paper fit is decent, but hard-gate misses or key validation gaps still block a stronger move.'
      : 'Paper fit is decent, but key validation gaps still block a stronger move.';
  }
  return 'Misses enough of the buyer brief that it should stay out of the active shortlist.';
}

function deriveStatusFromRecommendation(recommendation, verification = '') {
  const normalizedRecommendation = String(recommendation ?? '').trim().toLowerCase();
  const normalizedVerification = String(verification ?? '').trim().toLowerCase();

  if (normalizedVerification === 'inactive') {
    return 'Sold';
  }

  if (normalizedRecommendation === 'pass') {
    return 'SKIP';
  }

  return 'Evaluated';
}

function buildQuickTake(facts, result, areaMatch) {
  const city = facts.city || areaMatch?.name || 'the target market';
  if (result.status === 'Sold') {
    return `This listing no longer appears to be active, so it should not stay in the live search queue.`;
  }
  if (result.recommendation === 'Pursue now') {
    return `Strong fit in ${city}: the visible hard-requirement signals clear the current bar, and the remaining risk items look manageable enough to move quickly.`;
  }
  if (result.recommendation === 'Worth touring') {
    return `Good paper fit in ${city}. The core home facts line up, but the next step should still validate neighborhood, traffic, and school details before escalation.`;
  }
  if (result.recommendation === 'Hold pending validation') {
    return `The home has enough paper fit to keep alive for now, but missing facts or soft-risk questions still prevent a stronger recommendation.`;
  }
  return `This home misses enough of the active brief that it should stay out of the shortlist unless the buyer priorities change.`;
}

function buildSummaryCard(facts, result, areaMatch) {
  const areaText = areaMatch ? `${areaMatch.name} rank ${areaMatch.rank}` : `${facts.city || 'Unmapped city'} is outside the ranked area list`;
  const schoolText = facts.schoolRatings.length > 0
    ? facts.schoolRatings.map((entry) => `${entry.name}: ${entry.rating}/10`).join('; ')
    : 'Assigned-school signal still needs direct confirmation.';
  return [
    ['Hard requirement fit', result.criticalMisses === 0 ? 'No visible critical miss' : `${result.criticalMisses} visible critical miss(es)`],
    ['Area fit', areaText],
    ['School signal', schoolText],
    ['Risk posture', result.recommendation === 'Pursue now' ? 'Manageable follow-up only' : 'Needs targeted follow-up before escalation'],
  ];
}

function toGateResultText(value) {
  if (value === true) {
    return 'Pass';
  }
  if (value === false) {
    return 'Miss';
  }
  return 'Needs validation';
}

function buildPropertyFit(facts, result, areaMatch) {
  const statements = [];
  if (Number.isFinite(facts.sqft) || Number.isFinite(facts.beds) || Number.isFinite(facts.baths)) {
    statements.push(`The visible listing facts show ${formatBedsBaths(facts.beds, facts.baths)} beds/baths across ${formatSqft(facts.sqft)} square feet.`);
  }
  if (Number.isFinite(facts.garageSpaces)) {
    statements.push(`${facts.garageSpaces} garage-space signal is visible.`);
  }
  if (facts.propertyType) {
    statements.push(`The current property-type read is ${facts.propertyType}.`);
  }
  if (facts.subdivision) {
    statements.push(`The page references ${facts.subdivision} as the neighborhood or subdivision context.`);
  }
  if (result.signals.fencedYard) {
    statements.push('Outdoor-use language suggests a fenced or otherwise family-usable yard, which fits the brief better than a nominal lot-size pass alone.');
  } else if (result.signals.usableYard) {
    statements.push('Outdoor-use language is visible, but the yard still needs an on-site usability check.');
  }
  if (!areaMatch) {
    statements.push('This city is outside the currently ranked search-area list, which limits the upside even if the home facts are acceptable.');
  }

  return statements.join(' ');
}

function buildNeighborhoodSection(facts, result) {
  const city = facts.city || 'the area';
  const lines = [];
  lines.push(`This deterministic batch pass did not run a fresh Facebook or Nextdoor neighborhood read, so treat the sentiment view as preliminary.`);
  lines.push(`If this home survives triage, use the hosted browser to check recent Facebook groups, Nextdoor posts, and a map-level street read for ${city}.`);
  if (result.signals.busyRoadRisk) {
    lines.push('The listing language itself raises a traffic or busy-road question, so street noise and cut-through patterns should be part of the next review pass.');
  } else {
    lines.push('Nothing in the extracted listing text alone creates a major neighborhood red flag, but that is not a substitute for real local-source validation.');
  }
  return lines.join(' ');
}

function buildSchoolSection(facts) {
  if (facts.schoolRatings.length > 0) {
    return `The page exposes a usable GreatSchools-style signal: ${facts.schoolRatings.map((entry) => `${entry.name} ${entry.rating}/10`).join('; ')}. That is strong enough for triage, but it should still be confirmed against GreatSchools, Niche, or SchoolDigger before a tour commitment.`;
  }

  return 'The current pass did not surface a reliable assigned-school rating. Before escalating, check GreatSchools, Niche, or SchoolDigger for the assigned schools and confirm the district assignment directly.';
}

function buildDevelopmentSection(facts, result) {
  const city = facts.city || 'the area';
  if (result.signals.newConstruction) {
    return `The listing language reads as new construction or near-new inventory, which is a weaker fit for a resale-first brief. Direct Wake County planning and NCDOT review should be part of any follow-up so you can see what nearby development and traffic growth are still coming.`;
  }

  return `Direct Wake County planning, municipal development, and NCDOT review is still outstanding for this deterministic batch pass. If the home stays alive, check those official sources around ${city} before moving it into finalist territory.`;
}

function buildFinancialSection(facts, profile) {
  const lines = [];
  const downPaymentPct = safeParseNumber(profile.financial?.down_payment_pct) ?? 20;
  const closingMinPct = safeParseNumber(profile.financial?.closing_cost_pct_min) ?? 2;
  const closingMaxPct = safeParseNumber(profile.financial?.closing_cost_pct_max) ?? 3;

  if (Number.isFinite(facts.priceNumber)) {
    const downPayment = facts.priceNumber * (downPaymentPct / 100);
    const closingMin = facts.priceNumber * (closingMinPct / 100);
    const closingMax = facts.priceNumber * (closingMaxPct / 100);
    lines.push(`- Price: ${formatCurrency(facts.priceNumber)}`);
    lines.push(`- Down payment assumption from profile: ${downPaymentPct}% = ${formatCurrency(downPayment)}`);
    lines.push(`- Closing-cost range from profile: ${closingMinPct}% to ${closingMaxPct}% = ${formatCurrency(closingMin)} to ${formatCurrency(closingMax)}`);
    lines.push(`- Estimated upfront cash before reserves: ${formatCurrency(downPayment + closingMin)} to ${formatCurrency(downPayment + closingMax)}`);
  } else {
    lines.push('- Listing price still needs direct validation before a reliable cash estimate is possible.');
  }

  if (facts.hoaText) {
    lines.push(`- HOA signal: ${facts.hoaText}`);
  }

  return lines.join('\n');
}

function buildRisksAndQuestions(facts, result) {
  const lines = [];
  if (result.unknownCritical > 0) {
    lines.push('- Several critical fields are still unverified, so this remains a triage-grade call rather than a full diligence pass.');
  }
  if (result.signals.busyRoadRisk) {
    lines.push('- Validate traffic, cut-through, and street-noise exposure at real travel times.');
  }
  if (result.signals.floodRisk) {
    lines.push('- Confirm floodplain and drainage conditions before escalation.');
  }
  if (facts.schoolRatings.length === 0) {
    lines.push('- Confirm the assigned schools and current ratings with direct sources.');
  }
  if (!facts.hoaText) {
    lines.push('- HOA terms and restrictions are still unclear from the extracted page data.');
  }
  if (!facts.daysOnMarketText) {
    lines.push('- Listing freshness should be rechecked against the live page if timing matters.');
  }
  if (lines.length === 0) {
    lines.push('- The main follow-up is a direct neighborhood, planning, and route-friction validation pass before deep work.');
  }
  return lines.join('\n');
}

function buildRecommendationSection(facts, result) {
  if (result.status === 'Sold') {
    return 'Pass. The listing no longer appears active, so it should stay closed out unless a different active source surfaces.';
  }

  if (result.recommendation === 'Pursue now') {
    return 'Pursue now. The visible facts fit the live brief closely enough that the next step should be a real-world validation pass rather than more paper triage.';
  }

  if (result.recommendation === 'Worth touring') {
    return 'Worth touring. The house clears enough of the brief to justify a visit, but it still needs a sharper read on area-level tradeoffs.';
  }

  if (result.recommendation === 'Hold pending validation') {
    return 'Hold pending validation. The home is not out, but the missing or soft-risk items should be resolved before it competes with the current leaders.';
  }

  return 'Pass. The visible facts do not justify active-shortlist attention against the current brief.';
}

function renderMarkdownTable(headers, rows) {
  const headerLine = `| ${headers.join(' | ')} |`;
  const separatorLine = `|${headers.map(() => '---').join('|')}|`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [headerLine, separatorLine, body].filter(Boolean).join('\n');
}

function renderReport(home, reportNumber, reportDate, profile) {
  const facts = home.bestAttempt.facts;
  const result = home.result;
  const summaryCard = buildSummaryCard(facts, result, home.areaMatch);
  const gateRows = result.rows.map((row) => [row.label, toGateResultText(row.pass), row.note]);
  const lines = [];

  lines.push(`# ${facts.address || 'Unknown Address'} - ${facts.city || 'Unknown City'}, ${facts.state || 'NC'}`);
  lines.push('');
  lines.push(`**Date:** ${reportDate}`);
  lines.push(`**Source:** ${home.bestAttempt.platformLabel}`);
  lines.push(`**URL:** ${home.bestAttempt.finalUrl || home.bestAttempt.url || ''}`);
  lines.push(`**Price:** ${facts.priceText}`);
  lines.push(`**Beds/Baths:** ${formatBedsBaths(facts.beds, facts.baths)}`);
  lines.push(`**SqFt:** ${formatSqft(facts.sqft)}`);
  lines.push(`**Lot:** ${facts.lotText || 'Unknown'}`);
  lines.push(`**Year Built:** ${Number.isFinite(facts.yearBuilt) ? Math.round(facts.yearBuilt) : 'Unknown'}`);
  lines.push(`**HOA:** ${facts.hoaText || 'Unknown'}`);
  lines.push(`**Days on Market:** ${facts.daysOnMarketText || 'Unknown'}`);
  lines.push(`**Overall Score:** ${formatScore(result.score)}`);
  lines.push(`**Recommendation:** ${result.recommendation}`);
  lines.push(`**Confidence:** ${result.confidence}`);
  lines.push(`**Verification:** ${home.bestAttempt.verification.status}`);
  lines.push('');
  lines.push('## Quick Take');
  lines.push('');
  lines.push(buildQuickTake(facts, result, home.areaMatch));
  lines.push('');
  lines.push('## Summary Card');
  lines.push('');
  lines.push(renderMarkdownTable(['Category', 'Verdict'], summaryCard));
  lines.push('');
  lines.push('## Hard Requirement Gate');
  lines.push('');
  lines.push(renderMarkdownTable(['Requirement', 'Result', 'Notes'], gateRows));
  lines.push('');
  lines.push('## Property Fit');
  lines.push('');
  lines.push(buildPropertyFit(facts, result, home.areaMatch));
  lines.push('');
  lines.push('## Neighborhood Sentiment');
  lines.push('');
  lines.push(buildNeighborhoodSection(facts, result));
  lines.push('');
  lines.push('## School Review');
  lines.push('');
  lines.push(buildSchoolSection(facts));
  lines.push('');
  lines.push('## Development and Infrastructure');
  lines.push('');
  lines.push(buildDevelopmentSection(facts, result));
  lines.push('');
  lines.push('## Financial Snapshot');
  lines.push('');
  lines.push(buildFinancialSection(facts, profile));
  lines.push('');
  lines.push('## Risks and Open Questions');
  lines.push('');
  lines.push(buildRisksAndQuestions(facts, result));
  lines.push('');
  lines.push('## Recommendation');
  lines.push('');
  lines.push(buildRecommendationSection(facts, result));
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function buildShortlistEntry(home, rank) {
  const reportNumber = home.reportNumber;
  const reportPath = home.reportPath;
  return {
    rank,
    tag: `Evaluate Top 10 - Rank ${rank}`,
    trackerNumber: home.trackerNumber,
    address: home.bestAttempt.facts.address,
    city: home.bestAttempt.facts.city,
    score: formatScore(home.result.score),
    status: home.result.status,
    reportNumber,
    reportPath,
    notes: buildTrackerNote(home.result),
  };
}

function renderShortlist(homes, reportDate, runId) {
  const viableHomes = homes
    .filter((home) => home.reportPath && home.result.status === 'Evaluated')
    .sort((left, right) => {
      if (right.result.score !== left.result.score) {
        return right.result.score - left.result.score;
      }
      return (left.areaMatch?.rank ?? 99) - (right.areaMatch?.rank ?? 99);
    })
    .slice(0, 10);

  const top10 = viableHomes.map((home, index) => buildShortlistEntry(home, index + 1));
  const lines = [];
  lines.push('# Review Shortlist');
  lines.push('');
  lines.push('This file stores the latest top-10 cohort from evaluate or compare and the handoff into deep mode.');
  lines.push('');
  lines.push('## Latest Top 10 Cohort');
  lines.push('');
  lines.push(`- Cohort ID: evaluate-${reportDate}-${runId.slice(-3)}`);
  lines.push(`- Created: ${reportDate}`);
  lines.push('- Source Mode: evaluate');
  lines.push('- Scope: full pending pipeline batch');
  lines.push('- Trigger: /home-ops evaluate');
  lines.push('- Top 10 Status: ready');
  lines.push('- Deep Batch Status: pending');
  lines.push('- Deep Batch Report: ');
  lines.push('- Finalist Review Status: not started');
  lines.push('');
  lines.push('## Top 10 Homes');
  lines.push('');
  lines.push('| Rank | Tag | Tracker # | Address | City | Score | Status | Report | Notes |');
  lines.push('|------|-----|-----------|---------|------|-------|--------|--------|-------|');
  for (const entry of top10) {
    lines.push(`| ${entry.rank} | ${entry.tag} | ${entry.trackerNumber} | ${entry.address} | ${entry.city} | ${entry.score} | ${entry.status} | [${entry.reportNumber}](${entry.reportPath}) | ${entry.notes} |`);
  }
  lines.push('');
  lines.push('## Refined Top 3 After Deep');
  lines.push('');
  lines.push('| Rank | Address | City | Updated Verdict | Why |');
  lines.push('|------|---------|------|-----------------|-----|');
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- This shortlist reflects the current evaluate run on the deduplicated pending pipeline.');
  lines.push('- Homes left in hold tier still need deeper school, traffic, neighborhood, or development validation before deep mode should treat them as finalist-grade.');
  lines.push(`- ${top10.length} home(s) qualified for the current top-10 cohort.`);
  lines.push('');

  return {
    content: `${lines.join('\n')}\n`,
    top10,
  };
}

function escapeTsv(value) {
  return String(value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();
}

function buildTrackerRow(home, reportDate) {
  return [
    home.trackerNumber,
    reportDate,
    escapeTsv(home.bestAttempt.facts.address),
    escapeTsv(home.bestAttempt.facts.city),
    escapeTsv(home.bestAttempt.facts.priceText),
    escapeTsv(formatBedsBaths(home.bestAttempt.facts.beds, home.bestAttempt.facts.baths)),
    escapeTsv(formatSqft(home.bestAttempt.facts.sqft)),
    escapeTsv(formatScore(home.result.score)),
    escapeTsv(home.result.status),
    `[${home.reportNumber}](${home.reportPath})`,
    escapeTsv(buildTrackerNote(home.result)),
  ].join('\t');
}

function formatProcessedLine(entry, home) {
  const urlValue = entry.inputType === 'local-report' ? `local:${entry.reportPath}` : entry.url;
  const addressLine = formatFullAddress(home.bestAttempt.facts) || entry.addressLine || entry.address;
  const platform = entry.platformLabel || home.bestAttempt.platformLabel;
  const area = home.bestAttempt.facts.city || entry.area || entry.city || '';
  const price = home.bestAttempt.facts.priceText || entry.price || 'Unknown';
  return `- [x] ${urlValue} | ${platform} | ${area} | ${addressLine} | ${price} | report ${String(home.reportNumber).padStart(3, '0')} | ${formatScore(home.result.score)} | ${home.result.recommendation} | ${home.result.status}`;
}

function buildPacket(home, runId, profile, portals, existingContext) {
  const bestAttempt = home.bestAttempt;
  const facts = bestAttempt.facts;
  return {
    schemaVersion: 1,
    mode: 'evaluate-pending-deterministic',
    runId,
    createdAt: new Date().toISOString(),
    buyerContext: {
      hardRequirements: profile.search?.hard_requirements ?? {},
      softPreferences: profile.search?.soft_preferences ?? {},
      dealBreakers: profile.search?.deal_breakers ?? [],
      searchAreas: profile.search?.areas ?? [],
      financial: profile.financial ?? {},
    },
    listing: {
      address: facts.address,
      city: facts.city,
      state: facts.state,
      zip: facts.zip,
      fullAddress: facts.fullAddress,
      price: facts.priceNumber,
      priceText: facts.priceText,
      beds: facts.beds,
      baths: facts.baths,
      sqft: facts.sqft,
      lot: facts.lotText,
      yearBuilt: facts.yearBuilt,
      garageSpaces: facts.garageSpaces,
      hoa: facts.hoaText,
      daysOnMarket: facts.daysOnMarketText,
      propertyType: facts.propertyType,
      subdivision: facts.subdivision,
      schoolRatings: facts.schoolRatings,
      areaMatch: home.areaMatch,
    },
    verification: {
      status: bestAttempt.verification.status,
      reason: bestAttempt.verification.reason,
      primaryUrl: bestAttempt.finalUrl || bestAttempt.url,
      allSources: home.attempts.map((attempt) => ({
        platform: attempt.platformLabel,
        url: attempt.finalUrl || attempt.url,
        verification: attempt.verification,
      })),
    },
    attempts: home.attempts,
    researchTargets: home.researchTargets,
    existingContext,
    outcome: {
      score: home.result?.score ?? null,
      recommendation: home.result?.recommendation ?? '',
      confidence: home.result?.confidence ?? '',
      suggestedStatus: home.result?.status ?? '',
      trackerNote: home.result ? buildTrackerNote(home.result) : '',
      reportPath: home.reportPath ?? '',
      reportNumber: home.reportNumber ?? null,
    },
  };
}

async function runNodeScript(scriptName, args, required = false) {
  const result = spawnSync(process.execPath, [join(ROOT, scriptName), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  if (result.status !== 0 && required) {
    throw new Error(`${scriptName} failed with exit code ${result.status ?? 1}.`);
  }

  return result.status ?? 0;
}

async function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(HELP_TEXT);
    process.exit(1);
  }

  if (config.help) {
    console.log(HELP_TEXT);
    return;
  }

  const { profile, portals } = loadResearchConfig(ROOT);
  const pipelineContent = await readPipelineDocument();
  const pipeline = parsePendingEntries(pipelineContent);
  if (pipeline.entries.length === 0) {
    console.log('No unchecked pending pipeline entries found.');
    return;
  }

  let grouped = groupPendingEntries(pipeline.entries);
  if (config.limit > 0) {
    grouped = grouped.slice(0, config.limit);
  }

  if (grouped.length === 0) {
    console.log('No canonical homes matched the requested limit.');
    return;
  }

  const needsBrowser = grouped.some((group) => group.entries.some((entry) => entry.inputType === 'url'));
  let session = null;
  if (needsBrowser) {
    session = await ensureHostedSession(config.profileName);
    console.log(`Using hosted browser profile: ${config.profileName}`);
  }

  const existingContext = await loadExistingContext();
  const reportDate = formatDate(new Date());
  const runId = formatRunId(new Date());
  let nextReportNumber = getNextReportNumber(existingContext.reportMap, existingContext.trackerMap);
  const evaluatedGroups = [];

  const extractionCache = config.noCache ? { entries: {} } : await loadCache(EXTRACTION_CACHE_NAME);
  if (!config.noCache) {
    pruneCache(extractionCache, CACHE_TTL.DEFAULT_PRUNE_MS);
  }
  const cacheState = {
    cache: extractionCache,
    disabled: Boolean(config.noCache),
    refresh: Boolean(config.refreshCache),
    hits: 0,
    misses: 0,
    dirty: false,
  };

  for (const group of grouped) {
    const attempts = [];
    for (const entry of group.entries) {
      let attempt;
      if (entry.inputType === 'local-report') {
        attempt = await extractFromLocalReport(entry, portals);
      } else {
        attempt = await extractFromBrowserCached(session.context, entry, cacheState);
      }

      attempts.push(attempt);
      if (attempt.verification.status === 'active' || attempt.verification.status === 'report') {
        break;
      }
    }

    evaluatedGroups.push({
      workItemId: group.workItemId,
      entries: group.entries,
      attempts,
    });
  }

  const canonicalHomes = mergeCanonicalHomes(evaluatedGroups);
  const packetWrites = [];
  const reportWrites = [];
  const trackerRows = [];
  const processedLineMap = new Map();
  const handledEntryIndexes = new Set();
  const blockedHomes = [];

  for (const home of canonicalHomes) {
    const bestAttempt = chooseBestAttempt(home.attempts);
    home.bestAttempt = bestAttempt;
    home.areaMatch = detectAreaMatch(bestAttempt?.facts?.city, profile.search?.areas ?? []);
    const contextKey = buildAddressKey(bestAttempt?.facts?.address, bestAttempt?.facts?.city);
    const trackerEntry = contextKey ? existingContext.trackerMap.get(contextKey) ?? null : null;
    const reportEntry = contextKey ? existingContext.reportMap.get(contextKey) ?? null : null;
    const shortlistEntry = contextKey
      ? existingContext.shortlistMap.get(normalizeKey(bestAttempt?.facts?.address, bestAttempt?.facts?.city)) ?? null
      : null;

    if (!bestAttempt || bestAttempt.verification.status === 'blocked') {
      home.researchTargets = buildResearchTargets(bestAttempt?.facts ?? {
        city: '',
        address: '',
        schoolRatings: [],
        subdivision: '',
      }, portals);
      blockedHomes.push(home);
      const blockedPacketPath = join(PACKETS_DIR, `${runId}-${slugify(bestAttempt?.facts?.address || home.entries[0]?.rawValue || home.workItemIds?.[0] || 'blocked')}.json`);
      packetWrites.push({
        filePath: blockedPacketPath,
        payload: buildPacket(home, runId, profile, portals, {
          tracker: trackerEntry,
          report: reportEntry?.report ? {
            reportPath: reportEntry.reportPath,
            reportNumber: reportEntry.reportNumber,
          } : null,
          shortlist: shortlistEntry,
        }),
      });
      continue;
    }

    home.researchTargets = bestAttempt.researchTargets ?? buildResearchTargets(bestAttempt.facts, portals, bestAttempt.report ?? reportEntry?.report ?? null);
    home.result = bestAttempt.inputType === 'local-report' && bestAttempt.report
      ? {
        score: safeParseNumber(bestAttempt.report.metadata.overallScore),
        recommendation: bestAttempt.report.metadata.recommendation,
        confidence: bestAttempt.report.metadata.confidence || 'Medium',
        status: trackerEntry?.status || deriveStatusFromRecommendation(bestAttempt.report.metadata.recommendation, bestAttempt.report.metadata.verification),
        rows: buildGateRows(bestAttempt.facts, profile, home.areaMatch).rows,
        schoolAverage: null,
        signals: detectSignals(bestAttempt.facts),
        criticalMisses: 0,
        unknownCritical: 0,
      }
      : scoreHome(bestAttempt.facts, profile, home.areaMatch, bestAttempt.verification.status);

    if (trackerEntry) {
      home.trackerNumber = trackerEntry.trackerNumber;
      home.reportPath = trackerEntry.reportPath;
      home.reportNumber = trackerEntry.reportNumber ?? parseExistingReportNumber(trackerEntry.reportPath) ?? home.trackerNumber;
      if (trackerEntry.score) {
        home.result.score = safeParseNumber(trackerEntry.score);
      }
      if (reportEntry?.report) {
        home.result.recommendation = reportEntry.report.metadata.recommendation;
        home.result.confidence = reportEntry.report.metadata.confidence || home.result.confidence;
      }
      home.result.status = trackerEntry.status || deriveStatusFromRecommendation(home.result.recommendation, bestAttempt.verification.status);
    } else if (reportEntry?.reportPath) {
      home.reportPath = reportEntry.reportPath;
      home.reportNumber = reportEntry.reportNumber ?? nextReportNumber;
      home.trackerNumber = home.reportNumber;
      if (reportEntry.report) {
        home.result.score = reportEntry.report.scoreNumber ?? home.result.score;
        home.result.recommendation = reportEntry.report.metadata.recommendation || home.result.recommendation;
        home.result.confidence = reportEntry.report.metadata.confidence || home.result.confidence;
        home.result.status = deriveStatusFromRecommendation(home.result.recommendation, reportEntry.report.metadata.verification || bestAttempt.verification.status);
      }
    } else {
      home.reportNumber = nextReportNumber;
      home.trackerNumber = nextReportNumber;
      nextReportNumber += 1;
      const slug = slugify(bestAttempt.facts.address || bestAttempt.facts.fullAddress || `listing-${home.trackerNumber}`);
      home.reportPath = `reports/${String(home.reportNumber).padStart(3, '0')}-${slug}-${reportDate}.md`;
    }

    const packetPath = join(PACKETS_DIR, `${runId}-${String(home.reportNumber ?? home.trackerNumber).padStart(3, '0')}-${slugify(bestAttempt.facts.address || bestAttempt.facts.fullAddress || 'listing')}.json`);
    packetWrites.push({
      filePath: packetPath,
      payload: buildPacket(home, runId, profile, portals, {
        tracker: trackerEntry,
        report: reportEntry?.report ? {
          reportPath: reportEntry.reportPath,
          reportNumber: reportEntry.reportNumber,
          score: reportEntry.report.scoreNumber,
          recommendation: reportEntry.report.metadata.recommendation,
        } : null,
        shortlist: shortlistEntry,
      }),
    });

    if (!trackerEntry) {
      trackerRows.push(buildTrackerRow(home, reportDate));
    }

    if (!reportEntry && !(bestAttempt.inputType === 'local-report' && bestAttempt.report)) {
      reportWrites.push({
        filePath: join(ROOT, home.reportPath),
        content: renderReport(home, home.reportNumber, reportDate, profile),
      });
    }

    for (const entry of home.entries) {
      handledEntryIndexes.add(entry.index);
      processedLineMap.set(entry.index, formatProcessedLine(entry, home));
    }
  }

  await mkdir(PACKETS_DIR, { recursive: true });
  for (const packet of packetWrites) {
    await writeFile(packet.filePath, `${JSON.stringify(packet.payload, null, 2)}\n`, 'utf8');
  }

  if (!config.noCache && cacheState.dirty) {
    await saveCache(EXTRACTION_CACHE_NAME, extractionCache);
  }

  const summaryPath = join(PACKETS_DIR, `run-${runId}.json`);
  await writeFile(summaryPath, `${JSON.stringify({
    runId,
    createdAt: new Date().toISOString(),
    processedHomes: canonicalHomes.length - blockedHomes.length,
    blockedHomes: blockedHomes.length,
    packets: packetWrites.map((entry) => entry.filePath.replace(`${ROOT}\\`, '').replace(/\\/g, '/')),
    reports: reportWrites.map((entry) => entry.filePath.replace(`${ROOT}\\`, '').replace(/\\/g, '/')),
  }, null, 2)}\n`, 'utf8');

  if (config.packetsOnly) {
    console.log(`Prepared ${packetWrites.length} packet(s).`);
    console.log(`Run summary: ${summaryPath.replace(`${ROOT}\\`, '').replace(/\\/g, '/')}`);
    if (blockedHomes.length > 0) {
      console.log(`Left ${blockedHomes.length} home(s) blocked for manual follow-up.`);
    }
    if (!config.noCache) {
      console.log(`Extraction cache: ${cacheState.hits} hit(s), ${cacheState.misses} miss(es)`);
    }
    if (session?.browser) {
      await session.browser.close();
    }
    return;
  }

  for (const report of reportWrites) {
    await mkdir(dirname(report.filePath), { recursive: true });
    await writeFile(report.filePath, report.content, 'utf8');
  }

  let stagedTsvPath = '';
  if (trackerRows.length > 0) {
    await mkdir(ADDITIONS_DIR, { recursive: true });
    stagedTsvPath = join(ADDITIONS_DIR, `evaluate-pending-${runId}.tsv`);
    await writeFile(stagedTsvPath, `${trackerRows.join('\n')}\n`, 'utf8');
    if (!config.skipMerge) {
      await runNodeScript('scripts/pipeline/merge-tracker.mjs', ['--verify'], true);
    }
  }

  const updatedPendingLines = [];
  for (let index = pipeline.pendingIndex + 1; index < pipeline.processedIndex; index += 1) {
    if (handledEntryIndexes.has(index)) {
      continue;
    }
    updatedPendingLines.push(pipeline.lines[index]);
  }

  const updatedProcessedLines = [
    ...pipeline.processedLines,
    ...[...processedLineMap.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]),
  ];

  const rebuiltPipeline = [
    ...pipeline.lines.slice(0, pipeline.pendingIndex + 1),
    ...updatedPendingLines,
    pipeline.lines[pipeline.processedIndex],
    ...updatedProcessedLines,
  ].join('\n').replace(/\n{3,}/g, '\n\n');
  await writeFile(PIPELINE_PATH, `${rebuiltPipeline.trimEnd()}\n`, 'utf8');

  const shortlist = renderShortlist(canonicalHomes.filter((home) => home.result), reportDate, runId);
  if (shortlist.top10.length > 0) {
    await writeFile(SHORTLIST_PATH, shortlist.content, 'utf8');
  }

  const newlyWrittenReportArgs = reportWrites.map((entry) => entry.filePath.replace(`${ROOT}\\`, '').replace(/\\/g, '/'));
  if (!config.skipAudit && newlyWrittenReportArgs.length > 0) {
    await runNodeScript('scripts/research/research-coverage-audit.mjs', newlyWrittenReportArgs, false);
  }

  if (!config.skipReviewTabs && shortlist.top10.length > 0) {
    await runNodeScript('scripts/browser/review-tabs.mjs', ['shortlist-top10', '--profile', config.profileName, '--group', 'Top 10'], false);
  }

  if (session?.browser) {
    await session.browser.close();
  }

  console.log('');
  console.log(`Processed ${canonicalHomes.length - blockedHomes.length} canonical home(s).`);
  console.log(`Blocked backlog: ${blockedHomes.length}`);
  console.log(`Packets written: ${packetWrites.length}`);
  console.log(`Reports written: ${reportWrites.length}`);
  if (stagedTsvPath) {
    console.log(`Tracker staging file: ${stagedTsvPath.replace(`${ROOT}\\`, '').replace(/\\/g, '/')}`);
  }
  console.log(`Run summary: ${summaryPath.replace(`${ROOT}\\`, '').replace(/\\/g, '/')}`);
  if (!config.noCache) {
    console.log(`Extraction cache: ${cacheState.hits} hit(s), ${cacheState.misses} miss(es)`);
  }
}

main().catch(async (error) => {
  console.error(`evaluate-pending.mjs failed: ${error.message}`);
  process.exit(1);
});