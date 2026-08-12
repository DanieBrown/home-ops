#!/usr/bin/env node

/**
 * sentiment-public-extract.mjs -- Public-source neighborhood sentiment pass.
 *
 * Complements sentiment-browser-extract.mjs (which handles login-walled
 * Facebook + Nextdoor via the hosted session) by pulling snippets from
 * the opted-in public sources listed in portals.yml under sentiment_sources
 * -- currently google_maps. Public pages are fetched through
 * crawl4ai first so rendered snippets are available, with fetch() retained
 * as a fallback when crawl4ai is unavailable or blocked.
 *
 * Writes to the same output/sentiment/{slug}.json file as the browser
 * extractor. If a file already exists for the target, the public results
 * are merged into its `sources` array and the kpiRollup is recomputed so
 * downstream consumers (deep-research-packet, briefing-pdf) pick them up
 * without extra glue.
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { readSessionState } from '../browser/browser-session.mjs';
import { ROOT } from '../shared/paths.mjs';
import {
  buildSentimentSourcePlan,
  loadResearchConfig,
  parseReport,
  parseShortlist,
} from './research-utils.mjs';
import {
  buildProfileRedFlagPatterns,
  buildProximityHints,
  classifyProximity,
  resolveProximityTierMultipliers,
  scoreProfileRedFlags,
} from './sentiment-scoring.mjs';
import { crawl4aiFetchPage } from './crawl4ai-utils.mjs';
import { slugify } from '../shared/text-utils.mjs';
import { expiresInDays, recordArtifact, subjectKeyForTarget, withSidecarMetadata } from '../shared/knowledge-store.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'sentiment');
const PUBLIC_KEYS = new Set(['google_maps']);
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_QUERIES_PER_SOURCE = 4;
const DEFAULT_PROFILE = 'chrome-host';
const MAPS_PAGE_TIMEOUT_MS = 30000;
const MAPS_REVIEW_SCROLL_PASSES = 6;
const MAX_REVIEWS_PER_PLACE = 20;

const POSITIVE_PATTERNS = [
  /\bquiet\b/i, /\bfriendly\b/i, /\bgreat\b/i, /\blove\b/i, /\bsafe\b/i,
  /\bcalm\b/i, /\bfamily/i, /\bwalkable\b/i, /\bconvenient\b/i, /\bhelpful\b/i,
  /\brecommend\b/i, /\bresponsive\b/i, /\bwell[-\s]?maintained\b/i,
];

const NEGATIVE_PATTERNS = [
  /\btraffic\b/i, /\bnois(?:e|y)\b/i, /\bcrime\b/i, /\bunsafe\b/i, /\bspeeding\b/i,
  /\baccident\b/i, /\bconstruction\b/i, /\bcongestion\b/i, /\bcrowded\b/i,
  /\bbreak[-\s]?in\b/i, /\btheft\b/i, /\bstolen\b/i, /\bflood(?:ing|ed)?\b/i,
];

// A review's own relative-date text ("3 days ago", "a week ago") is the
// only reliable recency signal once we're reading real Google Maps reviews
// instead of static place-card copy. Matches sentiment-browser-extract.mjs's
// window (last ~7 days) so "recent" means the same thing across every
// sentiment source: a multi-month-old review of a grocery store is weak
// evidence about today's traffic.
const RECENT_PATTERNS = [
  /\bjust now\b/i, /\btoday\b/i, /\byesterday\b/i,
  /\b[1-7]\s*d(?:ay|ays)?\s+ago\b/i,
  /\ba\s+day\s+ago\b/i,
  /\b(?:[1-9]|1\d|2[0-3])\s*h(?:r|rs|our|ours)?\s+ago\b/i,
];

export function isRecent(text) {
  return RECENT_PATTERNS.some((pattern) => pattern.test(text));
}

const THEME_PATTERNS = {
  crime_safety: [/\bcrime\b/i, /\bunsafe\b/i, /\bpolice\b/i, /\btheft\b/i, /\bbreak[-\s]?in\b/i, /\bsuspicious\b/i, /\bsafety\b/i],
  traffic_commute: [/\btraffic\b/i, /\bcommute\b/i, /\bbackup\b/i, /\bcongestion\b/i, /\bspeeding\b/i, /\baccident\b/i, /\broad work\b/i, /\bwidening\b/i],
  community: [/\bcommunity\b/i, /\bneighbor/i, /\bhoa\b/i, /\bfamily/i, /\bfriendly\b/i, /\bevent/i, /\bplayground\b/i],
  livability: [/\bpark\b/i, /\btrail\b/i, /\bgrocery\b/i, /\brestaurant\b/i, /\bquiet\b/i, /\bwalkable\b/i, /\bgreenway\b/i, /\bsidewalk\b/i],
};

const HELP_TEXT = `Usage:
  node sentiment-public-extract.mjs reports/003-foo.md
  node sentiment-public-extract.mjs --shortlist
  node sentiment-public-extract.mjs --top3
  node sentiment-public-extract.mjs reports/003-foo.md --profile chrome-host

Fetches opted-in public sentiment sources (google_maps) from
portals.yml for each target and merges snippets into output/sentiment/.

Options:
  --shortlist       Use the current populated Top 10 cohort from data/shortlist.md.
  --top3            Use the current refined top 3 from data/shortlist.md.
  --profile <name>  Hosted browser profile. Routes Google Maps through the
                     reviews pane instead of a static fetch (place cards
                     only). Falls back to crawl4ai/fetch when omitted or the
                     session is unreachable.
  --json            Print JSON instead of human-readable text.
  --help            Show this help text.`;

function parseArgs(argv) {
  const config = { shortlist: false, top3: false, profileName: '', json: false, help: false, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--profile') { config.profileName = argv[index + 1] ?? DEFAULT_PROFILE; index += 1; continue; }
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
      throw new Error(config.top3 ? 'No refined top-3 homes found in data/shortlist.md.' : 'No populated top-10 homes found in data/shortlist.md.');
    }
    return rows.map((row) => parseReport(ROOT, row.reportPath));
  }
  if (config.files.length === 0) {
    throw new Error('Provide at least one report path, or use --shortlist or --top3.');
  }
  return config.files.map((filePath) => parseReport(ROOT, filePath));
}

function buildOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'sentiment-target';
  return join(OUTPUT_DIR, `${slug}.json`);
}

async function fetchText(url) {
  const crawled = await crawl4aiFetchPage(url, { timeoutMs: DEFAULT_TIMEOUT_MS });
  if (crawled.ok && crawled.html) {
    return {
      ok: true,
      status: crawled.status || 200,
      text: crawled.html,
      url: crawled.finalUrl || url,
      requestedUrl: url,
      provider: 'crawl4ai',
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'home-ops/sentiment-public-extract (+https://github.com/)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timer);
    if (!response.ok) return { ok: false, status: response.status, text: '', url, provider: 'fetch', crawl4aiError: crawled.error ?? null };
    const text = await response.text();
    return { ok: true, status: response.status, text, url, provider: 'fetch', crawl4aiError: crawled.error ?? null };
  } catch (error) {
    return { ok: false, status: 0, text: '', url, provider: 'fetch', error: String(error?.message ?? error), crawl4aiError: crawled.error ?? null };
  }
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

/**
 * Google Maps place cards (name/address/hours) are what a plain fetch or
 * crawl4ai pass returns -- the reviews live behind client-side navigation
 * that only a real browser can drive. This opens the top result for a
 * search, clicks into its Reviews tab, sorts newest-first when the sort
 * control is found, scrolls to load more, and harvests review text.
 *
 * NOTE: Google Maps' DOM is not a documented, stable API and this has not
 * been verified against a live session in the environment that wrote it
 * (see docs -- Phase 4 candidate sources are unverified leads). It uses
 * durable, semantic selectors (data-review-id, role="tab", aria-label
 * substrings) rather than hashed class names, and fails closed: if the
 * Reviews tab itself can't be found, it reports `ok: false` (blocked) so a
 * selector regression is visible in sourceCoverage instead of silently
 * reading back as "no reviews here."
 */
