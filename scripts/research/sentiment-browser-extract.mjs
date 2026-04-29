#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { chromium } from 'playwright';
import { readSessionState } from '../browser/browser-session.mjs';
import {
  ROOT,
  buildSentimentSourcePlan,
  loadResearchConfig,
  parseReport,
  parseShortlist,
} from './research-utils.mjs';
import {
  buildProfileRedFlagPatterns,
  scoreProfileRedFlags,
} from './sentiment-scoring.mjs';
import {
  CACHE_TTL,
  getCacheEntry,
  isCacheFresh,
  loadCache,
  pruneCache,
  putCacheEntry,
  saveCache,
} from '../system/cache-utils.mjs';
import { slugify } from '../shared/text-utils.mjs';

const SENTIMENT_CACHE_NAME = 'sentiment';

const DEFAULT_PROFILE = 'chrome-host';
const OUTPUT_DIR = join(ROOT, 'output', 'sentiment');
const COMMUNITY_DIR = join(ROOT, 'output', 'communities');
const SUPPORTED_BROWSER_SOURCES = new Set(['facebook', 'nextdoor']);
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
// Browser-backed sources (Facebook / Nextdoor) only populate these sentiment
// dimensions. Traffic-commute is sourced from the public extractor and NCDOT
// so it's not included here.
const BROWSER_ALLOWED_CATEGORIES = new Set(['crime_safety', 'community', 'livability']);
const STOP_WORDS = new Set(['and', 'the', 'for', 'with', 'from', 'near', 'road', 'drive', 'lane', 'court', 'place']);

// Rate-limit knobs -- defensive, not evasive. Keeps query bursts from tripping
// account-level rate limits on FB/ND when the user has authorized automated crawl.
const QUERY_PAUSE_MIN_MS = 2000;
const QUERY_PAUSE_MAX_MS = 5000;
const SCROLL_PAUSE_MIN_MS = 900;
const SCROLL_PAUSE_MAX_MS = 1600;
const MAX_SCROLLS_PER_PAGE = 8;
const MAX_QUERIES_PER_SOURCE = 6;

// Quick-mode caps trade depth for latency when deep is running a progressive
// pass. The numbers are roughly half the normal depth, which in practice lands
// each target at ~1/3 the wall-clock time because scroll pauses dominate.
const QUICK_MAX_SCROLLS_PER_PAGE = 3;
const QUICK_MAX_QUERIES_PER_SOURCE = 3;
const MAX_CONCURRENCY = 4;
const SHORTLIST_SIZE_THRESHOLD = 5;
const HIGH_CONCURRENCY = 4;
const LOW_CONCURRENCY = 2;

// Membership announcement posts (e.g. "Jane joined the group") are not
// sentiment evidence. Filter them before they reach the classifier.
const MEMBERSHIP_PATTERNS = [
  /\bjoined the group\b/i,
  /\bis now a member\b/i,
  /\bwelcome\b.*\bto the neighborhood\b/i,
  /\bwelcome\b.*\bto the group\b/i,
  /\bstarted following\b/i,
  /\bjust moved\b.*\bto the (?:neighborhood|group)\b/i,
  /^\s*welcome\s+[A-Z][a-z]+/i,
];

const BLOCK_PATTERNS = [
  /log in/i,
  /sign in/i,
  /join facebook/i,
  /join nextdoor/i,
  /create new account/i,
  /see more on facebook/i,
  /check your browser/i,
  /security check/i,
  /captcha/i,
  /unusual activity/i,
  /temporarily blocked/i,
  /enter the code/i,
];

const RECENT_PATTERNS = [
  /\bjust now\b/i,
  /\btoday\b/i,
  /\byesterday\b/i,
  /\b[1-7]\s*d(?:ay|ays)?\b/i,
  /\b(?:[1-9]|1\d|2[0-3])\s*h(?:r|rs|our|ours)?\b/i,
  /\b(?:[1-9]|[1-5]\d)\s*m(?:in|ins|inute|inutes)?\b/i,
];

// Expanded KPI keyword set. Organized by sentiment weight category so each
// profile weight maps to the signals used for it. Positive and negative
// patterns feed the overall direction score; theme patterns drive per-category
// KPI rollups. Case-insensitive; word-boundary where it matters.
const POSITIVE_PATTERNS = [
  /\bquiet\b/i, /\bfriendly\b/i, /\bgreat\b/i, /\blove\b/i, /\bsafe\b/i,
  /\bcalm\b/i, /\bfamily/i, /\bwalkable\b/i, /\bconvenient\b/i, /\bhelpful\b/i,
  /\bkid-?friendly\b/i, /\bpet-?friendly\b/i, /\bwell[-\s]?maintained\b/i,
  /\bgood neighbors?\b/i, /\bclean\b/i, /\bupgraded\b/i, /\bbeautiful\b/i,
  /\brecommend\b/i, /\bresponsive\b/i, /\bcommunity events?\b/i,
];

