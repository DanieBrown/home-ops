#!/usr/bin/env node

/**
 * access-check.mjs -- Per-home road adjacency, traffic volume, drive times,
 * and the guided-link dimensions. Writes one sidecar per home to
 * output/access/{slug}.json.
 *
 * This is the source behind the "major road adjacency" cap in modes/_shared.md.
 * That rule previously fired on a regex over listing copy, so a home 80 m from
 * a 40,000-vehicle arterial scored the same as one on a cul-de-sac whenever
 * the listing text stayed quiet. Here it is a named route, a count, and a
 * distance, measured against thresholds the buyer sets in config/profile.yml.
 *
 * Drive times run through the user's established hosted browser session
 * (--profile chrome-host), the same CDP session community-lookup.mjs and
 * sentiment-browser-extract.mjs use. When a duration cannot be read the map
 * link is still emitted and the dimension is recorded blocked -- never guessed.
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { readSessionState } from '../browser/browser-session.mjs';
import { ROOT } from '../shared/paths.mjs';
import { slugify } from '../shared/text-utils.mjs';
import { ensureGeocode } from './geocode.mjs';
import { arcgisQuery, loadResearchConfig, parseReport, parseShortlist } from './research-utils.mjs';
import {
  SOURCES,
  buildAccessRecord,
  buildDriveTimes,
  buildRedistrictingGuide,
  buildSexOffenderGuide,
  mapsDirectionsUrl,
  parseDurationMinutes,
  parseRoadAccess,
  resolveThresholds,
} from './access-core.mjs';
import { coverageConfidence } from './source-coverage.mjs';
import { expiresInDays, recordArtifact, subjectKeyForTarget, withSidecarMetadata } from '../shared/knowledge-store.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'access');
const DEFAULT_PROFILE = 'chrome-host';
const SEGMENT_RADIUS_METERS = 800;
const PAGE_TIMEOUT_MS = 45000;
const DURATION_TIMEOUT_MS = 20000;

const HELP_TEXT = `Usage:
  node access-check.mjs reports/001-foo.md [--profile chrome-host]
  node access-check.mjs --shortlist [--profile chrome-host]
  node access-check.mjs --top3

Captures the access dimensions for each home into output/access/{slug}.json:

  Road         Nearest NCDOT AADT count station -- route name, annual average
               daily traffic, survey year, and distance -- plus the highest
               AADT segment nearby. Busy-road exposure is judged against
               access.busy_road_aadt / access.busy_road_distance_meters in
               config/profile.yml, not against listing wording.
  Drive times  One measured driving duration per config/profile.yml
               commute.destinations entry, read from the hosted browser
               session. Map links are always emitted; unreadable durations are
               recorded blocked rather than estimated.
  Guided       Sex-offender proximity and school-redistricting risk: official
               link plus how to check this home. Neither source is scraped --
               the NC SBI registry has no public API and its acceptable-use
               policy rules out automated retrieval.

Options:
  --shortlist       Use the current Top 10 cohort from data/shortlist.md.
  --top3            Use the refined Top 3 from data/shortlist.md.
  --profile <name>  Hosted browser profile for drive times (default ${DEFAULT_PROFILE}).
  --no-drive-times  Skip the browser entirely; emit map links only.
  --no-network      Skip every live query; record each source as blocked.
  --json            Print JSON instead of human-readable text.
  --help, -h        Show this help text.
`;

function parseArgs(argv) {
  const config = {
    shortlist: false, top3: false, json: false, help: false,
    noNetwork: false, noDriveTimes: false, profileName: DEFAULT_PROFILE, files: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--no-network') { config.noNetwork = true; continue; }
    if (arg === '--no-drive-times') { config.noDriveTimes = true; continue; }
    if (arg === '--profile') { config.profileName = argv[i + 1] ?? DEFAULT_PROFILE; i += 1; continue; }
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    config.files.push(arg);
  }
  return config;
}

export function accessOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'access-target';
  return join(OUTPUT_DIR, `${slug}.json`);
}

export function readAccessRecord(target) {
  const path = accessOutputPath(target);
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

function oneLineAddress(target) {
  return [target.address, target.city, target.state].filter(Boolean).join(', ');
}

/**
 * Reads the directions panel for one destination. Google renders the duration
 * as free text next to the route; the typical-traffic range, when present,
 * appears alongside it. Anything unreadable returns an error so the caller
 * records `blocked` instead of inventing a number.
 */