async function fetchGoogleMapsReviewsViaBrowser(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: MAPS_PAGE_TIMEOUT_MS });
    await page.waitForTimeout(2000);

    // A multi-result search page shows a results list; a single strong match
    // renders the place panel directly. If a results list is present, open
    // the first card.
    const firstResult = page.locator('a[href*="/maps/place/"]').first();
    if (await firstResult.count().catch(() => 0)) {
      await firstResult.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }

    const reviewsTab = page.locator('button[role="tab"]', { hasText: /reviews/i })
      .or(page.locator('button[aria-label*="Reviews" i]'))
      .first();
    const tabFound = await reviewsTab.count().catch(() => 0);
    if (!tabFound) {
      return { ok: false, error: 'Reviews tab not found (place may have no reviews section, or the Maps UI selector needs updating)' };
    }
    await reviewsTab.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const sortButton = page.locator('button[aria-label*="Sort reviews" i]').first();
    if (await sortButton.count().catch(() => 0)) {
      await sortButton.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);
      const newestOption = page.locator('div[role="menuitemradio"]', { hasText: /newest/i }).first();
      if (await newestOption.count().catch(() => 0)) {
        await newestOption.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(800);
      }
    }

    for (let pass = 0; pass < MAPS_REVIEW_SCROLL_PASSES; pass += 1) {
      await page.mouse.wheel(0, 1200).catch(() => {});
      await page.waitForTimeout(500);
    }

    const reviews = await page.evaluate((maxReviews) => {
      const normalize = (value) => String(value ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
      const nodes = Array.from(document.querySelectorAll('[data-review-id]'));
      const results = [];
      for (const node of nodes) {
        const text = normalize(node.innerText);
        if (text.length < 40) continue;
        results.push(text.slice(0, 2000));
        if (results.length >= maxReviews) break;
      }
      return results;
    }, MAX_REVIEWS_PER_PLACE);

    const placeName = await page.title().catch(() => '');
    return { ok: true, reviews, placeName, finalUrl: page.url() };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    await page.close().catch(() => {});
  }
}

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifySnippet(text, redFlagPatterns = []) {
  const categories = Object.entries(THEME_PATTERNS)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(text)))
    .map(([key]) => key);
  const positiveHits = POSITIVE_PATTERNS.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);
  const baseNegativeHits = NEGATIVE_PATTERNS.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);
  const redFlag = scoreProfileRedFlags(text, redFlagPatterns);
  return {
    categories,
    positiveHits,
    negativeHits: baseNegativeHits + redFlag.hits,
    redFlagsMatched: redFlag.matched,
  };
}

