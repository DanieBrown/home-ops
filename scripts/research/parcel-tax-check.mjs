#!/usr/bin/env node

/**
 * parcel-tax-check.mjs -- Per-home county parcel record. Writes one sidecar
 * per home to output/parcel/{slug}.json covering the parcel ID, deeded
 * acreage, assessed land and improvement value, last recorded sale, an
 * estimated annual tax, the zoning district, and a guided future-land-use
 * link.
 *
 * This is the source behind the "taxes" component of Financial Fit in
 * modes/_shared.md. Nothing in the repo captured a parcel, an assessment, or a
 * tax figure before this, so that part of the score had no input at all.
 *
 * Parcels are matched by street address, not by proximity: geocodes are
 * interpolated along street centerlines and routinely land on a neighbouring
 * parcel. A near miss is reported `unconfirmed` and consumed by nothing.
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { ROOT } from '../shared/paths.mjs';
import { slugify } from '../shared/text-utils.mjs';
import { ensureGeocode } from './geocode.mjs';
import { arcgisLiteral, arcgisQuery, loadResearchConfig, parseReport, parseShortlist, resolveAreaContext } from './research-utils.mjs';
import {
  buildAssessmentDimension,
  buildFutureLandUseGuide,
  buildParcelRecord,
  buildSaleHistoryDimension,
  buildTaxEstimate,
  parseParcel,
  parseZoning,
} from './parcel-tax-core.mjs';
import { coverageConfidence } from './source-coverage.mjs';
import { expiresInDays, recordArtifact, subjectKeyForTarget, withSidecarMetadata } from '../shared/knowledge-store.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'parcel');
const COUNTY_REGISTRY_PATH = join(ROOT, 'config', 'county-arcgis-registry.yml');
const TAX_RATES_PATH = join(ROOT, 'config', 'property-tax-rates.yml');
const DEVELOPMENT_SOURCES_PATH = join(ROOT, 'output', 'development-sources.json');

const PARCEL_SEARCH_RADIUS_METERS = 500;

const HELP_TEXT = `Usage:
  node parcel-tax-check.mjs reports/001-foo.md
  node parcel-tax-check.mjs --shortlist
  node parcel-tax-check.mjs --top3

Captures the county parcel record for each home into output/parcel/{slug}.json:

  Parcel       PIN/parcel ID, owner, deeded acreage, year built, heated area,
               and legal description from the county parcel layer.
  Assessment   Assessed total, land, and improvement value.
  Sale         Last recorded sale price and date.
  Tax          Estimated annual tax from the county + municipal rates in
               config/property-tax-rates.yml. An estimate, never a quote:
               special district levies are excluded and the county's own bill
               lookup is always emitted alongside it.
  Zoning       Zoning district from the jurisdiction's zoning layer.
  Land use     Guided link to the municipal future land use map; no
               designation is ever claimed from an unqueryable source.

Parcels are matched on street address. If no county row matches this home's
address the record stays unconfirmed and carries no figures -- a neighbouring
parcel's assessment is not this home's. A county with no registered parcel
layer reports unsupported.

Options:
  --shortlist       Use the current Top 10 cohort from data/shortlist.md.
  --top3            Use the refined Top 3 from data/shortlist.md.
  --no-network      Skip every live query; record each source as blocked.
  --json            Print JSON instead of human-readable text.
  --help, -h        Show this help text.
`;

function parseArgs(argv) {
  const config = { shortlist: false, top3: false, json: false, help: false, noNetwork: false, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--no-network') { config.noNetwork = true; continue; }
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    config.files.push(arg);
  }
  return config;
}

export function parcelOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'parcel-target';
  return join(OUTPUT_DIR, `${slug}.json`);
}

export function readParcelRecord(target) {
  const path = parcelOutputPath(target);
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
      try { targets.push(parseReport(ROOT, row.reportPath)); } catch { console.warn(`[warn] Skipping unreadable report: ${row.reportPath}`); }
    }
    if (targets.length === 0) throw new Error('No shortlist entries have readable reports.');
    return targets;
  }
  if (config.files.length === 0) throw new Error('Provide a report path, or use --shortlist / --top3.');
  return config.files.map((filePath) => parseReport(ROOT, filePath));
}

function readYamlIfExists(path) {
  if (!existsSync(path)) return {};
  try { return YAML.parse(readFileSync(path, 'utf8')) ?? {}; } catch { return {}; }
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function resolveZoningLayer(countyEntry, city) {
  const zoning = countyEntry?.zoningLayers;
  if (!zoning?.base) return { url: null, classField: 'CLASS', label: null };
  const key = String(city ?? '').toLowerCase().trim();
  const layerId = zoning.byJurisdiction?.[key] ?? zoning.countyFallback;
  if (layerId == null) return { url: null, classField: zoning.classField ?? 'CLASS', label: null };
  return {
    url: `${zoning.base}/${layerId}`,
    classField: zoning.classField ?? 'CLASS',
    label: zoning.byJurisdiction?.[key] != null ? city : 'County',
  };
}

/**
 * Address lookup first, spatial fallback second. The county's own address
 * column is far more reliable than an interpolated geocode -- see the module
 * header.
 */
