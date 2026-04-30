#!/usr/bin/env node

// skim-portals.mjs -- Open one filtered search tab per configured portal area.
//
// Reads portals.yml and config/profile.yml, syncs search filters from the
// buyer profile into each platform URL, then opens a tab for each area in the
// active hosted browser session.  If no hosted session is running, launches one
// automatically before opening tabs.
//
// Usage:
//   node skim-portals.mjs
//   node skim-portals.mjs --zillow --redfin
//   node skim-portals.mjs --no-zillow
//   node skim-portals.mjs --status
//
// Options:
//   --zillow        Open Zillow tabs only.
//   --redfin        Open Redfin tabs only.
//   --relator       Open Realtor.com tabs only.
//   --realtor       Backward-compatible alias for --relator.
//   --homes         Open Homes.com tabs only.
//   --no-zillow     Skip Zillow.
//   --no-redfin     Skip Redfin.
//   --no-relator    Skip Realtor.com.
//   --no-homes      Skip Homes.com.
//   --status        Show session status and exit.
//   --profile NAME  Use a named browser profile (default: chrome-host).
//   --help          Show this help text.

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import YAML from 'yaml';
import {
  readSessionState,
  writeSessionState,
  launchHostedBrowserSession,
} from './browser-session.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_PROFILE = 'chrome-host';
const DEFAULT_CDP_PORT = 9222;
const NAVIGATION_TIMEOUT_MS = 15000;
const SETTLE_TIMEOUT_MS = 1200;
const PORTALS_PATH = join(ROOT, 'portals.yml');
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');

const PLATFORM_FLAG_MAP = {
  '--zillow': { include: 'zillow' },
  '--redfin': { include: 'redfin' },
  '--relator': { include: 'realtor' },
  '--realtor': { include: 'realtor' },
  '--realtor.com': { include: 'realtor' },
  '--homes': { include: 'homes' },
  '--homes.com': { include: 'homes' },
  '--no-zillow': { exclude: 'zillow' },
  '--no-redfin': { exclude: 'redfin' },
  '--no-relator': { exclude: 'realtor' },
  '--no-realtor': { exclude: 'realtor' },
  '--no-homes': { exclude: 'homes' },
};