function extractSnippets(bodyText, query, maxSnippets = 5) {
  const needle = query.toLowerCase();
  const body = bodyText.toLowerCase();
  const snippets = [];
  let start = 0;
  while (snippets.length < maxSnippets) {
    const index = body.indexOf(needle, start);
    if (index === -1) break;
    const snipStart = Math.max(0, index - 140);
    const snipEnd = Math.min(bodyText.length, index + needle.length + 220);
    const text = bodyText.slice(snipStart, snipEnd).trim();
    if (text.length >= 60) snippets.push(text);
    start = index + needle.length;
  }
  return snippets;
}

function summarizeThemes(snippets, redFlagPatterns = [], proximityHints = null, tierMultipliers = undefined) {
  const themes = new Map();
  for (const snippet of snippets) {
    const proximity = proximityHints
      ? classifyProximity(snippet, proximityHints, tierMultipliers)
      : { level: 'subdivision', multiplier: 1.0, matchedHints: [] };
    if (proximity.level === 'none') continue;
    const { categories, positiveHits, negativeHits } = classifySnippet(snippet, redFlagPatterns);
    const m = proximity.multiplier;
    for (const category of categories) {
      const current = themes.get(category) ?? {
        category, hits: 0, recentHits: 0, positiveHits: 0, negativeHits: 0, examples: [],
      };
      current.hits += 1 * m;
      current.positiveHits += positiveHits * m;
      current.negativeHits += negativeHits * m;
      if (current.examples.length < 2) current.examples.push(snippet.slice(0, 180));
      themes.set(category, current);
    }
  }
  return [...themes.values()].sort((a, b) => b.hits - a.hits);
}

