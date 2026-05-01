#!/usr/bin/env node

/**
 * sentiment-public-extract.mjs -- Public-source neighborhood sentiment pass.
 *
 * Complements sentiment-browser-extract.mjs (which handles login-walled
 * Facebook + Nextdoor via the hosted session) by pulling snippets from
 * the opted-in public sources listed in portals.yml under sentiment_sources
 * -- currently reddit (via old.reddit.com search) and google_maps (lightly,
 * since their search pages are JS-heavy).
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
  scoreProfileRedFlags,
} from './sentiment-scoring.mjs';
import { slugify } from '../shared/text-utils.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'sentiment');
const PUBLIC_KEYS = new Set(['reddit', 'google_maps']);
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_QUERIES_PER_SOURCE = 4;

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

Fetches opted-in public sentiment sources (reddit, google_maps) from
portals.yml for each target and merges snippets into output/sentiment/.

Options:
  --shortlist   Use the current populated Top 10 cohort from data/shortlist.md.
  --top3        Use the current refined top 3 from data/shortlist.md.
  --json        Print JSON instead of human-readable text.
  --help        Show this help text.`;

function parseArgs(argv) {
  const config = { shortlist: false, top3: false, json: false, help: false, files: [] };
  for (const arg of argv) {
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
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
    if (!response.ok) return { ok: false, status: response.status, text: '', url };
    const text = await response.text();
    return { ok: true, status: response.status, text, url };
  } catch (error) {
    return { ok: false, status: 0, text: '', url, error: String(error?.message ?? error) };
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

function classifySnippet(text, redFlagPatterns = []) {
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

function summarizeThemes(snippets, redFlagPatterns = [], proximityHints = null) {
  const themes = new Map();
  for (const snippet of snippets) {
    const proximity = proximityHints
      ? classifyProximity(snippet, proximityHints)
      : { level: 'strong', multiplier: 1.0, matchedHints: [] };
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

async function runSource(sourceEntry, scoringContext) {
  const { redFlagPatterns = [], proximityHints = null } = scoringContext || {};
  const queryResults = [];
  const urls = Array.isArray(sourceEntry.searchUrls) ? sourceEntry.searchUrls : [];
  const queries = sourceEntry.recommendedQueries ?? [];
  const pairs = [];
  for (const url of urls.slice(0, MAX_QUERIES_PER_SOURCE)) {
    const queryFromUrl = decodeURIComponent((url.match(/[?&]q(?:uery)?=([^&]+)/) ?? [])[1] ?? '').replace(/\+/g, ' ');
    pairs.push({ url, query: queryFromUrl || queries[0] || '' });
  }

  for (const { url, query } of pairs) {
    if (!query) continue;
    const page = await fetchText(url);
    if (!page.ok) {
      queryResults.push({ status: 'error', query, searchUrl: url, finalUrl: url, reason: `HTTP ${page.status}${page.error ? ` ${page.error}` : ''}` });
      continue;
    }
    const body = stripHtml(page.text);
    const snippets = extractSnippets(body, query);
    if (snippets.length === 0) {
      queryResults.push({ status: 'empty', query, searchUrl: url, finalUrl: url });
      continue;
    }
    const snippetObjects = snippets.map((text) => {
      const proximity = proximityHints
        ? classifyProximity(text, proximityHints)
        : { level: 'strong', multiplier: 1.0, matchedHints: [] };
      return { text, ...classifySnippet(text, redFlagPatterns), recent: false, proximity };
    });
    queryResults.push({
      status: 'ok',
      query,
      searchUrl: url,
      finalUrl: url,
      snippets: snippetObjects,
      themes: summarizeThemes(snippets, redFlagPatterns, proximityHints),
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

function mergeSources(existingSources, newSources) {
  const byKey = new Map();
  for (const entry of existingSources ?? []) byKey.set(entry.key, entry);
  for (const entry of newSources) byKey.set(entry.key, entry);
  return [...byKey.values()];
}

async function extractTarget(target, researchContext) {
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
  const scoringContext = { redFlagPatterns, proximityHints };
  const newSources = [];
  for (const entry of publicEntries) {
    newSources.push(await runSource(entry, scoringContext));
  }

  const outputPath = buildOutputPath(target);
  const existing = readExistingOutput(outputPath);
  const mergedSources = mergeSources(existing?.sources, newSources);
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
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  return { ...output, outputPath, newSourceCount: newSources.length };
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
  const results = [];
  for (const target of targets) {
    results.push(await extractTarget(target, researchContext));
  }

  if (config.json) {
    console.log(JSON.stringify({ count: results.length, results }, null, 2));
    return;
  }
  printSummary(results);
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exit(1);
});
