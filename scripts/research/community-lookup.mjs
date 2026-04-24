#!/usr/bin/env node

/**
 * community-lookup.mjs -- Resolve addresses to their named community via
 * mapdevelopers.com and cache the result so the downstream sentiment pass
 * can build deterministic Nextdoor / Facebook URLs.
 *
 * The script drives a hosted Chrome session because mapdevelopers.com does
 * not accept a GET-with-address URL -- you have to type into the search box
 * and click through. Each resolved community lands in output/communities/
 * and the `community` cache, so subsequent runs on the same address are free.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { chromium } from 'playwright';
import { readSessionState } from '../browser/browser-session.mjs';
import {
  ROOT,
  loadResearchConfig,
  parseReport,
  parseShortlist,
} from './research-utils.mjs';
import {
  getCacheEntry,
  isCacheFresh,
  loadCache,
  pruneCache,
  putCacheEntry,
  saveCache,
} from '../system/cache-utils.mjs';
import { slugify } from '../shared/text-utils.mjs';

const COMMUNITY_CACHE_NAME = 'community';
const COMMUNITY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PROFILE = 'chrome-host';
const OUTPUT_DIR = join(ROOT, 'output', 'communities');
const LOOKUP_URL = 'https://www.mapdevelopers.com/what-neighborhood-am-i-in.php';
const PAGE_TIMEOUT_MS = 30000;
const RESULT_TIMEOUT_MS = 15000;
const INVALID_COMMUNITY_PATTERNS = [
  /map my location along with the neighborhood you are in at the moment/i,
  /find my neighborhood/i,
  /what neighborhood am i in/i,
  /share my location/i,
  /your approximiate location/i,
  /this is the location information for the address you searched/i,
  /you can share this map with the link below/i,
  /^not found$/i,
];
const FIELD_LABEL_TOKENS = new Set(['address', 'city', 'state', 'zipcode', 'zip', 'code', 'county']);

const HELP_TEXT = `Usage:
  node community-lookup.mjs --shortlist [--profile chrome-host]
  node community-lookup.mjs --top3 [--profile chrome-host]
  node community-lookup.mjs --address "141 Eden Glen Dr" --city "Holly Springs" [--state NC]
  node community-lookup.mjs reports/003-foo.md [reports/011-bar.md ...]

Resolves each address to its mapdevelopers-reported community name and
writes output/communities/<slug>.json with the built Nextdoor + Facebook
URLs. Results are cached for 30 days.

Options:
  --shortlist        Use the current populated Top 10 cohort from data/shortlist.md.
  --top3             Use the current refined top 3 from data/shortlist.md.
  --address <value>  Manual target address.
  --city <value>     Manual target city.
  --state <value>    Manual target state. Defaults to NC.
  --profile <name>   Hosted browser profile. Defaults to chrome-host.
  --no-cache         Skip the community cache for this run.
  --refresh-cache    Re-scrape every target and overwrite the cached entry.
  --json             Print JSON instead of the human-readable summary.
  --help             Show this help text.`;

function parseArgs(argv) {
  const config = {
    shortlist: false,
    top3: false,
    address: '',
    city: '',
    state: 'NC',
    profileName: DEFAULT_PROFILE,
    json: false,
    help: false,
    noCache: false,
    refreshCache: false,
    files: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--no-cache') { config.noCache = true; continue; }
    if (arg === '--refresh-cache') { config.refreshCache = true; continue; }
    if (arg === '--address') { config.address = argv[++i] ?? ''; continue; }
    if (arg === '--city') { config.city = argv[++i] ?? ''; continue; }
    if (arg === '--state') { config.state = argv[++i] ?? 'NC'; continue; }
    if (arg === '--profile') { config.profileName = argv[++i] ?? DEFAULT_PROFILE; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    config.files.push(arg);
  }

  return config;
}

function normalizeText(value) {
  return String(value ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function isFieldLabelCluster(value) {
  const tokens = normalizeText(value).toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.length >= 3 && tokens.every((token) => FIELD_LABEL_TOKENS.has(token));
}

function sanitizeCommunityName(value) {
  let community = normalizeText(value)
    .replace(/^Neighborhood\s*[:\-]\s*/i, '')
    .replace(/\b(?:subdivision|community|hoa|neighborhood)\b\s*$/i, '')
    .replace(/[.,;:]+$/, '')
    .trim();

  if (!community) {
    return null;
  }

  if (community.length > 80 || isFieldLabelCluster(community)) {
    return null;
  }

  if (FIELD_LABEL_TOKENS.has(community.toLowerCase())) {
    return null;
  }

  if (/https?:\/\//i.test(community)) {
    return null;
  }

  if (/^\d+\s+.*\b(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln|court|ct|place|pl|terrace|ter|boulevard|blvd|way|parkway|pkwy)\b/i.test(community)) {
    return null;
  }

  if (/\b\d{5}\b/.test(community) || (community.includes(',') && /\b(?:north carolina|south carolina|nc|sc)\b/i.test(community))) {
    return null;
  }

  if (INVALID_COMMUNITY_PATTERNS.some((pattern) => pattern.test(community))) {
    return null;
  }

  return community;
}

