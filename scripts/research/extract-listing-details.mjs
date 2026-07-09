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
 *   4. Use crawl4ai as a fallback to supplement missing facts only when the
 *      hosted browser extraction is low-confidence or internally inconsistent.
 *
 * Hosted Chrome remains the primary verification surface. Generic crawl output
 * may supplement facts, but should not be the sole source for an inactive/sold
 * listing decision.
 */

import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from '../shared/paths.mjs';
import { slugify } from '../shared/text-utils.mjs';
import { expiresInDays, recordArtifact, subjectKeyForTarget, withSidecarMetadata } from '../shared/knowledge-store.mjs';
import {
  attachHostedBrowser,
  navigateAndSettle,
  safeClose,
} from '../browser/browser-extract-utils.mjs';
import { crawl4aiFetchPage, crawl4aiPortalExtract } from './crawl4ai-utils.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'listings');
const DEFAULT_PROFILE = 'chrome-host';
const PAGE_TIMEOUT_MS = 35000;
const SETTLE_MS = 2500;
const CRAWL4AI_TIMEOUT_MS = 30000;

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

function toRatingNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const slash = String(value).match(/\b(\d+(?:\.\d+)?)\s*\/\s*10\b/);
  if (slash) return Number.parseFloat(slash[1]);
  return toNumber(value);
}

function pickFirst(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return null;
}

export function normalizeListingStatus(raw, bodyText = '') {
  const rawStr = String(raw ?? '').toLowerCase();
  // schema.org/InStock and explicit active signals in the raw status string take
  // priority over body-text scanning, which can pick up historical listing events.
  if (/instock|in-stock/i.test(rawStr)) return 'active';
  if (/active|for[\s-]sale|listed/i.test(rawStr)) return 'active';

  // Treat short raw values as authoritative status fields. Full-page body text
  // often includes "sold nearby" or historical price events, so never classify
  // a page as sold from an unscoped body-wide match.
  if (rawStr && rawStr.length <= 160) {
    if (/(off[\s-]?market|delisted|removed|withdrawn|not\s+for\s+sale)/i.test(rawStr)) return 'off-market';
    if (/(pending|under\s+contract|contingent)/i.test(rawStr)) return 'pending';
    if (/(^|\b)(sold|closed)(\b|$)|sold\s+on/i.test(rawStr)) return 'sold';
  }

  const zone = statusSignalZone(bodyText);
  if (hasActiveListingSignals(zone)) return 'active';
  if (/(off[\s-]?market|delisted|removed|withdrawn|not\s+for\s+sale)/i.test(zone)) return 'off-market';
  if (/(pending|under\s+contract|contingent)/i.test(zone)) return 'pending';
  if (/(?:\bstatus\s*:?\s*sold\b|\bsold\s+on\b|\bsold\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b|\bproperty\s+has\s+been\s+sold\b|\bhome\s+has\s+been\s+sold\b|\bclosed\b)/i.test(zone)) return 'sold';
  return 'unconfirmed';
}

function statusSignalZone(text) {
  return String(text ?? '')
    .toLowerCase()
    .slice(0, 2800);
}

function hasActiveListingSignals(text) {
  const value = String(text ?? '').toLowerCase();
  return /(?:\bfor\s+sale\b|\bactive\b|\blisted\s+by\b|\bschedule\s+(?:a\s+)?tour\b|\brequest\s+(?:a\s+)?tour\b|\bcontact\s+(?:agent|builder)\b|\bnew\s+construction\b|\bopen\s+house\b)/i.test(value);
}

function hasInactiveListingSignals(text) {
  const value = statusSignalZone(text);
  return /(?:off[\s-]?market|delisted|removed|withdrawn|not\s+for\s+sale|pending|under\s+contract|contingent|sold\s+on|\bclosed\b)/i.test(value);
}