// Each URL in `searchUrls` is built positionally from `recommendedQueries` (see
// buildSentimentSearchUrls in research-utils.mjs), so index-matching is the
// reliable pairing. A URL that itself encodes ?q=/&query= (not true for the
// path-based Google Maps URLs today, but possible for a future source) takes
// precedence when present. Without this, path-based URLs never match the
// regex and every entry silently inherited queries[0].
export function pairSearchUrlsWithQueries(urls, queries) {
  return urls.map((url, index) => {
    const queryFromUrl = decodeURIComponent((url.match(/[?&]q(?:uery)?=([^&]+)/) ?? [])[1] ?? '').replace(/\+/g, ' ');
    return { url, query: queryFromUrl || queries[index] || queries[0] || '' };
  });
}

async function runSource(sourceEntry, scoringContext) {
  const {
    redFlagPatterns = [], proximityHints = null, tierMultipliers = undefined,
    browserContext = null, browserSessionError = null,
  } = scoringContext || {};
  const queryResults = [];
  const urls = Array.isArray(sourceEntry.searchUrls) ? sourceEntry.searchUrls : [];
  const queries = sourceEntry.recommendedQueries ?? [];
  const pairs = pairSearchUrlsWithQueries(urls.slice(0, MAX_QUERIES_PER_SOURCE), queries);

  for (const { url, query } of pairs) {
    if (!query) continue;

    // --profile was requested but the session never connected: report
    // blocked rather than silently falling back to the place-card-only
    // fetch/crawl4ai path below.
    if (sourceEntry.key === 'google_maps' && browserSessionError) {
      queryResults.push({
        status: 'blocked', query, searchUrl: url, finalUrl: '', provider: 'hosted-browser',
        reason: `--profile was requested for Google Maps reviews, but the session did not connect: ${browserSessionError}`,
      });
      continue;
    }

    // With a hosted session, Google Maps is driven through the reviews pane
    // instead of a static fetch/crawl4ai pass, which only ever returns place
    // cards (name/address/hours -- zero review text). No crawl4ai fallback
    // here: silently downgrading to the place-card fetch would reintroduce
    // exactly the bug this path exists to fix.
    if (sourceEntry.key === 'google_maps' && browserContext) {
      const browserResult = await fetchGoogleMapsReviewsViaBrowser(browserContext, url);
      if (!browserResult.ok) {
        queryResults.push({
          status: 'blocked', query, searchUrl: url, finalUrl: '', provider: 'hosted-browser',
          reason: browserResult.error,
        });
        continue;
      }
      if (browserResult.reviews.length === 0) {
        queryResults.push({
          status: 'empty', query, searchUrl: url, finalUrl: browserResult.finalUrl || url, provider: 'hosted-browser',
          placeName: browserResult.placeName ?? null,
        });
        continue;
      }
      const snippetObjects = browserResult.reviews.map((text) => {
        const proximity = proximityHints
          ? classifyProximity(text, proximityHints, tierMultipliers)
          : { level: 'subdivision', multiplier: 1.0, matchedHints: [] };
        return { text, ...classifySnippet(text, redFlagPatterns), recent: isRecent(text), proximity };
      });
      queryResults.push({
        status: 'ok', query, searchUrl: url, finalUrl: browserResult.finalUrl || url, provider: 'hosted-browser',
        placeName: browserResult.placeName ?? null,
        snippets: snippetObjects,
        themes: summarizeThemes(browserResult.reviews, redFlagPatterns, proximityHints, tierMultipliers),
      });
      continue;
    }

    const page = await fetchText(url);
    if (!page.ok) {
      queryResults.push({
        status: 'error',
        query,
        searchUrl: url,
        finalUrl: page.url || url,
        provider: page.provider ?? null,
        crawl4aiError: page.crawl4aiError ?? null,
        reason: `HTTP ${page.status}${page.error ? ` ${page.error}` : ''}`,
      });
      continue;
    }
    const body = stripHtml(page.text);
    const snippets = extractSnippets(body, query);
    if (snippets.length === 0) {
      queryResults.push({ status: 'empty', query, searchUrl: url, finalUrl: page.url || url, provider: page.provider ?? null, crawl4aiError: page.crawl4aiError ?? null });
      continue;
    }
    const snippetObjects = snippets.map((text) => {
      const proximity = proximityHints
        ? classifyProximity(text, proximityHints, tierMultipliers)
        : { level: 'subdivision', multiplier: 1.0, matchedHints: [] };
      return { text, ...classifySnippet(text, redFlagPatterns), recent: isRecent(text), proximity };
    });
    queryResults.push({
      status: 'ok',
      query,
      searchUrl: url,
      finalUrl: page.url || url,
      provider: page.provider ?? null,
      crawl4aiError: page.crawl4aiError ?? null,
      snippets: snippetObjects,
      themes: summarizeThemes(snippets, redFlagPatterns, proximityHints, tierMultipliers),
    });
  }

  return {
    key: sourceEntry.key,
    name: sourceEntry.name,
    url: sourceEntry.url,
    note: sourceEntry.note,
    lookbackDays: sourceEntry.lookbackDays,
    queryResults,
  };
}

