#!/usr/bin/env node

/**
 * extract-listing-details.mjs -- Drive the hosted Chrome session against a
 * single listing URL and pull a normalized JSON of the property's facts.
 *
 * This script exists because Realtor.com / Zillow / Redfin all block WebFetch
 * for unauthenticated agents. The deep-single-runner uses this as step 1 so
 * downstream evaluate / source-plan / school-metadata / builder-check scripts
 * have ground-truth listing data to anchor on.
 *
 * Approach (per portal):
 *   1. Try structured data first: JSON-LD (RealEstateListing/Residence) and
 *      Next.js __NEXT_DATA__ / Redfin __REDFIN_INITIAL_STATE__.
 *   2. Fall back to a selector map for fields the structured data missed.
 *   3. Detect inactive/sold/redirect signals and set listingStatus.
 *
 * Hard rule: no WebFetch / WebSearch / external API calls. Hosted Chrome only.
 */

import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from '../shared/paths.mjs';
import { slugify } from '../shared/text-utils.mjs';
import {
  attachHostedBrowser,
  navigateAndSettle,
  safeClose,
} from '../browser/browser-extract-utils.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'listings');
const DEFAULT_PROFILE = 'chrome-host';
const PAGE_TIMEOUT_MS = 35000;
const SETTLE_MS = 2500;

const HELP_TEXT = `Usage:
  node extract-listing-details.mjs --url <listing-url> [--profile chrome-host] [--json]
  node extract-listing-details.mjs <listing-url>

Drives the hosted Chrome session to scrape structured listing facts from a
single Zillow / Redfin / Realtor.com / Homes.com URL and writes the result to
output/listings/<slug>.json. Used by deep-single-runner.mjs as step 1 of the
single-home deep flow.

Options:
  --url <url>        Listing URL to scrape (positional accepted as alternative).
  --profile <name>   Hosted browser profile. Defaults to chrome-host.
  --json             Print JSON to stdout instead of the human summary.
  --help             Show this help text.
`;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const config = {
    url: '',
    profileName: DEFAULT_PROFILE,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--url') { config.url = argv[++i] ?? ''; continue; }
    if (arg === '--profile') { config.profileName = argv[++i] ?? DEFAULT_PROFILE; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    if (!config.url) {
      config.url = arg;
      continue;
    }
    throw new Error(`Unexpected positional argument: ${arg}`);
  }
  return config;
}

// ---------------------------------------------------------------------------
// Portal detection + URL helpers
// ---------------------------------------------------------------------------

function detectPlatform(url) {
  try {
    const host = new URL(url).host.toLowerCase();
    if (host.includes('zillow.com')) return 'zillow';
    if (host.includes('redfin.com')) return 'redfin';
    if (host.includes('realtor.com')) return 'realtor';
    if (host.includes('homes.com')) return 'homes';
    return 'other';
  } catch {
    return 'other';
  }
}

// ---------------------------------------------------------------------------
// In-page evaluators
// These run inside the page; they must be self-contained (no closures over
// node-side helpers) because Playwright serializes them to the browser.
// ---------------------------------------------------------------------------

async function readNextData(page) {
  return page.evaluate(() => {
    const node = document.querySelector('script#__NEXT_DATA__');
    if (!node) return null;
    try {
      return JSON.parse(node.textContent || '');
    } catch {
      return null;
    }
  }).catch(() => null);
}

async function readJsonLd(page) {
  return page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    const objects = [];
    for (const script of scripts) {
      try {
        const parsed = JSON.parse(script.textContent || '');
        if (Array.isArray(parsed)) {
          for (const item of parsed) objects.push(item);
        } else {
          objects.push(parsed);
        }
      } catch {
        // ignore
      }
    }
    return objects;
  }).catch(() => []);
}

async function readRedfinInitialState(page) {
  return page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      const text = script.textContent || '';
      const match = text.match(/__REDFIN_INITIAL_STATE__\s*=\s*(\{[\s\S]+?\});?\s*$/);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch {
          // fall through to next script
        }
      }
    }
    return null;
  }).catch(() => null);
}

