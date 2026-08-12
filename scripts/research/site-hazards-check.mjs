#!/usr/bin/env node

/**
 * site-hazards-check.mjs -- Per-home site hazard capture. Writes one sidecar
 * per home to output/hazards/{slug}.json covering flood zone, wetlands, radon
 * zone, nearby EPA-regulated sites, septic soil suitability, and RDU airport
 * noise contours.
 *
 * This is the source behind the flood rule in modes/_shared.md. Before it
 * existed, "flood-zone exposure" was decided by a regex over listing marketing
 * copy, which meant a home inside a FEMA Special Flood Hazard Area scored
 * identically to one on high ground whenever the agent's blurb stayed quiet.
 *
 * Fails soft by design: a dead source is recorded as `blocked` in
 * sourceCoverage and the script still exits 0 with whatever it did get.
 * `blocked` is not "no hazard found" and must never render as one.
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { ROOT } from '../shared/paths.mjs';
import { slugify } from '../shared/text-utils.mjs';
import { ensureGeocode } from './geocode.mjs';
import { arcgisQuery, loadResearchConfig, parseReport, parseShortlist, resolveAreaContext } from './research-utils.mjs';
import { SOURCES, buildHazardsRecord, lookupRadonZone, parseEpaSites, parseFloodZone, parseSepticSuitability, parseWetlands, resolveAirportNoise } from './site-hazards-core.mjs';
import { coverageConfidence } from './source-coverage.mjs';
import { expiresInDays, recordArtifact, subjectKeyForTarget, withSidecarMetadata } from '../shared/knowledge-store.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'hazards');
const UTILITIES_DIR = join(ROOT, 'output', 'utilities');
const RADON_CONFIG_PATH = join(ROOT, 'config', 'radon-zones.yml');

const DEFAULT_EPA_RADIUS_METERS = 3000;
const WETLAND_RADIUS_METERS = 500;
const REQUEST_TIMEOUT_MS = 25000;

const HELP_TEXT = `Usage:
  node site-hazards-check.mjs reports/001-foo.md
  node site-hazards-check.mjs --shortlist
  node site-hazards-check.mjs --top3

Captures the site-hazard dimensions for each home into output/hazards/{slug}.json:

  Flood        FEMA National Flood Hazard Layer -- zone code, Special Flood
               Hazard Area flag, and FIRM panel at the geocoded point.
  Wetlands     USFWS National Wetlands Inventory -- on-parcel classification,
               or mapped wetlands within ${WETLAND_RADIUS_METERS} m.
  Radon        EPA county radon zone from config/radon-zones.yml (no network).
  Environment  EPA Facility Registry Service -- superfund and brownfield sites
               within the radius, separated from routine regulated facilities.
  Septic       USDA NRCS Soil Data Access septic suitability. Skipped when the
               utilities sidecar confirms public sewer.
  Airport      RDU composite noise contours. Outside the modelled area is
               reported not-applicable, never "quiet".

Every dimension carries its provenance: captured, unconfirmed, blocked,
unsupported, or not-applicable. A source that could not be reached is blocked,
which is NOT the same as no hazard found, and the script still exits 0.

Options:
  --shortlist       Use the current Top 10 cohort from data/shortlist.md.
  --top3            Use the refined Top 3 from data/shortlist.md.
  --radius <m>      EPA site search radius in meters (default ${DEFAULT_EPA_RADIUS_METERS}).
  --no-network      Skip every live query; record each source as blocked.
  --json            Print JSON instead of human-readable text.
  --help, -h        Show this help text.
`;

function parseArgs(argv) {
  const config = { shortlist: false, top3: false, json: false, help: false, noNetwork: false, radiusMeters: DEFAULT_EPA_RADIUS_METERS, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--no-network') { config.noNetwork = true; continue; }
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

export function hazardsOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'hazards-target';
  return join(OUTPUT_DIR, `${slug}.json`);
}

export function readHazardsRecord(target) {
  const path = hazardsOutputPath(target);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function resolveTargets(config) {
  if (config.shortlist || config.top3) {
    const shortlist = parseShortlist(ROOT);
    const rows = config.top3 ? shortlist.refinedTop3 : shortlist.top10;
    if (rows.length === 0) {
      throw new Error(config.top3 ? 'No refined top-3 homes in data/shortlist.md.' : 'No populated top-10 homes in data/shortlist.md.');
    }
    const targets = [];
    for (const row of rows) {
      try { targets.push(parseReport(ROOT, row.reportPath)); } catch (error) {
        console.warn(`[warn] Skipping shortlist entry - report not readable: ${row.reportPath}`);
      }
    }
    if (targets.length === 0) throw new Error('No shortlist entries have readable reports.');
    return targets;
  }
  if (config.files.length === 0) throw new Error('Provide a report path, or use --shortlist / --top3.');
  return config.files.map((filePath) => parseReport(ROOT, filePath));
}

function loadRadonTable() {
  if (!existsSync(RADON_CONFIG_PATH)) return {};
  try { return YAML.parse(readFileSync(RADON_CONFIG_PATH, 'utf8'))?.counties ?? {}; } catch { return {}; }
}

/**
 * Reads sewer status from the utilities sidecar so septic suitability is only
 * asked where it bears on the decision. Anything short of a confirmed public
 * connection leaves it 'unconfirmed' -- we do not assume public sewer.
 */
