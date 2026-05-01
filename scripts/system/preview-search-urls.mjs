#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { chromium } from 'playwright';
import YAML from 'yaml';
import { readSessionState } from '../browser/browser-session.mjs';
import { ROOT, PORTALS_PATH, PROFILE_PATH } from '../shared/paths.mjs';

const PLATFORM_ORDER = ['zillow', 'redfin', 'realtor', 'homes'];
const DEFAULT_PROFILE_NAME = 'chrome-host';

function readYamlFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing required file: ${filePath}`);
  }
  return YAML.parse(readFileSync(filePath, 'utf8')) ?? {};
}

function loadRequirements(parsed) {
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

function formatCompactThousands(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  if (numeric % 1000 === 0) return String(Math.round(numeric / 1000));
  return Number((numeric / 1000).toFixed(1)).toString();
}

function syncZillowSearchUrl(rawUrl, r) {
  const parsed = new URL(rawUrl);
  const rawState = parsed.searchParams.get('searchQueryState');
  const state = rawState ? JSON.parse(rawState) : { pagination: {}, filterState: {} };
  const f = state.filterState ?? {};
  if (r.priceMin > 0 || r.priceMax < Number.MAX_SAFE_INTEGER) {
    f.price = { ...(f.price ?? {}), ...(r.priceMin > 0 ? { min: r.priceMin } : {}), ...(r.priceMax < Number.MAX_SAFE_INTEGER ? { max: r.priceMax } : {}) };
  }
  if (r.bedsMin > 0) f.beds = { ...(f.beds ?? {}), min: r.bedsMin };
  if (r.bathsMin > 0) f.baths = { ...(f.baths ?? {}), min: r.bathsMin };
  if (r.sqftMin > 0) f.sqft = { ...(f.sqft ?? {}), min: r.sqftMin };
  if (r.garageMin > 0) f.garSp = { ...(f.garSp ?? {}), min: r.garageMin };
  if (r.maxListingAgeDays < Number.MAX_SAFE_INTEGER) f.doz = { ...(f.doz ?? {}), value: String(r.maxListingAgeDays) };
  if (r.hoaMaxMonthly > 0) f.hoa = { ...(f.hoa ?? {}), max: r.hoaMaxMonthly };
  if (r.yearBuiltMin > 0) f.built = { ...(f.built ?? {}), min: r.yearBuiltMin };
  if (r.homeTypePreference === 'resale_only') {
    f.isMultiFamily = { value: false };
    f.isApartment = { value: false };
    f.isCondo = { value: false };
    f.isTownhouse = { value: false };
    f.isManufactured = { value: false };
    f.isLotLand = { value: false };
    f.nc = { value: false };
  }
  state.filterState = f;
  parsed.searchParams.set('searchQueryState', JSON.stringify(state));
  return parsed.toString();
}

function syncRedfinSearchUrl(rawUrl, r) {
  const parsed = new URL(rawUrl);
  const [pathnameRoot, rawFilterSegment] = parsed.pathname.split('/filter/');
  const existing = rawFilterSegment ? rawFilterSegment.split(',').filter(Boolean) : [];
  const managed = [
    'min-price=', 'max-price=', 'min-beds=', 'min-baths=', 'min-sqft=', 'hoa=',
    'min-parking-spots=', 'min-year-built=', 'property-type=', 'include=',
  ];
  const tokens = existing.filter((t) => !managed.some((p) => t.startsWith(p)));
  const minPrice = formatCompactThousands(r.priceMin);
  const maxPrice = formatCompactThousands(r.priceMax);
  const minSqft = formatCompactThousands(r.sqftMin);
  if (minPrice) tokens.push(`min-price=${minPrice}k`);
  if (maxPrice && r.priceMax < Number.MAX_SAFE_INTEGER) tokens.push(`max-price=${maxPrice}k`);
  if (r.bedsMin > 0) tokens.push(`min-beds=${Math.ceil(r.bedsMin)}`);
  if (r.bathsMin > 0) tokens.push(`min-baths=${r.bathsMin}`);
  if (minSqft) tokens.push(`min-sqft=${minSqft}k-sqft`);
  if (r.hoaMaxMonthly > 0) tokens.push(`hoa=${r.hoaMaxMonthly}`);
  if (r.garageMin > 0) tokens.push(`min-parking-spots=${r.garageMin}`);
  if (r.yearBuiltMin > 0) tokens.push(`min-year-built=${r.yearBuiltMin}`);
  if (r.homeTypePreference === 'resale_only') {
    tokens.push('property-type=house');
    tokens.push('include=resale-only');
  }
  parsed.pathname = tokens.length > 0 ? `${pathnameRoot.replace(/\/+$/, '')}/filter/${tokens.join(',')}` : pathnameRoot;
  return parsed.toString();
}

function syncRealtorSearchUrl(rawUrl, r) {
  const parsed = new URL(rawUrl);
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return rawUrl;
  const [searchRoot, areaSegment, ...existing] = segments;
  const managed = ['beds-', 'baths-', 'price-', 'sqft-', 'garage-', 'age-', 'hoa-', 'built-after-', 'type-'];
  const synced = existing.filter((s) => !managed.some((p) => s.startsWith(p)));
  if (r.bedsMin > 0) synced.push(`beds-${Math.ceil(r.bedsMin)}`);
  if (r.bathsMin > 0) synced.push(`baths-${r.bathsMin}`);
  if (r.priceMin > 0 || r.priceMax < Number.MAX_SAFE_INTEGER) {
    const lo = r.priceMin > 0 ? r.priceMin : 0;
    const hi = r.priceMax < Number.MAX_SAFE_INTEGER ? r.priceMax : r.priceMin;
    synced.push(`price-${lo}-${hi}`);
  }
  if (r.sqftMin > 0) synced.push(`sqft-${r.sqftMin}`);
  if (r.garageMin > 0) synced.push(`garage-${r.garageMin}`);
  if (r.maxListingAgeDays < Number.MAX_SAFE_INTEGER) synced.push(`age-${r.maxListingAgeDays}`);
  if (r.hoaMaxMonthly > 0) synced.push(`hoa-${r.hoaMaxMonthly}`);
  if (r.yearBuiltMin > 0) synced.push(`built-after-${r.yearBuiltMin}`);
  if (r.homeTypePreference === 'resale_only') synced.push('type-single-family-home');
  parsed.pathname = `/${[searchRoot, areaSegment, ...synced].join('/')}`;
  return parsed.toString();
}

function syncHomesSearchUrl(rawUrl, r) {
  const parsed = new URL(rawUrl);
  const p = parsed.searchParams;
  ['price-min', 'price-max', 'bath-min', 'bath-max', 'sfmin', 'yb-min', 'hoa-max', 'gsr-min', 'gsr-max', 'parking', 'dom-max', 'ssit'].forEach((k) => p.delete(k));
  if (r.priceMin > 0) p.set('price-min', String(r.priceMin));
  if (r.priceMax < Number.MAX_SAFE_INTEGER) p.set('price-max', String(r.priceMax));
  if (r.bathsMin > 0) p.set('bath-min', String(Math.ceil(r.bathsMin)));
  if (r.sqftMin > 0) p.set('sfmin', String(r.sqftMin));
  if (r.yearBuiltMin > 0) p.set('yb-min', String(r.yearBuiltMin));
  if (r.hoaMaxMonthly > 0) p.set('hoa-max', String(r.hoaMaxMonthly));
  if (r.schoolsMinRating > 0) {
    p.set('gsr-min', String(r.schoolsMinRating));
    p.set('gsr-max', '10');
  }
  if (r.garageMin > 0) p.set('parking', String(r.garageMin));
  if (r.maxListingAgeDays < Number.MAX_SAFE_INTEGER) p.set('dom-max', `${r.maxListingAgeDays}d`);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const base = [];
  for (const seg of segments) {
    if (seg === 'houses-for-sale') continue;
    if (seg === 'resale' || seg === 'new-construction') continue;
    if (/^\d+(?:-to-\d+)?-bedroom$/.test(seg)) continue;
    base.push(seg);
  }
  if (r.homeTypePreference === 'resale_only') base.push('resale');
  if (r.bedsMin > 0) {
    const min = Math.ceil(r.bedsMin);
    base.push(`${min}-to-${Math.max(min + 1, 5)}-bedroom`);
  }
  parsed.pathname = `/${base.join('/')}/`;
  return parsed.toString();
}

const SYNCERS = {
  zillow: syncZillowSearchUrl,
  redfin: syncRedfinSearchUrl,
  realtor: syncRealtorSearchUrl,
  homes: syncHomesSearchUrl,
};

const FIELDS_BY_PLATFORM = {
  zillow: ['priceMin', 'priceMax', 'bedsMin', 'bathsMin', 'sqftMin', 'garageMin', 'maxListingAgeDays', 'hoaMaxMonthly', 'yearBuiltMin', 'homeTypePreference'],
  redfin: ['priceMin', 'priceMax', 'bedsMin', 'bathsMin', 'sqftMin', 'hoaMaxMonthly', 'garageMin', 'yearBuiltMin', 'homeTypePreference'],
  realtor: ['priceMin', 'priceMax', 'bedsMin', 'bathsMin', 'sqftMin', 'garageMin', 'maxListingAgeDays', 'hoaMaxMonthly', 'yearBuiltMin', 'homeTypePreference'],
  homes: ['priceMin', 'priceMax', 'bedsMin', 'bathsMin', 'sqftMin', 'garageMin', 'maxListingAgeDays', 'hoaMaxMonthly', 'yearBuiltMin', 'homeTypePreference', 'schoolsMinRating'],
};

const ALL_PROFILE_FIELDS = ['priceMin', 'priceMax', 'bedsMin', 'bathsMin', 'sqftMin', 'garageMin', 'maxListingAgeDays', 'hoaMaxMonthly', 'yearBuiltMin', 'homeTypePreference', 'schoolsMinRating'];

function parseArgs(argv) {
  const cfg = { open: false, useHosted: false, profileName: DEFAULT_PROFILE_NAME, area: 'Apex', platforms: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--open') cfg.open = true;
    else if (a === '--use-hosted') { cfg.open = true; cfg.useHosted = true; }
    else if (a === '--profile') { cfg.profileName = argv[++i]; }
    else if (a === '--area') { cfg.area = argv[++i]; }
    else if (a.startsWith('--')) {
      const key = a.replace(/^--/, '').toLowerCase();
      const canonical = key === 'relator' ? 'realtor' : key;
      if (PLATFORM_ORDER.includes(canonical)) {
        cfg.platforms.add(canonical);
      }
    }
  }
  return cfg;
}

async function getHostedContext(profileName) {
  const session = await readSessionState(ROOT, profileName);
  if (!session?.data?.cdpUrl) {
    throw new Error(`No hosted session found for profile "${profileName}". Run /home-ops init first.`);
  }
  try {
    const r = await fetch(`${session.data.cdpUrl}/json/version`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    throw new Error(`Hosted CDP at ${session.data.cdpUrl} unreachable: ${err.message}. Run npm run browser:setup to relaunch.`);
  }
  const browser = await chromium.connectOverCDP(session.data.cdpUrl, { timeout: 30000, isLocal: true });
  const context = browser.contexts()[0];
  if (!context) throw new Error('Hosted browser exposes no default context.');
  return { browser, context, hosted: true };
}

async function getEphemeralContext() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  return { browser, context, hosted: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = readYamlFile(PROFILE_PATH);
  const portals = readYamlFile(PORTALS_PATH);
  const r = loadRequirements(profile);

  console.log('=== Profile values used by scanner ===');
  for (const k of ALL_PROFILE_FIELDS) {
    console.log(`  ${k.padEnd(20)} = ${JSON.stringify(r[k])}`);
  }
  console.log('');

  const platformsToShow = args.platforms.size > 0 ? [...args.platforms] : PLATFORM_ORDER;
  const urlsToOpen = [];

  for (const platform of platformsToShow) {
    const config = portals.platforms?.[platform];
    if (!config) {
      console.log(`[${platform}] not present in portals.yml`);
      continue;
    }
    console.log(`=== ${config.name} (${platform}) ===`);
    console.log(`  Profile fields applied to URL: ${FIELDS_BY_PLATFORM[platform].join(', ')}`);
    const missing = ALL_PROFILE_FIELDS.filter((f) => !FIELDS_BY_PLATFORM[platform].includes(f));
    if (missing.length > 0) {
      console.log(`  Profile fields NOT pushed into URL: ${missing.join(', ')}`);
    }
    console.log('');
    for (const search of config.search_urls ?? []) {
      const synced = SYNCERS[platform](search.url, r);
      console.log(`  [${search.area}]`);
      console.log(`    base   : ${search.url}`);
      console.log(`    synced : ${synced}`);
      if (search.area === args.area) {
        urlsToOpen.push({ platform, name: config.name, area: search.area, url: synced });
      }
    }
    console.log('');
  }

  if (!args.open) {
    console.log('Pass --open to launch a fresh Chromium, or --use-hosted to load the URLs in your existing /home-ops init Chrome session.');
    return;
  }

  if (urlsToOpen.length === 0) {
    console.log(`No URLs matched --area ${args.area}; nothing to open.`);
    return;
  }

  let ctx;
  try {
    ctx = args.useHosted ? await getHostedContext(args.profileName) : await getEphemeralContext();
  } catch (err) {
    console.error(`Cannot get browser: ${err.message}`);
    process.exit(1);
  }

  console.log(`${ctx.hosted ? 'Connected to hosted Chrome session' : 'Launched fresh Chromium'}; opening ${urlsToOpen.length} URLs for area "${args.area}"...`);
  for (const entry of urlsToOpen) {
    const page = await ctx.context.newPage();
    console.log(`  -> ${entry.name} ${entry.area}`);
    try {
      await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      console.log(`     navigation issue: ${err.message.split('\n')[0]}`);
    }
  }
  console.log('');
  if (ctx.hosted) {
    console.log('Tabs opened in your hosted Chrome window. Close tabs manually when finished. This script will now exit.');
    await ctx.browser.close().catch(() => {});
    return;
  }
  console.log('Browser left open. Close it manually when finished, or press Ctrl+C in this terminal.');
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