function normalizeSchoolLevel(raw) {
  const value = String(raw ?? '').toLowerCase();
  if (/elementary|primary/.test(value)) return 'elementary';
  if (/middle|junior/.test(value)) return 'middle';
  if (/high|senior/.test(value)) return 'high';
  if (/(?:pre[-\s]?k|pk|k|[0-5])\s*-\s*5\b|\bk\s*-\s*5\b/.test(value)) return 'elementary';
  if (/\b6\s*-\s*8\b/.test(value)) return 'middle';
  if (/\b9\s*-\s*12\b/.test(value)) return 'high';
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
      rating: toRatingNumber(entry.rating ?? entry.greatSchoolsRating ?? entry.score),
      distance: pickFirst(entry.distance, entry.distanceText) || null,
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

  // homes.com wraps the SingleFamilyResidence under item.mainEntity inside the
  // RealEstateListing.  When mainEntity is present, prefer its address/bedroom/
  // sqft fields while keeping the top-level offers/description/datePosted.
  const entity = (item.mainEntity && typeof item.mainEntity === 'object') ? item.mainEntity : item;

  const address = entity.address || item.address || {};
  result.address = pickFirst(address.streetAddress, entity.streetAddress, item.streetAddress);
  result.city = pickFirst(address.addressLocality, entity.addressLocality, item.addressLocality);
  result.state = pickFirst(address.addressRegion, entity.addressRegion, item.addressRegion);
  result.zip = pickFirst(address.postalCode, entity.postalCode, item.postalCode);

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

  result.beds = toNumber(entity.numberOfBedrooms ?? entity.numberOfRooms ?? item.numberOfBedrooms ?? item.numberOfRooms);
  const baths = entity.numberOfBathroomsTotal ?? entity.numberOfBathrooms ?? entity.numberOfFullBathrooms
    ?? item.numberOfBathroomsTotal ?? item.numberOfBathrooms ?? item.numberOfFullBathrooms;
  result.baths = toNumber(baths);

  const floor = entity.floorSize ?? item.floorSize;
  if (floor && typeof floor === 'object') {
    result.sqftFinished = toNumber(floor.value);
  } else {
    result.sqftFinished = toNumber(floor);
  }

  result.yearBuilt = toNumber(entity.yearBuilt ?? entity.dateBuilt ?? item.yearBuilt ?? item.dateBuilt);
  result.propertyType = pickFirst(entity.propertyType, entity.category, item.propertyType, item.category);
  result.description = pickFirst(item.description, entity.description);
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

  if (!Array.isArray(findings.assignedSchools) || findings.assignedSchools.length === 0) {
    const visibleSchools = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.SchoolsListItem'));
      return rows.map((row) => {
        const name = row.querySelector('.SchoolsListItem__heading')?.textContent?.trim() || '';
        const description = row.querySelector('.SchoolsListItem__description')?.textContent?.trim() || '';
        const rating = row.querySelector('.SchoolsListItem__schoolRating')?.textContent?.trim() || '';
        const distance = description.match(/(?:Assigned\s*[•|,]?\s*)?([0-9.]+\s*mi)/i)?.[1] || '';
        return { name, gradeLevel: `${name} ${description}`, rating, distance, source: 'redfin-dom' };
      }).filter((school) => school.name && /assigned/i.test(school.gradeLevel));
    }).catch(() => []);
    if (visibleSchools.length > 0) {
      findings.assignedSchools = normalizeSchools(visibleSchools);
      notes.push(`redfin: captured ${visibleSchools.length} visible assigned school rows from DOM`);
    }
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

        // listingAgent from advertisers array
        const advertisers = Array.isArray(listing.advertisers) ? listing.advertisers : [];
        if (advertisers[0]?.name) {
          findings.listingAgent = String(advertisers[0].name).trim();
        } else {
          findings.listingAgent = null;
        }

        // MLS from source.listing_id (the canonical MLS number realtor.com stores per-listing)
        const src = listing.source && typeof listing.source === 'object' ? listing.source : null;
        if (src?.listing_id) {
          findings.mls = String(src.listing_id).trim();
        } else {
          findings.mls = null;
        }

        // daysOnMarket: source.days_on_mls is authoritative (MLS-supplied); fall back to
        // listing.days_on_market, then list_date_min, then compute from list_date string
        if (src?.days_on_mls != null) {
          findings.daysOnMarket = toNumber(src.days_on_mls);
        } else if (listing.days_on_market != null) {
          findings.daysOnMarket = toNumber(listing.days_on_market);
        } else if (listing.list_date_min != null) {
          findings.daysOnMarket = toNumber(listing.list_date_min);
        } else if (listing.list_date) {
          const listed = new Date(listing.list_date);
          if (!Number.isNaN(listed.getTime())) {
            findings.daysOnMarket = Math.floor((Date.now() - listed.getTime()) / (1000 * 60 * 60 * 24));
          }
        }

        // Precise baths: use baths_full + halves when available
        if (typeof desc.baths_full === 'number') {
          findings.baths = desc.baths_full
            + 0.5 * (desc.baths_half ?? 0)
            + 0.5 * (desc.baths_3qtr ?? 0);
        }
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
      const m = parkingText.match(/(\d+)/);
      if (m) result.garage = Number(m[1]);
    }

    // Lot Details → lotSqft
    const lotText = sectionText(/Lot\s*Details?/i);
    if (lotText) {
      const m = lotText.match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft)/i);
      if (m) result.lotSqft = Number(m[1].replace(/,/g, ''));
    }

    // Listing Details section → builderName (e.g. "Builder Name: Taylor Morrison")
    const listingDetailsText = sectionText(/^Listing\s*Details?$/i);
    if (listingDetailsText) {
      const builderMatch = listingDetailsText.match(/Builder\s*Name\s*:\s*([^\n\r]+)/i);
      if (builderMatch) result.builderName = builderMatch[1].trim() || null;
    }

    // Builder section (fallback for portals that have a standalone Builder h3)
    if (!result.builderName) {
      const builderText = sectionText(/^Builder$/i);
      if (builderText) result.builderName = builderText.split('\n')[0].trim() || null;
    }

    // Community Details → communityName from subdivision/built-by lines
    // The "Overview" h3 sibling contains community info including the subdivision name
    const communityOverviewText = sectionText(/^Overview$/i);
    if (communityOverviewText) {
      // Look for "Brighton Ridge Subdivision" or "Built in XYZ Subdivision" patterns
      const subMatch = communityOverviewText.match(/([A-Z][A-Za-z0-9 ]+(?:Subdivision|Community|Development|Neighborhood))/i);
      if (subMatch) {
        result.communityName = subMatch[1].trim();
      } else {
        // Fall back to "Built by X" line
        const builtByMatch = communityOverviewText.match(/Built\s+by\s+([^\n\r,]+)/i);
        if (builtByMatch && !result.builderName) result.builderName = builtByMatch[1].trim();
      }
    }

    // MLS → extract from body text pattern "MLS Number: XXXXXX" or "MLS# XXXXXX"
    const allBodyText = document.body?.innerText ?? '';
    const mlsBodyMatch = allBodyText.match(/MLS(?:\s*Number|\s*#|#)\s*:?\s*([A-Z0-9]{6,})/i);
    if (mlsBodyMatch) result.mls = mlsBodyMatch[1].trim();

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

function parseJsonLdFromHtml(html) {
  const items = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(String(html ?? ''))) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) items.push(...parsed);
      else items.push(parsed);
    } catch {
      // ignore malformed markup
    }
  }
  return items;
}