function rollupKpiScores(sourceResults, weights = {}) {
  const categories = new Map();
  for (const source of sourceResults) {
    for (const query of source.queryResults ?? []) {
      if (query.status !== 'ok') continue;
      for (const theme of query.themes ?? []) {
        const entry = categories.get(theme.category) ?? {
          category: theme.category, hits: 0, recentHits: 0, positiveHits: 0, negativeHits: 0,
          contributingSources: new Set(), examples: [],
        };
        entry.hits += Number(theme.hits ?? 0);
        entry.recentHits += Number(theme.recentHits ?? 0);
        entry.positiveHits += Number(theme.positiveHits ?? 0);
        entry.negativeHits += Number(theme.negativeHits ?? 0);
        entry.contributingSources.add(source.key);
        entry.examples.push(...(theme.examples ?? []).slice(0, 2));
        categories.set(theme.category, entry);
      }
    }
  }
  return [...categories.values()].map((entry) => {
    const weight = Number(weights?.[entry.category] ?? 0);
    const rawDirection = entry.positiveHits - entry.negativeHits;
    const signalScore = Number(rawDirection.toFixed(3));
    const weightedScore = Number((signalScore * weight).toFixed(3));
    return {
      category: entry.category,
      weight,
      hits: entry.hits,
      recentHits: entry.recentHits,
      positiveHits: entry.positiveHits,
      negativeHits: entry.negativeHits,
      signalScore,
      weightedScore,
      contributingSources: [...entry.contributingSources],
      examples: [...new Set(entry.examples)].slice(0, 2),
    };
  }).sort((a, b) => Math.abs(b.weightedScore) - Math.abs(a.weightedScore));
}

function readExistingOutput(outputPath) {
  if (!existsSync(outputPath)) return null;
  try { return JSON.parse(readFileSync(outputPath, 'utf8')); } catch { return null; }
}

function mergeSources(existingSources, newSources, allowedKeys = null) {
  const byKey = new Map();
  for (const entry of existingSources ?? []) {
    if (allowedKeys && !allowedKeys.has(entry.key)) continue;
    byKey.set(entry.key, entry);
  }
  for (const entry of newSources) byKey.set(entry.key, entry);
  return [...byKey.values()];
}