const NEGATIVE_PATTERNS = [
  /\btraffic\b/i, /\bnois(?:e|y)\b/i, /\bcrime\b/i, /\bunsafe\b/i, /\bspeeding\b/i,
  /\baccident\b/i, /\bconstruction\b/i, /\bcongestion\b/i, /\bcrowded\b/i,
  /\bbreak[-\s]?in\b/i, /\btheft\b/i, /\bstolen\b/i, /\bprowler\b/i, /\bshots?\b/i,
  /\bfight\b/i, /\bsuspicious\b/i, /\bflood(?:ing|ed)?\b/i, /\bstanding water\b/i,
  /\bsinkhole\b/i, /\bsewage\b/i, /\bpackage (?:theft|stolen)\b/i,
  /\bcut[-\s]?through\b/i, /\bbarking\b/i, /\bsirens?\b/i, /\bgunshots?\b/i,
  /\bmeth\b/i, /\bhomeless(?:ness)?\b/i, /\bvandal/i, /\bgraffiti\b/i,
  /\brudeness\b/i, /\bhoa (?:drama|violation|fine)/i, /\bpower outage\b/i,
];

const THEME_PATTERNS = {
  // profile.sentiment.weights.crime_safety (0.25)
  crime_safety: [
    /\bcrime\b/i, /\bunsafe\b/i, /\bpolice\b/i, /\btheft\b/i, /\bstolen\b/i,
    /\bbreak[-\s]?in\b/i, /\bsuspicious\b/i, /\bsafety\b/i, /\bprowler\b/i,
    /\bshots?\b/i, /\bgunshots?\b/i, /\bfight\b/i, /\bvandal/i,
    /\bpackage (?:theft|stolen)\b/i, /\bcar (?:broken into|break[-\s]?in)\b/i,
    /\bsirens?\b/i, /\bshelter[-\s]?in[-\s]?place\b/i, /\blockdown\b/i,
  ],
  // profile.sentiment.weights.traffic_commute (0.20)
  traffic_commute: [
    /\btraffic\b/i, /\bcommute\b/i, /\bbackup\b/i, /\bbottleneck\b/i,
    /\bcongestion\b/i, /\bschool pickup\b/i, /\broad work\b/i, /\bwidening\b/i,
    /\bspeeding\b/i, /\bcut[-\s]?through\b/i, /\bstop sign\b/i, /\brunning (?:the )?light\b/i,
    /\baccident\b/i, /\bcrash\b/i, /\bfender[-\s]?bender\b/i,
    /\bdetour\b/i, /\broad clos(?:ed|ure)\b/i, /\bchoke[-\s]?point\b/i,
    /\broundabout\b/i, /\brush hour\b/i,
  ],
  // profile.sentiment.weights.community (0.20)
  community: [
    /\bcommunity\b/i, /\bneighbor/i, /\bhoa\b/i, /\bfamily/i, /\bfriendly\b/i,
    /\bevent/i, /\bgroup\b/i, /\bfacebook group\b/i, /\bblock party\b/i,
    /\bpool\b/i, /\bclubhouse\b/i, /\bamenity\b/i, /\bplayground\b/i,
    /\byard sale\b/i, /\bwelcome/i, /\bkid-?friendly\b/i, /\bpet-?friendly\b/i,
    /\bdog park\b/i, /\bhoa (?:drama|meeting|violation|fine|board)/i,
  ],
  // profile.sentiment.weights.livability
  livability: [
    /\bpark\b/i, /\btrail\b/i, /\bgrocery\b/i, /\brestaurant\b/i, /\bnois(?:e|y)\b/i,
    /\bquiet\b/i, /\bplayground\b/i, /\burgent care\b/i, /\bdaycare\b/i,
    /\bwalkable\b/i, /\bbike\b/i, /\bgreenway\b/i, /\bsidewalk\b/i,
    /\bgarbage\b/i, /\btrash (?:pickup|pick[-\s]?up|day)\b/i, /\brecycl/i,
    /\bmail\b/i, /\bamazon\b/i, /\bups\b/i, /\bfedex\b/i, /\bdelivery\b/i,
    /\binternet\b/i, /\bspectrum\b/i, /\bgoogle fiber\b/i, /\bat&?t fiber\b/i,
    /\bpower outage\b/i, /\bwater pressure\b/i, /\bwell water\b/i, /\bseptic\b/i,
  ],
  // Development/construction pressure signals -- not a profile weight today but
  // contributes to the construction flag consumed by deep-research-packet.
  construction_pressure: [
    /\bconstruction\b/i, /\bclearing\b/i, /\bbulldozer\b/i, /\bnew build\b/i,
    /\brezoning\b/i, /\bpermit\b/i, /\bdevelopment\b/i, /\bsubdivision\b/i,
    /\bbreaking ground\b/i, /\bgroundbreaking\b/i, /\btree clearing\b/i,
    /\blot clearing\b/i, /\bgrading\b/i, /\bheavy equipment\b/i,
  ],
  // Environmental risks -- feed negatives on crime_safety and livability.
  environmental: [
    /\bflood(?:ing|ed)?\b/i, /\bstanding water\b/i, /\bdrainage\b/i,
    /\bsinkhole\b/i, /\brunoff\b/i, /\bcreek\b/i, /\bsewage\b/i, /\bsewer backup\b/i,
    /\bmold\b/i, /\bpest\b/i, /\btermite\b/i, /\bmosquito/i,
  ],
};

