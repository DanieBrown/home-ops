#!/usr/bin/env node

/**
 * county-permits-check.mjs -- Per-home county GIS permit/development pressure
 * signal. For each shortlisted home it geocodes the address (cached), then runs
 * spatial queries against the county's ArcGIS feature services within 5 miles,
 * filtered to the last 24 months. Writes one record per home to
 * output/permits/{slug}.json.
 *
 * Service config is loaded from config/county-sources.json (written by
 * scripts/research/county-services-discover.mjs). If that file is absent, the
 * built-in Wake County defaults are used as a fallback.
 *
 * Honors research_sources.development.county_planning in config/profile.yml --
 * if disabled or no supported county is in the buyer's search.areas, the
 * script writes a "skipped-by-profile" record without making any HTTP calls.
 *
 * This is a deterministic public-source lookup. Failures (geocode miss, GIS
 * timeout, county unsupported) degrade to status flags rather than throwing
 * so downstream agents can reason about coverage gaps.
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from '../shared/paths.mjs';
import {
  loadResearchConfig,
  parseReport,
  parseShortlist,
  resolveAreaContext,
} from './research-utils.mjs';
import { ensureGeocode } from './geocode.mjs';
import { slugify } from '../shared/text-utils.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'permits');
const COUNTY_SOURCES_PATH = join(ROOT, 'config', 'county-sources.json');
const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_RADIUS_METERS = 8047; // 5 miles
const LOOKBACK_DAYS = 24 * 30; // ~24 months

// Built-in fallback for Wake County. Superseded by config/county-sources.json
// once county-services-discover.mjs has been run.
const COUNTY_SOURCES_BUILTIN = {
  wake: {
    label: 'Wake County, NC',
    services: [
      {
        key: 'wake-development',
        name: 'Wake County Development (subdivisions)',
        url: 'https://maps.wake.gov/arcgis/rest/services/Planning/Wake_County_Development/FeatureServer/0',
        dateField: 'APPLICATIONDATE',
        outFields: 'CASEID,CASENUMBER,WORK_CLASS,APPLICATIONDATE,DESCRIPTION,PLAN_STATUS,SUBDIVISION_NAME,PROPOSED_NO_LOTS,NUMBER_OF_ACRES',
        recordKind: 'subdivision-case',
      },
      {
        key: 'wake-zoning',
        name: 'Wake County Zoning Cases',
        url: 'https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/FeatureServer/0',
        dateField: null,
        outFields: '*',
        recordKind: 'zoning',
        skipDateFilter: true,
      },
    ],
  },
};

function loadCountySources() {
  if (!existsSync(COUNTY_SOURCES_PATH)) return COUNTY_SOURCES_BUILTIN;
  try {
    const dynamic = JSON.parse(readFileSync(COUNTY_SOURCES_PATH, 'utf8'));
    // Merge: dynamic entries override matching builtin keys; builtin fills gaps.
    const merged = { ...COUNTY_SOURCES_BUILTIN };
    for (const [key, entry] of Object.entries(dynamic.counties ?? {})) {
      if (Array.isArray(entry.services) && entry.services.length > 0 && entry.ok !== false) {
        merged[key] = { label: entry.label ?? key, services: entry.services };
      }
    }
    return merged;
  } catch {
    return COUNTY_SOURCES_BUILTIN;
  }
}

const COUNTY_SOURCES = loadCountySources();

const PHASE_WEIGHTS = {
  active: 3,        // construction / approved
  near_term: 2,     // approved, scheduled
  planning: 1,      // submitted, under review
  complete: 0,
};

const STATUS_PHASE_HINTS = [
  { phase: 'active', patterns: [/under construction/i, /\bactive\b/i, /\bissued\b/i, /\bapproved\b/i] },
  { phase: 'near_term', patterns: [/\bscheduled\b/i, /\bpending\b/i, /\bin review\b/i] },
  { phase: 'planning', patterns: [/\bsubmitted\b/i, /\bapplication\b/i, /\breceived\b/i, /\bplanning\b/i] },
  { phase: 'complete', patterns: [/\bcomplete\b/i, /\bfinal\b/i, /\bclosed\b/i, /\bwithdrawn\b/i, /\bdenied\b/i] },
];

const HELP_TEXT = `Usage:
  node county-permits-check.mjs reports/001-foo.md
  node county-permits-check.mjs --shortlist
  node county-permits-check.mjs --top3

Queries county GIS feature services for permits, subdivision cases, and
zoning within 5 miles of each shortlisted home. Currently supports Wake
County, NC. Writes per-home records to output/permits/.

Options:
  --shortlist       Use the current Top 10 cohort.
  --top3            Use the refined Top 3.
  --radius <m>      Override the spatial radius in meters (default 8047 = 5 miles).
  --json            Print JSON instead of human-readable text.
  --help            Show this help.`;

function parseArgs(argv) {
  const config = { shortlist: false, top3: false, json: false, help: false, radiusMeters: DEFAULT_RADIUS_METERS, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--radius') {
      config.radiusMeters = Number.parseInt(argv[i + 1] ?? '', 10);
      if (!Number.isFinite(config.radiusMeters) || config.radiusMeters <= 0) {
        throw new Error('--radius requires a positive integer (meters)');
      }
      i += 1; continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    config.files.push(arg);
  }
  return config;
}

function buildOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'permits-target';
  return join(OUTPUT_DIR, `${slug}.json`);
}

function resolveTargets(config) {
  if (config.shortlist || config.top3) {
    const shortlist = parseShortlist(ROOT);
    const rows = config.top3 ? shortlist.refinedTop3 : shortlist.top10;
    if (rows.length === 0) {
      throw new Error(config.top3 ? 'No refined top-3 homes.' : 'No populated top-10 homes.');
    }
    return rows.map((row) => parseReport(ROOT, row.reportPath));
  }
  if (config.files.length === 0) {
    throw new Error('Provide a report path, or use --shortlist / --top3.');
  }
  return config.files.map((filePath) => parseReport(ROOT, filePath));
}

function pickCountySources(target, researchContext) {
  const areaContext = resolveAreaContext(target, researchContext);
  const matched = [];
  for (const county of areaContext.counties) {
    const key = String(county || '').toLowerCase().trim();
    const config = COUNTY_SOURCES[key];
    if (config) matched.push({ key, ...config });
  }
  return matched;
}

async function spatialQuery(serviceUrl, lng, lat, radiusMeters, opts = {}) {
  const params = new URLSearchParams({
    f: 'json',
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    distance: String(radiusMeters),
    units: 'esriSRUnit_Meter',
    outFields: opts.outFields || '*',
    returnGeometry: 'false',
    where: opts.where || '1=1',
  });

  const url = `${serviceUrl}/query?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'home-ops/county-permits-check (+https://github.com/)' },
    });
    if (!response.ok) {
      return { ok: false, status: response.status, features: [], error: `HTTP ${response.status}` };
    }
    const body = await response.json();
    if (body?.error) {
      return { ok: false, status: response.status, features: [], error: body.error.message || 'service error' };
    }
    return { ok: true, status: response.status, features: body.features || [] };
  } catch (error) {
    return { ok: false, status: 0, features: [], error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

function classifyPhase(text) {
  const haystack = String(text || '');
  for (const { phase, patterns } of STATUS_PHASE_HINTS) {
    if (patterns.some((p) => p.test(haystack))) return phase;
  }
  return 'unknown';
}

function summarizeFeatures(features, service) {
  const matches = [];
  let pressure = 0;

  for (const feature of features.slice(0, 50)) {
    const a = feature.attributes || {};
    const status = a.PLAN_STATUS || a.STATUS || a.STAGE || '';
    const desc = a.DESCRIPTION || a.PROJECT_NAME || a.NAME || '';
    const subdivision = a.SUBDIVISION_NAME || '';
    const phase = classifyPhase(`${status} ${desc}`);
    const phaseWeight = PHASE_WEIGHTS[phase] ?? 0;
    pressure += phaseWeight;

    matches.push({
      service: service.key,
      kind: service.recordKind,
      caseId: a.CASEID ?? a.CASE_ID ?? a.CASENUMBER ?? null,
      subdivisionName: subdivision || null,
      workClass: a.WORK_CLASS || null,
      proposedLots: Number.isFinite(Number(a.PROPOSED_NO_LOTS)) ? Number(a.PROPOSED_NO_LOTS) : null,
      acres: Number.isFinite(Number(a.NUMBER_OF_ACRES)) ? Number(a.NUMBER_OF_ACRES) : null,
      applicationDate: a.APPLICATIONDATE ? new Date(a.APPLICATIONDATE).toISOString() : null,
      status,
      description: desc ? String(desc).slice(0, 360) : '',
      phase,
    });
  }

  return { matches, pressure };
}

function buildDateFilter(service) {
  if (service.skipDateFilter || !service.dateField) return '1=1';
  const sinceMs = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return `${service.dateField} >= ${sinceMs}`;
}

function pressureLevel(score) {
  if (score >= 9) return 'high';
  if (score >= 4) return 'moderate';
  if (score >= 1) return 'low';
  return 'none';
}

async function checkTarget(target, researchContext, options) {
  const counties = pickCountySources(target, researchContext);
  if (counties.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      address: target.address,
      city: target.city,
      state: target.state,
      reportPath: target.relativePath,
      status: 'unsupported-county',
      level: 'unknown',
      pressure: null,
      matches: [],
      sourcesChecked: [],
      note: 'No supported county GIS source for this home. Add the county to scripts/research/county-permits-check.mjs to enable.',
    };
  }

  const geocode = await ensureGeocode(target);
  if (geocode.status !== 'ok' || !Number.isFinite(geocode.lat) || !Number.isFinite(geocode.lng)) {
    return {
      generatedAt: new Date().toISOString(),
      address: target.address,
      city: target.city,
      state: target.state,
      reportPath: target.relativePath,
      status: 'geocode-failed',
      level: 'unknown',
      pressure: null,
      matches: [],
      sourcesChecked: [],
      geocodeStatus: geocode.status,
      note: `Could not geocode address. Spatial permit filter skipped. (${geocode.error ?? geocode.status})`,
    };
  }

  const allMatches = [];
  const sourcesChecked = [];
  let totalPressure = 0;

  for (const county of counties) {
    for (const service of county.services) {
      const result = await spatialQuery(service.url, geocode.lng, geocode.lat, options.radiusMeters, {
        outFields: service.outFields,
        where: buildDateFilter(service),
      });
      sourcesChecked.push({
        county: county.label,
        service: service.key,
        name: service.name,
        url: service.url,
        ok: result.ok,
        status: result.status,
        featureCount: result.features.length,
        error: result.error ?? null,
      });
      if (!result.ok) continue;
      const summary = summarizeFeatures(result.features, service);
      allMatches.push(...summary.matches);
      totalPressure += summary.pressure;
    }
  }

  const cappedPressure = Math.min(15, totalPressure);
  return {
    generatedAt: new Date().toISOString(),
    address: target.address,
    city: target.city,
    state: target.state,
    reportPath: target.relativePath,
    geocode: { lat: geocode.lat, lng: geocode.lng, source: geocode.source },
    radiusMeters: options.radiusMeters,
    status: 'reviewed',
    level: pressureLevel(cappedPressure),
    pressure: cappedPressure,
    matchCount: allMatches.length,
    matches: allMatches.slice(0, 25),
    sourcesChecked,
  };
}

export function readPermitsRecord(target) {
  const path = buildOutputPath(target);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function permitsRecordPath(target) {
  return buildOutputPath(target);
}

async function run() {
  let config;
  try { config = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(e.message); console.error(''); console.error(HELP_TEXT); process.exit(1);
  }
  if (config.help) { console.log(HELP_TEXT); return; }

  const researchContext = loadResearchConfig(ROOT);
  const countyEnabled = researchContext.profile?.research_sources?.development?.county_planning === true;
  const targets = resolveTargets(config);

  await mkdir(OUTPUT_DIR, { recursive: true });

  const records = [];
  for (const target of targets) {
    let record;
    if (!countyEnabled) {
      record = {
        generatedAt: new Date().toISOString(),
        address: target.address,
        city: target.city,
        state: target.state,
        reportPath: target.relativePath,
        status: 'skipped-by-profile',
        level: 'unknown',
        pressure: null,
        matches: [],
        sourcesChecked: [],
        note: 'research_sources.development.county_planning is false in config/profile.yml.',
      };
    } else {
      record = await checkTarget(target, researchContext, { radiusMeters: config.radiusMeters });
    }
    await writeFile(buildOutputPath(target), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    records.push(record);
  }

  if (config.json) {
    console.log(JSON.stringify({ count: records.length, records }, null, 2));
    return;
  }

  console.log('\nCounty permits check\n');
  for (const r of records) {
    console.log(`${r.address} | ${r.city}, ${r.state}`);
    console.log(`Status: ${r.status} | Level: ${r.level}${r.pressure != null ? ` (pressure ${r.pressure}/15)` : ''}`);
    console.log(`Matches: ${r.matchCount ?? 0}, sources reachable: ${(r.sourcesChecked || []).filter((s) => s.ok).length}/${(r.sourcesChecked || []).length}`);
    if (r.note) console.log(`Note: ${r.note}`);
    console.log('');
  }
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  run().catch((error) => { console.error(`Fatal: ${error.message}`); process.exit(1); });
}
