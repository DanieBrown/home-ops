#!/usr/bin/env node

/**
 * construction-check.mjs -- Lightweight NCDOT construction-risk signal for
 * home-ops finalists. For each target home it fetches NCDOT project index
 * pages, counts mentions of the home's county and road hints, and emits a
 * JSON record under output/construction/{slug}.json so deep-research-packet
 * can surface a construction_pressure weight without each worker having to
 * refetch.
 *
 * This is a deterministic, public-source lookup -- no login, no scraping of
 * private data, no evasion. Failures are tolerated (empty fetch = zero score
 * plus an explicit "unreviewed" flag) so downstream workers can still reason
 * about gap coverage.
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from '../shared/paths.mjs';
import {
  extractRoadHints,
  loadResearchConfig,
  parseReport,
  parseShortlist,
  resolveAreaContext,
} from './research-utils.mjs';
import { slugify } from '../shared/text-utils.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'construction');
const DEFAULT_TIMEOUT_MS = 20000;

// NCDOT maintains a handful of public project index pages. Rather than guess
// at their search API (which changes shape often), we fetch a known-stable
// list page and a per-county STIP landing when we can. Pages missing or
// unreachable degrade gracefully to a "not reviewed" record.
const NCDOT_INDEX_URLS = [
  'https://www.ncdot.gov/projects/current-projects/Pages/default.aspx',
  'https://www.ncdot.gov/initiatives-policies/Transportation/stip/Pages/default.aspx',
];

// Match project-phase keywords inside a result snippet so the score reflects
// active vs. planned vs. complete.
const PHASE_PATTERNS = {
  active: [/\bunder construction\b/i, /\bactive construction\b/i, /\blet\b/i, /\bin construction\b/i],
  near_term: [/\blet 20(?:2[4-9]|3\d)\b/i, /\bscheduled 20(?:2[4-9]|3\d)\b/i, /\bfunded\b/i],
  planning: [/\bplanning\b/i, /\bpre[-\s]?construction\b/i, /\bdesign phase\b/i, /\benvironmental review\b/i],
  complete: [/\bcompleted\b/i, /\bopened to traffic\b/i],
};

const PHASE_WEIGHTS = {
  active: 3,
  near_term: 2,
  planning: 1,
  complete: 0,
};

const HELP_TEXT = `Usage:
  node construction-check.mjs reports/001-foo.md
  node construction-check.mjs --shortlist
  node construction-check.mjs --top3

Fetches NCDOT project index pages and emits a per-home construction_pressure
record under output/construction/. Downstream callers like deep-research-packet
read those records to include construction risk in each deep packet.

Options:
  --shortlist   Use the current top 10 cohort from data/shortlist.md.
  --top3        Use the current refined top 3 from data/shortlist.md.
  --quick       Fetch only the primary NCDOT index page for a faster pass.
  --json        Print JSON instead of human-readable text.
  --help        Show this help text.
`;

function parseArgs(argv) {
  const config = { shortlist: false, top3: false, json: false, help: false, quick: false, files: [] };
  for (const arg of argv) {
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--quick') { config.quick = true; continue; }
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    config.files.push(arg);
  }
  return config;
}

function buildOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'construction-target';
  return join(OUTPUT_DIR, `${slug}.json`);
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

  if (config.files.length === 0) {
    throw new Error('Provide at least one report path, or use --shortlist or --top3.');
  }
  return config.files.map((filePath) => parseReport(ROOT, filePath));
}

async function fetchText(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Public endpoints -- identify the caller honestly so operators can
        // differentiate automated traffic if they want to block us.
        'User-Agent': 'home-ops/construction-check (+https://github.com/)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timer);
    if (!response.ok) {
      return { ok: false, status: response.status, text: '', url };
    }
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
    .replace(/\s+/g, ' ')
    .trim();
}

function countPhaseHits(text) {
  const counts = {};
  for (const [phase, patterns] of Object.entries(PHASE_PATTERNS)) {
    counts[phase] = patterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
  }
  return counts;
}

function extractProjectSnippets(bodyText, needle, windowSize = 240, maxSnippets = 5) {
  if (!needle) return [];
  const normalizedNeedle = needle.toLowerCase();
  const lowerBody = bodyText.toLowerCase();
  const snippets = [];
  let start = 0;
  while (snippets.length < maxSnippets) {
    const matchIndex = lowerBody.indexOf(normalizedNeedle, start);
    if (matchIndex === -1) break;
    const snippetStart = Math.max(0, matchIndex - windowSize / 2);
    const snippetEnd = Math.min(bodyText.length, matchIndex + needle.length + windowSize / 2);
    snippets.push(bodyText.slice(snippetStart, snippetEnd).trim());
    start = matchIndex + needle.length;
  }
  return snippets;
}

function scoreTarget(target, areaContext, indexPages) {
  const roadHints = extractRoadHints(target);
  const counties = areaContext.counties ?? [];
  const needles = [
    ...counties.map((name) => `${name} County`),
    ...counties,
    ...roadHints,
    target.city,
  ].filter(Boolean);

  const matches = [];
  const phaseTotals = { active: 0, near_term: 0, planning: 0, complete: 0 };

  for (const page of indexPages) {
    if (!page.ok) continue;
    const bodyText = stripHtml(page.text);
    for (const needle of [...new Set(needles.map((n) => n.trim()))]) {
      if (!needle) continue;
      const snippets = extractProjectSnippets(bodyText, needle);
      for (const snippet of snippets) {
        const phaseHits = countPhaseHits(snippet);
        const totalPhaseHits = Object.values(phaseHits).reduce((a, b) => a + b, 0);
        if (totalPhaseHits === 0) continue; // text mentions the needle but with no project-phase language
        for (const phase of Object.keys(phaseTotals)) {
          phaseTotals[phase] += phaseHits[phase];
        }
        matches.push({
          sourceUrl: page.url,
          needle,
          snippet,
          phaseHits,
        });
      }
    }
  }

  // Pressure score: phase-weighted sum capped at 10.
  const rawPressure = Object.entries(phaseTotals).reduce(
    (sum, [phase, hits]) => sum + hits * (PHASE_WEIGHTS[phase] ?? 0),
    0,
  );
  const constructionPressure = Math.min(10, rawPressure);

  let level = 'none';
  if (constructionPressure >= 6) level = 'high';
  else if (constructionPressure >= 3) level = 'moderate';
  else if (constructionPressure >= 1) level = 'low';

  return {
    matches: matches.slice(0, 10),
    phaseTotals,
    constructionPressure,
    level,
    reviewed: indexPages.some((page) => page.ok),
  };
}

function buildRecord(target, areaContext, score, indexPages) {
  return {
    generatedAt: new Date().toISOString(),
    address: target.address,
    city: target.city,
    state: target.state,
    counties: areaContext.counties,
    roadHints: extractRoadHints(target),
    source: 'NCDOT public project index',
    sourcesChecked: indexPages.map((page) => ({
      url: page.url,
      ok: page.ok,
      status: page.status,
      error: page.error ?? null,
    })),
    reportPath: target.relativePath,
    reviewed: score.reviewed,
    level: score.level,
    constructionPressure: score.constructionPressure,
    phaseTotals: score.phaseTotals,
    matches: score.matches,
  };
}

function printSummary(records) {
  console.log('\nNCDOT construction check\n');
  for (const record of records) {
    console.log(`${record.address} | ${record.city}, ${record.state}`);
    console.log(`Counties: ${record.counties.join(', ') || '(none)'}`);
    console.log(`Level: ${record.level} (pressure ${record.constructionPressure}/10)`);
    console.log(`Matches: ${record.matches.length}, sources reachable: ${record.sourcesChecked.filter((s) => s.ok).length}/${record.sourcesChecked.length}`);
    console.log('');
  }
}

async function run() {
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

  // One shared fetch per index URL -- no need to refetch for every home.
  // Quick mode trims to the primary URL (saves one full timeout if the STIP
  // page is slow or unreachable).
  const indexUrls = config.quick ? NCDOT_INDEX_URLS.slice(0, 1) : NCDOT_INDEX_URLS;
  const indexPages = await Promise.all(indexUrls.map((url) => fetchText(url)));

  await mkdir(OUTPUT_DIR, { recursive: true });
  const records = [];
  for (const target of targets) {
    const areaContext = resolveAreaContext(target, researchContext);
    const score = scoreTarget(target, areaContext, indexPages);
    const record = buildRecord(target, areaContext, score, indexPages);
    const outputPath = buildOutputPath(target);
    await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    records.push({ ...record, outputPath });
  }

  if (config.json) {
    console.log(JSON.stringify({ count: records.length, records }, null, 2));
    return;
  }

  printSummary(records);
}

// When imported as a module (e.g. by deep-research-packet for lookup helpers)
// we don't want to auto-run. Only execute when invoked directly.
const isDirectEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectEntry) {
  run().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}

export function readConstructionRecord(target) {
  const outputPath = buildOutputPath(target);
  if (!existsSync(outputPath)) return null;
  return JSON.parse(readFileSync(outputPath, 'utf8'));
}

export { buildOutputPath as constructionRecordPath };