function htmlText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldUseCrawl4aiFallback(listing) {
  if (listing.confidence === 'low') return true;
  if (!listing.address || !listing.price) return true;
  if (['sold', 'off-market', 'pending'].includes(listing.listingStatus)) return true;
  return false;
}

function mergeSupplementalFindings(listing, findings) {
  for (const [key, value] of Object.entries(findings)) {
    if (value === null || value === undefined) continue;
    if (key === 'assignedSchools' && Array.isArray(value) && value.length && !listing.assignedSchools.length) {
      listing.assignedSchools = value;
      continue;
    }
    if (key === 'photos' && value?.count && !listing.photos?.count) {
      listing.photos = value;
      continue;
    }
    if (listing[key] === null || listing[key] === undefined || listing[key] === '') {
      listing[key] = value;
    }
  }
}

async function extractWithCrawl4ai(url) {
  const page = await crawl4aiFetchPage(url, { timeoutMs: CRAWL4AI_TIMEOUT_MS });
  if (!page.html) {
    return {
      findings: {},
      notes: [`crawl4ai fallback unavailable: ${page.error || page.status || 'unknown error'}`],
    };
  }

  const jsonLd = parseJsonLdFromHtml(page.html);
  const residence = pickJsonLdResidence(jsonLd);
  const findings = fromJsonLdResidence(residence);
  const text = htmlText(page.html).slice(0, 12000);
  const status = normalizeListingStatus('', text);
  if (status !== 'unconfirmed') findings.listingStatus = status;
  return {
    findings,
    notes: [`crawl4ai fallback checked ${page.finalUrl || url}${page.ok ? '' : ` (partial: ${page.error || page.status || 'limited capture'})`}`],
    text,
  };
}