async function captureDriveTime(context, origin, destination) {
  const page = await context.newPage();
  try {
    await page.goto(mapsDirectionsUrl(origin, destination.address ?? destination.name), {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });

    const durationLocator = page.locator('#section-directions-trip-0, div[id^="section-directions-trip-"]').first();
    await durationLocator.waitFor({ state: 'visible', timeout: DURATION_TIMEOUT_MS });
    const panelText = (await durationLocator.innerText()).replace(/\s+/g, ' ').trim();

    const freeFlowMinutes = parseDurationMinutes(panelText);
    if (!Number.isFinite(freeFlowMinutes)) {
      return { name: destination.name, error: 'directions panel carried no readable duration' };
    }

    // "Typically 25 - 45 min" appears when Google has traffic history.
    const rangeMatch = /typically\s+([\d]+\s*(?:hr|min)[^,;]*?)\s*[-–]\s*([\d]+\s*(?:hr|min)[^,;]*)/i.exec(panelText);
    const peakMinutes = rangeMatch ? parseDurationMinutes(rangeMatch[2]) : null;

    return {
      name: destination.name,
      freeFlowMinutes,
      peakMinutes: Number.isFinite(peakMinutes) ? peakMinutes : null,
      typicalRange: rangeMatch ? `${rangeMatch[1].trim()} – ${rangeMatch[2].trim()}` : null,
    };
  } catch (error) {
    return { name: destination.name, error: String(error?.message ?? error).split('\n')[0] };
  } finally {
    await page.close().catch(() => {});
  }
}

async function captureAllDriveTimes(destinations, origin, config) {
  if (destinations.length === 0) return { captures: [], browserError: null };
  if (config.noDriveTimes || config.noNetwork) {
    return {
      captures: destinations.map((d) => ({ name: d.name, error: config.noNetwork ? '--no-network was set' : '--no-drive-times was set' })),
      browserError: null,
    };
  }

  let browser = null;
  try {
    const session = readSessionState(config.profileName);
    if (!session?.cdpUrl) throw new Error(`No hosted session for profile "${config.profileName}". Run /home-ops init first.`);
    browser = await chromium.connectOverCDP(session.cdpUrl, { timeout: 30000, isLocal: true });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Hosted browser session exposed no default context.');

    const captures = [];
    for (const destination of destinations) {
      captures.push(await captureDriveTime(context, origin, destination));
    }
    return { captures, browserError: null };
  } catch (error) {
    const message = String(error?.message ?? error).split('\n')[0];
    return {
      captures: destinations.map((d) => ({ name: d.name, error: message })),
      browserError: message,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function checkTarget(target, researchContext, config) {
  const profile = researchContext.profile ?? {};
  const thresholds = resolveThresholds(profile);
  const destinations = (profile.commute?.destinations ?? []).filter((entry) => entry?.name);

  const geocodeRecord = config.noNetwork ? null : await ensureGeocode(target).catch(() => null);
  const point = geocodeRecord?.status === 'ok' && Number.isFinite(geocodeRecord.lat)
    ? { lat: geocodeRecord.lat, lng: geocodeRecord.lng }
    : null;

  const blocked = (reason) => ({ ok: false, error: reason, features: [] });
  const reason = config.noNetwork
    ? '--no-network was set'
    : `Address could not be geocoded (${geocodeRecord?.error ?? geocodeRecord?.status ?? 'no result'})`;

  const [stationsResponse, segmentsResponse] = point
    ? await Promise.all([
      arcgisQuery(SOURCES.aadtStations.url, {
        point,
        radiusMeters: thresholds.aadtSearchRadiusMeters,
        returnGeometry: true,
        resultRecordCount: 30,
      }),
      arcgisQuery(SOURCES.aadtSegments.url, { point, radiusMeters: SEGMENT_RADIUS_METERS, resultRecordCount: 20 }),
    ])
    : [blocked(reason), blocked(reason)];

  const road = parseRoadAccess(stationsResponse, segmentsResponse, point ?? { lat: null, lng: null }, thresholds);

  const { captures } = await captureAllDriveTimes(destinations, oneLineAddress(target), config);
  const driveTimes = buildDriveTimes(destinations, captures, { origin: oneLineAddress(target) });

  return buildAccessRecord({
    target,
    geocode: geocodeRecord,
    road,
    driveTimes,
    sexOffender: buildSexOffenderGuide(target),
    redistricting: buildRedistrictingGuide(target),
  });
}

function printSummary(records) {
  console.log('\nAccess: roads, traffic, and drive times\n');
  for (const record of records) {
    console.log(`${record.address} | ${record.city}, ${record.state}`);
    for (const dim of Object.values(record.dimensions ?? {})) {
      const value = dim.provenance === 'captured' ? dim.value : `(${dim.provenance})`;
      console.log(`  ${dim.label.padEnd(24)} ${value}${dim.detail ? ` — ${dim.detail}` : ''}`);
    }
    if (record.busyRoadExposure) {
      console.log(`  Busy-road exposure:      ${record.busyRoadExposure.exposed ? 'YES' : 'no'}`);
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
    const outputPath = accessOutputPath(target);
    const sidecar = withSidecarMetadata(record, {
      kind: 'access',
      scope: 'property',
      subject: target,
      subjectKey: subjectKeyForTarget(target),
      expiresAt: expiresInDays(90, record.generatedAt),
      sourceUrls: (record.sourceCoverage ?? []).map((entry) => entry.url).filter(Boolean),
      status: record.status,
      // withSidecarMetadata already merges record.warnings; passing them again duplicates each line.
      warnings: [],
    });
    sidecar.confidence = coverageConfidence(record.sourceCoverage);
    await writeFile(outputPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
    recordArtifact({
      path: outputPath,
      kind: 'access',
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

export { parseArgs as parseAccessArgs };
