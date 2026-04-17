#!/usr/bin/env node

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { chromium } from 'playwright';
import { readSessionState } from './browser-session.mjs';
import {
  ROOT,
  buildSentimentSourcePlan,
  loadResearchConfig,
  parseReport,
  parseShortlist,
} from './research-utils.mjs';

const DEFAULT_PROFILE = 'chrome-host';
const OUTPUT_DIR = join(ROOT, 'output', 'sentiment');
const SUPPORTED_BROWSER_SOURCES = new Set(['facebook', 'nextdoor']);
const STOP_WORDS = new Set(['and', 'the', 'for', 'with', 'from', 'near', 'road', 'drive', 'lane', 'court', 'place']);

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

const POSITIVE_PATTERNS = [/quiet/i, /friendly/i, /great/i, /love/i, /safe/i, /calm/i, /family/i, /walkable/i, /convenient/i, /helpful/i];
const NEGATIVE_PATTERNS = [/traffic/i, /noise/i, /noisy/i, /crime/i, /unsafe/i, /speeding/i, /accident/i, /construction/i, /congestion/i, /crowded/i, /break-?in/i, /theft/i];

const THEME_PATTERNS = {
  crime_safety: [/crime/i, /unsafe/i, /police/i, /theft/i, /break-?in/i, /suspicious/i, /safety/i, /speeding/i, /accident/i],
  traffic_commute: [/traffic/i, /commute/i, /backup/i, /bottleneck/i, /congestion/i, /school pickup/i, /road work/i, /widening/i],
  community: [/community/i, /neighbor/i, /neighborhood/i, /hoa/i, /family/i, /friendly/i, /event/i, /group/i],
  school_quality: [/school/i, /teacher/i, /student/i, /elementary/i, /middle school/i, /high school/i, /bus/i, /carpool/i],
  livability: [/park/i, /trail/i, /grocery/i, /restaurant/i, /noise/i, /quiet/i, /playground/i, /urgent care/i, /daycare/i],
};

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

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    config.files.push(arg);
  }

  return config;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugify(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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

    return rows.map((row) => parseReport(ROOT, row.reportPath));
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

function buildSearchUrlCandidates(sourceKey, query) {
  const encoded = encodeURIComponent(query);

  if (sourceKey === 'facebook') {
    return [
      `https://www.facebook.com/search/posts/?q=${encoded}`,
      `https://www.facebook.com/search/top/?q=${encoded}`,
    ];
  }

  if (sourceKey === 'nextdoor') {
    return [
      `https://nextdoor.com/search/?query=${encoded}`,
      `https://nextdoor.com/search/?q=${encoded}`,
    ];
  }

  return [];
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

function classifySnippet(text) {
  const categories = Object.entries(THEME_PATTERNS)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(text)))
    .map(([key]) => key);

  return {
    categories,
    positiveHits: countPatternHits(text, POSITIVE_PATTERNS),
    negativeHits: countPatternHits(text, NEGATIVE_PATTERNS),
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

function selectRelevantSnippets(pageData, query) {
  const queryTokens = tokenizeQuery(query);
  const exactNeedle = normalizeText(query).toLowerCase();
  const candidates = dedupeStrings([...pageData.blocks, ...extractBodyWindows(pageData.bodyText, queryTokens)]);

  return candidates
    .map((text) => {
      const normalized = text.toLowerCase();
      const matchedTokens = queryTokens.filter((token) => normalized.includes(token));
      const classification = classifySnippet(text);
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

async function extractSourceQuery(context, source, query) {
  const attempts = [];

  for (const searchUrl of buildSearchUrlCandidates(source.key, query)) {
    const page = await context.newPage();

    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      await page.waitForSelector('article, [role="article"]', { timeout: 4000 }).catch(() => {});
      const pageData = await collectPageData(page);
      const blockedReason = detectBlockedReason(pageData);

      if (blockedReason) {
        attempts.push({ status: 'blocked', searchUrl, finalUrl: pageData.finalUrl, reason: blockedReason });
        continue;
      }

      const snippets = selectRelevantSnippets(pageData, query);
      if (snippets.length === 0) {
        attempts.push({
          status: 'empty',
          searchUrl,
          finalUrl: pageData.finalUrl,
          pageTitle: pageData.title,
          preview: pageData.bodyText.slice(0, 220),
        });
        continue;
      }

      return {
        status: 'ok',
        query,
        searchUrl,
        finalUrl: pageData.finalUrl,
        pageTitle: pageData.title,
        snippets,
        themes: summarizeThemes(snippets),
        preview: pageData.bodyText.slice(0, 220),
        attempts,
      };
    } catch (error) {
      attempts.push({
        status: 'error',
        searchUrl,
        reason: error.message.split('\n')[0],
      });
    } finally {
      await page.close().catch(() => {});
    }
  }

  const lastAttempt = attempts.at(-1) ?? { status: 'error', reason: 'no search URL templates available' };
  return {
    status: lastAttempt.status,
    query,
    searchUrl: lastAttempt.searchUrl ?? '',
    finalUrl: lastAttempt.finalUrl ?? '',
    pageTitle: lastAttempt.pageTitle ?? '',
    snippets: [],
    themes: [],
    preview: lastAttempt.preview ?? '',
    reason: lastAttempt.reason ?? 'no matching content found',
    attempts,
  };
}

function buildTargetOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'sentiment-target';
  return join(OUTPUT_DIR, `${slug}.json`);
}

async function extractTarget(context, target, researchContext) {
  const sentimentPlan = buildSentimentSourcePlan(target, researchContext);
  const sourceResults = [];

  for (const source of sentimentPlan.entries.filter((entry) => entry.browserSupported && SUPPORTED_BROWSER_SOURCES.has(entry.key))) {
    const queryResults = [];
    for (const query of source.recommendedQueries.slice(0, 4)) {
      queryResults.push(await extractSourceQuery(context, source, query));
    }

    sourceResults.push({
      key: source.key,
      name: source.name,
      url: source.url,
      note: source.note,
      lookbackDays: source.lookbackDays,
      queryResults,
    });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    address: target.address,
    city: target.city,
    state: target.state,
    reportPath: target.relativePath,
    subdivisionHints: sentimentPlan.subdivisionHints,
    roadHints: sentimentPlan.roadHints,
    schoolNames: sentimentPlan.schoolNames,
    sources: sourceResults,
  };

  const outputPath = buildTargetOutputPath(target);
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  return {
    ...output,
    outputPath,
  };
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

  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('Hosted browser session is running, but no default context was exposed.');
    }

    const results = [];
    for (const target of targets) {
      results.push(await extractTarget(context, target, researchContext));
    }

    if (config.json) {
      console.log(JSON.stringify({ profile: config.profileName, count: results.length, results }, null, 2));
      return;
    }

    printSummary(results);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exit(1);
});