async function readPageMeta(page) {
  return page.evaluate(() => {
    const title = document.title || '';
    const url = location.href || '';
    const bodyText = (document.body?.innerText || '').slice(0, 12000);
    const status = document.querySelector('meta[name="status"]')?.getAttribute('content') || '';
    const description = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
    return { title, url, bodyText, status, description, canonical };
  }).catch(() => ({ title: '', url: '', bodyText: '', status: '', description: '', canonical: '' }));
}

// ---------------------------------------------------------------------------
// Field normalizers (run in node-land after page evaluation)
// ---------------------------------------------------------------------------

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickFirst(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return null;
}

function normalizeListingStatus(raw, bodyText = '') {
  const candidates = [String(raw ?? '').toLowerCase(), String(bodyText ?? '').toLowerCase()];
  const flat = candidates.join(' ');
  if (/(off[\s-]?market|delisted|removed|withdrawn)/i.test(flat)) return 'off-market';
  if (/(pending|under\s+contract|contingent)/i.test(flat)) return 'pending';
  if (/sold/i.test(flat)) return 'sold';
  if (/active|for\s+sale|listed/i.test(flat)) return 'active';
  return 'unconfirmed';
}

function normalizeSchoolLevel(raw) {
  const value = String(raw ?? '').toLowerCase();
  if (/elementary|primary/.test(value)) return 'elementary';
  if (/middle|junior/.test(value)) return 'middle';
  if (/high|senior/.test(value)) return 'high';
  return value || null;
}

function normalizeSchools(rawSchools = []) {
  const list = Array.isArray(rawSchools) ? rawSchools : [];
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const name = pickFirst(entry.name, entry.schoolName);
    if (!name) return null;
    return {
      name: String(name).trim(),
      level: normalizeSchoolLevel(entry.level || entry.gradeLevel || entry.type),
      district: pickFirst(entry.district, entry.schoolDistrict) || null,
      rating: toNumber(entry.rating ?? entry.greatSchoolsRating ?? entry.score),
      source: pickFirst(entry.source, entry.provider) || null,
    };
  }).filter(Boolean);
}

function buildEmptyListing(url) {
  return {
    address: null,
    city: null,
    state: null,
    zip: null,
    price: null,
    priceHistory: [],
    beds: null,
    baths: null,
    sqftFinished: null,
    lotSqft: null,
    lotAcres: null,
    yearBuilt: null,
    garage: null,
    hoaMonthly: null,
    hoaAnnual: null,
    listingStatus: 'unconfirmed',
    daysOnMarket: null,
    propertyType: null,
    homeStyle: null,
    builderName: null,
    communityName: null,
    assignedSchools: [],
    photos: { count: 0, urls: [] },
    description: null,
    listingAgent: null,
    mls: null,
    platform: detectPlatform(url),
    url,
    canonicalUrl: null,
    extractedAt: new Date().toISOString(),
    confidence: 'low',
    coverageNotes: [],
  };
}

// ---------------------------------------------------------------------------
// Per-portal extractors
//
// Each extractor receives the page, the platform-detection result, and
// returns a partially-filled listing object that gets merged into the empty
// listing skeleton. It SHOULD NOT throw; on parse failure it returns {} and
// adds a coverageNote about which step failed.
// ---------------------------------------------------------------------------

export function pickJsonLdResidence(jsonLdItems = []) {
  const raw = Array.isArray(jsonLdItems) ? jsonLdItems : [];
  // Unwrap @graph containers (homes.com wraps residence in a top-level @graph array)
  const list = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && Array.isArray(item['@graph']) && !item['@type']) {
      for (const inner of item['@graph']) list.push(inner);
    } else {
      list.push(item);
    }
  }
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const type = item['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => /Residence|RealEstateListing|SingleFamilyResidence|House/i.test(String(t || '')))) {
      return item;
    }
  }
  for (const item of list) {
    // Many sites embed a Product/Place that wraps the listing; descend if needed
    if (item && typeof item === 'object' && item.address && (item.numberOfRooms || item.floorSize)) {
      return item;
    }
  }
  return null;
}