function randomDelay(minMs, maxMs) {
  const span = Math.max(0, maxMs - minMs);
  const jitter = Math.floor(Math.random() * (span + 1));
  return new Promise((resolve) => setTimeout(resolve, minMs + jitter));
}

const HELP_TEXT = `Usage:
  node sentiment-browser-extract.mjs reports/003-foo.md
  node sentiment-browser-extract.mjs reports/003-foo.md reports/011-bar.md --profile chrome-host
  node sentiment-browser-extract.mjs --shortlist --profile chrome-host
  node sentiment-browser-extract.mjs --top3 --profile chrome-host
  node sentiment-browser-extract.mjs --address "200 Meadowcrest Pl" --city "Holly Springs" [--county Wake] [--subdivision "Sunset Oaks"]

Captures deterministic browser-backed neighborhood sentiment evidence from hosted Facebook and Nextdoor pages.

Options:
  --shortlist          Use the current populated Top 10 cohort from data/shortlist.md.
  --top3               Use the current refined top 3 from data/shortlist.md.
  --address <value>    Manual target address when no report exists yet.
  --city <value>       Manual target city.
  --state <value>      Manual target state. Defaults to NC.
  --county <value>     Manual county hint.
  --subdivision <val>  Manual subdivision or community hint.
  --profile <name>     Hosted browser profile to reuse. Defaults to chrome-host.
  --no-cache           Skip the per-neighborhood sentiment cache for this run.
  --refresh-cache      Re-scrape every target but still update the cache with fresh results.
  --quick              Cap queries and scrolls for a fast progressive pass (roughly 1/3 wall-clock).
  --concurrency <N>    Extract up to N targets in parallel (default 1, max 4).
  --json               Print JSON instead of human-readable text.
  --help               Show this help text.`;

function parseArgs(argv) {
  const config = {
    shortlist: false,
    top3: false,
    address: '',
    city: '',
    state: 'NC',
    county: '',
    subdivision: '',
    profileName: DEFAULT_PROFILE,
    json: false,
    help: false,
    noCache: false,
    refreshCache: false,
    quick: false,
    concurrency: 1,
    concurrencyProvided: false,
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      config.help = true;
      continue;
    }

    if (arg === '--shortlist') {
      config.shortlist = true;
      continue;
    }

    if (arg === '--top3') {
      config.top3 = true;
      continue;
    }

    if (arg === '--json') {
      config.json = true;
      continue;
    }

    if (arg === '--address') {
      config.address = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--city') {
      config.city = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--state') {
      config.state = argv[index + 1] ?? 'NC';
      index += 1;
      continue;
    }

    if (arg === '--county') {
      config.county = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--subdivision') {
      config.subdivision = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--profile') {
      config.profileName = argv[index + 1] ?? DEFAULT_PROFILE;
      index += 1;
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

    if (arg === '--quick') {
      config.quick = true;
      continue;
    }

    if (arg === '--concurrency') {
      const value = Number.parseInt(argv[index + 1] ?? '', 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error('Expected a positive integer after --concurrency.');
      }
      config.concurrency = Math.min(MAX_CONCURRENCY, value);
      config.concurrencyProvided = true;
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    config.files.push(arg);
  }

  return config;
}

function determineDefaultConcurrency(config, targetCount) {
  if (!(config.shortlist || config.top3)) {
    return 1;
  }

  const shortlistConcurrency = targetCount >= SHORTLIST_SIZE_THRESHOLD
    ? HIGH_CONCURRENCY
    : LOW_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, shortlistConcurrency);
}