async function extractTarget(target, researchContext, getBrowserContext = null) {
  const sentimentPlan = buildSentimentSourcePlan(target, researchContext);
  const publicEntries = sentimentPlan.entries.filter(
    (entry) => PUBLIC_KEYS.has(entry.key) && (entry.searchUrls?.length ?? 0) > 0,
  );
  const redFlagPatterns = buildProfileRedFlagPatterns(researchContext.profile);
  const proximityHints = buildProximityHints({
    subdivisionHints: sentimentPlan.subdivisionHints,
    roadHints: sentimentPlan.roadHints,
    schoolNames: sentimentPlan.schoolNames,
    city: target.city,
  });
  const tierMultipliers = resolveProximityTierMultipliers(researchContext.profile);
  // --profile was explicitly requested (getBrowserContext is set) but the
  // session didn't connect: report google_maps as blocked rather than
  // silently falling back to the place-card-only fetch/crawl4ai path, which
  // would misrepresent weak evidence as a normal capture.
  let browserContext = null;
  let browserSessionError = null;
  if (getBrowserContext && publicEntries.some((entry) => entry.key === 'google_maps')) {
    try {
      browserContext = await getBrowserContext();
    } catch (error) {
      browserSessionError = String(error?.message ?? error);
    }
  }
  const scoringContext = { redFlagPatterns, proximityHints, tierMultipliers, browserContext, browserSessionError };
  const newSources = [];
  for (const entry of publicEntries) {
    newSources.push(await runSource(entry, scoringContext));
  }

  const outputPath = buildOutputPath(target);
  const existing = readExistingOutput(outputPath);
  const allowedKeys = new Set(sentimentPlan.entries.map((entry) => entry.key));
  const mergedSources = mergeSources(existing?.sources, newSources, allowedKeys);
  const kpiWeights = researchContext.profile?.sentiment?.weights ?? {};
  const kpiRollup = rollupKpiScores(mergedSources, kpiWeights);

  const output = {
    generatedAt: new Date().toISOString(),
    address: target.address,
    city: target.city,
    state: target.state,
    reportPath: target.relativePath,
    subdivisionHints: existing?.subdivisionHints ?? sentimentPlan.subdivisionHints,
    roadHints: existing?.roadHints ?? sentimentPlan.roadHints,
    schoolNames: existing?.schoolNames ?? sentimentPlan.schoolNames,
    kpiWeights,
    kpiRollup,
    sources: mergedSources,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  const sourceUrls = mergedSources.flatMap((source) => [
    source.url,
    ...(source.queryResults ?? []).map((query) => query.finalUrl || query.searchUrl),
  ]).filter(Boolean);
  const sidecar = withSidecarMetadata(output, {
    kind: 'sentiment',
    scope: 'property',
    subject: target,
    subjectKey: subjectKeyForTarget(target),
    expiresAt: expiresInDays(30, output.generatedAt),
    sourceUrls,
    status: mergedSources.length > 0 ? 'reviewed' : 'unconfigured',
    warnings: mergedSources.length > 0 ? [] : ['No public sentiment sources were configured for this target.'],
  });
  await writeFile(outputPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  recordArtifact({
    path: outputPath,
    kind: 'sentiment',
    scope: 'property',
    subject: target,
    subjectKey: sidecar.subjectKey,
    commandId: sidecar.commandId,
    generatedAt: sidecar.generatedAt,
    expiresAt: sidecar.expiresAt,
    sourceUrls: sidecar.sourceUrls,
    status: sidecar.status,
    warnings: sidecar.warnings,
  });
  return { ...sidecar, outputPath, newSourceCount: newSources.length };
}

function printSummary(results) {
  console.log('\nPublic sentiment extract\n');
  for (const result of results) {
    console.log(`${result.address} | ${result.city}, ${result.state}`);
    if (result.sources.length === 0) {
      console.log('- No public sentiment sources were configured for this target.');
      console.log('');
      continue;
    }
    for (const source of result.sources) {
      if (!PUBLIC_KEYS.has(source.key)) continue;
      const counts = (source.queryResults ?? []).reduce((acc, entry) => {
        acc[entry.status] = (acc[entry.status] ?? 0) + 1;
        return acc;
      }, {});
      const summary = Object.entries(counts).map(([key, value]) => `${key}:${value}`).join(', ');
      console.log(`- ${source.name}: ${summary || 'no queries run'}`);
    }
    console.log('');
  }
}

async function main() {
  let config;
  try { config = parseArgs(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(HELP_TEXT);
    process.exit(1);
  }
  if (config.help) { console.log(HELP_TEXT); return; }

  const targets = resolveTargets(config);
  const researchContext = loadResearchConfig(ROOT);

  let browserHandle = null;
  let contextPromise = null;
  const getBrowserContext = config.profileName ? async () => {
    if (!contextPromise) {
      contextPromise = (async () => {
        const session = await ensureHostedSession(config.profileName);
        browserHandle = await chromium.connectOverCDP(session.cdpUrl, { timeout: 30000, isLocal: true });
        const context = browserHandle.contexts()[0];
        if (!context) throw new Error('Hosted browser session is running, but no default context was exposed.');
        return context;
      })();
    }
    return contextPromise;
  } : null;

  try {
    const results = [];
    for (const target of targets) {
      results.push(await extractTarget(target, researchContext, getBrowserContext));
    }

    if (config.json) {
      console.log(JSON.stringify({ count: results.length, results }, null, 2));
      return;
    }
    printSummary(results);
  } finally {
    if (browserHandle) await browserHandle.close().catch(() => {});
  }
}

const isDirectEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectEntry) {
  main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}