export function fromJsonLdResidence(item) {
  if (!item) return {};
  const result = {};
  const address = item.address || {};
  result.address = pickFirst(address.streetAddress, item.streetAddress);
  result.city = pickFirst(address.addressLocality, item.addressLocality);
  result.state = pickFirst(address.addressRegion, item.addressRegion);
  result.zip = pickFirst(address.postalCode, item.postalCode);

  const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
  if (offers && typeof offers === 'object') {
    result.price = toNumber(offers.price ?? offers.priceSpecification?.price);
    result.listingStatus = normalizeListingStatus(offers.availability || offers.itemCondition);
    const offeredBy = Array.isArray(offers.offeredBy) ? offers.offeredBy[0] : offers.offeredBy;
    result.listingAgent = offeredBy?.name ? String(offeredBy.name).trim() : null;
  } else {
    result.price = toNumber(item.price);
    result.listingAgent = null;
  }

  result.beds = toNumber(item.numberOfBedrooms ?? item.numberOfRooms);
  const baths = item.numberOfBathroomsTotal ?? item.numberOfBathrooms ?? item.numberOfFullBathrooms;
  result.baths = toNumber(baths);

  const floor = item.floorSize;
  if (floor && typeof floor === 'object') {
    result.sqftFinished = toNumber(floor.value);
  } else {
    result.sqftFinished = toNumber(item.floorSize);
  }

  result.yearBuilt = toNumber(item.yearBuilt ?? item.dateBuilt);
  result.propertyType = pickFirst(item.propertyType, item.category);
  result.description = pickFirst(item.description);
  if (item.datePosted) {
    const posted = new Date(item.datePosted);
    if (!Number.isNaN(posted.getTime())) {
      result.daysOnMarket = Math.floor((Date.now() - posted.getTime()) / (1000 * 60 * 60 * 24));
    }
  }
  if (result.daysOnMarket === undefined) result.daysOnMarket = null;
  return result;
}

async function extractZillow(page) {
  const findings = {};
  const notes = [];
  const nextData = await readNextData(page);
  if (nextData?.props?.pageProps) {
    try {
      const props = nextData.props.pageProps;
      const listing = props.componentProps?.gdpClientCache
        ? Object.values(JSON.parse(props.componentProps.gdpClientCache))[0]?.property
        : props.componentProps?.property
          ?? props.initialReduxState?.gdp?.building
          ?? null;
      if (listing) {
        findings.address = pickFirst(listing.streetAddress, listing.address?.streetAddress);
        findings.city = pickFirst(listing.city, listing.address?.city);
        findings.state = pickFirst(listing.state, listing.address?.state);
        findings.zip = pickFirst(listing.zipcode, listing.address?.zipcode);
        findings.price = toNumber(listing.price ?? listing.priceForHDP ?? listing.zestimate);
        findings.beds = toNumber(listing.bedrooms);
        findings.baths = toNumber(listing.bathrooms);
        findings.sqftFinished = toNumber(listing.livingArea ?? listing.livingAreaValue);
        findings.lotSqft = toNumber(listing.lotSize ?? listing.lotAreaValue);
        findings.yearBuilt = toNumber(listing.yearBuilt);
        findings.hoaMonthly = toNumber(listing.monthlyHoaFee ?? listing.hoaFee);
        findings.daysOnMarket = toNumber(listing.daysOnZillow);
        findings.propertyType = pickFirst(listing.homeType, listing.propertyTypeDimension);
        findings.homeStyle = pickFirst(listing.architecturalStyle);
        findings.description = pickFirst(listing.description);
        findings.listingStatus = normalizeListingStatus(listing.homeStatus);
        if (Array.isArray(listing.schools)) {
          findings.assignedSchools = normalizeSchools(listing.schools.map((s) => ({
            name: s.name,
            level: s.level || s.type || s.gradeRange,
            rating: s.rating,
            district: s.district,
            source: 'zillow',
          })));
        }
      }
    } catch (error) {
      notes.push(`zillow: __NEXT_DATA__ parse error: ${error.message}`);
    }
  }

  // JSON-LD fallback
  const jsonLd = await readJsonLd(page);
  const residence = pickJsonLdResidence(jsonLd);
  const fromLd = fromJsonLdResidence(residence);
  for (const [key, value] of Object.entries(fromLd)) {
    if ((findings[key] === undefined || findings[key] === null) && value !== null && value !== undefined) {
      findings[key] = value;
    }
  }

  if (!findings.address && !findings.price) {
    notes.push('zillow: no structured data found; selectors not implemented yet');
  }
  return { findings, notes };
}

