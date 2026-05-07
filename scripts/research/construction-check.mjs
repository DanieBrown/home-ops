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
 * private data, no evasion. It prefers crawl4ai for rendered capture and
 * falls back to fetch() when crawl4ai is unavailable. Failures are tolerated
 * (empty fetch = zero score plus an explicit "unreviewed" flag) so downstream
 * workers can still reason about gap coverage.
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { OUTPUT_DIR as ROOT_OUTPUT_DIR, ROOT } from '../shared/paths.mjs';
import {
  extractRoadHints,
  loadResearchConfig,
  parseReport,
  parseShortlist,
  resolveAreaContext,
} from './research-utils.mjs';
import { crawl4aiFetchPage } from './crawl4ai-utils.mjs';
import { ensureGeocode } from './geocode.mjs';
import { slugify } from '../shared/text-utils.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'construction');
const STATE_SOURCES_PATH = join(ROOT_OUTPUT_DIR, 'state-sources.json');
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_STIP_RADIUS_METERS = 32187; // 20 miles

// NCDOT maintains a handful of public project index pages. Rather than guess
// at their search API (which changes shape often), we fetch a known-stable
// list page and a per-county STIP landing when we can. Pages missing or
// unreachable degrade gracefully to a "not reviewed" record.
const NCDOT_INDEX_URLS = [
  'https://www.ncdot.gov/projects/current-projects/Pages/default.aspx',
  'https://www.ncdot.gov/initiatives-policies/Transportation/stip/Pages/default.aspx',
];

const NCDOT_STIP_LAYERS = [
  {
    name: 'NCDOT STIP points',
    url: 'https://gis11.services.ncdot.gov/arcgis/rest/services/NCDOT_STIP/MapServer/0',
  },
  {
    name: 'NCDOT STIP lines',
    url: 'https://gis11.services.ncdot.gov/arcgis/rest/services/NCDOT_STIP/MapServer/1',
  },
];

function loadStipLayers() {
  if (!existsSync(STATE_SOURCES_PATH)) return NCDOT_STIP_LAYERS;
  try {
    const inventory = JSON.parse(readFileSync(STATE_SOURCES_PATH, 'utf8'));
    const layers = Object.values(inventory.states ?? {})
      .flatMap((state) => state.transportation ?? [])
      .filter((source) => /ncdot|stip/i.test(`${source.name ?? ''} ${source.url ?? ''}`))
      .flatMap((source) => source.layers ?? [])
      .filter((layer) => layer?.url);
    return layers.length > 0 ? layers : NCDOT_STIP_LAYERS;
  } catch {
    return NCDOT_STIP_LAYERS;
  }
}

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
  --radius <m>  Spatial STIP query radius in meters (default 32187 = 20 miles).
  --json        Print JSON instead of human-readable text.
  --help        Show this help text.
`;

function parseArgs(argv) {
  const config = { shortlist: false, top3: false, json: false, help: false, quick: false, radiusMeters: DEFAULT_STIP_RADIUS_METERS, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--quick') { config.quick = true; continue; }
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--radius') {
      config.radiusMeters = Number.parseInt(argv[index + 1] ?? '', 10);
      if (!Number.isFinite(config.radiusMeters) || config.radiusMeters <= 0) {
        throw new Error('--radius requires a positive integer (meters)');
      }
      index += 1;
      continue;
    }
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
      headers: {
        // Public endpoints -- identify the caller honestly so operators can
        // differentiate automated traffic if they want to block us.
        'User-Agent': 'home-ops/construction-check (+https://github.com/)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timer);
    if (!response.ok) {
      return { ok: false, status: response.status, text: '', url, provider: 'fetch', crawl4aiError: crawled.error ?? null };
    }
    const text = await response.text();
    return { ok: true, status: response.status, text, url, provider: 'fetch', crawl4aiError: crawled.error ?? null };
  } catch (error) {
    return { ok: false, status: 0, text: '', url, provider: 'fetch', error: String(error?.message ?? error), crawl4aiError: crawled.error ?? null };
  }
}

async function queryStipLayer(layer, lng, lat, radiusMeters, counties = []) {
  const countyFilter = counties
    .map((county) => String(county ?? '').replace(/'/g, "''").trim())
    .filter(Boolean)
    .map((county) => `Counties like '%${county}%'`)
    .join(' OR ');

  const params = new URLSearchParams({
    f: 'json',
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    distance: String(radiusMeters),
    units: 'esriSRUnit_Meter',
    outFields: 'TIP,SPOTID,Route,Description,Category,Mode,RightOfWayYear,ConstructionYear,COMMENT,ProjectCost,Counties,MPOsRPOs',
    returnGeometry: 'false',
    where: countyFilter ? `(${countyFilter})` : '1=1',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${layer.url}/query?${params.toString()}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'home-ops/construction-check (+https://github.com/)' },
    });
    if (!response.ok) {
      return { ...layer, ok: false, status: response.status, features: [], error: `HTTP ${response.status}` };
    }
    const body = await response.json();
    if (body?.error) {
      return { ...layer, ok: false, status: response.status, features: [], error: body.error.message || 'service error' };
    }
    return { ...layer, ok: true, status: response.status, features: body.features ?? [] };
  } catch (error) {
    return { ...layer, ok: false, status: 0, features: [], error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

async function queryStipNearTarget(target, areaContext, radiusMeters) {
  const geocode = await ensureGeocode(target);
  if (geocode.status !== 'ok' || !Number.isFinite(geocode.lat) || !Number.isFinite(geocode.lng)) {
    return {
      status: 'geocode-failed',
      radiusMeters,
      sourcesChecked: [],
      matches: [],
      pressure: 0,
      note: `Could not geocode address. Spatial STIP query skipped. (${geocode.error ?? geocode.status})`,
    };
  }

  const layerResults = [];
  for (const layer of loadStipLayers()) {
    layerResults.push(await queryStipLayer(layer, geocode.lng, geocode.lat, radiusMeters, areaContext.counties ?? []));
  }

  const seen = new Set();
  const matches = [];
  let pressure = 0;

  for (const result of layerResults) {
    if (!result.ok) continue;
    for (const feature of result.features.slice(0, 100)) {
      const attrs = feature.attributes ?? {};
      const key = `${attrs.TIP ?? ''}|${attrs.Route ?? ''}|${attrs.Description ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = `${attrs.COMMENT ?? ''} ${attrs.ConstructionYear ?? ''} ${attrs.RightOfWayYear ?? ''} ${attrs.Description ?? ''}`;
      const phaseHits = countPhaseHits(text);
      const phase = classifyStipPhase(attrs, phaseHits);
      const phaseWeight = PHASE_WEIGHTS[phase] ?? 0;
      pressure += phaseWeight;
      matches.push({
        source: result.name,
        tip: attrs.TIP ?? null,
        spotId: attrs.SPOTID ?? null,
        route: attrs.Route ?? '',
        description: attrs.Description ?? '',
        counties: attrs.Counties ?? '',
        rightOfWayYear: attrs.RightOfWayYear ?? '',
        constructionYear: attrs.ConstructionYear ?? '',
        comment: attrs.COMMENT ?? '',
        projectCost: attrs.ProjectCost ?? null,
        phase,
      });
    }
  }

  return {
    status: layerResults.some((result) => result.ok) ? 'reviewed' : 'unreachable',
    geocode: { lat: geocode.lat, lng: geocode.lng, source: geocode.source },
    radiusMeters,
    sourcesChecked: layerResults.map((result) => ({
      name: result.name,
      url: result.url,
      ok: result.ok,
      status: result.status,
      featureCount: result.features?.length ?? 0,
      error: result.error ?? null,
    })),
    matches: matches.slice(0, 25),
    pressure: Math.min(15, pressure),
  };
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