function pickCommunityCandidate(candidates) {
  for (const candidate of candidates ?? []) {
    const community = sanitizeCommunityName(candidate);
    if (community) {
      return community;
    }
  }

  return null;
}

function buildManualTarget(config) {
  if (!config.address || !config.city) {
    throw new Error('Manual lookup requires both --address and --city.');
  }
  return {
    filePath: null,
    relativePath: null,
    address: normalizeText(config.address),
    city: normalizeText(config.city),
    state: normalizeText(config.state || 'NC'),
  };
}

function resolveTargets(config) {
  if (config.shortlist || config.top3) {
    const shortlist = parseShortlist(ROOT);
    const rows = config.top3 ? shortlist.refinedTop3 : shortlist.top10;
    if (rows.length === 0) {
      throw new Error(config.top3
        ? 'No refined top-3 homes found in data/shortlist.md.'
        : 'No populated top-10 homes found in data/shortlist.md.');
    }
    return rows.map((row) => {
      const report = parseReport(ROOT, row.reportPath);
      return {
        filePath: report.filePath,
        relativePath: report.relativePath,
        address: report.address,
        city: report.city,
        state: report.state || 'NC',
      };
    });
  }

  if (config.address || config.city) {
    return [buildManualTarget(config)];
  }

  if (config.files.length === 0) {
    throw new Error('Provide at least one report path, or use --shortlist, --top3, or manual address/city arguments.');
  }

  return config.files.map((filePath) => {
    const report = parseReport(ROOT, filePath);
    return {
      filePath: report.filePath,
      relativePath: report.relativePath,
      address: report.address,
      city: report.city,
      state: report.state || 'NC',
    };
  });
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
    if (!response.ok) throw new Error(`CDP endpoint returned HTTP ${response.status}`);
  } catch (error) {
    throw new Error(`Hosted browser session ${profileName} is not reachable: ${error.message}`);
  }
  return session.data;
}

function buildCommunityUrls(community, city, state) {
  const sanitizedCommunity = sanitizeCommunityName(community);
  if (!sanitizedCommunity) {
    return { nextdoor: null, facebook: null };
  }
  const communitySlug = slugify(sanitizedCommunity);
  const nextdoorCommunitySlug = communitySlug.replace(/-/g, '');
  const citySlug = slugify(city);
  const stateSlug = slugify(state).toLowerCase();
  const nextdoor = nextdoorCommunitySlug && citySlug && stateSlug
    ? `https://nextdoor.com/neighborhood/${nextdoorCommunitySlug}--${citySlug}--${stateSlug}/`
    : null;
  const facebookQuery = encodeURIComponent(`${sanitizedCommunity} neighborhood ${city}`.trim());
  const facebook = `https://www.facebook.com/search/top?q=${facebookQuery}`;
  return { nextdoor, facebook };
}