async function extractRedfin(page) {
  const findings = {};
  const notes = [];
  const initial = await readRedfinInitialState(page);
  if (initial && typeof initial === 'object') {
    try {
      const propertyId = Object.keys(initial.aboveTheFold || initial.belowTheFold || {})[0];
      const above = initial.aboveTheFold?.[propertyId] || initial.aboveTheFold || {};
      const below = initial.belowTheFold?.[propertyId] || initial.belowTheFold || {};
      const main = above.addressSectionInfo || above.publicRecordsInfo || {};
      findings.address = pickFirst(main.streetAddress, main.streetLine?.value);
      findings.city = pickFirst(main.city);
      findings.state = pickFirst(main.state);
      findings.zip = pickFirst(main.zip);
      findings.price = toNumber(above.priceInfo?.amount?.value ?? main.priceInfo?.amount?.value);
      findings.beds = toNumber(main.beds);
      findings.baths = toNumber(main.baths);
      findings.sqftFinished = toNumber(main.sqFt?.value ?? main.totalSqFt?.value);
      findings.lotSqft = toNumber(main.lotSize?.value);
      findings.yearBuilt = toNumber(main.yearBuilt?.value);
      findings.daysOnMarket = toNumber(main.daysOnMarket);
      findings.listingStatus = normalizeListingStatus(main.searchStatus || main.mlsStatus);
      const schools = below.schoolsAndDistrictsInfo?.servingThisHomeSchools
        ?? below.schoolsInfo?.servingThisHomeSchools
        ?? null;
      if (Array.isArray(schools)) {
        findings.assignedSchools = normalizeSchools(schools.map((s) => ({
          name: s.officialName ?? s.name,
          level: s.gradeRange ?? s.educationGradeType,
          rating: s.greatSchoolsRating,
          district: s.parentRating?.districtName ?? s.districtName,
          source: 'redfin',
        })));
      }
    } catch (error) {
      notes.push(`redfin: __REDFIN_INITIAL_STATE__ parse error: ${error.message}`);
    }
  }

  const jsonLd = await readJsonLd(page);
  const residence = pickJsonLdResidence(jsonLd);
  const fromLd = fromJsonLdResidence(residence);
  for (const [key, value] of Object.entries(fromLd)) {
    if ((findings[key] === undefined || findings[key] === null) && value !== null && value !== undefined) {
      findings[key] = value;
    }
  }

  if (!findings.address && !findings.price) {
    notes.push('redfin: no structured data found; selectors not implemented yet');
  }
  return { findings, notes };
}

