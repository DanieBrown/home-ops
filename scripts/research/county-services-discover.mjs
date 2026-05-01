#!/usr/bin/env node

/**
 * county-services-discover.mjs -- Auto-discovers ArcGIS feature services
 * for county permit / development / zoning lookups.
 *
 * Reads county ArcGIS base URLs from config/county-arcgis-registry.yml,
 * queries the REST catalog, scores layers by field relevance, and writes
 * config/county-sources.json for use by county-permits-check.mjs.
 *
 * Safe to re-run -- results are deterministic for a given catalog snapshot.
 * Triggered by the profile command after county_planning is enabled.
 *
 * Usage:
 *   node county-services-discover.mjs --all
 *   node county-services-discover.mjs --county wake
 *   node county-services-discover.mjs --county chatham --base-url https://gis.chathamcountync.gov/arcgis/rest/services
 */

import { existsSync, readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { ROOT, PROFILE_PATH } from '../shared/paths.mjs';

const REGISTRY_PATH = join(ROOT, 'config', 'county-arcgis-registry.yml');
const OUTPUT_PATH = join(ROOT, 'config', 'county-sources.json');
const DEFAULT_TIMEOUT_MS = 15000;

// Keywords that suggest a service or folder is planning/permits-related.
const SERVICE_KEYWORDS = [
  'planning', 'development', 'permit', 'subdivision', 'zoning',
  'construction', 'entitlement', 'land use', 'rezoning',
];

// Field scoring: how much each field name contributes to layer relevance.
// Layers scoring < MIN_LAYER_SCORE are dropped.
const FIELD_SCORES = {
  // Date fields (temporal filtering)
  APPLICATIONDATE: 3, SUBMITDATE: 3, SUBMITTALDATE: 3, APPLYDATE: 3, FILEDDATE: 3,
  RECEIVED_DATE: 3, CREATED_DATE: 2,
  // Case identifiers
  CASEID: 3, CASENUMBER: 3, PERMITNUMBER: 3, CASE_ID: 3, PERMIT_NO: 3,
  // Status
  PLAN_STATUS: 2, STATUS: 2, STAGE: 2, CURRENTSTATUS: 2, APPROVAL_STATUS: 2,
  // Description
  DESCRIPTION: 2, PROJECT_NAME: 2, PROJECTNAME: 2, NAME: 1, NOTES: 1,
  // Subdivision / scale
  SUBDIVISION_NAME: 2, SUBDIV_NAME: 2, PROPOSED_NO_LOTS: 2, NUMBER_OF_ACRES: 1,
  ACREAGE: 1, LOTS: 1,
  // Work type
  WORK_CLASS: 2, PERMIT_TYPE: 2, CASE_TYPE: 2, REQUEST_TYPE: 2,
};

const DATE_FIELD_NAMES = new Set([
  'APPLICATIONDATE', 'SUBMITDATE', 'SUBMITTALDATE', 'APPLYDATE',
  'FILEDDATE', 'RECEIVED_DATE', 'CREATED_DATE',
]);

const MIN_LAYER_SCORE = 5;

const HELP_TEXT = `Usage:
  node county-services-discover.mjs --all
  node county-services-discover.mjs --county wake
  node county-services-discover.mjs --county chatham --base-url https://...

Queries ArcGIS REST catalogs for planning/permits/zoning layers and writes
config/county-sources.json consumed by county-permits-check.mjs.

Options:
  --all             Discover for all counties found in config/profile.yml search areas
                    that have entries in config/county-arcgis-registry.yml.
  --county <key>    Discover for a single county (lowercase key, e.g. "wake").
  --base-url <url>  Override or supply the ArcGIS base URL for --county.
  --json            Print JSON result instead of human-readable text.
  --help            Show this help.`;

function parseArgs(argv) {
  const config = { all: false, county: null, baseUrl: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') { config.all = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--county') { config.county = (argv[i + 1] ?? '').toLowerCase().trim(); i++; continue; }
    if (arg === '--base-url') { config.baseUrl = (argv[i + 1] ?? '').trim(); i++; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
  }
  return config;
}

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return { counties: {} };
  try { return YAML.parse(readFileSync(REGISTRY_PATH, 'utf8')) ?? { counties: {} }; } catch { return { counties: {} }; }
}

function loadProfile() {
  if (!existsSync(PROFILE_PATH)) return null;
  try { return YAML.parse(readFileSync(PROFILE_PATH, 'utf8')); } catch { return null; }
}