function classifyStipPhase(attrs, phaseHits) {
  const comment = String(attrs.COMMENT ?? '');
  if (PHASE_PATTERNS.active.some((pattern) => pattern.test(comment))) return 'active';

  const constructionYear = Number.parseInt(String(attrs.ConstructionYear ?? '').match(/\d{4}/)?.[0] ?? '', 10);
  const rightOfWayYear = Number.parseInt(String(attrs.RightOfWayYear ?? '').match(/\d{4}/)?.[0] ?? '', 10);
  const currentYear = new Date().getFullYear();

  if (Number.isFinite(constructionYear)) {
    if (constructionYear <= currentYear + 1 && !PHASE_PATTERNS.complete.some((pattern) => pattern.test(comment))) return 'active';
    if (constructionYear <= currentYear + 4) return 'near_term';
    return 'planning';
  }

  if (Number.isFinite(rightOfWayYear)) {
    if (rightOfWayYear <= currentYear + 2) return 'near_term';
    return 'planning';
  }

  for (const phase of ['active', 'near_term', 'planning', 'complete']) {
    if ((phaseHits[phase] ?? 0) > 0) return phase;
  }

  return 'planning';
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

function buildRecord(target, areaContext, score, indexPages, stipRecord) {
  const combinedPressure = Math.min(15, (score.constructionPressure ?? 0) + (stipRecord.pressure ?? 0));
  let level = 'none';
  if (combinedPressure >= 9) level = 'high';
  else if (combinedPressure >= 4) level = 'moderate';
  else if (combinedPressure >= 1) level = 'low';

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
      provider: page.provider ?? null,
      requestedUrl: page.requestedUrl ?? page.url,
      crawl4aiError: page.crawl4aiError ?? null,
      error: page.error ?? null,
    })),
    reportPath: target.relativePath,
    reviewed: score.reviewed || stipRecord.status === 'reviewed',
    level,
    constructionPressure: combinedPressure,
    phaseTotals: score.phaseTotals,
    spatialStip: stipRecord,
    matches: score.matches,
  };
}

function printSummary(records) {
  console.log('\nNCDOT construction check\n');
  for (const record of records) {
    console.log(`${record.address} | ${record.city}, ${record.state}`);
    console.log(`Counties: ${record.counties.join(', ') || '(none)'}`);
    console.log(`Level: ${record.level} (pressure ${record.constructionPressure}/15)`);
    console.log(`Text matches: ${record.matches.length}, STIP matches: ${record.spatialStip?.matches?.length ?? 0}`);
    console.log(`Sources reachable: ${record.sourcesChecked.filter((s) => s.ok).length}/${record.sourcesChecked.length} text, ${(record.spatialStip?.sourcesChecked || []).filter((s) => s.ok).length}/${record.spatialStip?.sourcesChecked?.length ?? 0} STIP`);
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
    const stipRecord = await queryStipNearTarget(target, areaContext, config.radiusMeters);
    const record = buildRecord(target, areaContext, score, indexPages, stipRecord);
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