function readSewerStatus(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`);
  const path = join(UTILITIES_DIR, `${slug}.json`);
  if (!existsSync(path)) return 'unconfirmed';
  try {
    const sidecar = JSON.parse(readFileSync(path, 'utf8'));
    const waterSewer = sidecar?.providers?.waterSewer;
    const status = String(waterSewer?.serviceStatus ?? '').toLowerCase();
    if (status === 'available' || status === 'confirmed' || status === 'captured') return 'public';
    return 'unconfirmed';
  } catch {
    return 'unconfirmed';
  }
}

async function fetchJson(url, { timeoutMs = REQUEST_TIMEOUT_MS, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'home-ops/site-hazards-check (+https://github.com/)', ...(init.headers ?? {}) },
      ...init,
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

async function querySoilSeptic(point) {
  const sql = `
SELECT co.cokey, co.compname, co.comppct_r, ci.mrulename, ci.interphr, ci.interphrc
FROM mapunit mu
INNER JOIN component co ON co.mukey = mu.mukey
INNER JOIN cointerp ci ON ci.cokey = co.cokey
WHERE mu.mukey IN (SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('point(${point.lng} ${point.lat})'))
AND ci.mrulename LIKE '%Septic Tank Absorption%' AND ci.ruledepth = 0`;

  const result = await fetchJson(SOURCES.soil.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'JSON+COLUMNNAME', query: sql }),
  });
  return result.ok ? result.body : { error: result.error };
}

/**
 * RDU publishes the contours as an embedded feature collection inside a web
 * map item rather than a queryable service, so the whole set is fetched and
 * tested locally.
 */
async function fetchAirportContours() {
  const result = await fetchJson(SOURCES.airport.dataUrl);
  if (!result.ok) return { ok: false, error: result.error };
  const layer = result.body?.operationalLayers?.[0]?.featureCollection?.layers?.[0];
  const features = layer?.featureSet?.features;
  if (!Array.isArray(features) || features.length === 0) {
    return { ok: false, error: 'RDU web map item carried no contour features' };
  }
  return { ok: true, features };
}

const blockedResponse = (error) => ({ ok: false, error, features: [] });

async function checkTarget(target, researchContext, config) {
  const radonTable = loadRadonTable();
  const areaContext = resolveAreaContext(target, researchContext);
  const county = areaContext.counties[0] ?? null;
  const sewerStatus = readSewerStatus(target);

  const geocodeRecord = config.noNetwork ? null : await ensureGeocode(target).catch(() => null);
  const hasPoint = geocodeRecord?.status === 'ok' && Number.isFinite(geocodeRecord.lat) && Number.isFinite(geocodeRecord.lng);
  const point = hasPoint ? { lat: geocodeRecord.lat, lng: geocodeRecord.lng } : null;

  // Radon needs no coordinate, so it answers even when geocoding fails.
  const results = { radon: lookupRadonZone(county, radonTable) };

  if (!point) {
    const reason = config.noNetwork
      ? '--no-network was set, so no live source was queried.'
      : `Address could not be geocoded (${geocodeRecord?.error ?? geocodeRecord?.status ?? 'no result'}).`;
    results.flood = parseFloodZone(blockedResponse(reason));
    results.wetlands = parseWetlands(blockedResponse(reason), blockedResponse(reason));
    results.epaSites = parseEpaSites(blockedResponse(reason), { lat: null, lng: null });
    results.septic = parseSepticSuitability({ error: reason }, { sewerStatus });
    results.airportNoise = resolveAirportNoise({ lat: null, lng: null }, blockedResponse(reason));
    return { record: buildHazardsRecord({ target, geocode: null, results }), geocodeRecord };
  }

  const femaZones = `${SOURCES.fema.url}/${SOURCES.fema.zonesLayer}`;
  const femaPanels = `${SOURCES.fema.url}/${SOURCES.fema.firmPanelLayer}`;
  const nwi = `${SOURCES.wetlands.url}/${SOURCES.wetlands.layer}`;
  const frs = `${SOURCES.epaSites.url}/${SOURCES.epaSites.layer}`;

  const [floodResponse, panelResponse, wetlandPoint, wetlandNearby, epaResponse, soilBody, contours] = await Promise.all([
    arcgisQuery(femaZones, { point }),
    arcgisQuery(femaPanels, { point }),
    arcgisQuery(nwi, { point }),
    arcgisQuery(nwi, { point, radiusMeters: WETLAND_RADIUS_METERS, resultRecordCount: 10 }),
    arcgisQuery(frs, { point, radiusMeters: config.radiusMeters, resultRecordCount: 30 }),
    querySoilSeptic(point),
    fetchAirportContours(),
  ]);

  results.flood = parseFloodZone(floodResponse, panelResponse.ok ? panelResponse : null);
  results.wetlands = parseWetlands(wetlandPoint, wetlandNearby, { nearbyRadiusMeters: WETLAND_RADIUS_METERS });
  results.epaSites = parseEpaSites(epaResponse, point, { radiusMeters: config.radiusMeters });
  results.septic = parseSepticSuitability(soilBody, { sewerStatus });
  results.airportNoise = resolveAirportNoise(point, contours);

  return { record: buildHazardsRecord({ target, geocode: geocodeRecord, results }), geocodeRecord };
}

function printSummary(records) {
  console.log('\nSite hazards\n');
  for (const record of records) {
    console.log(`${record.address} | ${record.city}, ${record.state}`);
    for (const dim of Object.values(record.dimensions ?? {})) {
      const value = dim.provenance === 'captured' ? dim.value : `(${dim.provenance})`;
      console.log(`  ${dim.label.padEnd(20)} ${value}${dim.detail ? ` — ${dim.detail}` : ''}`);
    }
    console.log(`  Confidence: ${coverageConfidence(record.sourceCoverage)}`);
    for (const warning of record.warnings ?? []) console.log(`  ! ${warning}`);
    console.log('');
  }
}

async function run() {
  let config;
  try { config = parseArgs(process.argv.slice(2)); } catch (error) {
    console.error(error.message); console.error(''); console.error(HELP_TEXT); process.exit(1);
  }
  if (config.help) { console.log(HELP_TEXT); return; }

  const researchContext = loadResearchConfig(ROOT);
  const targets = resolveTargets(config);
  await mkdir(OUTPUT_DIR, { recursive: true });

  const records = [];
  for (const target of targets) {
    const { record } = await checkTarget(target, researchContext, config);
    const outputPath = hazardsOutputPath(target);
    const sidecar = withSidecarMetadata(record, {
      kind: 'hazards',
      scope: 'property',
      subject: target,
      subjectKey: subjectKeyForTarget(target),
      expiresAt: expiresInDays(180, record.generatedAt),
      sourceUrls: (record.sourceCoverage ?? []).map((entry) => entry.url).filter(Boolean),
      status: record.status,
      warnings: record.warnings ?? [],
    });
    sidecar.confidence = coverageConfidence(record.sourceCoverage);
    await writeFile(outputPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
    recordArtifact({
      path: outputPath,
      kind: 'hazards',
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
    records.push(sidecar);
  }

  if (config.json) {
    console.log(JSON.stringify({ count: records.length, records }, null, 2));
    return;
  }
  printSummary(records);
}

const isDirectEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectEntry) {
  run().catch((error) => { console.error(`Fatal: ${error.message}`); process.exit(1); });
}

export { parseArgs as parseSiteHazardsArgs };