function loadExistingOutput() {
  if (!existsSync(OUTPUT_PATH)) return { generatedAt: null, counties: {} };
  try { return JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')); } catch { return { generatedAt: null, counties: {} }; }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'home-ops/county-services-discover (+https://github.com/)' },
    });
    if (!response.ok) return { ok: false, status: response.status, body: null, error: `HTTP ${response.status}` };
    const body = await response.json();
    return { ok: true, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

function isRelevantKeyword(name) {
  const lower = String(name ?? '').toLowerCase();
  return SERVICE_KEYWORDS.some((kw) => lower.includes(kw));
}

async function queryCatalog(arcgisBase, folderHints = []) {
  const rootResult = await fetchJson(`${arcgisBase}?f=json`);
  if (!rootResult.ok || !rootResult.body) {
    return { ok: false, error: rootResult.error, services: [] };
  }

  const body = rootResult.body;
  const rootServices = (body.services ?? []).filter((s) => s.type === 'FeatureServer' && isRelevantKeyword(s.name));

  // Collect folders to probe -- folderHints first, then any folder with a relevant name.
  const allFolders = body.folders ?? [];
  const foldersToProbe = [
    ...folderHints.filter((h) => allFolders.some((f) => f.toLowerCase() === h.toLowerCase())),
    ...allFolders.filter((f) => isRelevantKeyword(f) && !folderHints.some((h) => h.toLowerCase() === f.toLowerCase())),
  ];

  const folderServices = [];
  for (const folder of foldersToProbe) {
    const folderResult = await fetchJson(`${arcgisBase}/${encodeURIComponent(folder)}?f=json`);
    if (!folderResult.ok || !folderResult.body) continue;
    const candidates = (folderResult.body.services ?? [])
      .filter((s) => s.type === 'FeatureServer' && isRelevantKeyword(s.name));
    folderServices.push(...candidates);
  }

  // Merge and deduplicate by service path.
  const seen = new Set();
  const combined = [];
  for (const svc of [...rootServices, ...folderServices]) {
    if (!seen.has(svc.name)) { seen.add(svc.name); combined.push(svc); }
  }

  return { ok: true, error: null, services: combined };
}

function scoreFields(fields) {
  let score = 0;
  const matched = {};
  for (const field of fields) {
    const upper = field.name.toUpperCase();
    const pts = FIELD_SCORES[upper] ?? 0;
    if (pts > 0) { score += pts; matched[upper] = pts; }
  }
  return { score, matched };
}

function pickDateField(fields) {
  for (const field of fields) {
    if (DATE_FIELD_NAMES.has(field.name.toUpperCase())) return field.name;
  }
  // Fall back to any esriFieldTypeDate field.
  const dateField = fields.find((f) => f.type === 'esriFieldTypeDate');
  return dateField?.name ?? null;
}

function buildOutFields(fields) {
  const scored = fields
    .map((f) => ({ name: f.name, pts: FIELD_SCORES[f.name.toUpperCase()] ?? 0 }))
    .filter((f) => f.pts > 0)
    .sort((a, b) => b.pts - a.pts)
    .slice(0, 12)
    .map((f) => f.name);
  // Always include OID-like fields for completeness.
  return scored.length > 0 ? scored.join(',') : '*';
}

function inferRecordKind(serviceName, layerName) {
  const text = `${serviceName} ${layerName}`.toLowerCase();
  if (/zoning/.test(text)) return 'zoning';
  if (/permit/.test(text)) return 'permit';
  if (/subdivision/.test(text)) return 'subdivision-case';
  if (/rezoning/.test(text)) return 'rezoning';
  return 'planning-case';
}

async function probeFeatureServer(arcgisBase, service, countyKey) {
  const serviceUrl = `${arcgisBase}/${service.name}/FeatureServer`;
  const svcResult = await fetchJson(`${serviceUrl}?f=json`);
  if (!svcResult.ok || !svcResult.body) {
    return { ok: false, error: svcResult.error, layers: [] };
  }

  const layers = (svcResult.body.layers ?? []).filter((l) => l.type !== 'Group Layer');
  const results = [];

  for (const layer of layers.slice(0, 10)) {
    const layerResult = await fetchJson(`${serviceUrl}/${layer.id}?f=json`);
    if (!layerResult.ok || !layerResult.body) continue;
    const fields = layerResult.body.fields ?? [];
    const { score, matched } = scoreFields(fields);
    if (score < MIN_LAYER_SCORE) continue;

    const dateField = pickDateField(fields);
    const outFields = buildOutFields(fields);
    const servicePart = service.name.replace(/\//g, '-').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    const key = `${countyKey}-${servicePart}-${layer.id}`;

    results.push({
      key,
      name: `${service.name.split('/').pop()} - ${layer.name}`,
      url: `${serviceUrl}/${layer.id}`,
      dateField,
      outFields,
      recordKind: inferRecordKind(service.name, layer.name),
      skipDateFilter: !dateField,
      _score: score,
      _matched: matched,
    });
  }

  return { ok: true, error: null, layers: results };
}

async function discoverCounty(countyKey, countyEntry) {
  const { label, arcgisBase, folderHints = [] } = countyEntry;
  console.log(`  Querying catalog: ${arcgisBase}`);

  const catalog = await queryCatalog(arcgisBase, folderHints);
  if (!catalog.ok) {
    return { ok: false, error: catalog.error, label, services: [] };
  }

  console.log(`  Found ${catalog.services.length} relevant FeatureServer(s) to probe`);
  const allLayers = [];

  for (const svc of catalog.services) {
    console.log(`    Probing: ${svc.name}`);
    const probe = await probeFeatureServer(arcgisBase, svc, countyKey);
    if (probe.ok && probe.layers.length > 0) {
      console.log(`      -> ${probe.layers.length} scored layer(s)`);
      allLayers.push(...probe.layers);
    } else if (!probe.ok) {
      console.log(`      -> fetch failed: ${probe.error}`);
    }
  }

  // Sort by score descending; keep top 8 to avoid noise.
  const services = allLayers
    .sort((a, b) => b._score - a._score)
    .slice(0, 8)
    .map(({ _score, _matched, ...rest }) => rest);

  return { ok: true, error: null, label, services };
}

async function run() {
  let config;
  try { config = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(e.message); console.error(''); console.error(HELP_TEXT); process.exit(1);
  }
  if (config.help) { console.log(HELP_TEXT); return; }

  const registry = loadRegistry();
  const profile = loadProfile();
  const existing = loadExistingOutput();

  // Determine which county keys to process.
  let targetKeys = [];
  if (config.all) {
    const profileCounties = (profile?.search?.areas ?? [])
      .map((a) => String(a.county ?? '').toLowerCase().trim())
      .filter(Boolean);
    const deduped = [...new Set(profileCounties)];
    targetKeys = deduped.filter((k) => registry.counties?.[k]);
    const unsupported = deduped.filter((k) => !registry.counties?.[k]);
    if (unsupported.length > 0) {
      console.log(`Counties not in registry (skipped): ${unsupported.join(', ')}`);
      console.log(`Add them to config/county-arcgis-registry.yml to enable discovery.`);
    }
  } else if (config.county) {
    targetKeys = [config.county];
  } else {
    console.error('Provide --all or --county <key>.');
    console.error(''); console.error(HELP_TEXT); process.exit(1);
  }

  if (targetKeys.length === 0) {
    console.log('No counties to process. Ensure config/county-arcgis-registry.yml has matching entries.');
    process.exit(0);
  }

  const output = { ...existing, generatedAt: new Date().toISOString(), counties: { ...(existing.counties ?? {}) } };

  for (const key of targetKeys) {
    const entry = {
      ...(registry.counties?.[key] ?? {}),
      ...(config.baseUrl ? { arcgisBase: config.baseUrl } : {}),
    };
    if (!entry.arcgisBase) {
      console.log(`No arcgisBase for county "${key}" -- skipping. Pass --base-url or add to registry.`);
      continue;
    }
    console.log(`\nDiscovering: ${entry.label ?? key} (${entry.arcgisBase})`);
    const result = await discoverCounty(key, entry);
    output.counties[key] = {
      label: entry.label ?? key,
      arcgisBase: entry.arcgisBase,
      discoveredAt: new Date().toISOString(),
      ok: result.ok,
      error: result.error ?? null,
      services: result.services,
    };
    if (result.ok) {
      console.log(`  -> ${result.services.length} service layer(s) registered for "${key}"`);
    } else {
      console.log(`  -> discovery failed: ${result.error}`);
    }
  }

  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`\nWrote config/county-sources.json (${Object.keys(output.counties).length} county entries)`);

  if (config.json) {
    console.log(JSON.stringify(output, null, 2));
  }
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  run().catch((error) => { console.error(`Fatal: ${error.message}`); process.exit(1); });
}
