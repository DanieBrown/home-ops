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
const PERMITS_DIR = join(ROOT, 'output', 'permits');
const COMMUNITY_DIR = join(ROOT, 'output', 'communities');
const DEEP_PACKET_DIR = join(ROOT, 'output', 'deep-packets');
const BUILDER_DIR = join(ROOT, 'output', 'builder');
const SCHOOL_METADATA_DIR = join(ROOT, 'output', 'school-metadata');
const LISTING_DIR = join(ROOT, 'output', 'listings');

const HELP_TEXT = `Usage:
  node briefing-pdf.mjs [--profile chrome-host] [--no-open]
  node briefing-pdf.mjs --report reports/{N}-{slug}-{date}.md [--profile chrome-host] [--no-open]
  node briefing-pdf.mjs --reports reports/a-deep-{date}.md,reports/b-deep-{date}.md [--profile chrome-host] [--no-open]

Modes:
  batch    (default, no flag) renders a top-3 finalist briefing PDF under
           output/briefings/top3-briefing-{date}.pdf using the current refined
           top 3 from data/shortlist.md. Cover + TOC + rank badges.

  single   (--report <path>) renders a single-home briefing PDF under
           output/briefings/{slug}-deep-{date}.pdf using the canonical
           single-home report at <path>. No cover, no TOC, no rank badge.

  combined (--reports a.md,b.md,...) renders one combined PDF covering N
           homes from URL-based deep runs, output at
           output/briefings/url-deep-{date}.pdf. Cover lists all homes (no
           top-3 ranking); one section per home, no rank badge.

All modes open the PDF in a new tab inside the hosted Chrome session unless
--no-open is supplied.

Options:
  --profile <name>     Hosted browser profile to reuse. Defaults to chrome-host.
  --report <path>      Render a single-home briefing for the given deep report.
  --reports <paths>    Comma-separated deep reports for a combined URL-deep PDF.
  --no-open            Render the PDF but do not open it in hosted Chrome.
  --help               Show this help text.
`;