async function extractRealtor(page) {
  const findings = {};
  const notes = [];
  const nextData = await readNextData(page);
  if (nextData?.props?.pageProps) {
    try {
      const pageProps = nextData.props.pageProps;
      const listing = pageProps.property
        ?? pageProps.initialState?.propertyDetails
        ?? pageProps.initialReduxState?.propertyDetails?.detailData
        ?? pageProps.initialReduxState?.propertyDetails
        ?? pageProps.detail
        ?? null;
      if (listing) {
        const addr = listing.address || listing.location?.address || {};
        findings.address = pickFirst(addr.line, addr.full_line, addr.streetAddress);
        findings.city = pickFirst(addr.city);
        findings.state = pickFirst(addr.state_code, addr.state);
        findings.zip = pickFirst(addr.postal_code, addr.zip);
        findings.price = toNumber(listing.list_price ?? listing.price ?? listing.last_price);
        const desc = listing.description || {};
        findings.beds = toNumber(desc.beds ?? listing.beds);
        findings.baths = toNumber(desc.baths_consolidated ?? desc.baths ?? listing.baths);
        findings.sqftFinished = toNumber(desc.sqft ?? listing.sqft);
        findings.lotSqft = toNumber(desc.lot_sqft);
        findings.yearBuilt = toNumber(desc.year_built);
        findings.garage = toNumber(desc.garage);
        findings.propertyType = pickFirst(desc.type, listing.prop_type);
        findings.homeStyle = pickFirst(desc.sub_type, desc.style);
        findings.description = pickFirst(listing.text);
        findings.listingStatus = normalizeListingStatus(listing.status);
        findings.daysOnMarket = toNumber(listing.list_date_min ?? listing.days_on_market);
        const hoa = listing.hoa || {};
        findings.hoaMonthly = toNumber(hoa.fee ?? hoa.amount);
        const photos = listing.photos || listing.photo_count;
        if (Array.isArray(photos)) {
          findings.photos = { count: photos.length, urls: photos.slice(0, 3).map((p) => p.href).filter(Boolean) };
        } else if (typeof photos === 'number') {
          findings.photos = { count: photos, urls: [] };
        }
        if (Array.isArray(listing.schools?.schools)) {
          findings.assignedSchools = normalizeSchools(listing.schools.schools.map((s) => ({
            name: s.name,
            level: s.education_levels?.[0] ?? s.funding_type,
            rating: s.rating,
            district: s.district?.name ?? s.district_id,
            source: 'realtor',
          })));
        }
        findings.builderName = pickFirst(listing.builder?.name);
        findings.communityName = pickFirst(listing.community?.name, listing.subdivision?.name);
      }
    } catch (error) {
      notes.push(`realtor: __NEXT_DATA__ parse error: ${error.message}`);
    }
  }

  const jsonLd = await readJsonLd(page);
  const residence = pickJsonLdResidence(jsonLd);
  const fromLd = fromJsonLdResidence(residence);
  for (const [key, value] of Object.entries(fromLd)) {
    if ((findings[key] === undefined || findings[key] === null) && value !== null && value !== undefined) {
      findings[key] = value;
    }
  }

  if (!findings.address && !findings.price) {
    notes.push('realtor: no structured data found; selectors not implemented yet');
  }
  return { findings, notes };
}

