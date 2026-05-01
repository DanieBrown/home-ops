#!/usr/bin/env node

/**
 * briefing-pdf.mjs -- Renders a top-3 finalist briefing PDF for the current
 * refined shortlist and opens it as a new tab inside the hosted Chrome
 * session. One combined PDF with one page per finalist so the user can flip
 * through them quickly.
 *
 * HTML-to-PDF via Playwright's built-in page.pdf(), so no new npm deps. Tab
 * open uses the same CDP /json/new path that review-tabs already relies on.
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import { join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from 'playwright';
import YAML from 'yaml';
import { readSessionState } from '../browser/browser-session.mjs';
import { ROOT } from '../shared/paths.mjs';
import {
  parseReport,
  parseShortlist,
} from '../research/research-utils.mjs';
import { slugify } from '../shared/text-utils.mjs';

const DEFAULT_PROFILE = 'chrome-host';
const OUTPUT_DIR = join(ROOT, 'output', 'briefings');
const SENTIMENT_DIR = join(ROOT, 'output', 'sentiment');
const CONSTRUCTION_DIR = join(ROOT, 'output', 'construction');
const COMMUNITY_DIR = join(ROOT, 'output', 'communities');
const DEEP_PACKET_DIR = join(ROOT, 'output', 'deep-packets');
const SCHOOL_METADATA_DIR = join(ROOT, 'output', 'school-metadata');

const HELP_TEXT = `Usage:
  node briefing-pdf.mjs [--profile chrome-host] [--no-open]

Renders a one-file top-3 finalist briefing PDF under output/briefings/ using
the current refined top 3 from data/shortlist.md, then opens it in a new tab
inside the hosted Chrome session.

Options:
  --profile <name>  Hosted browser profile to reuse. Defaults to chrome-host.
  --no-open         Render the PDF but do not open it in hosted Chrome.
  --help            Show this help text.
`;

function parseArgs(argv) {
  const config = { profileName: DEFAULT_PROFILE, open: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--profile') { config.profileName = argv[index + 1] ?? DEFAULT_PROFILE; index += 1; continue; }
    if (arg === '--no-open') { config.open = false; continue; }
    // Silently accept (and ignore) flags that callers commonly pass but this script doesn't need
    if (arg === '--shortlist' || arg === '--top3') { continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
  }
  return config;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function findCompanionJson(target, dir) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'target';
  return readJsonIfExists(join(dir, `${slug}.json`));
}

function normalizeLocationField(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function companionMatchesReport(companion, report) {
  if (!companion || !report) return false;
  return normalizeLocationField(companion.address) === normalizeLocationField(report.address)
    && normalizeLocationField(companion.city) === normalizeLocationField(report.city)
    && normalizeLocationField(companion.state || 'NC') === normalizeLocationField(report.state || 'NC');
}

function loadCompanionForReport(report, dir, label) {
  const payload = findCompanionJson(report, dir);
  if (!payload) {
    return { data: null, mismatch: false, mismatchMessage: '' };
  }

  if (companionMatchesReport(payload, report)) {
    return { data: payload, mismatch: false, mismatchMessage: '' };
  }

  return {
    data: null,
    mismatch: true,
    mismatchMessage: `${label} capture exists but does not match this report address; ignored for safety.`,
  };
}

function summarizeSection(sectionText, maxLength = 900) {
  if (!sectionText) return '';
  const compact = sectionText.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}\u2026`;
}

function extractBullets(sectionText, maxItems = 5) {
  if (!sectionText) return [];
  const bullets = [];
  for (const line of sectionText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      bullets.push(trimmed.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''));
      if (bullets.length >= maxItems) break;
    }
  }
  return bullets;
}

function loadBuyerProfile() {
  const profilePath = join(ROOT, 'config', 'profile.yml');
  if (!existsSync(profilePath)) return null;
  try {
    return YAML.parse(readFileSync(profilePath, 'utf8')) ?? null;
  } catch {
    return null;
  }
}

function parseDollarAmount(raw) {
  const text = String(raw ?? '').toLowerCase();
  if (!text || text === 'not recorded' || text.includes('n/a')) return null;
  if (text.includes('none') || text.includes('no hoa')) return 0;
  const match = text.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)\s*(k|m)?/i);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = (match[2] ?? '').toLowerCase();
  if (suffix === 'k') return value * 1000;
  if (suffix === 'm') return value * 1_000_000;
  return value;
}

function parseBedsNumber(raw) {
  const text = String(raw ?? '');

  // Prefer explicit "N bed" phrasing so "Hoke Elementary 8/10" style strings
  // that leaked into Beds/Baths never get mistaken for a bed count.
  const explicit = text.match(/(\d+)\s*(?:bed|bd|br)/i);
  if (explicit) {
    const beds = Number.parseInt(explicit[1], 10);
    return Number.isFinite(beds) ? beds : null;
  }

  const match = text.match(/(\d+)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const beds = Number.parseInt(match[1], 10);
  const baths = Number.parseFloat(match[2]);
  // Sanity guard per modes/_shared.md -- plausible residential ranges are
  // beds 1-7 and baths 1-8; anything outside that is almost certainly a
  // parsing mistake (school rating, mislabeled field, etc.).
  if (!Number.isFinite(beds) || beds < 1 || beds > 7) return null;
  if (!Number.isFinite(baths) || baths < 1 || baths > 8) return null;
  return beds;
}

function parseSqftNumber(raw) {
  const cleaned = String(raw ?? '').replace(/,/g, '');
  const match = cleaned.match(/(\d{3,6})/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseYearNumber(raw) {
  const match = String(raw ?? '').match(/(19|20)\d{2}/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `$${Math.round(value / 1000)}k`;
  return `$${value.toLocaleString()}`;
}

function classifyFitStatus(report, profile) {
  if (!profile) return [];
  const hard = profile.search?.hard_requirements ?? {};
  const soft = profile.search?.soft_preferences ?? {};
  const dealBreakers = profile.search?.deal_breakers ?? [];
  const reportBlob = [
    report.sections['Quick Take'],
    report.sections['Property Fit'],
    report.sections['Neighborhood Sentiment'],
    report.sections['Risks and Open Questions'],
    report.sections['Hard Requirement Gate'],
  ].filter(Boolean).join(' \n ').toLowerCase();

  const items = [];
  const price = parseDollarAmount(report.metadata.price);
  if (Number.isFinite(price) && (hard.price_min || hard.price_max)) {
    const min = hard.price_min;
    const max = hard.price_max;
    if (Number.isFinite(max) && price > max) {
      items.push({ status: 'gap', label: `Price ${formatMoney(price)} is above the ${formatMoney(max)} max` });
    } else if (Number.isFinite(min) && price < min) {
      items.push({ status: 'gap', label: `Price ${formatMoney(price)} is below the ${formatMoney(min)} target floor` });
    } else {
      items.push({ status: 'match', label: `Priced at ${formatMoney(price)} -- inside your ${formatMoney(min ?? 0)}-${formatMoney(max ?? 0)} range` });
    }
  }

  const beds = parseBedsNumber(report.metadata.bedsBaths);
  if (Number.isFinite(beds) && Number.isFinite(hard.beds_min)) {
    if (beds < hard.beds_min) {
      items.push({ status: 'gap', label: `Only ${beds} bedroom${beds === 1 ? '' : 's'} -- you need at least ${hard.beds_min}` });
    } else {
      items.push({ status: 'match', label: `${beds} bedrooms clears your ${hard.beds_min}+ minimum` });
    }
  }

  const sqft = parseSqftNumber(report.metadata.sqft);
  if (Number.isFinite(sqft) && Number.isFinite(hard.sqft_min)) {
    if (sqft < hard.sqft_min) {
      items.push({ status: 'gap', label: `${sqft.toLocaleString()} sqft is under your ${hard.sqft_min.toLocaleString()} minimum` });
    } else {
      items.push({ status: 'match', label: `${sqft.toLocaleString()} sqft clears your ${hard.sqft_min.toLocaleString()} floor` });
    }
  }

  const year = parseYearNumber(report.metadata.yearBuilt);
  if (Number.isFinite(year)) {
    const resalePreferred = String(hard.home_type_preference ?? '').toLowerCase().includes('resale');
    if (resalePreferred && year >= 2023) {
      items.push({ status: 'gap', label: `Built ${year} -- leans new-construction, which you prefer to avoid` });
    } else if (Number.isFinite(soft.year_built_min) && year < soft.year_built_min) {
      items.push({ status: 'gap', label: `Built ${year} is older than your ${soft.year_built_min}+ soft preference` });
    } else {
      items.push({ status: 'match', label: `Built ${year} -- fits your year-built preference` });
    }
  }

  const hoa = parseDollarAmount(report.metadata.hoa);
  if (Number.isFinite(hoa) && Number.isFinite(soft.hoa_max_monthly)) {
    if (hoa > soft.hoa_max_monthly) {
      items.push({ status: 'gap', label: `HOA ${formatMoney(hoa)}/mo is above your ${formatMoney(soft.hoa_max_monthly)}/mo cap` });
    } else {
      items.push({ status: 'match', label: `HOA ${formatMoney(hoa)}/mo is inside your ${formatMoney(soft.hoa_max_monthly)}/mo cap` });
    }
  }

  const garageMatch = reportBlob.match(/(\d)\s*[- ]?car\s*garage/);
  if (garageMatch && Number.isFinite(hard.garage_min)) {
    const garage = Number.parseInt(garageMatch[1], 10);
    if (garage < hard.garage_min) {
      items.push({ status: 'gap', label: `${garage}-car garage is short of your ${hard.garage_min}+ minimum` });
    } else {
      items.push({ status: 'match', label: `${garage}-car garage clears your ${hard.garage_min}+ minimum` });
    }
  }

  if (soft.fenced_yard && /fence/.test(reportBlob)) {
    items.push({ status: 'match', label: 'Fenced yard noted -- matches your family priority' });
  }

  const flaggedBreakers = dealBreakers
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean)
    .filter((entry) => {
      const needle = entry.toLowerCase();
      if (needle.includes('flood') && /flood/.test(reportBlob)) return true;
      if (needle.includes('busy road') && /(busy road|highway frontage|traffic noise)/.test(reportBlob)) return true;
      if (needle.includes('weak') && /(weak school|below.*rating|school concern)/.test(reportBlob)) return true;
      if (needle.includes('structural') && /(structural|foundation issue|major repair)/.test(reportBlob)) return true;
      return false;
    });

  for (const breaker of flaggedBreakers) {
    items.push({ status: 'gap', label: `Possible match against your deal-breaker: ${breaker}` });
  }

  return items;
}

function buildFitNarrative(report, profile) {
  const items = classifyFitStatus(report, profile);
  if (items.length === 0) return '';

  const rows = items.slice(0, 8).map((item) => `
    <li class="fit-row fit-${escapeHtml(item.status)}">
      <span class="fit-mark" aria-hidden="true">${item.status === 'match' ? '&#10003;' : '!'}</span>
      <span class="fit-label">${escapeHtml(item.label)}</span>
    </li>
  `).join('');

  return `
    <div class="card fit wide">
      <h3>Why this fits</h3>
      <ul class="fit-list">${rows}</ul>
    </div>
  `;
}

function buildGapList(report, finalist, profile) {
  const gaps = [];

  if (!finalist.construction) {
    gaps.push('Construction and road-project pressure has not been captured yet.');
  }
  if (!finalist.sentiment) {
    gaps.push('Neighborhood sentiment from Facebook and Nextdoor has not been pulled yet.');
  }
  if (finalist.sentimentMismatch) {
    gaps.push(finalist.sentimentMismatch);
  }
  if (finalist.constructionMismatch) {
    gaps.push(finalist.constructionMismatch);
  }
  if (finalist.packetMismatch) {
    gaps.push(finalist.packetMismatch);
  }

  const auditBlockers = finalist.packet?.audit?.criticalFindings ?? [];
  for (const finding of auditBlockers.slice(0, 4)) {
    gaps.push(`${finding.heading}: ${finding.message}`);
  }

  const confidence = String(report.metadata.confidence ?? '').toLowerCase();
  if (confidence.startsWith('low')) {
    gaps.push('Report confidence is Low -- several required facts are still missing.');
  }

  const hardGate = report.sections['Hard Requirement Gate'] ?? '';
  if (/unknown/i.test(hardGate)) {
    gaps.push('One or more hard requirements are marked Unknown on the gate table.');
  }

  if (profile?.search?.hard_requirements?.schools_min_rating && !/greatschools|niche|school rating/i.test(report.sections['School Review'] ?? '')) {
    gaps.push('Assigned-school ratings have not been cross-checked against an external source.');
  }

  return Array.from(new Set(gaps));
}

function classifyRecommendation(text) {
  const value = String(text || '').toLowerCase();
  if (!value || value === 'not recorded') return 'neutral';
  if (/(strong(ly)?\s+consider|proceed|pursue|recommend|buy|offer|tour)/.test(value)) return 'positive';
  if (/(skip|pass|reject|avoid|drop|do\s+not)/.test(value)) return 'negative';
  return 'neutral';
}

function buildMapsUrl(address, city, state) {
  const query = [address, city, state].filter(Boolean).join(', ');
  if (!query) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function buildDirectionsUrl(origin, destination) {
  if (!origin || !destination) return '';
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`;
}

function resolveCommuteDestinationAddress(dest) {
  if (!dest) return '';
  // Only render a destination when the user provided a real street-level
  // address (house number + street). Town-level defaults like "Downtown
  // Raleigh, NC" are not precise enough for a drive-time comparison to be
  // meaningful, so we skip them entirely.
  const addr = String(dest.address ?? '').trim();
  if (!addr) return '';
  if (!/^\d+\s+\S+/.test(addr)) return '';
  if (dest.state && !addr.toLowerCase().includes(String(dest.state).toLowerCase())) {
    return `${addr}, ${dest.state}`;
  }
  return addr;
}

function resolveCommuteDestinationLabel(dest) {
  if (!dest) return 'Commute destination';
  if (dest.label) return dest.label;
  if (dest.county) return `${dest.county} County`;
  return dest.name ?? 'Commute destination';
}

function buildCommuteCard(report, profile) {
  const destinations = profile?.commute?.destinations ?? [];
  if (!Array.isArray(destinations) || destinations.length === 0) return '';
  const origin = [report.address, report.city, report.state].filter(Boolean).join(', ');
  // Only render destinations that have a resolvable address. Entries where
  // the user left the address blank are skipped entirely.
  const renderable = destinations
    .map((dest) => ({ dest, destAddress: resolveCommuteDestinationAddress(dest) }))
    .filter(({ destAddress }) => destAddress && destAddress.length > 0);
  if (renderable.length === 0) return '';
  const rows = renderable.map(({ dest, destAddress }) => {
    const label = escapeHtml(resolveCommuteDestinationLabel(dest));
    const priority = dest.priority ? `<span class="subtle">${escapeHtml(dest.priority)}</span>` : '';
    const directions = buildDirectionsUrl(origin, destAddress);
    const link = directions
      ? `<a class="pill-link" href="${escapeHtml(directions)}">Light-traffic drive &#8599;</a>`
      : '<span class="muted">N/A</span>';
    return `
      <li class="commute-row">
        <span class="commute-label">${label} ${priority}</span>
        ${link}
      </li>
    `;
  }).join('');
  return `
    <div class="card wide commute">
      <h3>Commute map links <span class="subtle">light traffic assumed</span></h3>
      <ul class="commute-list">${rows}</ul>
      <p class="muted">Each link opens Google Maps driving directions from the listing to the destination. Custom destinations that cannot be resolved will show N/A.</p>
    </div>
  `;
}

function finalistAnchor(rank) {
  return `finalist-${slugify(String(rank)) || 'n'}`;
}

function buildCoverToc(finalists) {
  const items = finalists.map((finalist) => {
    const rank = finalist.rank;
    const address = finalist.report.address;
    const city = finalist.report.city;
    const state = finalist.report.state;
    const score = finalist.report.metadata.overallScore || 'n/a';
    const recommendation = finalist.report.metadata.recommendation || 'Not recorded';
    const recClass = classifyRecommendation(recommendation);
    return `
      <li>
        <a href="#${finalistAnchor(rank)}" class="toc-row">
          <span class="toc-rank">#${escapeHtml(String(rank))}</span>
          <span class="toc-body">
            <span class="toc-address">${escapeHtml(address)}</span>
            <span class="toc-locality">${escapeHtml(city)}, ${escapeHtml(state)}</span>
          </span>
          <span class="toc-metrics">
            <span class="score-badge">${escapeHtml(score)}</span>
            <span class="rec-badge rec-${escapeHtml(recClass)}">${escapeHtml(recommendation)}</span>
          </span>
        </a>
      </li>`;
  }).join('');

  return `
    <div class="cover-toc">
      <h3>Finalists</h3>
      <ol>${items}</ol>
    </div>`;
}

function buildConstructionBlurb(construction) {
  if (!construction) {
    return `
      <div class="card wide construction unreviewed">
        <h3>Construction Pressure</h3>
        <p class="muted">Not yet captured. Flagged in the research gaps below so it can be filled in before you decide.</p>
      </div>`;
  }

  const reachableSources = (construction.sourcesChecked ?? []).filter((entry) => entry?.ok);
  const resourceList = reachableSources.length > 0
    ? `<ul class="resource-list">${reachableSources.map((entry) => `
        <li><a href="${escapeHtml(entry.url)}">${escapeHtml(entry.url)}</a></li>
      `).join('')}</ul>`
    : '<p class="muted">No resources were reachable during the last check.</p>';

  const level = String(construction.level || 'unknown').toLowerCase();
  const pressure = Number(construction.constructionPressure);
  const active = Number(construction.phaseTotals?.active ?? 0);
  const matches = Number(construction.matches?.length ?? 0);

  let findings;
  if (!construction.reviewed) {
    findings = 'the public project index pages were unreachable during this run, so the result is inconclusive rather than clear.';
  } else if (level === 'none' || (matches === 0 && pressure === 0)) {
    findings = 'no active or planned road projects appear to be near this home, so construction pressure looks minimal for now.';
  } else if (level === 'low') {
    findings = `there is some nearby project activity (${matches} snippet${matches === 1 ? '' : 's'} matched, ${active} active-phase hit${active === 1 ? '' : 's'}), but nothing that looks likely to meaningfully affect this home.`;
  } else if (level === 'moderate') {
    findings = `there is moderate construction activity in the surrounding area (${matches} snippet${matches === 1 ? '' : 's'} matched, ${active} active-phase hit${active === 1 ? '' : 's'}); worth checking whether any of those projects sit on your immediate commute or frontage.`;
  } else if (level === 'high') {
    findings = `there is heavy construction pressure in the surrounding area (${matches} snippet${matches === 1 ? '' : 's'} matched, ${active} active-phase hit${active === 1 ? '' : 's'}); read through the matched projects before deciding, since this is the kind of level that can affect traffic, noise, or resale.`;
  } else {
    findings = `the review was completed but returned no strong signal either way (${matches} snippet${matches === 1 ? '' : 's'} matched).`;
  }

  return `
    <div class="card wide construction">
      <h3>Construction Pressure</h3>
      <p>After reviewing the following resources:</p>
      ${resourceList}
      <p>${escapeHtml(findings.charAt(0).toUpperCase() + findings.slice(1))}</p>
    </div>`;
}

function buildTailoredConcerns(report, finalist) {
  const seen = new Set();
  const push = (value) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const key = text.slice(0, 90).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    concerns.push(text);
  };
  const concerns = [];

  for (const bullet of extractBullets(report.sections['Risks and Open Questions'], 6)) {
    push(bullet);
  }

  const construction = finalist?.construction;
  if (construction?.reviewed) {
    const level = String(construction.level || '').toLowerCase();
    const matches = Number(construction.matches?.length ?? 0);
    if (level === 'high' || level === 'moderate') {
      push(`${level === 'high' ? 'Heavy' : 'Moderate'} nearby road-project activity flagged on NCDOT (${matches} snippet${matches === 1 ? '' : 's'} matched) -- check frontage and commute impact.`);
    }
  }

  const sentiment = finalist?.sentiment;
  const topNegative = (sentiment?.kpiRollup ?? [])
    .filter((row) => Number(row.weightedScore) < 0)
    .sort((a, b) => Number(a.weightedScore) - Number(b.weightedScore))[0];
  if (topNegative) {
    push(`Neighborhood sentiment leans negative on ${String(topNegative.category).replace(/_/g, ' ')} (${topNegative.negativeHits} negative vs ${topNegative.positiveHits} positive mention${topNegative.positiveHits === 1 ? '' : 's'}).`);
  }

  const packetBlockers = finalist?.packet?.audit?.criticalFindings ?? [];
  for (const finding of packetBlockers.slice(0, 2)) {
    push(`${finding.heading}: ${finding.message}`);
  }

  const confidence = String(report.metadata.confidence ?? '').toLowerCase();
  if (confidence.startsWith('low')) {
    push('Report confidence is Low -- required facts are still missing.');
  }

  return concerns;
}

function buildSchoolRatings(report) {
  const sectionText = [
    report.sections['School Review'],
    report.sections['Summary Card'],
    report.sections['Hard Requirement Gate'],
  ].filter(Boolean).join('\n');
  if (!sectionText) return [];

  const regex = /([A-Z][A-Za-z0-9.'&-]*(?:\s+[A-Z][A-Za-z0-9.'&-]*)*\s+(?:Elementary|Middle|High|Academy|School))[^0-9]{0,30}?(\d{1,2})\s*\/\s*10/g;
  const seen = new Set();
  const ratings = [];
  for (const match of sectionText.matchAll(regex)) {
    const name = match[1].trim();
    const rating = Number.parseInt(match[2], 10);
    if (!Number.isFinite(rating) || rating < 0 || rating > 10) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ratings.push({ name, rating });
  }
  return ratings;
}

function loadSchoolMetadata(report) {
  const payload = findCompanionJson(report, SCHOOL_METADATA_DIR);
  if (!payload) return null;
  // Accept two shapes:
  //   - legacy top-level array: [{name, ...}, ...]
  //   - new object: { address, city, schools: [...] }
  // Slug-keyed file path already proves the file belongs to this report,
  // so the address check is only enforced on the object shape.
  if (Array.isArray(payload)) {
    return { schools: payload };
  }
  if (!companionMatchesReport(payload, report)) return null;
  return payload;
}

function formatEthnicityDistribution(distribution) {
  if (!distribution || typeof distribution !== 'object') return '--';
  const entries = Object.entries(distribution)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([group, value]) => {
      const label = group.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      const pct = typeof value === 'number' ? `${value}%` : escapeHtml(String(value));
      return `${escapeHtml(label)} ${pct}`;
    });
  return entries.length ? entries.join('<br>') : '--';
}

function formatSchoolField(value) {
  if (value === null || value === undefined || value === '') return '--';
  return escapeHtml(String(value));
}

function formatNicheGrade(nicheGrade) {
  if (!nicheGrade?.letter) return '--';
  const letter = escapeHtml(nicheGrade.letter);
  const colorMap = {
    'A+': '#15803d', A: '#16a34a', 'A-': '#22c55e',
    'B+': '#2563eb', B: '#3b82f6', 'B-': '#60a5fa',
    'C+': '#d97706', C: '#f59e0b', 'C-': '#fbbf24',
    'D+': '#dc2626', D: '#ef4444', 'D-': '#f87171',
    F: '#7f1d1d',
  };
  const color = colorMap[nicheGrade.letter] ?? '#6b7280';
  return `<span style="font-weight:700;color:${color}">${letter}</span>`;
}

function formatSubGrades(subGrades) {
  if (!subGrades) return '--';
  const labels = { academics: 'Acad', teachers: 'Tchr', diversity: 'Div', collegePrep: 'CP', clubs: 'Clubs', sports: 'Sprt', healthSafety: 'Safety' };
  const parts = Object.entries(subGrades)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${labels[k] ?? k}: ${v}`);
  return parts.length ? escapeHtml(parts.join(' · ')) : '--';
}

function buildSchoolsCard(report) {
  const metadata = loadSchoolMetadata(report);

  if (metadata && Array.isArray(metadata.schools) && metadata.schools.length > 0) {
    const rows = metadata.schools.map((school) => {
      const nameCell = school.url
        ? `<a href="${escapeHtml(school.url)}">${escapeHtml(school.name ?? '--')}</a>`
        : formatSchoolField(school.name);
      const profMath = school.percentProficient?.math != null ? `${school.percentProficient.math}%` : '--';
      const profReading = school.percentProficient?.reading != null ? `${school.percentProficient.reading}%` : '--';
      const frl = school.freeReducedLunchPct != null ? `${school.freeReducedLunchPct}%` : '--';
      return `
        <tr>
          <td>${nameCell}</td>
          <td>${formatSchoolField(school.gradeLevel)}</td>
          <td class="num">${formatNicheGrade(school.nicheGrade)}</td>
          <td class="num" style="font-size:0.72em">${formatSubGrades(school.subGrades)}</td>
          <td class="num">${formatSchoolField(school.enrollment)}</td>
          <td class="num">${formatSchoolField(school.studentTeacherRatio)}</td>
          <td class="num">${frl}</td>
          <td class="num">${profMath} / ${profReading}</td>
          <td>${formatEthnicityDistribution(school.ethnicityDistribution)}</td>
        </tr>`;
    }).join('');

    return `
      <div class="card wide schools">
        <h3>Schools &amp; Metadata <span class="muted" style="font-size:0.8em;font-weight:400">via Niche.com</span></h3>
        <table class="school-metadata">
          <thead>
            <tr>
              <th>School</th>
              <th>Level</th>
              <th class="num">Grade</th>
              <th class="num">Sub-grades</th>
              <th class="num">Enrollment</th>
              <th class="num">Stu/Tch</th>
              <th class="num">FRL%</th>
              <th class="num">Math/Read</th>
              <th>Ethnicity</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="muted">FRL% = Free/Reduced Lunch; Math/Read = % proficient; Sub-grades condensed from Niche category scores.</p>
      </div>`;
  }

  // Fallback: regex-extract ratings from the report when the metadata sidecar
  // has not been populated (e.g. the deep workers did not land their captures).
  const ratings = buildSchoolRatings(report);
  if (ratings.length === 0) return '';
  const rows = ratings.map((entry) => `
      <li class="school-row">
        <span class="school-name">${escapeHtml(entry.name)}</span>
        <span class="school-rating school-neutral">${escapeHtml(String(entry.rating))}/10</span>
      </li>`).join('');
  const footnote = '<p class="muted">Run the deep-mode school-metadata capture to populate the full table (Niche grades, enrollment, demographics).</p>';
  return `
    <div class="card wide schools">
      <h3>Schools &amp; Ratings</h3>
      <ul class="school-list">${rows}</ul>
      ${footnote}
    </div>`;
}

function buildFinalistSection(finalist, profile) {
  const report = finalist.report;
  const construction = finalist.construction;
  const sentiment = finalist.sentiment;
  const packet = finalist.packet;

  const scoreDisplay = report.metadata.overallScore || 'n/a';
  const recommendation = report.metadata.recommendation || 'Not recorded';
  const recClass = classifyRecommendation(recommendation);
  const url = report.metadata.url || '';
  const mapsUrl = buildMapsUrl(report.address, report.city, report.state);
  const anchor = finalistAnchor(finalist.rank);

  const addressHeading = url
    ? `<a href="${escapeHtml(url)}">${escapeHtml(report.address)}</a>`
    : escapeHtml(report.address);

  const linkRow = [];
  if (url) {
    linkRow.push(`<a class="pill-link" href="${escapeHtml(url)}">View listing &#8599;</a>`);
  }
  if (mapsUrl) {
    linkRow.push(`<a class="pill-link" href="${escapeHtml(mapsUrl)}">Open in Maps &#8599;</a>`);
  }
  const linkRowHtml = linkRow.length
    ? `<p class="pill-links">${linkRow.join(' ')}</p>`
    : '';

  const concerns = buildTailoredConcerns(report, finalist).slice(0, 4);
  const constructionBlock = buildConstructionBlurb(construction);

  const topKpi = (sentiment?.kpiRollup ?? []).slice(0, 5).map((row) => `
    <tr>
      <td>${escapeHtml(row.category)}</td>
      <td class="num">${escapeHtml(String(row.weight))}</td>
      <td class="num">${escapeHtml(String(row.positiveHits))}</td>
      <td class="num">${escapeHtml(String(row.negativeHits))}</td>
      <td class="num ${row.weightedScore < 0 ? 'neg' : 'pos'}">${escapeHtml(String(row.weightedScore))}</td>
    </tr>
  `).join('');

  const sentimentBlock = sentiment
    ? `
      <div class="card wide">
        <h3>Neighborhood Sentiment <span class="subtle">profile-weighted</span></h3>
        <table>
          <thead>
            <tr><th>Category</th><th class="num">Weight</th><th class="num">+ Mentions</th><th class="num">- Mentions</th><th class="num">Weighted</th></tr>
          </thead>
          <tbody>${topKpi || '<tr><td colspan="5" class="muted">No rollup captured.</td></tr>'}</tbody>
        </table>
      </div>`
    : `
      <div class="card wide unreviewed">
        <h3>Neighborhood Sentiment</h3>
        <p class="muted">Not yet captured from Facebook or Nextdoor. Listed in the research gaps below.</p>
      </div>`;

  const fitNarrative = buildFitNarrative(report, profile);
  const gapItems = buildGapList(report, finalist, profile);
  const gapBlock = gapItems.length > 0
    ? `
      <div class="card wide warn">
        <h3>Research gaps you may want filled in</h3>
        <ul>${gapItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        <p class="muted">Ask for a deeper dive on this listing to capture these before a final decision.</p>
      </div>`
    : '';

  return `
    <section class="finalist" id="${anchor}">
      <header class="finalist-header">
        <div class="rank-badge">#${escapeHtml(String(finalist.rank))}</div>
        <div class="finalist-title">
          <h2>${addressHeading}</h2>
          <p class="locality">${escapeHtml(report.city)}, ${escapeHtml(report.state)}${finalist.community ? ` <span class="community-tag">&middot; ${escapeHtml(finalist.community)} community</span>` : ''}</p>
          <div class="badges">
            <span class="score-badge">Score ${escapeHtml(scoreDisplay)}</span>
            <span class="rec-badge rec-${escapeHtml(recClass)}">${escapeHtml(recommendation)}</span>
          </div>
          ${linkRowHtml}
        </div>
      </header>

      <div class="grid">
        <div class="card quick-take wide">
          <h3>Quick Take</h3>
          <p>${escapeHtml(summarizeSection(report.sections['Quick Take'], 600))}</p>
        </div>
        ${fitNarrative}
        <div class="card concerns wide">
          <h3>Top Concerns</h3>
          <ul>${(concerns.length ? concerns : ['(none captured)']).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
        </div>
        ${constructionBlock}
        ${buildSchoolsCard(report)}
        ${sentimentBlock}
        ${buildCommuteCard(report, profile)}
        ${gapBlock}
      </div>
    </section>
  `;
}

function buildHtml(finalists, profile) {
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const finalistSections = finalists.map((finalist) => buildFinalistSection(finalist, profile)).join('\n');
  const toc = buildCoverToc(finalists);
  const buyerLabel = profile?.buyer?.full_name ? ` &middot; Prepared for ${escapeHtml(profile.buyer.full_name)}` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Home-Ops Top 3 Finalist Briefing</title>
<style>
  @page { size: Letter; margin: 0.5in; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    color: #1f2937;
    margin: 0;
    font-size: 10pt;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  a { color: #1d4ed8; text-decoration: none; }
  p { margin: 0 0 6px; }
  h1, h2, h3 { margin: 0; color: #111827; }

  /* Cover */
  .cover { page-break-after: always; padding: 36px 8px 0; }
  .cover .brand {
    font-size: 9pt; letter-spacing: 0.25em; color: #6b7280;
    font-weight: 700; text-transform: uppercase; margin-bottom: 10px;
  }
  .cover h1 {
    font-size: 30pt; font-weight: 800; color: #0f172a;
    letter-spacing: -0.02em; margin-bottom: 6px;
  }
  .cover .cover-meta { font-size: 10pt; color: #6b7280; margin-bottom: 28px; }
  .cover-toc h3 {
    font-size: 9pt; letter-spacing: 0.12em; color: #6b7280;
    text-transform: uppercase; font-weight: 700;
    border-top: 2px solid #0f172a; padding-top: 14px; margin-bottom: 14px;
  }
  .cover-toc ol { list-style: none; padding: 0; margin: 0; }
  .cover-toc li { margin-bottom: 10px; }
  .toc-row {
    display: flex; align-items: center; gap: 14px;
    padding: 12px 14px; border: 1px solid #e5e7eb; border-radius: 10px;
    color: #1f2937; background: #ffffff;
    page-break-inside: avoid;
  }
  .toc-rank {
    font-size: 18pt; font-weight: 800; color: #1d4ed8;
    min-width: 44px; flex-shrink: 0;
  }
  .toc-body { flex: 1; min-width: 0; }
  .toc-address { display: block; font-weight: 600; font-size: 11.5pt; color: #0f172a; }
  .toc-locality { display: block; font-size: 9pt; color: #6b7280; margin-top: 2px; }
  .toc-metrics { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
  .cover-legend {
    margin-top: 32px; font-size: 9pt; color: #6b7280;
    border-left: 3px solid #e5e7eb; padding: 2px 0 2px 12px;
  }
  .cover-legend p { margin-bottom: 6px; }

  /* Finalist page */
  .finalist { page-break-before: always; padding: 8px 0 0; }
  .finalist:first-of-type { page-break-before: auto; }
  .finalist-header {
    display: flex; gap: 18px; align-items: flex-start;
    border-bottom: 2px solid #0f172a; padding-bottom: 14px; margin-bottom: 16px;
  }
  .rank-badge {
    width: 58px; height: 58px; border-radius: 12px;
    background: linear-gradient(135deg, #1d4ed8 0%, #312e81 100%);
    color: #ffffff; font-size: 20pt; font-weight: 800;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; letter-spacing: -0.02em;
  }
  .finalist-title { flex: 1; min-width: 0; }
  .finalist-title h2 {
    font-size: 17pt; font-weight: 700; margin-bottom: 4px;
    letter-spacing: -0.01em;
  }
  .finalist-title h2 a { color: #0f172a; }
  .locality { color: #6b7280; font-size: 10pt; margin-bottom: 10px; }
  .community-tag { color: #4f46e5; font-weight: 500; }
  .badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .score-badge {
    padding: 3px 10px; border-radius: 999px; font-size: 9pt;
    font-weight: 700; background: #eef2ff; color: #3730a3;
  }
  .rec-badge {
    padding: 3px 10px; border-radius: 999px; font-size: 9pt;
    font-weight: 600;
  }
  .rec-positive { background: #dcfce7; color: #166534; }
  .rec-neutral  { background: #fef3c7; color: #92400e; }
  .rec-negative { background: #fee2e2; color: #991b1b; }
  .pill-links { margin: 0; font-size: 9pt; }
  .pill-link {
    display: inline-block; padding: 2px 10px; margin-right: 6px;
    border: 1px solid #c7d2fe; border-radius: 999px;
    background: #eef2ff; color: #1d4ed8; font-weight: 600;
  }

  /* Grid and cards */
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .card {
    border: 1px solid #e5e7eb; border-radius: 10px;
    padding: 12px 14px; background: #ffffff;
    page-break-inside: avoid;
  }
  .card.wide { grid-column: span 2; }
  .card h3 {
    font-size: 9pt; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: #6b7280; margin-bottom: 8px;
  }
  .card h3 .subtle {
    font-size: 8pt; font-weight: 500; color: #9ca3af;
    text-transform: none; letter-spacing: 0; margin-left: 4px;
  }
  .card p { font-size: 9.5pt; margin-bottom: 4px; }
  .card ul { margin: 0; padding-left: 18px; font-size: 9.5pt; }
  .card li { margin-bottom: 4px; }

  .card.quick-take { background: #f0f9ff; border-color: #bae6fd; }
  .card.quick-take h3 { color: #0369a1; }
  .card.strengths h3 { color: #166534; }
  .card.concerns h3 { color: #991b1b; }

  .card.construction { text-align: center; }
  .pressure-level {
    font-size: 16pt; font-weight: 800; margin: 4px 0 8px;
    letter-spacing: 0.03em;
  }
  .pressure-level.high { color: #b91c1c; }
  .pressure-level.moderate { color: #b45309; }
  .pressure-level.low { color: #166534; }
  .pressure-level.none, .pressure-level.unknown { color: #6b7280; }

  .card.warn { background: #fffbeb; border-color: #fde68a; }
  .card.warn h3 { color: #92400e; }
  .card.recommendation {
    background: linear-gradient(135deg, #f8fafc 0%, #eef2ff 100%);
    border-color: #c7d2fe;
  }
  .card.recommendation h3 { color: #3730a3; }

  .stat { font-size: 9.5pt; color: #4b5563; margin-bottom: 2px; }
  .stat strong { color: #111827; }
  .muted { color: #9ca3af; font-size: 8.5pt; }

  /* Fit narrative */
  .card.fit {
    background: linear-gradient(135deg, #ecfdf5 0%, #f0f9ff 100%);
    border-color: #bbf7d0;
  }
  .card.fit h3 { color: #166534; }
  .fit-list { list-style: none; padding: 0; margin: 0; }
  .fit-row {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 4px 0; font-size: 9.5pt;
    border-bottom: 1px dashed #e5e7eb;
  }
  .fit-row:last-child { border-bottom: 0; }
  .fit-mark {
    flex-shrink: 0; width: 18px; height: 18px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 10pt; font-weight: 800; color: #ffffff;
  }
  .fit-match .fit-mark { background: #16a34a; }
  .fit-gap .fit-mark { background: #dc2626; }
  .fit-unknown .fit-mark { background: #9ca3af; }
  .fit-label { color: #1f2937; line-height: 1.4; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  th {
    text-align: left; padding: 6px 8px;
    background: #f3f4f6; color: #4b5563;
    font-weight: 600; text-transform: uppercase;
    font-size: 8pt; letter-spacing: 0.05em;
    border-bottom: 1px solid #e5e7eb;
  }
  td { padding: 6px 8px; border-bottom: 1px solid #f3f4f6; }
  tbody tr:last-child td { border-bottom: 0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .pos { color: #166534; font-weight: 600; }
  .neg { color: #991b1b; font-weight: 600; }

  .card.unreviewed { background: #f9fafb; border-style: dashed; color: #6b7280; }
  .card.unreviewed h3 { color: #9ca3af; }

  .card.construction p { font-size: 9.5pt; color: #1f2937; }
  .card.construction .resource-list {
    list-style: none; padding: 6px 0 6px 0; margin: 0 0 6px;
    border-top: 1px dashed #e5e7eb; border-bottom: 1px dashed #e5e7eb;
  }
  .card.construction .resource-list li {
    font-size: 8.5pt; padding: 2px 0; word-break: break-all;
    color: #4b5563;
  }
  .card.construction .resource-list a { color: #1d4ed8; }

  .card.schools h3 { color: #0369a1; }
  .school-list { list-style: none; padding: 0; margin: 0; }
  .school-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; padding: 5px 0; font-size: 9.5pt;
    border-bottom: 1px dashed #e5e7eb;
  }
  .school-row:last-child { border-bottom: 0; }
  .school-name { color: #1f2937; font-weight: 500; }
  .school-rating {
    padding: 2px 10px; border-radius: 999px; font-size: 9pt;
    font-weight: 700;
  }
  .school-pass { background: #dcfce7; color: #166534; }
  .school-fail { background: #fee2e2; color: #991b1b; }
  .school-neutral { background: #eef2ff; color: #3730a3; }

  .school-metadata { width: 100%; font-size: 8.5pt; }
  .school-metadata th { font-size: 8pt; color: #475569; text-transform: uppercase; letter-spacing: 0.03em; }
  .school-metadata td { vertical-align: top; padding: 4px 6px; }
  .school-metadata td a { color: #1d4ed8; text-decoration: none; }
  .school-metadata .school-rating { display: inline-block; min-width: 24px; text-align: center; }

  .card.commute h3 { color: #0369a1; }
  .commute-list { list-style: none; padding: 0; margin: 0; }
  .commute-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; padding: 6px 0; font-size: 9.5pt;
    border-bottom: 1px dashed #e5e7eb;
  }
  .commute-row:last-child { border-bottom: 0; }
  .commute-label { color: #1f2937; font-weight: 500; }
  .commute-label .subtle {
    color: #9ca3af; font-size: 8.5pt; font-weight: 400; margin-left: 6px;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
</style>
</head>
<body>
  <section class="cover">
    <div class="brand">Home-Ops &middot; Decision Brief</div>
    <h1>Top 3 Finalist Briefing</h1>
    <p class="cover-meta">Generated ${escapeHtml(generatedAt)} UTC &middot; ${escapeHtml(String(finalists.length))} finalist${finalists.length === 1 ? '' : 's'}${buyerLabel}</p>
    ${toc}
    <div class="cover-legend">
      <p>Each page shows a quick take, a "why this fits" summary tied to your buyer profile, top concerns tailored to that listing, construction pressure, a schools metadata table (rating, enrollment, student/teacher ratio, ethnicity distribution), neighborhood sentiment, and any research gaps worth filling in.</p>
      <p>Anything marked <strong>Not yet captured</strong> is unknown, not favorable. Ask for a deeper dive to fill in the research gaps before a final decision. Tap a finalist above to jump to its page; listing links open directly in the browser.</p>
    </div>
  </section>
  ${finalistSections}
</body>
</html>`;
}

function loadFinalists() {
  const shortlist = parseShortlist(ROOT);
  if (!shortlist.refinedTop3 || shortlist.refinedTop3.length === 0) {
    throw new Error('No refined top-3 homes found in data/shortlist.md. Run deep mode before generating the briefing.');
  }

  return shortlist.refinedTop3.map((row, index) => {
    const report = parseReport(ROOT, row.reportPath);
    const constructionCompanion = loadCompanionForReport(report, CONSTRUCTION_DIR, 'Construction');
    const sentimentCompanion = loadCompanionForReport(report, SENTIMENT_DIR, 'Sentiment');
    const packetCompanion = loadCompanionForReport(report, DEEP_PACKET_DIR, 'Deep packet');
    const communityPayload = findCompanionJson(report, COMMUNITY_DIR);
    const community = communityPayload && communityPayload.community
      && communityPayload.status !== 'no-community-match'
      ? String(communityPayload.community).trim()
      : null;
    return {
      rank: row.rank || index + 1,
      report,
      construction: constructionCompanion.data,
      sentiment: sentimentCompanion.data,
      packet: packetCompanion.data,
      community,
      constructionMismatch: constructionCompanion.mismatchMessage,
      sentimentMismatch: sentimentCompanion.mismatchMessage,
      packetMismatch: packetCompanion.mismatchMessage,
    };
  });
}

async function renderPdf(html, outputPath) {
  // Use a plain chromium launch (not the hosted session) for rendering -- we
  // do not want to push a non-user page into the hosted browser just for PDF
  // generation. Then we open the rendered file:// URL in the hosted session.
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.pdf({
      path: outputPath,
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' },
    });
  } finally {
    await browser.close();
  }
}

async function openInHostedChrome(outputPath, profileName) {
  const session = await readSessionState(ROOT, profileName);
  if (!session?.data?.cdpUrl || session.data.status !== 'open' || session.data.mode !== 'hosted') {
    console.warn(`Hosted browser session "${profileName}" is not open; skipping tab open.`);
    console.warn(`PDF is available at: ${outputPath}`);
    return;
  }

  const reachable = await fetch(`${session.data.cdpUrl}/json/version`).then((r) => r.ok).catch(() => false);
  if (!reachable) {
    console.warn(`Hosted browser session "${profileName}" is not reachable over CDP; skipping tab open.`);
    return;
  }

  const fileUrl = pathToFileURL(outputPath).href;
  const encoded = encodeURIComponent(fileUrl);
  try {
    // PUT first (preferred by newer Chrome); fall back to GET on 405.
    let response = await fetch(`${session.data.cdpUrl}/json/new?${encoded}`, { method: 'PUT' });
    if (response.status === 405) {
      response = await fetch(`${session.data.cdpUrl}/json/new?${encoded}`);
    }
    if (!response.ok) {
      throw new Error(`CDP responded ${response.status} ${response.statusText}`);
    }
    console.log(`Opened briefing in hosted Chrome: ${fileUrl}`);
  } catch (error) {
    console.warn(`Could not open tab via CDP: ${error.message}`);
    console.warn(`PDF is available at: ${outputPath}`);
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
  if (config.help) { console.log(HELP_TEXT); return; }

  const finalists = loadFinalists();
  const profile = loadBuyerProfile();
  const html = buildHtml(finalists, profile);
  await mkdir(OUTPUT_DIR, { recursive: true });
  const dateStamp = new Date().toISOString().slice(0, 10);
  const outputPath = join(OUTPUT_DIR, `top3-briefing-${dateStamp}.pdf`);
  await renderPdf(html, outputPath);
  const relPath = relative(ROOT, outputPath).replace(/\\/g, '/');
  console.log(`Wrote briefing PDF: ${relPath}`);

  if (config.open) {
    await openInHostedChrome(outputPath, config.profileName);
  }
}

const isDirectEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectEntry) {
  run().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}