function normalizeText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildNextdoorNeighborhoodUrl(community, city, state) {
  const communitySlug = slugify(community).replace(/-/g, '');
  const citySlug = slugify(city);
  const stateSlug = slugify(state || 'NC').toLowerCase();
  return communitySlug && citySlug && stateSlug
    ? `https://nextdoor.com/neighborhood/${communitySlug}--${citySlug}--${stateSlug}/`
    : null;
}

function buildFacebookSearchUrl(community, city) {
  const query = encodeURIComponent(`${community} neighborhood ${city}`.trim());
  return query ? `https://www.facebook.com/search/top?q=${query}` : null;
}

function sanitizeCommunityName(value) {
  const community = normalizeText(value);
  if (!community) {
    return null;
  }

  if (INVALID_COMMUNITY_PATTERNS.some((pattern) => pattern.test(community))) {
    return null;
  }

  return community;
}

function dedupeStrings(values) {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

function buildManualTarget(config) {
  if (!config.address || !config.city) {
    throw new Error('Manual sentiment extraction requires both --address and --city.');
  }

  return {
    filePath: null,
    relativePath: null,
    address: normalizeText(config.address),
    city: normalizeText(config.city),
    state: normalizeText(config.state || 'NC'),
    title: `${normalizeText(config.address)} - ${normalizeText(config.city)}, ${normalizeText(config.state || 'NC')}`,
    metadata: {
      recommendation: '',
      overallScore: '',
    },
    scoreNumber: null,
    manualCountyHint: normalizeText(config.county),
    manualSubdivisionHint: normalizeText(config.subdivision),
    sections: {
      'Quick Take': '',
      'Summary Card': '',
      'Hard Requirement Gate': '',
      'Property Fit': '',
      'Neighborhood Sentiment': '',
      'School Review': '',
      'Development and Infrastructure': '',
      'Financial Snapshot': '',
      'Risks and Open Questions': '',
      'Recommendation': '',
    },
  };
}

function resolveTargets(config) {
  if (config.shortlist || config.top3) {
    const shortlist = parseShortlist(ROOT);
    const rows = config.top3 ? shortlist.refinedTop3 : shortlist.top10;
    if (rows.length === 0) {
      throw new Error(config.top3 ? 'No refined top-3 homes found in data/shortlist.md.' : 'No populated top-10 homes found in data/shortlist.md.');
    }

    const targets = [];
    for (const row of rows) {
      try {
        targets.push(parseReport(ROOT, row.reportPath));
      } catch (err) {
        if (err.code === 'ENOENT' || String(err.message).includes('ENOENT')) {
          console.warn(`[warn] Skipping shortlist entry — report not found: ${row.reportPath}`);
        } else {
          throw err;
        }
      }
    }
    if (targets.length === 0) {
      throw new Error('No shortlist entries have readable reports. Re-run hunt to generate fresh evaluation reports.');
    }
    return targets;
  }

  if (config.address || config.city) {
    return [buildManualTarget(config)];
  }

  if (config.files.length === 0) {
    throw new Error('Provide at least one report path, or use --shortlist, --top3, or manual address/city arguments.');
  }

  return config.files.map((filePath) => parseReport(ROOT, filePath));
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

function buildBrowserSourceUrl(sourceKey, communityData) {
  if (!communityData?.community) return null;
  if (sourceKey === 'nextdoor') {
    return buildNextdoorNeighborhoodUrl(communityData.community, communityData.city, communityData.state);
  }
  if (sourceKey === 'facebook') {
    return buildFacebookSearchUrl(communityData.community, communityData.city);
  }
  return null;
}

function loadCommunityData(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`);
  if (!slug) return null;
  const path = join(COMMUNITY_DIR, `${slug}.json`);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const community = sanitizeCommunityName(parsed?.community);
    const status = parsed?.status === 'no-community-match' || !community
      ? 'no-community-match'
      : parsed?.status ?? 'ok';

    return {
      ...parsed,
      community,
      city: normalizeText(parsed?.city || target.city),
      state: normalizeText(parsed?.state || target.state || 'NC'),
      status,
      communityUrls: community ? {
        nextdoor: buildNextdoorNeighborhoodUrl(community, parsed?.city || target.city, parsed?.state || target.state || 'NC'),
        facebook: buildFacebookSearchUrl(community, parsed?.city || target.city),
      } : { nextdoor: null, facebook: null },
    };
  } catch {
    return null;
  }
}

function isMembershipAnnouncement(text) {
  return MEMBERSHIP_PATTERNS.some((pattern) => pattern.test(text));
}

function tokenizeQuery(query) {
  return dedupeStrings(
    normalizeText(query)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  );
}

function countPatternHits(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function classifySnippet(text, allowedCategories = null, redFlagPatterns = []) {
  const categories = Object.entries(THEME_PATTERNS)
    .filter(([key, patterns]) => {
      if (allowedCategories && !allowedCategories.has(key)) return false;
      return patterns.some((pattern) => pattern.test(text));
    })
    .map(([key]) => key);

  const baseNegative = countPatternHits(text, NEGATIVE_PATTERNS);
  const redFlag = scoreProfileRedFlags(text, redFlagPatterns);
  return {
    categories,
    positiveHits: countPatternHits(text, POSITIVE_PATTERNS),
    negativeHits: baseNegative + redFlag.hits,
    redFlagsMatched: redFlag.matched,
    recent: RECENT_PATTERNS.some((pattern) => pattern.test(text)),
  };
}

function extractBodyWindows(bodyText, queryTokens) {
  if (!bodyText || queryTokens.length === 0) {
    return [];
  }

  const normalizedBody = normalizeText(bodyText).toLowerCase();
  const windows = [];

  for (const token of queryTokens.slice(0, 3)) {
    let startIndex = normalizedBody.indexOf(token);
    while (startIndex !== -1 && windows.length < 8) {
      const snippetStart = Math.max(0, startIndex - 120);
      const snippetEnd = Math.min(bodyText.length, startIndex + 260);
      const snippet = normalizeText(bodyText.slice(snippetStart, snippetEnd));
      if (snippet.length >= 60) {
        windows.push(snippet);
      }
      startIndex = normalizedBody.indexOf(token, startIndex + token.length);
    }
  }

  return dedupeStrings(windows);
}

function selectRelevantSnippets(pageData, query, options = {}) {
  const queryTokens = tokenizeQuery(query);
  const exactNeedle = normalizeText(query).toLowerCase();
  const allowedCategories = options.allowedCategories ?? null;
  const redFlagPatterns = options.redFlagPatterns ?? [];
  const candidates = dedupeStrings([...pageData.blocks, ...extractBodyWindows(pageData.bodyText, queryTokens)])
    .filter((text) => !isMembershipAnnouncement(text));

  return candidates
    .map((text) => {
      const normalized = text.toLowerCase();
      const matchedTokens = queryTokens.filter((token) => normalized.includes(token));
      const classification = classifySnippet(text, allowedCategories, redFlagPatterns);
      const score = (normalized.includes(exactNeedle) ? 8 : 0)
        + (matchedTokens.length * 2)
        + (classification.recent ? 2 : 0)
        + classification.categories.length
        + (classification.positiveHits > 0 || classification.negativeHits > 0 ? 1 : 0);

      return {
        text,
        matchedTokens,
        score,
        ...classification,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

function summarizeThemes(snippets) {
  const themes = new Map();

  for (const snippet of snippets) {
    for (const category of snippet.categories) {
      const current = themes.get(category) ?? {
        category,
        hits: 0,
        recentHits: 0,
        positiveHits: 0,
        negativeHits: 0,
        examples: [],
      };

      current.hits += 1;
      current.recentHits += snippet.recent ? 1 : 0;
      current.positiveHits += snippet.positiveHits;
      current.negativeHits += snippet.negativeHits;
      if (current.examples.length < 2) {
        current.examples.push(snippet.text.slice(0, 180));
      }

      themes.set(category, current);
    }
  }

  return [...themes.values()].sort((left, right) => right.hits - left.hits);
}

async function autoScrollForMoreResults(page, maxScrolls = MAX_SCROLLS_PER_PAGE) {
  for (let pass = 0; pass < maxScrolls; pass += 1) {
    const beforeHeight = await page.evaluate(() => document.body?.scrollHeight ?? 0).catch(() => 0);
    await page.evaluate(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
    }).catch(() => {});
    await randomDelay(SCROLL_PAUSE_MIN_MS, SCROLL_PAUSE_MAX_MS);
    const afterHeight = await page.evaluate(() => document.body?.scrollHeight ?? 0).catch(() => 0);
    if (afterHeight <= beforeHeight) {
      break;
    }
  }
}

async function collectPageData(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const selectors = [
      'article',
      '[role="article"]',
      '[data-testid*="post"]',
      '[data-pagelet*="FeedUnit"]',
      '[class*="post"]',
      '[class*="Post"]',
    ];
    const seen = new Set();
    const blocks = [];

    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        const text = normalize(node.innerText);
        if (!text || text.length < 80 || text.length > 5000 || seen.has(text)) {
          continue;
        }

        seen.add(text);
        blocks.push(text);
        if (blocks.length >= 40) {
          break;
        }
      }

      if (blocks.length >= 40) {
        break;
      }
    }

    return {
      title: document.title ?? '',
      finalUrl: location.href,
      bodyText: normalize(document.body?.innerText ?? '').slice(0, 40000),
      blocks,
    };
  });
}

function detectBlockedReason(pageData) {
  const combined = `${pageData.title}\n${pageData.bodyText}`;
  const match = BLOCK_PATTERNS.find((pattern) => pattern.test(combined));
  return match ? match.source : null;
}

async function extractCommunityPage(context, source, communityUrl, query, options = {}) {
  const attempts = [];
  const maxScrolls = options.quick ? QUICK_MAX_SCROLLS_PER_PAGE : MAX_SCROLLS_PER_PAGE;
  const allowedCategories = options.allowedCategories ?? null;
  const redFlagPatterns = options.redFlagPatterns ?? [];

  const page = await context.newPage();
  try {
    await page.goto(communityUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.waitForSelector('article, [role="article"]', { timeout: 4000 }).catch(() => {});
    if (maxScrolls > 0) {
      await autoScrollForMoreResults(page, maxScrolls);
    }
    const pageData = await collectPageData(page);
    const blockedReason = detectBlockedReason(pageData);

    if (blockedReason) {
      attempts.push({ status: 'blocked', searchUrl: communityUrl, finalUrl: pageData.finalUrl, reason: blockedReason });
      return {
        status: 'blocked',
        query,
        searchUrl: communityUrl,
        finalUrl: pageData.finalUrl,
        pageTitle: pageData.title,
        snippets: [],
        themes: [],
        preview: pageData.bodyText.slice(0, 220),
        reason: blockedReason,
        attempts,
      };
    }

    const snippets = selectRelevantSnippets(pageData, query, { allowedCategories, redFlagPatterns });
    if (snippets.length === 0) {
      return {
        status: 'empty',
        query,
        searchUrl: communityUrl,
        finalUrl: pageData.finalUrl,
        pageTitle: pageData.title,
        snippets: [],
        themes: [],
        preview: pageData.bodyText.slice(0, 220),
        attempts,
      };
    }

    return {
      status: 'ok',
      query,
      searchUrl: communityUrl,
      finalUrl: pageData.finalUrl,
      pageTitle: pageData.title,
      snippets,
      themes: summarizeThemes(snippets),
      preview: pageData.bodyText.slice(0, 220),
      attempts,
    };
  } catch (error) {
    return {
      status: 'error',
      query,
      searchUrl: communityUrl,
      finalUrl: '',
      pageTitle: '',
      snippets: [],
      themes: [],
      preview: '',
      reason: error.message.split('\n')[0],
      attempts,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function buildTargetOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'sentiment-target';
  return join(OUTPUT_DIR, `${slug}.json`);
}

function rollupKpiScores(sourceResults, weights = {}) {
  const categories = new Map();
  for (const source of sourceResults) {
    for (const query of source.queryResults ?? []) {
      if (query.status !== 'ok') continue;
      for (const theme of query.themes ?? []) {
        const entry = categories.get(theme.category) ?? {
          category: theme.category,
          hits: 0,
          recentHits: 0,
          positiveHits: 0,
          negativeHits: 0,
          contributingSources: new Set(),
          examples: [],
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
    // Signal: negatives subtract from positives; recency acts as a 1.5x multiplier.
    const rawDirection = entry.positiveHits - entry.negativeHits;
    const recencyMultiplier = entry.hits > 0 ? 1 + 0.5 * (entry.recentHits / entry.hits) : 1;
    const signalScore = Number((rawDirection * recencyMultiplier).toFixed(3));
    const weightedScore = Number((signalScore * (weight || 0)).toFixed(3));
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
      examples: dedupeStrings(entry.examples).slice(0, 2),
    };
  }).sort((a, b) => Math.abs(b.weightedScore) - Math.abs(a.weightedScore));
}

function normalizeCacheToken(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildSentimentCacheKey(target, sentimentPlan) {
  const hint = sentimentPlan?.subdivisionHints?.[0] || target.address || '';
  const city = target.city || '';
  const state = target.state || '';
  const key = `${normalizeCacheToken(hint)}::${normalizeCacheToken(city)}::${normalizeCacheToken(state)}`;
  return key === '::' + '::' ? '' : key;
}

async function extractTarget(context, target, researchContext, cacheState, options = {}) {
  const quick = Boolean(options.quick);
  const maxQueries = quick ? QUICK_MAX_QUERIES_PER_SOURCE : MAX_QUERIES_PER_SOURCE;
  const sentimentPlan = buildSentimentSourcePlan(target, researchContext);
  const cacheKey = buildSentimentCacheKey(target, sentimentPlan);
  const redFlagPatterns = buildProfileRedFlagPatterns(researchContext.profile);

  const materializeSharedResult = async (sharedOutput, cachedFromKey = cacheKey) => {
    const outputPath = buildTargetOutputPath(target);
    const reusedOutput = {
      generatedAt: new Date().toISOString(),
      address: target.address,
      city: target.city,
      state: target.state,
      reportPath: target.relativePath,
      subdivisionHints: sentimentPlan.subdivisionHints,
      roadHints: sentimentPlan.roadHints,
      schoolNames: sentimentPlan.schoolNames,
      kpiWeights: sharedOutput?.kpiWeights ?? {},
      kpiRollup: sharedOutput?.kpiRollup ?? [],
      sources: sharedOutput?.sources ?? [],
      fromCache: true,
      cachedFrom: cachedFromKey || cacheKey,
    };
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(reusedOutput, null, 2)}\n`, 'utf8');
    if (cacheState && !cacheState.disabled) {
      cacheState.hits += 1;
    }
    return { ...reusedOutput, outputPath };
  };

  if (cacheState?.cache && !cacheState.disabled && !cacheState.refresh && cacheKey) {
    const existing = getCacheEntry(cacheState.cache, cacheKey);
    if (existing && isCacheFresh(existing, CACHE_TTL.SENTIMENT_MS) && existing.sources) {
      cacheState.hits += 1;
      const cachedOutput = {
        generatedAt: new Date().toISOString(),
        address: target.address,
        city: target.city,
        state: target.state,
        reportPath: target.relativePath,
        subdivisionHints: sentimentPlan.subdivisionHints,
        roadHints: sentimentPlan.roadHints,
        schoolNames: sentimentPlan.schoolNames,
        kpiWeights: existing.kpiWeights ?? {},
        kpiRollup: existing.kpiRollup ?? {},
        sources: existing.sources,
        fromCache: true,
        cachedFrom: existing.cacheKey ?? cacheKey,
      };
      const outputPath = buildTargetOutputPath(target);
      await mkdir(OUTPUT_DIR, { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(cachedOutput, null, 2)}\n`, 'utf8');
      return { ...cachedOutput, outputPath };
    }
  }

  const runFreshExtraction = async () => {
    const sourceResults = [];
    const communityData = loadCommunityData(target);

    for (const source of sentimentPlan.entries.filter((entry) => entry.browserSupported && SUPPORTED_BROWSER_SOURCES.has(entry.key))) {
      const communityUrl = buildBrowserSourceUrl(source.key, communityData);

      if (!communityUrl) {
        sourceResults.push({
          key: source.key,
          name: source.name,
          url: source.url,
          note: source.note,
          lookbackDays: source.lookbackDays,
          queryResults: [{
            status: communityData?.status === 'no-community-match' ? 'no-community-match' : source.key === 'nextdoor' ? 'no-community-match' : 'no-community-url',
            query: '',
            searchUrl: '',
            finalUrl: '',
            pageTitle: '',
            snippets: [],
            themes: [],
            reason: communityData
              ? communityData.status === 'no-community-match'
                ? 'community lookup did not produce a valid neighborhood; browser searches skipped'
                : 'no community URL available for this source'
              : 'no community lookup found; run community-lookup.mjs first',
          }],
        });
        continue;
      }

      const queryLabel = communityData.community
        ? `${communityData.community} neighborhood ${target.city}`
        : `${target.city} neighborhood`;
      const result = await extractCommunityPage(context, source, communityUrl, queryLabel, {
        quick,
        allowedCategories: BROWSER_ALLOWED_CATEGORIES,
        redFlagPatterns,
      });

      sourceResults.push({
        key: source.key,
        name: source.name,
        url: source.url,
        note: source.note,
        lookbackDays: source.lookbackDays,
        community: communityData.community,
        communityUrl,
        queryResults: [result],
      });

      await randomDelay(QUERY_PAUSE_MIN_MS, QUERY_PAUSE_MAX_MS);
    }

    const kpiWeights = researchContext.profile?.sentiment?.weights ?? {};
    const kpiRollup = rollupKpiScores(sourceResults, kpiWeights);

    const output = {
      generatedAt: new Date().toISOString(),
      address: target.address,
      city: target.city,
      state: target.state,
      reportPath: target.relativePath,
      subdivisionHints: sentimentPlan.subdivisionHints,
      roadHints: sentimentPlan.roadHints,
      schoolNames: sentimentPlan.schoolNames,
      community: communityData?.community ?? null,
      communityStatus: communityData?.status ?? 'community-lookup-missing',
      kpiWeights,
      kpiRollup,
      sources: sourceResults,
    };

    const outputPath = buildTargetOutputPath(target);
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

    if (cacheState?.cache && !cacheState.disabled && cacheKey) {
      putCacheEntry(cacheState.cache, cacheKey, {
        kpiWeights,
        kpiRollup,
        sources: sourceResults,
        cacheKey,
      });
      cacheState.dirty = true;
      cacheState.misses += 1;
    }

    return {
      ...output,
      outputPath,
    };
  };

  if (cacheKey && options.inFlightByCacheKey) {
    const inFlight = options.inFlightByCacheKey.get(cacheKey);
    if (inFlight) {
      const sharedOutput = await inFlight;
      return materializeSharedResult(sharedOutput, sharedOutput?.cachedFrom ?? cacheKey);
    }

    const currentRun = runFreshExtraction();
    options.inFlightByCacheKey.set(cacheKey, currentRun);
    try {
      return await currentRun;
    } finally {
      if (options.inFlightByCacheKey.get(cacheKey) === currentRun) {
        options.inFlightByCacheKey.delete(cacheKey);
      }
    }
  }

  return runFreshExtraction();
}

function printSummary(results) {
  console.log('\nSentiment browser extract\n');
  for (const result of results) {
    console.log(`${result.address} | ${result.city}, ${result.state}`);
    if (result.reportPath) {
      console.log(`Report: ${result.reportPath}`);
    }
    console.log(`Output: ${result.outputPath.replace(ROOT + '\\', '').replace(/\\/g, '/')}`);

    if (result.sources.length === 0) {
      console.log('- No browser-supported sentiment sources were configured.');
      console.log('');
      continue;
    }

    for (const source of result.sources) {
      const counts = source.queryResults.reduce((acc, entry) => {
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
  const researchContext = loadResearchConfig(ROOT);
  const session = await ensureHostedSession(config.profileName);
  const browser = await chromium.connectOverCDP(session.cdpUrl, { timeout: 30000, isLocal: true });

  const sentimentCache = config.noCache ? { entries: {} } : await loadCache(SENTIMENT_CACHE_NAME);
  if (!config.noCache) {
    pruneCache(sentimentCache, CACHE_TTL.DEFAULT_PRUNE_MS);
  }
  const cacheState = {
    cache: sentimentCache,
    disabled: Boolean(config.noCache),
    refresh: Boolean(config.refreshCache),
    hits: 0,
    misses: 0,
    dirty: false,
  };

  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('Hosted browser session is running, but no default context was exposed.');
    }

    const results = new Array(targets.length);
    const inFlightByCacheKey = new Map();
    let nextIndex = 0;
    const defaultConcurrency = determineDefaultConcurrency(config, targets.length);
    const effectiveConcurrency = config.concurrencyProvided ? config.concurrency : defaultConcurrency;
    const workerCount = Math.min(effectiveConcurrency, targets.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= targets.length) {
          return;
        }
        results[index] = await extractTarget(context, targets[index], researchContext, cacheState, {
          quick: config.quick,
          inFlightByCacheKey,
        });
      }
    });
    await Promise.all(workers);

    if (!config.noCache && cacheState.dirty) {
      await saveCache(SENTIMENT_CACHE_NAME, sentimentCache);
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
      console.log(`Sentiment cache: ${cacheState.hits} hit(s), ${cacheState.misses} miss(es)`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exit(1);
});