async function extractHomes(page) {
  const findings = {};
  const notes = [];

  // Primary: JSON-LD (@graph unwrap handled by pickJsonLdResidence)
  const jsonLd = await readJsonLd(page);
  const residence = pickJsonLdResidence(jsonLd);
  const fromLd = fromJsonLdResidence(residence);
  Object.assign(findings, fromLd);

  // Secondary: DOM section parser for fields JSON-LD doesn't carry
  const domFindings = await page.evaluate(() => {
    const result = {};

    function sectionText(headerPattern) {
      const headers = Array.from(document.querySelectorAll('h3, h4, [class*="section-title"], [class*="label"]'));
      for (const h of headers) {
        if (headerPattern.test(h.textContent.trim())) {
          const sibling = h.nextElementSibling ?? h.parentElement?.nextElementSibling;
          if (sibling) return sibling.textContent.trim();
        }
      }
      return '';
    }

    // HOA Fees → hoaMonthly
    const hoaText = sectionText(/HOA\s*Fee/i);
    if (hoaText) {
      const m = hoaText.match(/\$?([\d,]+)/);
      if (m) result.hoaMonthly = Number(m[1].replace(/,/g, ''));
    }

    // Parking → garage count
    const parkingText = sectionText(/Parking/i);
    if (parkingText) {
      const m = parkingText.match(/^(\d+)/);
      if (m) result.garage = Number(m[1]);
    }

    // Lot Details → lotSqft
    const lotText = sectionText(/Lot\s*Details?/i);
    if (lotText) {
      const m = lotText.match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft)/i);
      if (m) result.lotSqft = Number(m[1].replace(/,/g, ''));
    }

    // Community Details → communityName
    const communityText = sectionText(/Community\s*Details?/i);
    if (communityText) result.communityName = communityText.split('\n')[0].trim() || null;

    // Builder → builderName
    const builderText = sectionText(/^Builder$/i);
    if (builderText) result.builderName = builderText.split('\n')[0].trim() || null;

    // MLS → mls
    const mlsText = sectionText(/^MLS/i);
    if (mlsText) {
      const m = mlsText.match(/([A-Z0-9]{6,})/i);
      if (m) result.mls = m[1];
    }

    // Schools section → assignedSchools
    const schoolHeaders = Array.from(document.querySelectorAll('h3, h4')).filter(
      (h) => /schools?/i.test(h.textContent.trim())
    );
    if (schoolHeaders.length) {
      const schoolSection = schoolHeaders[0].nextElementSibling
        ?? schoolHeaders[0].parentElement?.nextElementSibling;
      if (schoolSection) {
        const items = Array.from(schoolSection.querySelectorAll('li'));
        result.assignedSchools = items.map((el) => {
          const text = el.textContent.trim();
          let level = null;
          if (/elementary|primary/i.test(text)) level = 'elementary';
          else if (/middle|junior/i.test(text)) level = 'middle';
          else if (/high|senior/i.test(text)) level = 'high';
          return { name: text.split('\n')[0].trim(), level, source: 'homes' };
        }).filter((s) => s.name.length > 0);
      }
    }

    // Precise baths from summary detail block
    const allText = document.body?.innerText ?? '';
    const bathMatch = allText.match(/(\d+(?:\.\d+)?)\s*Ba(?:th)?s?\b/);
    if (bathMatch) result.baths = Number(bathMatch[1]);

    return result;
  }).catch(() => ({}));

  // Merge: DOM baths win over JSON-LD integer baths; JSON-LD wins for everything else
  for (const [key, value] of Object.entries(domFindings)) {
    if (value === null || value === undefined) continue;
    if (key === 'baths') {
      findings.baths = value;
    } else if (findings[key] === null || findings[key] === undefined) {
      findings[key] = value;
    }
  }

  if (!findings.address && !findings.price) {
    notes.push('homes: JSON-LD and DOM section parser found no structured data');
  }
  return { findings, notes };
}

async function extractGeneric(page, url) {
  const findings = {};
  const notes = [`generic extractor used for unknown platform host (${detectPlatform(url)})`];
  const jsonLd = await readJsonLd(page);
  const residence = pickJsonLdResidence(jsonLd);
  Object.assign(findings, fromJsonLdResidence(residence));
  return { findings, notes };
}

const PORTAL_EXTRACTORS = {
  zillow: extractZillow,
  redfin: extractRedfin,
  realtor: extractRealtor,
  homes: extractHomes,
  other: extractGeneric,
};

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

function scoreConfidence(listing) {
  const required = ['address', 'price', 'beds', 'baths', 'sqftFinished', 'yearBuilt'];
  const present = required.filter((key) => listing[key] !== null && listing[key] !== undefined);
  if (present.length >= 5) return 'high';
  if (present.length >= 3) return 'medium';
  return 'low';
}