function buildCacheKey(target) {
  const key = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`);
  return key || null;
}

function buildOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'community-target';
  return join(OUTPUT_DIR, `${slug}.json`);
}

async function scrapeCommunity(context, target) {
  const fullAddress = `${target.address}, ${target.city}, ${target.state || 'NC'}`;
  const page = await context.newPage();
  try {
    await page.goto(LOOKUP_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await page.waitForTimeout(1500);

    const input = await page.waitForSelector(
      'input[id*="address" i]:visible, input[name*="address" i]:visible, input[placeholder*="address" i]:visible, #address:visible',
      { timeout: RESULT_TIMEOUT_MS },
    ).catch(() => null);
    if (!input) {
      return { community: null, status: 'input-not-found', raw: '' };
    }

    await input.click({ clickCount: 3 }).catch(() => {});
    await input.fill(fullAddress);
    await page.waitForTimeout(600);

    // Submit the typed address through the page's dedicated address lookup
    // control. Use a real Playwright click so the site receives the same
    // interaction path as the manual flow.
    const addressButton = page.locator('button:visible, input[type="submit"]:visible, input[type="button"]:visible, a.btn:visible')
      .filter({ hasText: /^Find Address$/i })
      .first();
    let clicked = false;
    if (await addressButton.count()) {
      await addressButton.click();
      clicked = true;
    }

    if (!clicked) {
      const fallbackButton = page.locator('button:visible, input[type="submit"]:visible, input[type="button"]:visible, a.btn:visible')
        .filter({ hasText: /^(Search|Go|Lookup)$/i })
        .first();
      if (await fallbackButton.count()) {
        await fallbackButton.click();
        clicked = true;
      }
    }
    if (!clicked) {
      // Fall back to submitting the enclosing form by pressing Enter.
      await input.press('Enter').catch(() => {});
    }

    // mapdevelopers renders the neighborhood name into a result box after the
    // geocode returns. Wait for any element whose text starts with
    // "Neighborhood" to appear; if none appears within the timeout we treat it
    // as an unmatched address.
    await page.waitForFunction(() => {
      const normalize = (value) => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const invalidPatterns = [
        /map my location along with the neighborhood you are in at the moment/i,
        /find my neighborhood/i,
        /what neighborhood am i in/i,
        /share my location/i,
        /your approximiate location/i,
        /this is the location information for the address you searched/i,
        /you can share this map with the link below/i,
      ];
      const fieldLabelTokens = new Set(['address', 'city', 'state', 'zipcode', 'zip', 'code', 'county']);
      const isFieldLabelCluster = (value) => {
        const tokens = normalize(value).toLowerCase().split(/\s+/).filter(Boolean);
        return tokens.length >= 3 && tokens.every((token) => fieldLabelTokens.has(token));
      };
      const sanitizeCommunityName = (value) => {
        let community = normalize(value)
          .replace(/^Neighborhood\s*[:\-]\s*/i, '')
          .replace(/\b(?:subdivision|community|hoa|neighborhood)\b\s*$/i, '')
          .replace(/[.,;:]+$/, '')
          .trim();
        if (!community) return null;
        if (community.length > 80 || isFieldLabelCluster(community)) return null;
        if (fieldLabelTokens.has(community.toLowerCase())) return null;
        if (/https?:\/\//i.test(community)) return null;
        if (/^\d+\s+.*\b(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln|court|ct|place|pl|terrace|ter|boulevard|blvd|way|parkway|pkwy)\b/i.test(community)) return null;
        if (/\b\d{5}\b/.test(community) || (community.includes(',') && /\b(?:north carolina|south carolina|nc|sc)\b/i.test(community))) return null;
        if (invalidPatterns.some((pattern) => pattern.test(community))) return null;
        return community;
      };

      const candidates = [];
      const pushCandidate = (value) => {
        const candidate = normalize(value);
        if (candidate && !candidates.includes(candidate)) {
          candidates.push(candidate);
        }
      };

      for (const element of Array.from(document.querySelectorAll('body *'))) {
        const label = normalize(element.innerText || element.textContent || '');
        if (label.toLowerCase() !== 'neighborhood') {
          continue;
        }

        pushCandidate(element.nextElementSibling?.innerText || element.nextElementSibling?.textContent || element.nextElementSibling?.value || '');

        const parent = element.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const index = siblings.indexOf(element);
          if (index !== -1) {
            pushCandidate(siblings[index + 1]?.innerText || siblings[index + 1]?.textContent || siblings[index + 1]?.value || '');
          }
        }
      }

      const text = normalize(document.body?.innerText ?? '');
      return candidates.some((candidate) => Boolean(sanitizeCommunityName(candidate)))
        || /This address is (?:not|in)/i.test(text)
        || /no neighborhood/i.test(text);
    }, { timeout: RESULT_TIMEOUT_MS }).catch(() => {});

    const scraped = await page.evaluate(() => {
      const normalize = (value) => String(value ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
      const text = normalize(document.body?.innerText ?? '');
      const candidates = [];
      const pushCandidate = (value) => {
        const candidate = normalize(value);
        if (candidate && !candidates.includes(candidate)) {
          candidates.push(candidate);
        }
      };

      for (const element of Array.from(document.querySelectorAll('body *'))) {
        const label = normalize(element.innerText || element.textContent || '');
        if (label.toLowerCase() !== 'neighborhood') {
          continue;
        }

        pushCandidate(element.nextElementSibling?.innerText || element.nextElementSibling?.textContent || element.nextElementSibling?.value || '');

        const parent = element.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const index = siblings.indexOf(element);
          if (index !== -1) {
            pushCandidate(siblings[index + 1]?.innerText || siblings[index + 1]?.textContent || siblings[index + 1]?.value || '');
          }
        }
      }

      for (const element of Array.from(document.querySelectorAll('[id*="neighborhood" i], [name*="neighborhood" i], input, textarea'))) {
        pushCandidate(element.value || element.getAttribute('value') || element.innerText || '');
      }

      const neighborhoodMatch = text.match(/Neighborhood\s*[:\-]\s*([^\n\r]+)/i);
      if (neighborhoodMatch) {
        pushCandidate(neighborhoodMatch[1]);
      }

      const lines = (document.body?.innerText ?? '').split(/\r?\n+/).map(normalize).filter(Boolean);
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].toLowerCase() === 'neighborhood') {
          pushCandidate(lines[index + 1] ?? '');
        }
      }

      return {
        bodyExcerpt: text.slice(0, 2000),
        candidates,
      };
    });

    const community = pickCommunityCandidate(scraped.candidates);

    if (!community || /^(?:n\/a|none|no neighborhood)$/i.test(community)) {
      return { community: null, status: 'no-community-match', raw: scraped.bodyExcerpt };
    }

    return { community, status: 'ok', raw: scraped.bodyExcerpt };
  } finally {
    await page.close().catch(() => {});
  }
}

async function lookupTarget(context, target, cacheState) {
  const cacheKey = buildCacheKey(target);

  if (cacheState?.cache && !cacheState.disabled && !cacheState.refresh && cacheKey) {
    const existing = getCacheEntry(cacheState.cache, cacheKey);
    const cachedCommunity = sanitizeCommunityName(existing?.community);
    const cachedStatus = cachedCommunity
      ? (existing?.status || 'ok')
      : existing?.status === 'no-community-match'
        ? 'no-community-match'
        : null;
    if (existing && isCacheFresh(existing, COMMUNITY_CACHE_TTL_MS) && cachedStatus) {
      cacheState.hits += 1;
      const urls = buildCommunityUrls(cachedCommunity, target.city, target.state);
      const cachedOutput = {
        generatedAt: new Date().toISOString(),
        address: target.address,
        city: target.city,
        state: target.state,
        reportPath: target.relativePath,
        community: cachedCommunity,
        communityUrls: urls,
        status: cachedStatus,
        source: 'cache',
      };
      const outputPath = buildOutputPath(target);
      await mkdir(OUTPUT_DIR, { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(cachedOutput, null, 2)}\n`, 'utf8');
      return { ...cachedOutput, outputPath };
    }
  }

  const scraped = await scrapeCommunity(context, target);
  const urls = buildCommunityUrls(scraped.community, target.city, target.state);
  const output = {
    generatedAt: new Date().toISOString(),
    address: target.address,
    city: target.city,
    state: target.state,
    reportPath: target.relativePath,
    community: scraped.community,
    communityUrls: urls,
    status: scraped.status,
    source: 'mapdevelopers.com',
    rawExcerpt: scraped.raw.slice(0, 600),
  };
  const outputPath = buildOutputPath(target);
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  if (cacheState?.cache && !cacheState.disabled && cacheKey) {
    putCacheEntry(cacheState.cache, cacheKey, {
      community: scraped.community,
      status: scraped.status,
    });
    cacheState.dirty = true;
    cacheState.misses += 1;
  }

  return { ...output, outputPath };
}