function parseArgs(argv) {
  const config = { profileName: DEFAULT_PROFILE, open: true, help: false, reportPath: null, reportPaths: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--profile') { config.profileName = argv[index + 1] ?? DEFAULT_PROFILE; index += 1; continue; }
    if (arg === '--no-open') { config.open = false; continue; }
    if (arg === '--report') { config.reportPath = argv[index + 1] ?? ''; index += 1; continue; }
    if (arg === '--reports') {
      const raw = argv[index + 1] ?? '';
      config.reportPaths = raw.split(',').map((s) => s.trim()).filter(Boolean);
      index += 1;
      continue;
    }
    // Silently accept (and ignore) flags that callers commonly pass but this script doesn't need
    if (arg === '--shortlist' || arg === '--top3') { continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
  }
  if (config.reportPath && config.reportPaths && config.reportPaths.length > 0) {
    throw new Error('Cannot pass both --report and --reports. Pick one.');
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

function firstNonEmpty(...values) {
  return values.find((value) => String(value ?? '').trim()) ?? '';
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

function plainText(value) {
  return String(value ?? '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortRecommendationLabel(report) {
  const raw = firstNonEmpty(report.metadata.recommendation, report.sections.Recommendation);
  const text = plainText(raw);
  if (!text) return 'Not recorded';
  const emphasized = String(raw).match(/\*\*([^*]+)\*\*/);
  if (emphasized?.[1]) return plainText(emphasized[1]).slice(0, 48);
  const sentence = text.split(/[.!?]\s/)[0] || text;
  return sentence.length > 48 ? `${sentence.slice(0, 47)}...` : sentence;
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

function buildBuyerFitChecks(report, profile) {
  const items = classifyFitStatus(report, profile);
  if (items.length === 0) return '';
  const rows = items.slice(0, 6).map((item) => `
    <li class="fit-row fit-${escapeHtml(item.status)}">
      <span class="fit-mark" aria-hidden="true">${item.status === 'match' ? '&#10003;' : '!'}</span>
      <span class="fit-label">${escapeHtml(item.label)}</span>
    </li>
  `).join('');

  return `
    <div class="panel fit wide">
      <h3>Buyer Fit Checks</h3>
      <ul class="fit-list">${rows}</ul>
    </div>
  `;
}

function buildGapList(report, finalist, profile) {
  const gaps = [];

  if (!finalist.construction) {
    gaps.push('Construction and road-project pressure has not been captured yet.');
  }
  if (!finalist.permits) {
    gaps.push('County permits and development cases within the 5-mile radius have not been captured yet.');
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
  if (finalist.permitsMismatch) {
    gaps.push(finalist.permitsMismatch);
  }
  if (finalist.builderMismatch) {
    gaps.push(finalist.builderMismatch);
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

function formatNumber(value) {
  const numeric = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(numeric) ? numeric.toLocaleString() : '';
}

function formatListingMoney(value) {
  const numeric = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(numeric) ? `$${numeric.toLocaleString()}` : '';
}

function loadListingFacts(report) {
  const payload = findCompanionJson(report, LISTING_DIR);
  if (!payload || !companionMatchesReport(payload, report)) return null;
  return payload;
}

function normalizeUrl(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || trimmed === '#') return '';
  if (/^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) return trimmed;
  return '';
}

function sourceLabelFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return 'Source';
  }
}

function addSourceLink(target, label, url, status = '') {
  const cleanUrl = normalizeUrl(url);
  if (!cleanUrl) return;
  if (/google\.com\/maps\/search/i.test(cleanUrl)) return;
  const key = cleanUrl.toLowerCase();
  if (target.seen.has(key)) return;
  target.seen.add(key);
  target.links.push({
    label: String(label || sourceLabelFromUrl(cleanUrl)).trim(),
    url: cleanUrl,
    status: String(status ?? '').trim(),
  });
}

function collectSourceLinks(finalist) {
  const report = finalist.report;
  const collector = { seen: new Set(), links: [] };
  addSourceLink(collector, 'Listing source', report.metadata.url);

  const schoolMetadata = loadSchoolMetadata(report);
  for (const source of schoolMetadata?.sourcesChecked ?? []) {
    addSourceLink(collector, source.name || 'School source', source.url || source.assignmentUrl || source.searchUrl || source.baseUrl, source.status);
    addSourceLink(collector, `${source.name || 'School source'} search`, source.searchUrl, source.status);
    addSourceLink(collector, `${source.name || 'School source'} assignment`, source.assignmentUrl, source.status);
  }
  for (const school of schoolMetadata?.schools ?? []) {
    addSourceLink(collector, school.name || 'School page', school.url, school.source || school.assignmentSource);
  }
  for (const school of schoolMetadata?.assignedSchools ?? []) {
    addSourceLink(collector, school.name || 'Assigned school', school.url, school.source || school.assignmentSource);
  }

  for (const source of finalist.construction?.sourcesChecked ?? []) {
    addSourceLink(collector, source.name || 'Construction source', source.url, source.ok === false ? 'unreachable' : 'checked');
  }
  for (const source of finalist.permits?.sourcesChecked ?? []) {
    addSourceLink(collector, source.name || source.service || 'Permit source', source.url, source.ok === false ? 'unreachable' : 'checked');
  }
  const builderReviews = finalist.builder?.reviews ?? {};
  addSourceLink(collector, 'Avid Ratings builder reviews', builderReviews.avidRatings?.url, finalist.builder?.status);
  addSourceLink(collector, 'Eliant builder reviews', builderReviews.eliant?.url, finalist.builder?.status);
  addSourceLink(collector, 'BBB builder profile', builderReviews.bbb?.url, finalist.builder?.status);
  addSourceLink(collector, 'Builder 100 list', builderReviews.builderOnline?.url, finalist.builder?.status);

  for (const source of finalist.sentiment?.sourceCoverage ?? []) {
    addSourceLink(collector, source.name || source.key || 'Sentiment source', source.url, source.status);
  }

  const sourcePlans = finalist.packet?.sourcePlans ?? {};
  for (const plan of Object.values(sourcePlans)) {
    for (const entry of plan?.entries ?? []) {
      addSourceLink(collector, entry.name || entry.key || 'Planned source', entry.url, entry.captureStatus || entry.reviewStatus);
      if (entry.key === 'google_maps') continue;
      for (const searchUrl of entry.searchUrls ?? []) {
        addSourceLink(collector, `${entry.name || entry.key || 'Search'} query`, searchUrl, entry.captureStatus || entry.reviewStatus);
      }
    }
  }

  for (const [key, url] of Object.entries(finalist.packet?.communityUrls ?? {})) {
    addSourceLink(collector, `${key} community URL`, url, 'planned');
  }

  return collector.links;
}

function buildFactsCard(finalist) {
  const report = finalist.report;
  const listing = finalist.listing;
  const facts = [
    ['Price', firstNonEmpty(report.metadata.price, formatListingMoney(listing?.price))],
    ['Beds / Baths', firstNonEmpty(report.metadata.bedsBaths, listing?.beds || listing?.baths ? `${listing?.beds ?? '--'}/${listing?.baths ?? '--'}` : '')],
    ['SqFt', firstNonEmpty(report.metadata.sqft, formatNumber(listing?.sqftFinished))],
    ['Lot', firstNonEmpty(report.metadata.lot, formatNumber(listing?.lotSqft) ? `${formatNumber(listing?.lotSqft)} sqft` : '')],
    ['Year Built', firstNonEmpty(report.metadata.yearBuilt, listing?.yearBuilt)],
    ['Garage', listing?.garage ? `${listing.garage} spaces` : ''],
    ['HOA', firstNonEmpty(report.metadata.hoa, listing?.hoaMonthly != null ? `$${listing.hoaMonthly}/mo` : '')],
    ['DOM', firstNonEmpty(report.metadata.daysOnMarket, listing?.daysOnMarket != null ? `${listing.daysOnMarket} days` : '')],
    ['Status', firstNonEmpty(report.metadata.verification, listing?.listingStatus)],
    ['MLS', listing?.mls || ''],
  ].filter(([, value]) => String(value ?? '').trim());

  const rows = facts.map(([label, value]) => `
    <tr>
      <th>${escapeHtml(label)}</th>
      <td>${escapeHtml(value)}</td>
    </tr>
  `).join('');

  return `
    <div class="panel facts">
      <h3>Listing Snapshot</h3>
      <table>${rows || '<tr><td class="muted">No structured facts captured.</td></tr>'}</table>
    </div>`;
}

function buildSourceLedger(finalist) {
  const links = collectSourceLinks(finalist);
  if (links.length === 0) return '';
  const rows = links.map((entry) => `
    <tr>
      <td>${escapeHtml(entry.label)}</td>
      <td>${entry.status ? escapeHtml(entry.status) : '<span class="muted">checked</span>'}</td>
      <td><a href="${escapeHtml(entry.url)}">${escapeHtml(entry.url)}</a></td>
    </tr>
  `).join('');
  return `
    <div class="panel wide sources">
      <h3>Sources Checked</h3>
      <table>
        <thead><tr><th>Source</th><th>Status</th><th>URL</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
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
    const score = finalist.report.metadata.overallScore || 'N/A';
    const recommendation = shortRecommendationLabel(finalist.report);
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
  return buildDevelopmentInfrastructureSection({ construction });
}

function statusTone(level) {
  const normalized = String(level || '').toLowerCase();
  if (normalized === 'high') return 'risk-high';
  if (normalized === 'moderate') return 'risk-med';
  if (normalized === 'low') return 'risk-low';
  if (normalized === 'none') return 'risk-none';
  return 'risk-unknown';
}

function milesFromMeters(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  return `${(numeric / 1609.344).toFixed(1)} mi`;
}

function formatPermitMatch(match) {
  const label = firstNonEmpty(match.subdivisionName, match.description, match.caseId, match.kind, 'Permit / case');
  const bits = [
    match.phase ? `phase ${match.phase}` : '',
    match.status ? `status ${match.status}` : '',
    match.proposedLots ? `${match.proposedLots} lots` : '',
    match.acres ? `${match.acres} acres` : '',
  ].filter(Boolean);
  return `${label}${bits.length ? ` (${bits.join('; ')})` : ''}`;
}

function buildDevelopmentInfrastructureSection({ construction, permits, developmentText = '' }) {
  const constructionLevel = String(construction?.level || 'unknown').toLowerCase();
  const permitLevel = String(permits?.level || 'unknown').toLowerCase();
  const constructionMatches = Number(construction?.matches?.length ?? 0);
  const permitMatches = Number(permits?.matchCount ?? permits?.matches?.length ?? 0);
  const radius = permits?.radiusMeters ? milesFromMeters(permits.radiusMeters) : '5.0 mi';
  const reviewedConstruction = Boolean(construction?.reviewed);
  const permitSourcesReachable = (permits?.sourcesChecked ?? []).some((source) => source?.ok);
  const reviewedPermits = permits?.status === 'reviewed' && permitSourcesReachable;

  const summaryParts = [];
  if (reviewedPermits) {
    summaryParts.push(`${permitMatches} county permit/development case${permitMatches === 1 ? '' : 's'} found within ${radius}.`);
  } else if (permits) {
    const sourceError = (permits.sourcesChecked ?? []).find((source) => source?.error)?.error;
    summaryParts.push(`County permit search did not complete cleanly (${sourceError || permits.status || 'unknown'}).`);
  } else {
    summaryParts.push('County permit search has not been captured yet.');
  }

  if (reviewedConstruction) {
    summaryParts.push(`${constructionMatches} NCDOT/STIP project snippet${constructionMatches === 1 ? '' : 's'} matched the home area/city signals.`);
  } else if (construction) {
    summaryParts.push('NCDOT/STIP construction review was inconclusive.');
  } else {
    summaryParts.push('NCDOT/STIP construction review has not been captured yet.');
  }

  const statusRows = [
    { label: 'County permits', value: reviewedPermits ? `${permitLevel} pressure` : 'not reviewed', tone: statusTone(reviewedPermits ? permitLevel : 'unknown') },
    { label: 'Road projects', value: reviewedConstruction ? `${constructionLevel} pressure` : 'not reviewed', tone: statusTone(reviewedConstruction ? constructionLevel : 'unknown') },
    { label: 'Search radius', value: radius, tone: 'risk-info' },
    { label: 'Lookahead', value: '10-year STIP + recent county cases', tone: 'risk-info' },
  ].map((item) => `
    <tr class="${item.tone}">
      <th>${escapeHtml(item.label)}</th>
      <td>${escapeHtml(item.value)}</td>
    </tr>`).join('');

  const permitRows = (permits?.matches ?? []).slice(0, 4).map((match) => `
    <li>${escapeHtml(formatPermitMatch(match))}</li>
  `).join('');
  const constructionRows = (construction?.matches ?? []).slice(0, 4).map((match) => `
    <li>${escapeHtml(firstNonEmpty(match.needle, 'Project signal'))}: ${escapeHtml(summarizeSection(match.snippet, 220))}</li>
  `).join('');

  const sourceRows = [
    ...(permits?.sourcesChecked ?? []).map((source) => ({ label: source.name || source.service || 'County source', url: source.url, ok: source.ok })),
    ...(construction?.sourcesChecked ?? []).map((source) => ({ label: source.name || 'NCDOT/STIP source', url: source.url, ok: source.ok })),
  ].slice(0, 6).map((source) => `
    <li>${source.ok === false ? '<span class="source-dot bad"></span>' : '<span class="source-dot good"></span>'}<a href="${escapeHtml(source.url)}">${escapeHtml(source.label)}</a></li>
  `).join('');

  return `
    <div class="panel wide infrastructure">
      <h3>Permits, Development &amp; Infrastructure</h3>
      <table class="infra-status"><tbody>${statusRows}</tbody></table>
      <p class="infra-summary">${escapeHtml(summaryParts.join(' '))}</p>
      <h4>Permit / Development Cases</h4>
      <ul class="infra-list">${permitRows || '<li class="muted">No county permit or subdivision cases captured within the current radius.</li>'}</ul>
      <h4>Road / Infrastructure Signals</h4>
      <ul class="infra-list">${constructionRows || '<li class="muted">No matched NCDOT/STIP project snippets captured for this home.</li>'}</ul>
      ${sourceRows ? `<ul class="resource-list compact">${sourceRows}</ul>` : ''}
    </div>`;
}

function formatScoreWithCount(score, count, unit) {
  const scoreText = score == null || score === '' ? '--' : `${score}/5`;
  const countText = count == null || count === '' ? '' : ` from ${Number(count).toLocaleString()} ${unit}${Number(count) === 1 ? '' : 's'}`;
  return `${scoreText}${countText}`;
}

function standingLabel(value) {
  return String(value ?? '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function sourceLink(label, url) {
  return url ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>` : escapeHtml(label);
}

function buildBuilderReputationCard(finalist) {
  const builder = finalist.builder;
  const packetBuilder = finalist.packet?.builderEvidence ?? {};
  const listingBuilderName = finalist.listing?.builderName;
  const builderName = firstNonEmpty(builder?.builderName, packetBuilder.builderName, listingBuilderName);
  if (!builderName) return '';

  const status = firstNonEmpty(builder?.status, packetBuilder.status, listingBuilderName ? 'detected-not-reviewed' : '');
  if (status === 'no-builder-detected') return '';

  const avid = builder?.reviews?.avidRatings;
  const eliant = builder?.reviews?.eliant;
  const bbb = builder?.reviews?.bbb;
  const builderOnline = builder?.reviews?.builderOnline;
  const hasReviewData = Boolean(avid || eliant || bbb || builderOnline || packetBuilder.avidRatingsOverall || packetBuilder.eliantOverall);
  const detectedBy = firstNonEmpty(builder?.detectionSource, packetBuilder.detectionSource);
  const confidence = firstNonEmpty(builder?.detectionConfidence, packetBuilder.detectionConfidence);
  const detectionSourceUrl = firstNonEmpty(builder?.detectionSourceUrl, packetBuilder.detectionSourceUrl, finalist.listing?.canonicalUrl, finalist.listing?.url);

  const rows = [];
  if (builder?.standing?.label) {
    rows.push(['Overall standing', standingLabel(builder.standing.label)]);
  }
  if (avid || packetBuilder.avidRatingsOverall) {
    const value = [
      formatScoreWithCount(avid?.overall ?? packetBuilder.avidRatingsOverall, avid?.reviewCount ?? packetBuilder.avidRatingsReviewCount, 'survey'),
      avid?.standing?.label ? standingLabel(avid.standing.label) : '',
    ].filter(Boolean).join(' - ');
    rows.push([sourceLink('Avid Ratings', avid?.url), value]);
    const categories = avid?.categories ?? packetBuilder.avidRatingsCategories;
    if (categories?.qualityOfHome != null) rows.push(['Avid quality of home', `${categories.qualityOfHome}/5`]);
    if (categories?.responsiveness != null) rows.push(['Avid responsiveness', `${categories.responsiveness}/5`]);
  }
  if (eliant || packetBuilder.eliantOverall) {
    const value = [
      formatScoreWithCount(eliant?.overall ?? packetBuilder.eliantOverall, eliant?.reviewCount, 'review'),
      eliant?.standing?.label ? standingLabel(eliant.standing.label) : '',
    ].filter(Boolean).join(' - ');
    rows.push([sourceLink('Eliant', eliant?.url), value]);
  }
  if (bbb) {
    rows.push([sourceLink('BBB rating', bbb.url), [bbb.rating ?? '--', bbb.standing?.label ? standingLabel(bbb.standing.label) : ''].filter(Boolean).join(' - ')]);
    rows.push(['BBB accreditation', bbb.accredited ? 'Accredited' : 'Not shown as accredited']);
    if (bbb.customerRating != null) rows.push(['BBB customer rating', formatScoreWithCount(bbb.customerRating, bbb.reviewCount, 'review')]);
    if (bbb.complaintsClosedLast3Years != null) rows.push(['BBB complaints', `${bbb.complaintsClosedLast3Years} closed in 3 years${bbb.complaintsClosedLast12Months != null ? `; ${bbb.complaintsClosedLast12Months} in 12 months` : ''}`]);
  }
  if (builderOnline) {
    const rank = builderOnline.rank ? `#${builderOnline.rank}` : 'Listed';
    const prior = builderOnline.priorYearRank ? `prior #${builderOnline.priorYearRank}` : '';
    rows.push([sourceLink(`Builder 100 ${builderOnline.year ?? ''}`.trim(), builderOnline.url), [rank, builderOnline.standing?.label ? standingLabel(builderOnline.standing.label) : '', prior].filter(Boolean).join(' - ')]);
    if (builderOnline.totalClosings != null) rows.push(['Builder 100 closings', `${Number(builderOnline.totalClosings).toLocaleString()} closings${builderOnline.grossRevenueMillions != null ? `; $${Number(builderOnline.grossRevenueMillions).toLocaleString()}M revenue` : ''}`]);
  }
  if (detectedBy || confidence) {
    rows.push(['Detection', [confidence, detectedBy].filter(Boolean).join(', ')]);
  }
  if (detectionSourceUrl) {
    rows.push([sourceLink('Builder source', detectionSourceUrl), detectedBy || 'listing/source page']);
  }

  const rowHtml = rows.map(([label, value]) => `
    <tr>
      <th>${label}</th>
      <td>${escapeHtml(value)}</td>
    </tr>
  `).join('');

  const snippets = (avid?.snippets ?? []).slice(0, 2).map((snippet) => `
    <li>${escapeHtml(summarizeSection(snippet, 180))}</li>
  `).join('');

  const reviewLinks = [
    avid?.url ? `<a href="${escapeHtml(avid.url)}">Avid Ratings</a>` : '',
    eliant?.url ? `<a href="${escapeHtml(eliant.url)}">Eliant</a>` : '',
    bbb?.url ? `<a href="${escapeHtml(bbb.url)}">BBB</a>` : '',
    builderOnline?.url ? `<a href="${escapeHtml(builderOnline.url)}">Builder 100</a>` : '',
  ].filter(Boolean).join(' ');

  const statusNote = hasReviewData
    ? 'Public builder reputation data was captured from the sources below. Treat it as a directional quality signal, not a substitute for inspection and warranty review.'
    : status === 'not-found'
      ? 'Builder was detected, but no matching public Avid Ratings or Eliant score was found.'
      : 'Builder was detected from the listing/report, but the reputation lookup has not populated a review sidecar yet.';

  return `
    <div class="panel builder wide">
      <h3>Builder Reputation</h3>
      <p><strong>${escapeHtml(builderName)}</strong></p>
      ${rowHtml ? `<table class="builder-status"><tbody>${rowHtml}</tbody></table>` : ''}
      ${builder?.standing?.summary ? `<p class="muted">${escapeHtml(builder.standing.summary)}</p>` : ''}
      <p class="muted">${escapeHtml(statusNote)}</p>
      ${snippets ? `<ul class="builder-snippets">${snippets}</ul>` : ''}
      ${reviewLinks ? `<p class="builder-links">${reviewLinks}</p>` : ''}
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

function numericPercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(String(value).replace(/[^0-9.]+/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function ethnicityEntries(distribution) {
  if (!distribution || typeof distribution !== 'object') return [];
  return Object.entries(distribution)
    .map(([group, value]) => ({
      group: group.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      percent: numericPercent(value),
    }))
    .filter((entry) => entry.percent !== null && entry.percent > 0)
    .sort((a, b) => b.percent - a.percent);
}

function formatEthnicitySummary(distribution) {
  const entries = ethnicityEntries(distribution).slice(0, 2);
  if (entries.length === 0) return '--';
  return entries.map((entry) => `${escapeHtml(entry.group)} ${entry.percent}%`).join('<br>');
}

function ethnicityColor(group, index) {
  const key = String(group ?? '').toLowerCase();
  if (/white/.test(key)) return '#2563eb';
  if (/hispanic|latino/.test(key)) return '#16a34a';
  if (/african|black/.test(key)) return '#7c3aed';
  if (/asian/.test(key)) return '#0891b2';
  if (/two|multi/.test(key)) return '#d97706';
  if (/native|american indian|alaska/.test(key)) return '#be123c';
  if (/pacific/.test(key)) return '#0f766e';
  const palette = ['#475569', '#9333ea', '#0284c7', '#ca8a04'];
  return palette[index % palette.length];
}

function buildEthnicityBars(schoolRows) {
  const cards = schoolRows
    .map((school) => {
      const entries = ethnicityEntries(school.ethnicityDistribution);
      if (entries.length === 0) return '';
      const bars = entries.map((entry, index) => {
        const width = Math.max(2, Math.min(100, entry.percent));
        return `
          <div class="ethnicity-row">
            <div class="ethnicity-label">${escapeHtml(entry.group)}</div>
            <div class="ethnicity-track">
              <div class="ethnicity-fill" style="width:${width}%;background:${ethnicityColor(entry.group, index)}"></div>
            </div>
            <div class="ethnicity-value">${escapeHtml(String(entry.percent))}%</div>
          </div>`;
      }).join('');
      return `
        <div class="ethnicity-card">
          <h4>${escapeHtml(school.name ?? 'School')}</h4>
          ${bars}
        </div>`;
    })
    .filter(Boolean)
    .join('');
  if (!cards) return '';
  return `
    <div class="ethnicity-breakdown">
      <h4>Ethnicity Distribution</h4>
      <div class="ethnicity-grid">${cards}</div>
    </div>`;
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

function formatGreatSchoolsSubratings(subratings) {
  if (!subratings || typeof subratings !== 'object') return '--';
  const labels = {
    testScores: 'Test',
    studentProgress: 'Progress',
    collegeReadiness: 'College',
    equity: 'Equity',
  };
  const parts = Object.entries(subratings)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${labels[key] ?? key}: ${value}`);
  return parts.length ? escapeHtml(parts.join(' · ')) : '--';
}

function schoolSourceLabel(school) {
  const source = String(school.source || school.assignmentSource || school.provider || school.metadataSource || '').trim();
  if (!source) return '--';
  if (source.toLowerCase() === 'wcpss') return 'WCPSS';
  if (/niche/i.test(source)) return 'Niche';
  if (/greatschools/i.test(source)) return 'GreatSchools';
  return source;
}

function schoolRatingCell(school) {
  if (school.rating != null) return `${escapeHtml(String(school.rating))}/10`;
  if (school.greatSchoolsRating != null) return `${escapeHtml(String(school.greatSchoolsRating))}/10`;
  if (school.nicheGrade?.letter) return formatNicheGrade(school.nicheGrade);
  return '--';
}

function normalizeSchoolKeyForPdf(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\bschool\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeSchoolLevelForPdf(...values) {
  for (const value of values) {
    const text = String(value ?? '').toLowerCase();
    if (/elementary|\bpk\b|\bk\b|k-?5|primary|\be\b/.test(text)) return 'elementary';
    if (/middle|junior|6-?8|\bm\b/.test(text)) return 'middle';
    if (/\bhigh\b|9-?12|\bh\b/.test(text)) return 'high';
  }
  return '';
}

function mergeSchoolRowsForPdf(metadata) {
  if (!metadata) return [];
  if (Array.isArray(metadata.standardizedSchools) && metadata.standardizedSchools.length > 0) {
    return metadata.standardizedSchools;
  }

  const assigned = Array.isArray(metadata.assignedSchools) ? metadata.assignedSchools : [];
  const enriched = Array.isArray(metadata.schools) ? metadata.schools : [];
  const enrichedByName = new Map();
  for (const school of enriched) {
    const key = normalizeSchoolKeyForPdf(school?.name);
    if (key && !enrichedByName.has(key)) enrichedByName.set(key, school);
  }

  const baseRows = assigned.length > 0 ? assigned : enriched;
  const seen = new Set();
  const rows = [];
  for (const base of baseRows) {
    const key = normalizeSchoolKeyForPdf(base?.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const school = assigned.length > 0 ? (enrichedByName.get(key) ?? {}) : base;
    rows.push({
      name: base.name || school.name,
      level: normalizeSchoolLevelForPdf(base.level, base.gradeLevel, school.gradeLevel, base.name, school.name),
      gradeLevel: school.gradeLevel || base.gradeLevel || base.level || '',
      assignmentSource: base.assignmentSource || base.source || '',
      assignmentUrl: base.url || '',
      district: base.district || '',
      calendar: base.calendar || '',
      capStatus: base.capStatus || '',
      transportation: base.transportation || '',
      rating: base.rating ?? school.greatSchoolsRating ?? null,
      ratingSource: base.rating != null ? (base.source || base.assignmentSource || '') : (school.greatSchoolsRating != null ? 'GreatSchools' : ''),
      greatSchoolsRatingScale: school.greatSchoolsRatingScale || null,
      greatSchoolsSubratings: school.greatSchoolsSubratings || null,
      nicheGrade: school.nicheGrade || null,
      enrollment: school.enrollment ?? base.enrollment ?? null,
      studentTeacherRatio: school.studentTeacherRatio ?? base.studentTeacherRatio ?? null,
      percentProficient: school.percentProficient || null,
      ethnicityDistribution: school.ethnicityDistribution ?? base.ethnicityDistribution ?? null,
      metadataSource: school.source || school.provider || '',
      metadataUrl: school.url || '',
      metadataStatus: school.captureStatus || base.fetchStatus || '',
    });
  }

  for (const school of enriched) {
    const key = normalizeSchoolKeyForPdf(school?.name);
    if (!key || seen.has(key)) continue;
    rows.push({
      name: school.name,
      level: normalizeSchoolLevelForPdf(school.gradeLevel, school.name),
      gradeLevel: school.gradeLevel || '',
      assignmentSource: '',
      assignmentUrl: '',
      district: '',
      calendar: '',
      capStatus: '',
      transportation: '',
      rating: school.greatSchoolsRating ?? null,
      ratingSource: school.greatSchoolsRating != null ? 'GreatSchools' : '',
      greatSchoolsRatingScale: school.greatSchoolsRatingScale || null,
      greatSchoolsSubratings: school.greatSchoolsSubratings || null,
      nicheGrade: school.nicheGrade || null,
      enrollment: school.enrollment ?? null,
      studentTeacherRatio: school.studentTeacherRatio ?? null,
      percentProficient: school.percentProficient || null,
      ethnicityDistribution: school.ethnicityDistribution || null,
      metadataSource: school.source || school.provider || '',
      metadataUrl: school.url || '',
      metadataStatus: school.captureStatus || '',
    });
  }
  return rows;
}

function parseSchoolRowsFromReport(report) {
  const section = report.sections['School Review'] ?? '';
  const rows = [];
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || /^\|\s*:?-{2,}/.test(trimmed)) continue;
    const cols = trimmed.split('|').slice(1, -1).map((col) => col.trim());
    if (cols.length < 4 || /assigned school/i.test(cols.join(' '))) continue;
    const [level, name, source, metadataStatus, notes] = cols;
    if (!name || /school/i.test(level) && /source/i.test(source)) continue;
    rows.push({
      name: name.replace(/\[[^\]]+\]\(([^)]+)\)/g, '').trim(),
      level: normalizeSchoolLevelForPdf(level, name),
      gradeLevel: level,
      assignmentSource: source,
      assignmentUrl: '',
      calendar: notes?.match(/traditional|year-round/i)?.[0] || '',
      capStatus: notes?.match(/not capped|capped/i)?.[0] || '',
      rating: null,
      ratingSource: '',
      nicheGrade: null,
      enrollment: null,
      studentTeacherRatio: null,
      percentProficient: null,
      ethnicityDistribution: null,
      metadataSource: '',
      metadataUrl: '',
      metadataStatus,
    });
  }
  return rows;
}

function buildSchoolsCard(report) {
  const metadata = loadSchoolMetadata(report);
  const schoolRows = mergeSchoolRowsForPdf(metadata);

  if (schoolRows.length > 0) {
    const rows = schoolRows.map((school) => {
      const displayUrl = school.assignmentUrl || school.metadataUrl || '';
      const nameCell = displayUrl
        ? `<a href="${escapeHtml(displayUrl)}">${escapeHtml(school.name ?? '--')}</a>`
        : formatSchoolField(school.name);
      const profMath = school.percentProficient?.math != null ? `${school.percentProficient.math}%` : '--';
      const profReading = school.percentProficient?.reading != null ? `${school.percentProficient.reading}%` : '--';
      const performance = profMath === '--' && profReading === '--'
        ? formatGreatSchoolsSubratings(school.greatSchoolsSubratings)
        : `${profMath} / ${profReading}`;
      const calendar = school.calendar
        ? `${school.calendar}${school.capStatus ? `; ${school.capStatus}` : ''}`
        : '--';
      const assignmentSource = school.assignmentSource || schoolSourceLabel(school);
      const enrichmentSource = school.metadataSource
        ? `${schoolSourceLabel({ metadataSource: school.metadataSource })}${school.metadataStatus ? ` (${school.metadataStatus})` : ''}`
        : (school.metadataStatus || '--');
      return `
        <tr>
          <td>${nameCell}</td>
          <td>${formatSchoolField(school.level || school.gradeLevel)}</td>
          <td>${formatSchoolField(assignmentSource)}</td>
          <td class="num">${schoolRatingCell(school)}</td>
          <td class="num">${formatSchoolField(school.enrollment)}</td>
          <td class="num">${formatSchoolField(school.studentTeacherRatio)}</td>
          <td>${formatSchoolField(calendar)}</td>
          <td>${formatSchoolField(enrichmentSource)}</td>
          <td>${performance}</td>
        </tr>`;
    }).join('');
    const ethnicityBars = buildEthnicityBars(schoolRows);

    const sourceNames = Array.from(new Set(
      (metadata.sourcesChecked ?? [])
        .map((source) => source.name)
        .filter(Boolean),
    ));
    const sourceNote = sourceNames.length ? `Sources: ${sourceNames.join(', ')}` : 'Sources recorded in the ledger below.';

    return `
      <div class="panel wide schools">
        <h3>Schools &amp; Metadata</h3>
        <table class="school-metadata">
          <thead>
            <tr>
              <th>School</th>
              <th>Level</th>
              <th>Assignment</th>
              <th class="num">Rating / Grade</th>
              <th class="num">Enrollment</th>
              <th class="num">Stu/Tch</th>
              <th>Calendar / Cap</th>
              <th>Metadata</th>
              <th>Performance</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${ethnicityBars}
        <p class="muted">${escapeHtml(sourceNote)} Performance shows Math/Read proficiency when available, otherwise GreatSchools subratings.</p>
      </div>`;
  }

  const reportRows = parseSchoolRowsFromReport(report);
  if (reportRows.length > 0) {
    const rows = reportRows.map((school) => `
        <tr>
          <td>${formatSchoolField(school.name)}</td>
          <td>${formatSchoolField(school.level || school.gradeLevel)}</td>
          <td>${formatSchoolField(school.assignmentSource)}</td>
          <td class="num">--</td>
          <td class="num">--</td>
          <td class="num">--</td>
          <td>${formatSchoolField([school.calendar, school.capStatus].filter(Boolean).join('; ') || '--')}</td>
          <td>${formatSchoolField(school.metadataStatus)}</td>
        </tr>`).join('');
    return `
      <div class="panel wide schools">
        <h3>Schools &amp; Metadata</h3>
        <table class="school-metadata">
          <thead><tr><th>School</th><th>Level</th><th>Assignment</th><th class="num">Rating</th><th class="num">Enrollment</th><th class="num">Stu/Tch</th><th>Calendar / Cap</th><th>Metadata</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="muted">Rendered from the report's School Review table because no structured school sidecar was available.</p>
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
    <div class="panel wide schools">
      <h3>Schools &amp; Ratings</h3>
      <ul class="school-list">${rows}</ul>
      ${footnote}
    </div>`;
}

function buildFinalistSection(finalist, profile, options = {}) {
  const showRank = options.showRank !== false;
  const isFirst = Boolean(options.isFirst);
  const report = finalist.report;
  const construction = finalist.construction;
  const permits = finalist.permits;
  const sentiment = finalist.sentiment;
  const packet = finalist.packet;

  const scoreDisplay = report.metadata.overallScore || 'N/A';
  const recommendation = shortRecommendationLabel(report);
  const recClass = classifyRecommendation(recommendation);
  const url = report.metadata.url || report.sourceUrl || finalist.listing?.canonicalUrl || finalist.listing?.url || '';
  const displayAddress = firstNonEmpty(report.address, finalist.listing?.address, report.title, 'Home');
  const displayCity = firstNonEmpty(report.city, finalist.listing?.city);
  const displayState = firstNonEmpty(report.state, finalist.listing?.state);
  const mapsUrl = buildMapsUrl(displayAddress, displayCity, displayState);
  const anchor = finalistAnchor(finalist.rank);

  const addressHeading = url
    ? `<a href="${escapeHtml(url)}">${escapeHtml(displayAddress)}</a>`
    : escapeHtml(displayAddress);

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
  const recommendationText = firstNonEmpty(report.sections.Recommendation, recommendation);
  const developmentText = summarizeSection(report.sections['Development and Infrastructure'], 850);
  const buyerFitBlock = buildBuyerFitChecks(report, profile);
  const infrastructureBlock = buildDevelopmentInfrastructureSection({ construction, permits, developmentText });
  const builderBlock = buildBuilderReputationCard(finalist);

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
      <div class="panel wide">
        <h3>Neighborhood Sentiment <span class="subtle">profile-weighted</span></h3>
        <table>
          <thead>
            <tr><th>Category</th><th class="num">Weight</th><th class="num">+ Mentions</th><th class="num">- Mentions</th><th class="num">Weighted</th></tr>
          </thead>
          <tbody>${topKpi || '<tr><td colspan="5" class="muted">No rollup captured.</td></tr>'}</tbody>
        </table>
      </div>`
    : `
      <div class="panel wide unreviewed">
        <h3>Neighborhood Sentiment</h3>
        <p class="muted">Not yet captured from Facebook or Nextdoor. Listed in the research gaps below.</p>
      </div>`;

  const gapItems = buildGapList(report, finalist, profile);
  const gapBlock = gapItems.length > 0
    ? `
      <div class="panel wide warn">
        <h3>Research gaps you may want filled in</h3>
        <ul>${gapItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        <p class="muted">Ask for a deeper dive on this listing to capture these before a final decision.</p>
      </div>`
    : '';

  const sectionClass = isFirst ? 'finalist finalist-first' : 'finalist';
  const rankBadgeHtml = showRank
    ? `<div class="rank-badge">#${escapeHtml(String(finalist.rank))}</div>`
    : '';

  return `
    <section class="${sectionClass}" id="${anchor}">
      <header class="finalist-header">
        ${rankBadgeHtml}
        <div class="finalist-title">
          <h2>${addressHeading}</h2>
          <p class="locality">${escapeHtml(displayCity)}, ${escapeHtml(displayState)}${finalist.community ? ` <span class="community-tag">&middot; ${escapeHtml(finalist.community)} community</span>` : ''}</p>
          <div class="badges">
            <span class="score-badge">Score ${escapeHtml(scoreDisplay)}</span>
            <span class="rec-badge rec-${escapeHtml(recClass)}">${escapeHtml(recommendation)}</span>
          </div>
          ${linkRowHtml}
        </div>
      </header>

      <div class="grid">
        ${buildFactsCard(finalist)}
        <div class="panel decision">
          <h3>Decision Read</h3>
          <p>${escapeHtml(summarizeSection(plainText(recommendationText), 1500))}</p>
        </div>
        ${buyerFitBlock}
        ${builderBlock}
        <div class="panel concerns wide">
          <h3>Top Concerns</h3>
          <ul>${(concerns.length ? concerns : ['(none captured)']).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
        </div>
        ${infrastructureBlock}
        ${buildSchoolsCard(report)}
        ${sentimentBlock}
        ${buildCommuteCard(report, profile)}
        ${gapBlock}
        ${buildSourceLedger(finalist)}
      </div>
    </section>
  `;
}

function buildHtml(finalists, profile, mode = 'batch') {
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const showRank = mode === 'batch';
  const finalistSections = finalists
    .map((finalist, idx) => buildFinalistSection(finalist, profile, { showRank, isFirst: idx === 0 }))
    .join('\n');
  const buyerLabel = profile?.buyer?.full_name ? ` &middot; Prepared for ${escapeHtml(profile.buyer.full_name)}` : '';

  const docTitle = mode === 'batch'
    ? 'Home-Ops Top 3 Finalist Briefing'
    : mode === 'combined'
      ? 'Home-Ops URL Deep Briefing'
      : 'Home-Ops Single-Home Deep Briefing';

  const coverHeading = mode === 'batch'
    ? 'Top 3 Finalist Briefing'
    : mode === 'combined'
      ? 'URL Deep Briefing'
      : '';

  const coverHtml = mode === 'single'
    ? '' // single-home: no cover, no TOC — go straight to the section
    : `
  <section class="cover">
    <div class="brand">Home-Ops &middot; Decision Brief</div>
    <h1>${escapeHtml(coverHeading)}</h1>
    <p class="cover-meta">Generated ${escapeHtml(generatedAt)} UTC &middot; ${escapeHtml(String(finalists.length))} home${finalists.length === 1 ? '' : 's'}${buyerLabel}</p>
    ${mode === 'batch' ? buildCoverToc(finalists) : buildCoverList(finalists)}
    <div class="cover-legend">
      <p>Each page shows the decision read, buyer fit checks, top concerns tailored to that listing, construction pressure, a schools metadata table, neighborhood sentiment, and any research gaps worth filling in.</p>
      <p>Anything marked <strong>Not yet captured</strong> is unknown, not favorable. Ask for a deeper dive to fill in the research gaps before a final decision.</p>
    </div>
  </section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(docTitle)}</title>
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
  p, li, td, th, a { overflow-wrap: anywhere; }
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
    padding: 12px 14px; border: 1px solid #e5e7eb; border-radius: 6px;
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
    width: 58px; height: 58px; border-radius: 8px;
    background: #0f766e;
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
  .card, .panel {
    border: 1px solid #d1d5db; border-radius: 6px;
    padding: 12px 14px; background: #ffffff;
    break-inside: auto;
    page-break-inside: auto;
    overflow: visible;
  }
  .facts { break-inside: avoid; page-break-inside: avoid; }
  .card.wide, .panel.wide { grid-column: span 2; }
  .card h3, .panel h3 {
    font-size: 9pt; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: #6b7280; margin-bottom: 8px;
  }
  .card h3 .subtle, .panel h3 .subtle {
    font-size: 8pt; font-weight: 500; color: #9ca3af;
    text-transform: none; letter-spacing: 0; margin-left: 4px;
  }
  .card p, .panel p { font-size: 9.5pt; margin-bottom: 4px; }
  .card ul, .panel ul { margin: 0; padding-left: 18px; font-size: 9.5pt; }
  .card li, .panel li { margin-bottom: 4px; }

  .quick-take { background: #f0f9ff; border-color: #bae6fd; }
  .quick-take h3 { color: #0369a1; }
  .strengths h3 { color: #166534; }
  .concerns h3 { color: #991b1b; }
  .decision { background: #f8fafc; border-color: #cbd5e1; }
  .decision h3, .facts h3 { color: #334155; }

  .construction { text-align: left; }
  .pressure-level {
    font-size: 16pt; font-weight: 800; margin: 4px 0 8px;
    letter-spacing: 0.03em;
  }
  .pressure-level.high { color: #b91c1c; }
  .pressure-level.moderate { color: #b45309; }
  .pressure-level.low { color: #166534; }
  .pressure-level.none, .pressure-level.unknown { color: #6b7280; }

  .warn { background: #fffbeb; border-color: #fde68a; }
  .warn h3 { color: #92400e; }
  .recommendation {
    background: #f8fafc;
    border-color: #c7d2fe;
  }
  .recommendation h3 { color: #3730a3; }

  .stat { font-size: 9.5pt; color: #4b5563; margin-bottom: 2px; }
  .stat strong { color: #111827; }
  .muted { color: #9ca3af; font-size: 8.5pt; }

  /* Fit narrative */
  .card.fit {
    background: #f0fdf4;
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

  .unreviewed { background: #f9fafb; border-style: dashed; color: #6b7280; }
  .unreviewed h3 { color: #9ca3af; }

  .construction p { font-size: 9.5pt; color: #1f2937; }
  .construction .resource-list {
    list-style: none; padding: 6px 0 6px 0; margin: 0 0 6px;
    border-top: 1px dashed #e5e7eb; border-bottom: 1px dashed #e5e7eb;
  }
  .construction .resource-list li {
    font-size: 8.5pt; padding: 2px 0; word-break: break-all;
    color: #4b5563;
  }
  .construction .resource-list a { color: #1d4ed8; }
  .infrastructure h3 { color: #075985; }
  .builder {
    background: #f8fafc;
    border-color: #cbd5e1;
  }
  .builder h3 { color: #334155; }
  .builder-status {
    width: 100%;
    margin: 6px 0 8px;
    table-layout: fixed;
  }
  .builder-status th {
    width: 38%;
    text-transform: none;
    letter-spacing: 0;
    font-size: 8.5pt;
    background: #f3f4f6;
  }
  .builder-status td { font-size: 9pt; font-weight: 600; color: #111827; }
  .builder-snippets {
    margin-top: 7px;
    padding-left: 14px;
    font-size: 8.5pt;
  }
  .builder-links a {
    color: #1d4ed8;
    margin-right: 10px;
    font-size: 8.5pt;
  }
  .risk-none th { border-left: 4px solid #16a34a; }
  .risk-low th { border-left: 4px solid #84cc16; }
  .risk-med th { border-left: 4px solid #f59e0b; }
  .risk-high th { border-left: 4px solid #dc2626; }
  .risk-unknown th { border-left: 4px solid #94a3b8; }
  .risk-info th { border-left: 4px solid #0284c7; }
  .infra-status {
    width: 100%;
    margin-bottom: 8px;
    table-layout: fixed;
  }
  .infra-status th {
    width: 34%;
    text-transform: none;
    letter-spacing: 0;
    font-size: 8.5pt;
    background: #f8fafc;
  }
  .infra-status td { font-size: 9pt; font-weight: 600; color: #111827; }
  .infra-summary { margin-top: 6px; }
  .infrastructure h4 {
    margin: 0 0 5px;
    color: #334155;
    font-size: 8.5pt;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .infra-list,
  .resource-list.compact {
    margin: 0;
    padding-left: 14px;
    font-size: 8.5pt;
  }
  .infra-list { margin-bottom: 9px; }
  .resource-list.compact {
    margin-top: 9px;
    padding-top: 7px;
    border-top: 1px dashed #e5e7eb;
    list-style: none;
    padding-left: 0;
  }
  .resource-list.compact li { margin: 2px 0; word-break: break-all; }
  .source-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    margin-right: 5px;
  }
  .source-dot.good { background: #16a34a; }
  .source-dot.bad { background: #dc2626; }

  .schools h3 { color: #0369a1; }
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
  .ethnicity-breakdown {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid #e5e7eb;
    break-inside: avoid;
  }
  .ethnicity-breakdown h4 {
    margin: 0 0 8px;
    font-size: 9.5pt;
    color: #334155;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .ethnicity-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  .ethnicity-card {
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 8px;
    background: #ffffff;
    break-inside: avoid;
  }
  .ethnicity-card h4 {
    margin: 0 0 6px;
    font-size: 8.5pt;
    color: #111827;
    text-transform: none;
    letter-spacing: 0;
  }
  .ethnicity-row {
    display: grid;
    grid-template-columns: minmax(68px, 1.1fr) minmax(78px, 1.4fr) 30px;
    align-items: center;
    gap: 6px;
    margin: 4px 0;
    font-size: 7.4pt;
  }
  .ethnicity-label {
    color: #475569;
    line-height: 1.15;
  }
  .ethnicity-track {
    height: 7px;
    border-radius: 999px;
    background: #e5e7eb;
    overflow: hidden;
  }
  .ethnicity-fill {
    height: 100%;
    border-radius: 999px;
  }
  .ethnicity-value {
    text-align: right;
    color: #111827;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .commute h3 { color: #0369a1; }
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
  .facts table th {
    width: 34%; text-transform: none; letter-spacing: 0;
    font-size: 8.5pt; color: #475569; background: #f8fafc;
  }
  .facts table td { font-size: 9pt; }
  .sources table { table-layout: fixed; }
  .sources th:nth-child(1), .sources td:nth-child(1) { width: 22%; }
  .sources th:nth-child(2), .sources td:nth-child(2) { width: 16%; }
  .sources td { font-size: 7.7pt; word-break: break-all; }
</style>
</head>
<body>
  ${coverHtml}
  ${finalistSections}
</body>
</html>`;
}

function buildCoverList(finalists) {
  const items = finalists.map((finalist) => {
    const report = finalist.report;
    const url = report.metadata.url || '';
    const addressLine = url
      ? `<a href="${escapeHtml(url)}">${escapeHtml(report.address)}</a>`
      : escapeHtml(report.address);
    return `
        <li>
          <div class="toc-row">
            <div class="toc-body">
              <span class="toc-address">${addressLine}</span>
              <span class="toc-locality">${escapeHtml(report.city)}, ${escapeHtml(report.state)}</span>
            </div>
          </div>
        </li>`;
  }).join('');
  return `
    <div class="cover-toc">
      <h3>Homes covered</h3>
      <ol>${items}</ol>
    </div>`;
}

function loadFinalist(reportPath, rank = 1) {
  const report = parseReport(ROOT, reportPath);
  const constructionCompanion = loadCompanionForReport(report, CONSTRUCTION_DIR, 'Construction');
  const permitsCompanion = loadCompanionForReport(report, PERMITS_DIR, 'Permits');
  const sentimentCompanion = loadCompanionForReport(report, SENTIMENT_DIR, 'Sentiment');
  const packetCompanion = loadCompanionForReport(report, DEEP_PACKET_DIR, 'Deep packet');
  const builderCompanion = loadCompanionForReport(report, BUILDER_DIR, 'Builder');
  const listing = loadListingFacts(report);
  const communityPayload = findCompanionJson(report, COMMUNITY_DIR);
  const community = communityPayload && communityPayload.community
    && communityPayload.status !== 'no-community-match'
    ? String(communityPayload.community).trim()
    : null;
  return {
    rank,
    report,
    construction: constructionCompanion.data,
    permits: permitsCompanion.data,
    sentiment: sentimentCompanion.data,
    builder: builderCompanion.data,
    packet: packetCompanion.data,
    listing,
    community,
    constructionMismatch: constructionCompanion.mismatchMessage,
    permitsMismatch: permitsCompanion.mismatchMessage,
    sentimentMismatch: sentimentCompanion.mismatchMessage,
    builderMismatch: builderCompanion.mismatchMessage,
    packetMismatch: packetCompanion.mismatchMessage,
  };
}

function loadFinalists() {
  const shortlist = parseShortlist(ROOT);
  if (!shortlist.refinedTop3 || shortlist.refinedTop3.length === 0) {
    throw new Error('No refined top-3 homes found in data/shortlist.md. Run deep mode before generating the briefing.');
  }

  return shortlist.refinedTop3.map((row, index) => loadFinalist(row.reportPath, row.rank || index + 1));
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

  const profile = loadBuyerProfile();
  const dateStamp = new Date().toISOString().slice(0, 10);
  await mkdir(OUTPUT_DIR, { recursive: true });

  let finalists;
  let outputPath;
  let mode;
  if (config.reportPath) {
    mode = 'single';
    finalists = [loadFinalist(config.reportPath, 1)];
    // Older deep brief titles used "Deep Brief: …"; canonical single-home
    // reports use numbered filenames. Fall back to the filename if parsing
    // cannot determine a useful slug.
    let slug = slugify(`${finalists[0].report.address}-${finalists[0].report.city}-${finalists[0].report.state || 'NC'}`)
      || '';
    if (!slug || slug === 'nc') {
      const baseName = (finalists[0].report.relativePath || config.reportPath || '').split(/[\\/]/).pop() || '';
      const stripped = baseName.replace(/\.md$/i, '').replace(/-deep-\d{4}-\d{2}-\d{2}$/i, '');
      if (stripped) slug = stripped;
    }
    if (!slug) slug = 'home';
    outputPath = join(OUTPUT_DIR, `${slug}-deep-${dateStamp}.pdf`);
  } else if (config.reportPaths && config.reportPaths.length > 0) {
    mode = 'combined';
    finalists = config.reportPaths.map((path, idx) => loadFinalist(path, idx + 1));
    outputPath = join(OUTPUT_DIR, `url-deep-${dateStamp}.pdf`);
  } else {
    mode = 'batch';
    finalists = loadFinalists();
    outputPath = join(OUTPUT_DIR, `top3-briefing-${dateStamp}.pdf`);
  }

  const html = buildHtml(finalists, profile, mode);
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