async function queryParcel(layerConfig, target, point, config) {
  if (config.noNetwork) return { ok: false, error: '--no-network was set', features: [] };

  const addressField = layerConfig.addressField ?? 'SITE_ADDRESS';
  const byAddress = await arcgisQuery(layerConfig.url, {
    where: `UPPER(${addressField}) = UPPER(${arcgisLiteral(target.address)})`,
    resultRecordCount: 5,
    returnGeometry: true,
  });
  if (byAddress.ok && byAddress.features.length > 0) return byAddress;

  if (!point) return byAddress.ok ? { ok: true, features: [] } : byAddress;

  const spatial = await arcgisQuery(layerConfig.url, {
    point,
    radiusMeters: PARCEL_SEARCH_RADIUS_METERS,
    resultRecordCount: 40,
    returnGeometry: true,
  });
  // Surface the address-query error if both failed, since that is the primary path.
  if (!spatial.ok && !byAddress.ok) return byAddress;
  return spatial;
}

async function checkTarget(target, researchContext, config) {
  const registry = readYamlIfExists(COUNTY_REGISTRY_PATH);
  const rateConfig = readYamlIfExists(TAX_RATES_PATH);
  const developmentSources = readJsonIfExists(DEVELOPMENT_SOURCES_PATH);

  const areaContext = resolveAreaContext(target, researchContext);
  const county = areaContext.counties[0] ?? null;
  const countyKey = String(county ?? '').toLowerCase().replace(/\s+county$/, '').trim();
  const countyEntry = countyKey ? registry.counties?.[countyKey] : null;
  const layerConfig = countyEntry?.parcelLayer ?? null;

  const geocodeRecord = config.noNetwork ? null : await ensureGeocode(target).catch(() => null);
  const point = geocodeRecord?.status === 'ok' && Number.isFinite(geocodeRecord.lat)
    ? { lat: geocodeRecord.lat, lng: geocodeRecord.lng }
    : null;

  const parcelResponse = layerConfig ? await queryParcel(layerConfig, target, point, config) : null;
  const parcelResult = parseParcel(parcelResponse, target, { county: countyEntry?.label ?? county, layerConfig });

  // Prefer the matched parcel's own centroid over the interpolated geocode:
  // a street-centerline geocode can sit in the right-of-way or on the
  // neighbour's lot, which would read the wrong zoning district.
  const zoningPoint = parcelResult.matchedCentroid ?? point;
  const zoningLayer = resolveZoningLayer(countyEntry, target.city);
  const zoningResponse = zoningLayer.url && zoningPoint && !config.noNetwork
    ? await arcgisQuery(zoningLayer.url, { point: zoningPoint, resultRecordCount: 3 })
    : (zoningLayer.url ? { ok: false, error: zoningPoint ? '--no-network was set' : 'no coordinate available', features: [] } : null);
  const zoningResult = parseZoning(zoningResponse, {
    url: zoningLayer.url,
    classField: zoningLayer.classField,
    jurisdictionLabel: zoningLayer.label,
  });

  const tax = buildTaxEstimate(parcelResult.parcel, { county, city: target.city, rateConfig });
  const landUse = buildFutureLandUseGuide(developmentSources, { city: target.city });
  const parcelUrl = layerConfig?.url ?? null;

  const dimensions = {
    parcel: parcelResult.dimension,
    assessedValue: buildAssessmentDimension(parcelResult.parcel, { url: parcelUrl }),
    lastSale: buildSaleHistoryDimension(parcelResult.parcel, { url: parcelUrl }),
    estimatedTax: tax.dimension,
    zoning: zoningResult.dimension,
    futureLandUse: landUse.dimension,
  };

  const sourceCoverage = [parcelResult.coverage, tax.coverage, zoningResult.coverage, landUse.coverage].filter(Boolean);

  return buildParcelRecord({
    target,
    geocode: geocodeRecord,
    parcel: parcelResult.parcel,
    dimensions,
    sourceCoverage,
    extras: {
      county: countyEntry?.label ?? county,
      taxEstimate: {
        annual: tax.annualEstimate ?? null,
        combinedRate: tax.combinedRate ?? null,
        municipalRateFound: tax.municipalRateFound ?? false,
        fiscalYear: rateConfig.fiscalYear ?? null,
        isEstimate: true,
      },
      billLookup: tax.billLookup ?? null,
      futureLandUseGuide: landUse.guide ?? null,
    },
  });
}

function printSummary(records) {
  console.log('\nParcel, assessment, and tax\n');
  for (const record of records) {
    console.log(`${record.address} | ${record.city}, ${record.state}${record.county ? ` (${record.county})` : ''}`);
    for (const dim of Object.values(record.dimensions ?? {})) {
      const value = dim.provenance === 'captured' ? dim.value : `(${dim.provenance})`;
      console.log(`  ${dim.label.padEnd(22)} ${value}${dim.detail ? ` — ${dim.detail}` : ''}`);
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
    const record = await checkTarget(target, researchContext, config);
    const outputPath = parcelOutputPath(target);
    const sidecar = withSidecarMetadata(record, {
      kind: 'parcel',
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
      kind: 'parcel',
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

export { parseArgs as parseParcelTaxArgs };