function buildSlug(listing) {
  const candidate = [listing.address, listing.city, listing.state || 'NC']
    .filter(Boolean)
    .join('-');
  return slugify(candidate) || 'listing-target';
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

export async function extractListing(url, opts = {}) {
  if (!url) throw new Error('extractListing requires a URL');
  const profileName = opts.profileName ?? DEFAULT_PROFILE;
  const platform = detectPlatform(url);

  const listing = buildEmptyListing(url);
  let attached = null;
  try {
    attached = await attachHostedBrowser(ROOT, profileName);
    const { context, browser } = attached;
    const { page, error } = await navigateAndSettle(context, url, {
      navigationTimeoutMs: PAGE_TIMEOUT_MS,
      settleMs: SETTLE_MS,
    });
    if (!page) {
      listing.coverageNotes.push(`navigation failed: ${error?.message || 'unknown error'}`);
      listing.confidence = 'low';
      listing.listingStatus = 'unconfirmed';
      await safeClose({ browser });
      return listing;
    }

    try {
      const meta = await readPageMeta(page);
      if (meta.canonical) listing.canonicalUrl = meta.canonical;
      // Update platform if redirect changed it (e.g. ?from=srp-list-card → final URL)
      if (meta.url) {
        const finalPlatform = detectPlatform(meta.url);
        if (finalPlatform !== 'other') listing.platform = finalPlatform;
      }
      const extractor = PORTAL_EXTRACTORS[listing.platform] || PORTAL_EXTRACTORS.other;
      const { findings, notes } = await extractor(page, listing.platform);
      Object.assign(listing, findings);
      listing.coverageNotes.push(...notes);

      // Body-text fallback for listingStatus when extractors don't set one
      if (!listing.listingStatus || listing.listingStatus === 'unconfirmed') {
        listing.listingStatus = normalizeListingStatus('', meta.bodyText);
      }
    } finally {
      await safeClose({ page });
    }

    await safeClose({ browser });
  } catch (error) {
    listing.coverageNotes.push(`extractor error: ${error.message}`);
    if (attached?.browser) {
      await safeClose({ browser: attached.browser });
    }
  }

  listing.confidence = scoreConfidence(listing);
  return listing;
}

async function writeListing(listing) {
  const slug = buildSlug(listing);
  const outputPath = join(OUTPUT_DIR, `${slug}.json`);
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(listing, null, 2)}\n`, 'utf8');
  return { slug, outputPath };
}

function printSummary(listing, outputPath) {
  console.log('\nListing extract\n');
  console.log(`Platform:    ${listing.platform}`);
  console.log(`URL:         ${listing.url}`);
  console.log(`Status:      ${listing.listingStatus}`);
  console.log(`Confidence:  ${listing.confidence}`);
  console.log(`Address:     ${listing.address || '--'}, ${listing.city || '--'}, ${listing.state || '--'} ${listing.zip || ''}`.trim());
  console.log(`Price:       ${listing.price ?? '--'}`);
  console.log(`Beds/Baths:  ${listing.beds ?? '--'} / ${listing.baths ?? '--'}`);
  console.log(`SqFt:        ${listing.sqftFinished ?? '--'}`);
  console.log(`Year built:  ${listing.yearBuilt ?? '--'}`);
  console.log(`HOA mo:      ${listing.hoaMonthly ?? '--'}`);
  console.log(`Builder:     ${listing.builderName || '--'}`);
  console.log(`Community:   ${listing.communityName || '--'}`);
  console.log(`Schools:     ${listing.assignedSchools.length || 0}`);
  if (listing.coverageNotes.length) {
    console.log('\nCoverage notes:');
    for (const note of listing.coverageNotes) console.log(`  - ${note}`);
  }
  console.log(`\nWrote ${outputPath}`);
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

  if (!config.url) {
    console.error('Error: --url is required');
    console.error('');
    console.error(HELP_TEXT);
    process.exit(1);
  }

  const listing = await extractListing(config.url, { profileName: config.profileName });
  const { outputPath } = await writeListing(listing);

  if (config.json) {
    console.log(JSON.stringify({ outputPath, listing }, null, 2));
    return;
  }

  printSummary(listing, outputPath);
}

const isDirectEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectEntry) {
  main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}