const PORTAL_EXTRACTORS = {
  zillow: extractZillow,
  redfin: extractRedfin,
  realtor: extractRealtor,
  homes: extractHomes,
  other: extractGeneric,
};

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function extractWithHostedBrowser(url, profileName, platform) {
  let browser = null;
  let page = null;
  const notes = [];
  try {
    const attached = await attachHostedBrowser(ROOT, profileName);
    browser = attached.browser;
    const nav = await navigateAndSettle(attached.context, url, {
      navigationTimeoutMs: PAGE_TIMEOUT_MS,
      settleMs: SETTLE_MS,
    });
    page = nav.page;
    if (!page) {
      return {
        findings: {},
        notes: [`hosted browser extraction failed to navigate: ${nav.error?.message || 'unknown error'}`],
      };
    }

    const extractor = PORTAL_EXTRACTORS[platform] ?? PORTAL_EXTRACTORS.other;
    const result = await extractor(page, url);
    const meta = await readPageMeta(page);
    const findings = result.findings ?? {};
    if (!findings.listingStatus || findings.listingStatus === 'unconfirmed') {
      findings.listingStatus = normalizeListingStatus(meta.status || meta.title, meta.bodyText);
    }
    findings.canonicalUrl = meta.canonical || meta.url || null;
    notes.push(...(result.notes ?? []));
    notes.push('hosted browser fallback extraction checked page structured data');
    if (hasInactiveListingSignals(meta.bodyText) && findings.listingStatus === 'active') {
      notes.push('hosted browser page also contained inactive-status language; status confidence reduced');
    }
    return { findings, notes };
  } catch (error) {
    return {
      findings: {},
      notes: [`hosted browser fallback extraction error: ${error.message}`],
    };
  } finally {
    await safeClose({ page, browser });
  }
}

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
  const browserResult = await extractWithHostedBrowser(url, profileName, platform);
  mergeSupplementalFindings(listing, browserResult.findings);
  listing.coverageNotes.push(...browserResult.notes);

  if (shouldUseCrawl4aiFallback(listing) && process.env.HOME_OPS_ENABLE_CRAWL4AI_LISTING === '1') {
    try {
      const result = await withTimeout(
        crawl4aiPortalExtract({
          mode: 'detail',
          platform,
          url,
          profileName,
          timeoutMs: CRAWL4AI_TIMEOUT_MS,
        }),
        CRAWL4AI_TIMEOUT_MS + 20000,
        'crawl4ai detail extraction'
      );

      if (result.listing) {
        mergeSupplementalFindings(listing, result.listing);
        listing.platform = result.listing.platform || platform;
        listing.url = url;
        listing.canonicalUrl = result.listing.canonicalUrl || result.finalUrl || null;
        if (result.listing.listingStatus) {
          listing.listingStatus = result.listing.listingStatus;
        }
        listing.coverageNotes.push(...(result.listing.coverageNotes ?? []));
      }

      listing.coverageNotes.push(...result.notes);
      if (result.captureStatus === 'blocked') {
        listing.coverageNotes.push('crawl4ai detail extraction was blocked or rate-limited');
        listing.listingStatus = 'unconfirmed';
      } else if (result.captureStatus === 'empty') {
        listing.coverageNotes.push('crawl4ai detail extraction found no usable listing facts');
      } else if (result.captureStatus === 'error') {
        listing.coverageNotes.push(`crawl4ai detail extraction error: ${result.error || 'unknown error'}`);
      }
    } catch (error) {
      listing.coverageNotes.push(`crawl4ai detail extractor error: ${error.message}`);
    }
  }

  listing.confidence = scoreConfidence(listing);
  return listing;
}