function printSummary(results) {
  console.log('\nCommunity lookup\n');
  for (const result of results) {
    const line = result.community
      ? `${result.address}, ${result.city}, ${result.state} -> ${result.community}`
      : `${result.address}, ${result.city}, ${result.state} -> no community match (${result.status})`;
    console.log(line);
    if (result.communityUrls?.nextdoor) console.log(`  Nextdoor: ${result.communityUrls.nextdoor}`);
    if (result.communityUrls?.facebook) console.log(`  Facebook: ${result.communityUrls.facebook}`);
  }
  console.log('');
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

  const targets = resolveTargets(config);
  loadResearchConfig(ROOT);
  const session = await ensureHostedSession(config.profileName);
  const browser = await chromium.connectOverCDP(session.cdpUrl, { timeout: 30000, isLocal: true });

  const cache = config.noCache ? { entries: {} } : await loadCache(COMMUNITY_CACHE_NAME);
  if (!config.noCache) pruneCache(cache, COMMUNITY_CACHE_TTL_MS * 2);
  const cacheState = {
    cache,
    disabled: Boolean(config.noCache),
    refresh: Boolean(config.refreshCache),
    hits: 0,
    misses: 0,
    dirty: false,
  };

  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('Hosted browser session is running, but no default context was exposed.');

    const results = [];
    for (const target of targets) {
      results.push(await lookupTarget(context, target, cacheState));
    }

    if (!config.noCache && cacheState.dirty) {
      await saveCache(COMMUNITY_CACHE_NAME, cache);
    }

    if (config.json) {
      console.log(JSON.stringify({
        profile: config.profileName,
        count: results.length,
        cache: { hits: cacheState.hits, misses: cacheState.misses },
        results,
      }, null, 2));
      return;
    }

    printSummary(results);
    if (!config.noCache) {
      console.log(`Community cache: ${cacheState.hits} hit(s), ${cacheState.misses} miss(es)`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exit(1);
});