const HELP_TEXT = `Usage:
  node skim-portals.mjs
  node skim-portals.mjs --zillow --redfin --relator --homes
  node skim-portals.mjs --no-zillow

Options:
  --zillow        Open Zillow search tabs only.
  --redfin        Open Redfin search tabs only.
  --relator       Open Realtor.com search tabs only.
  --homes         Open Homes.com search tabs only.
  --no-zillow     Skip Zillow.
  --no-redfin     Skip Redfin.
  --no-relator    Skip Realtor.com.
  --no-homes      Skip Homes.com.
  --status        Show session status and exit.
  --profile NAME  Use a named browser profile (default: chrome-host).
  --help          Show this help text.`;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const config = {
    profileName: DEFAULT_PROFILE,
    selectedPlatforms: new Set(),
    excludedPlatforms: new Set(),
    statusOnly: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      config.help = true;
      continue;
    }

    if (arg === '--status') {
      config.statusOnly = true;
      continue;
    }

    if (arg === '--profile') {
      config.profileName = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    const flagEntry = PLATFORM_FLAG_MAP[arg];
    if (flagEntry) {
      if (flagEntry.include) config.selectedPlatforms.add(flagEntry.include);
      if (flagEntry.exclude) config.excludedPlatforms.add(flagEntry.exclude);
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    throw new Error(`Unexpected argument: ${arg}. Run with --help for usage.`);
  }

  if (!config.profileName) {
    throw new Error('Expected a profile name after --profile.');
  }

  return config;
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

function readYamlFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing required file: ${filePath}`);
  }
  return YAML.parse(readFileSync(filePath, 'utf8')) ?? {};
}

function canonicalPlatformKey(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'relator' || normalized === 'realtor.com') return 'realtor';
  if (normalized === 'homes.com') return 'homes';
  return normalized;
}

// ---------------------------------------------------------------------------
// Filter sync -- mirrors the logic in scan-listings.mjs
// ---------------------------------------------------------------------------

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

function syncZillowSearchUrl(rawUrl, req) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    const rawState = parsed.searchParams.get('searchQueryState');
    const state = rawState ? JSON.parse(rawState) : { pagination: {}, filterState: {} };
    const f = state.filterState ?? {};

    if (req.priceMin > 0 || req.priceMax < Number.MAX_SAFE_INTEGER) {
      f.price = {
        ...(f.price ?? {}),
        ...(req.priceMin > 0 ? { min: req.priceMin } : {}),
        ...(req.priceMax < Number.MAX_SAFE_INTEGER ? { max: req.priceMax } : {}),
      };
    }
    if (req.bedsMin > 0) f.beds = { ...(f.beds ?? {}), min: req.bedsMin };
    if (req.bathsMin > 0) f.baths = { ...(f.baths ?? {}), min: req.bathsMin };
    if (req.sqftMin > 0) f.sqft = { ...(f.sqft ?? {}), min: req.sqftMin };
    if (req.garageMin > 0) f.garSp = { ...(f.garSp ?? {}), min: req.garageMin };
    if (req.maxListingAgeDays < Number.MAX_SAFE_INTEGER) {
      f.doz = { ...(f.doz ?? {}), value: String(req.maxListingAgeDays) };
    }
    if (req.hoaMaxMonthly > 0) f.hoa = { ...(f.hoa ?? {}), max: req.hoaMaxMonthly };
    if (req.yearBuiltMin > 0) f.built = { ...(f.built ?? {}), min: req.yearBuiltMin };
    if (req.homeTypePreference === 'resale_only') {
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

function syncRedfinSearchUrl(rawUrl, req) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    const [pathnameRoot, rawFilterSegment] = parsed.pathname.split('/filter/');
    const existing = rawFilterSegment ? rawFilterSegment.split(',').filter(Boolean) : [];
    const managed = [
      'min-price=', 'max-price=', 'min-beds=', 'min-baths=', 'min-sqft=', 'hoa=',
      'min-parking=', 'min-year-built=', 'max-days-on-market=', 'property-type=', 'include=',
    ];
    const tokens = existing.filter((t) => !managed.some((p) => t.startsWith(p)));

    const minPrice = formatCompactThousands(req.priceMin);
    const maxPrice = formatCompactThousands(req.priceMax);
    const minSqft = formatCompactThousands(req.sqftMin);

    if (minPrice) tokens.push(`min-price=${minPrice}k`);
    if (maxPrice && req.priceMax < Number.MAX_SAFE_INTEGER) tokens.push(`max-price=${maxPrice}k`);
    if (req.bedsMin > 0) tokens.push(`min-beds=${Math.ceil(req.bedsMin)}`);
    if (req.bathsMin > 0) tokens.push(`min-baths=${req.bathsMin}`);
    if (minSqft) tokens.push(`min-sqft=${minSqft}k-sqft`);
    if (req.hoaMaxMonthly > 0) tokens.push(`hoa=${req.hoaMaxMonthly}`);
    if (req.garageMin > 0) tokens.push(`min-parking=${req.garageMin}`);
    if (req.yearBuiltMin > 0) tokens.push(`min-year-built=${req.yearBuiltMin}`);
    if (req.maxListingAgeDays < Number.MAX_SAFE_INTEGER) {
      const dom = redfinDaysOnMarketToken(req.maxListingAgeDays);
      if (dom) tokens.push(`max-days-on-market=${dom}`);
    }
    if (req.homeTypePreference === 'resale_only') tokens.push('property-type=house');
    tokens.push('include=forsale+fsbo');

    parsed.pathname = tokens.length > 0
      ? `${pathnameRoot.replace(/\/+$/, '')}/filter/${tokens.join(',')}`
      : pathnameRoot;
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function syncRealtorSearchUrl(rawUrl, req) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return rawUrl;

    const [searchRoot, areaSegment, ...rest] = segments;
    const managed = ['beds-', 'baths-', 'price-', 'sqft-', 'garage-', 'age-', 'hoa-', 'built-after-', 'type-'];
    const synced = rest.filter((s) => !managed.some((p) => s.startsWith(p)));

    if (req.bedsMin > 0) synced.push(`beds-${Math.ceil(req.bedsMin)}`);
    if (req.bathsMin > 0) synced.push(`baths-${req.bathsMin}`);
    if (req.priceMin > 0) synced.push(`price-${req.priceMin}-na`);
    if (req.priceMax < Number.MAX_SAFE_INTEGER) synced.push(`price-na-${req.priceMax}`);
    if (req.sqftMin > 0) synced.push(`sqft-${req.sqftMin}-na`);
    if (req.garageMin > 0) synced.push(`garage-${req.garageMin}`);
    if (req.maxListingAgeDays < Number.MAX_SAFE_INTEGER) synced.push(`age-${req.maxListingAgeDays}`);
    if (req.hoaMaxMonthly > 0) synced.push(`hoa-${req.hoaMaxMonthly}`);
    if (req.yearBuiltMin > 0) synced.push(`built-after-${req.yearBuiltMin}`);
    if (req.homeTypePreference === 'resale_only') synced.push('type-single-family-home');

    parsed.pathname = `/${[searchRoot, areaSegment, ...synced].join('/')}`;
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function syncHomesSearchUrl(rawUrl, req) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    const params = parsed.searchParams;
    const HOMES_KEYS = [
      'price-min', 'price-max', 'bath-min', 'bath-max', 'sfmin',
      'yb-min', 'hoa-max', 'gsr-min', 'gsr-max', 'parking', 'dom-max', 'ssit', 'ssort',
    ];
    for (const key of HOMES_KEYS) params.delete(key);

    if (req.priceMin > 0) params.set('price-min', String(req.priceMin));
    if (req.priceMax < Number.MAX_SAFE_INTEGER) params.set('price-max', String(req.priceMax));
    if (req.bathsMin > 0) params.set('bath-min', String(Math.ceil(req.bathsMin)));
    if (req.sqftMin > 0) params.set('sfmin', String(req.sqftMin));
    if (req.yearBuiltMin > 0) params.set('yb-min', String(req.yearBuiltMin));
    if (req.hoaMaxMonthly > 0) params.set('hoa-max', String(req.hoaMaxMonthly));
    if (req.schoolsMinRating > 0) {
      params.set('gsr-min', String(req.schoolsMinRating));
      params.set('gsr-max', '10');
    }
    if (req.garageMin > 0) params.set('parking', String(req.garageMin));
    if (req.maxListingAgeDays < Number.MAX_SAFE_INTEGER) {
      params.set('dom-max', `${req.maxListingAgeDays}d`);
      params.set('ssort', 'newest');
    }

    const segs = parsed.pathname.split('/').filter(Boolean);
    const base = [];
    for (const seg of segs) {
      if (seg === 'houses-for-sale') continue;
      if (seg === 'resale' || seg === 'new-construction') continue;
      if (/^\d+(?:-to-\d+)?-bedroom$/.test(seg)) continue;
      base.push(seg);
    }
    if (req.homeTypePreference === 'resale_only') base.push('resale');
    if (req.bedsMin > 0) {
      const min = Math.ceil(req.bedsMin);
      base.push(`${min}-to-${Math.max(min + 1, 5)}-bedroom`);
    }
    parsed.pathname = `/${base.join('/')}/`;
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function syncPlatformSearchUrl(platform, rawUrl, req) {
  if (platform === 'zillow') return syncZillowSearchUrl(rawUrl, req);
  if (platform === 'redfin') return syncRedfinSearchUrl(rawUrl, req);
  if (platform === 'realtor') return syncRealtorSearchUrl(rawUrl, req);
  if (platform === 'homes') return syncHomesSearchUrl(rawUrl, req);
  return rawUrl;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

async function checkCdpReachable(cdpUrl) {
  try {
    const response = await fetch(`${cdpUrl}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureOrLaunchSession(profileName) {
  const session = await readSessionState(ROOT, profileName);

  if (session?.data?.mode === 'hosted' && session.data.cdpUrl) {
    const reachable = await checkCdpReachable(session.data.cdpUrl);
    if (reachable) {
      console.log(`Using existing hosted session at ${session.data.cdpUrl}`);
      return session.data;
    }
    console.log('Existing session not reachable -- launching a new one...');
  } else {
    console.log('No hosted session found -- launching one automatically...');
  }

  const launched = await launchHostedBrowserSession({
    projectRoot: ROOT,
    profileName,
    channel: 'chrome',
    targets: [],
    cdpPort: DEFAULT_CDP_PORT,
  });

  const state = {
    schemaVersion: 1,
    mode: 'hosted',
    caller: 'skim',
    profile: profileName,
    channel: launched.channel,
    platforms: [],
    targets: [],
    userDataDir: launched.userDataDir,
    executablePath: launched.executablePath,
    cdpUrl: launched.cdpUrl,
    wsEndpoint: launched.wsEndpoint,
    pid: launched.pid,
    openedAt: new Date().toISOString(),
    closedAt: null,
    status: 'open',
  };
  await writeSessionState(ROOT, profileName, state);

  if (launched.fallbackFrom) {
    console.log(`Note: Chrome not found -- launched ${launched.channel} instead.`);
  }
  console.log(`Launched hosted session at ${launched.cdpUrl} (${launched.channel})`);
  return state;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function printStatus(profileName) {
  const session = await readSessionState(ROOT, profileName);
  if (!session?.data) {
    console.log(`No saved session for profile: ${profileName}`);
    return;
  }
  const { data } = session;
  console.log(`Profile:   ${profileName}`);
  console.log(`Mode:      ${data.mode ?? 'persistent'}`);
  console.log(`Status:    ${data.status}`);
  console.log(`Channel:   ${data.channel}`);
  console.log(`Opened at: ${data.openedAt}`);
  if (data.mode === 'hosted' && data.cdpUrl) {
    const reachable = await checkCdpReachable(data.cdpUrl);
    console.log(`CDP:       ${data.cdpUrl} (${reachable ? 'reachable' : 'not reachable'})`);
  }
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

  if (config.statusOnly) {
    await printStatus(config.profileName);
    return;
  }

  // Load portals and profile
  const portals = readYamlFile(PORTALS_PATH);
  const profile = readYamlFile(PROFILE_PATH);
  const requirements = loadRequirements(profile);

  // Build target list: one entry per platform × area, filters synced
  const platformsNode = portals.platforms ?? {};
  const targets = [];

  for (const [rawKey, rawValue] of Object.entries(platformsNode)) {
    if (!rawValue || typeof rawValue !== 'object') continue;
    const key = canonicalPlatformKey(rawKey);
    if (config.selectedPlatforms.size > 0 && !config.selectedPlatforms.has(key)) continue;
    if (config.excludedPlatforms.has(key)) continue;

    const searchUrls = Array.isArray(rawValue.search_urls) ? rawValue.search_urls : [];
    for (const entry of searchUrls) {
      const rawUrl = String(entry?.url ?? '').trim();
      if (!rawUrl) continue;
      const syncedUrl = syncPlatformSearchUrl(key, rawUrl, requirements);
      targets.push({
        platform: key,
        name: String(rawValue.name ?? rawKey).trim(),
        area: String(entry?.area ?? '').trim(),
        url: syncedUrl,
      });
    }
  }

  if (targets.length === 0) {
    console.log('No portal search URLs matched the selected platforms. Check portals.yml.');
    process.exit(1);
  }

  // Ensure a hosted session is running
  const sessionData = await ensureOrLaunchSession(config.profileName);

  // Connect to the hosted session via CDP
  let browser;
  try {
    browser = await chromium.connectOverCDP(sessionData.cdpUrl, {
      timeout: 15000,
      isLocal: true,
    });
  } catch (error) {
    console.error(`Could not connect to hosted browser at ${sessionData.cdpUrl}: ${error.message}`);
    console.error('Try running /home-ops init to reset the session.');
    process.exit(1);
  }

  const context = browser.contexts()[0];
  if (!context) {
    console.error('Connected to browser but found no default context. Try /home-ops init.');
    process.exit(1);
  }

  // Open one tab per target
  console.log(`\nOpening ${targets.length} search tab(s)...\n`);
  const opened = [];
  const failed = [];

  for (const target of targets) {
    try {
      const page = await context.newPage();
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_TIMEOUT_MS);
      console.log(`  ${target.name} | ${target.area}`);
      opened.push(target);
    } catch (error) {
      console.log(`  ${target.name} | ${target.area}  [navigation error: ${error.message.split('\n')[0]}]`);
      failed.push(target);
    }
  }

  // Disconnect without closing the hosted browser window
  await browser.close().catch(() => {});

  const platformCount = new Set(opened.map((t) => t.platform)).size;
  console.log(`\nSkimmed ${opened.length} tab(s) across ${platformCount} portal(s).`);
  if (failed.length > 0) {
    console.log(`${failed.length} tab(s) failed to load -- the tabs are open but may need a manual refresh.`);
  }
  console.log('\nThe hosted browser is still open. Browse the tabs and run /home-ops scan when ready to extract listings.');
}

main().catch((error) => {
  console.error('Fatal:', error.message);
  process.exit(1);
});