// ---------------------------------------------------------------------------
// Photo caching
// The briefing PDF embeds photos as base64 data URIs, so they must exist on
// disk at capture time -- remote hotlinks 403 or stall networkidle at render.
// ---------------------------------------------------------------------------

const PHOTO_DOWNLOAD_TIMEOUT_MS = 10000;
const PHOTO_MAX_COUNT = 3;

export async function savePhotoBuffers(slug, buffers, { root = ROOT } = {}) {
  const photoDir = join(root, 'output', 'listings', 'photos', slug);
  const localPaths = [];
  let wroteDir = false;
  for (let index = 0; index < buffers.length; index += 1) {
    const buffer = buffers[index];
    if (!buffer || buffer.length === 0) continue;
    if (!wroteDir) {
      await mkdir(photoDir, { recursive: true });
      wroteDir = true;
    }
    const filePath = join(photoDir, `photo-${index + 1}.jpg`);
    await writeFile(filePath, buffer);
    localPaths.push(relative(root, filePath).replace(/\\/g, '/'));
  }
  return localPaths;
}

async function fetchPhotoBuffer(requestContext, url) {
  if (requestContext) {
    try {
      const response = await requestContext.get(url, { timeout: PHOTO_DOWNLOAD_TIMEOUT_MS });
      if (response.ok()) return Buffer.from(await response.body());
    } catch { /* fall through to plain fetch */ }
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PHOTO_DOWNLOAD_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) return Buffer.from(await response.arrayBuffer());
  } catch { /* unrecoverable for this photo */ }
  return null;
}

export async function downloadListingPhotos(listing, profileName) {
  const urls = (listing.photos?.urls ?? []).slice(0, PHOTO_MAX_COUNT);
  if (urls.length === 0) return listing;

  let browser = null;
  let requestContext = null;
  try {
    const attached = await attachHostedBrowser(ROOT, profileName);
    browser = attached.browser;
    requestContext = attached.context.request;
  } catch {
    listing.coverageNotes.push('photo download: hosted session unavailable, using direct fetch only');
  }

  const buffers = [];
  for (const url of urls) {
    buffers.push(await fetchPhotoBuffer(requestContext, url));
  }
  if (browser) await safeClose({ browser });

  const localPaths = await savePhotoBuffers(buildSlug(listing), buffers);
  if (localPaths.length > 0) {
    listing.photos.localPaths = localPaths;
  } else {
    listing.coverageNotes.push('photo download failed for all listing photos');
  }
  return listing;
}

async function writeListing(listing) {
  const slug = buildSlug(listing);
  const outputPath = join(OUTPUT_DIR, `${slug}.json`);
  const generatedAt = new Date().toISOString();
  const sidecar = withSidecarMetadata({
    generatedAt,
    ...listing,
  }, {
    kind: 'listing',
    scope: 'property',
    subject: listing,
    subjectKey: subjectKeyForTarget(listing),
    generatedAt,
    expiresAt: expiresInDays(7, generatedAt),
    sourceUrls: [listing.url, listing.canonicalUrl].filter(Boolean),
    status: listing.listingStatus ?? 'unconfirmed',
    warnings: listing.coverageNotes ?? [],
  });
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  recordArtifact({
    path: outputPath,
    kind: 'listing',
    scope: 'property',
    subject: listing,
    subjectKey: sidecar.subjectKey,
    commandId: sidecar.commandId,
    generatedAt: sidecar.generatedAt,
    expiresAt: sidecar.expiresAt,
    sourceUrls: sidecar.sourceUrls,
    status: sidecar.status,
    warnings: sidecar.warnings,
  });
  return { slug, outputPath, listing: sidecar };
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
  await downloadListingPhotos(listing, config.profileName);
  const { outputPath, listing: writtenListing } = await writeListing(listing);

  if (config.json) {
    console.log(JSON.stringify({ outputPath, listing: writtenListing }, null, 2));
    return;
  }

  printSummary(writtenListing, outputPath);
}

const isDirectEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectEntry) {
  main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}
