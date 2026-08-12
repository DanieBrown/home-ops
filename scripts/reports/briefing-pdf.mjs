#!/usr/bin/env node

/**
 * briefing-pdf.mjs -- Renders a top-3 finalist briefing PDF for the current
 * refined shortlist and opens it as a new tab inside the hosted Chrome
 * session. Each home gets an overview page plus page-sized report sections so
 * the user can flip through the brief without cramped card breaks.
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
import { ROOT, LISTINGS_FILE } from '../shared/paths.mjs';
import {
  parseReport,
  parseShortlist,
} from '../research/research-utils.mjs';
import { slugify } from '../shared/text-utils.mjs';
import { parseListingRow } from '../shared/listings.mjs';

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
const HOA_DIR = join(ROOT, 'output', 'hoa');
const UTILITIES_DIR = join(ROOT, 'output', 'utilities');
const AXIS_DIR = join(ROOT, 'output', 'axis');
const HAZARDS_DIR = join(ROOT, 'output', 'hazards');
const PARCEL_DIR = join(ROOT, 'output', 'parcel');
const ACCESS_DIR = join(ROOT, 'output', 'access');

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
           top-3 ranking); each home gets its own section-page set, no rank badge.

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

export function loadUtilityOptionsForReport(report) {
  return loadCompanionForReport(report, UTILITIES_DIR, 'Utilities');
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
  if (!finalist.axis) {
    gaps.push('Axis-agent interpretation sidecar has not been written for this home (deep axis phase incomplete).');
  }
  if (finalist.axisMismatch) {
    gaps.push(finalist.axisMismatch);
  }
  if (finalist.sentimentMismatch) {
    gaps.push(finalist.sentimentMismatch);
  }
  {
    const axisSentiment = finalist.axis?.sentiment;
    const coverage = Object.entries(axisSentiment?.sourceCoverage ?? {});
    const skippedBelowTier = coverage.filter(([, status]) => status === 'skipped-below-tier').map(([key]) => key);
    if (skippedBelowTier.length > 0) {
      gaps.push(`${skippedBelowTier.join(', ')} could not reach subdivision-tier evidence for this home (no resolved neighborhood name) -- an architectural limit, not a null result; treat it as an open question.`);
    }
    const blockedSentimentSources = coverage.filter(([, status]) => status === 'blocked').map(([key]) => key);
    if (blockedSentimentSources.length > 0) {
      gaps.push(`${blockedSentimentSources.join(', ')} sentiment source(s) were blocked or unreachable; treat affected sentiment dimensions as unconfirmed, not clear.`);
    }
    const municipalOnlyDimensions = Object.entries(axisSentiment?.sentimentScores ?? {})
      .filter(([, entry]) => {
        const mix = entry?.proximityMix;
        if (!mix || Number(mix.municipal ?? 0) === 0) return false;
        return !['subdivision', 'street', 'school-zone'].some((tier) => Number(mix[tier] ?? 0) > 0);
      })
      .map(([dimension]) => dimension.replace(/_/g, ' '));
    if (municipalOnlyDimensions.length > 0) {
      gaps.push(`${municipalOnlyDimensions.join(', ')} sentiment is built only from city-wide chatter, not evidence about this specific subdivision or street.`);
    }
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
  if (finalist.hoaMismatch) {
    gaps.push(finalist.hoaMismatch);
  }
  if (!finalist.utilities) {
    gaps.push('Utility/provider billing options have not been captured yet.');
  }
  if (finalist.utilitiesMismatch) {
    gaps.push(finalist.utilitiesMismatch);
  }
  if ((finalist.utilities?.sourceCoverage ?? []).some((entry) => ['blocked', 'error'].includes(entry.status))) {
    gaps.push('One or more utility/provider sources were blocked or unreachable; treat affected availability as unknown.');
  }

  // Property snapshot. A missing sidecar and a blocked source are different
  // failures and get different lines -- neither may read as "no risk found".
  if (!finalist.hazards) {
    gaps.push('Site hazards have not been captured yet: flood zone, wetlands, radon, environmental sites, septic soil, and airport noise are all unknown, not clear.');
  }
  if (finalist.hazardsMismatch) {
    gaps.push(finalist.hazardsMismatch);
  }
  if (!finalist.parcel) {
    gaps.push('The county parcel record has not been captured yet, so assessed value and property tax are unknown.');
  }
  if (finalist.parcelMismatch) {
    gaps.push(finalist.parcelMismatch);
  }
  if (!finalist.access) {
    gaps.push('Road adjacency and drive times have not been captured yet; traffic exposure is unmeasured, not low.');
  }
  if (finalist.accessMismatch) {
    gaps.push(finalist.accessMismatch);
  }

  for (const [sidecar, label] of [[finalist.hazards, 'site hazard'], [finalist.parcel, 'parcel/tax'], [finalist.access, 'access']]) {
    const blocked = (sidecar?.sourceCoverage ?? []).filter((entry) => entry.status === 'blocked');
    if (blocked.length > 0) {
      gaps.push(`${blocked.length} ${label} source${blocked.length === 1 ? '' : 's'} could not be reached (${blocked.map((entry) => entry.name).join(', ')}). Those dimensions are unknown, not clear.`);
    }
  }
  if (finalist.listing && !finalist.listing.priceMovement) {
    gaps.push('The listing page published no price history, so price movement — the stronger resale signal — is unconfirmed.');
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

  for (const source of finalist.hoaRules?.sourcesChecked ?? []) {
    addSourceLink(collector, source.label || source.name || 'HOA source', source.finalUrl || source.url, source.status);
  }
  for (const document of finalist.hoaRules?.documents ?? []) {
    addSourceLink(collector, document.label || 'HOA document', document.finalUrl || document.url, document.status);
  }

  for (const source of finalist.utilities?.sourceCoverage ?? []) {
    addSourceLink(collector, source.name || source.key || 'Utility source', source.url, source.status);
  }
  for (const providers of Object.values(finalist.utilities?.providers ?? {})) {
    for (const provider of providers ?? []) {
      addSourceLink(collector, provider.name || 'Utility provider', provider.sourceUrl, provider.serviceStatus);
      for (const plan of provider.plans ?? []) {
        addSourceLink(collector, `${provider.name || 'Internet'} ${plan.name || 'plan'}`, plan.sourceUrl, provider.serviceStatus);
      }
    }
  }

  // Property snapshot sources. Their status is carried through verbatim so a
  // blocked FEMA or NCDOT query is visible in the ledger rather than absent
  // from it -- an unreachable source that simply vanishes reads as a clean run.
  for (const [sidecar, label] of [
    [finalist.hazards, 'Site hazard source'],
    [finalist.parcel, 'Parcel/tax source'],
    [finalist.access, 'Access source'],
  ]) {
    for (const source of sidecar?.sourceCoverage ?? []) {
      addSourceLink(collector, source.name || source.key || label, source.url, source.status);
    }
  }
  for (const guide of finalist.access?.guidedChecks ?? []) {
    addSourceLink(collector, guide.name || 'Buyer-run check', guide.url, 'buyer-run check');
  }
  addSourceLink(collector, finalist.parcel?.billLookup?.name || 'County tax bill lookup', finalist.parcel?.billLookup?.url, 'buyer-run check');
  addSourceLink(collector, finalist.parcel?.futureLandUseGuide?.name || 'Future land use map', finalist.parcel?.futureLandUseGuide?.url, 'buyer-run check');

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

function formatHoaDues(value, fallback = '') {
  if (value === null || value === undefined || value === '') return String(fallback ?? '').trim();
  const numeric = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.\-]/g, ''));
  if (Number.isFinite(numeric)) return `$${numeric.toLocaleString()}/mo`;
  return String(fallback ?? '').trim();
}

function buildHoaRulesCard(finalist) {
  const hoa = finalist.hoaRules;
  if (!hoa) return '';

  const facts = [
    ['Status', hoa.status || 'unconfirmed'],
    ['Confidence', hoa.confidence || 'unconfirmed'],
    ['HOA / Community', firstNonEmpty(hoa.hoa?.associationName, hoa.hoa?.communityName, 'Unconfirmed')],
    ['Manager / Source', firstNonEmpty(hoa.hoa?.managementCompany, 'Unconfirmed')],
    ['Monthly dues', firstNonEmpty(formatHoaDues(hoa.hoa?.monthlyDues, hoa.hoa?.duesText), 'Unconfirmed')],
  ].map(([label, value]) => `
    <tr>
      <th>${escapeHtml(label)}</th>
      <td>${escapeHtml(value)}</td>
    </tr>
  `).join('');

  const documents = (hoa.documents ?? [])
    .filter((document) => document.status === 'captured' || document.status === 'found')
    .slice(0, 6);
  const documentRows = documents.length
    ? documents.map((document) => `
      <li><a href="${escapeHtml(document.finalUrl || document.url)}">${escapeHtml(document.label || document.documentType || 'HOA document')}</a>${document.documentType ? ` <span class="subtle">${escapeHtml(document.documentType)}</span>` : ''}</li>
    `).join('')
    : '<li class="muted">No public governing documents confirmed.</li>';

  const topicRows = (hoa.topics ?? [])
    .filter((topic) => topic.status === 'found')
    .slice(0, 6)
    .map((topic) => `
      <tr>
        <th>${escapeHtml(topic.topic)}</th>
        <td>${escapeHtml(summarizeSection(topic.summary, 240))}</td>
      </tr>
    `).join('');

  const openQuestions = (hoa.openQuestions ?? []).slice(0, 3).map((item) => `<li>${escapeHtml(item)}</li>`).join('');

  return `
    <div class="panel hoa wide">
      <h3>HOA Rules &amp; Restrictions</h3>
      <table class="hoa-status"><tbody>${facts}</tbody></table>
      <h4>Documents found</h4>
      <ul class="hoa-docs">${documentRows}</ul>
      ${topicRows ? `<h4>Buyer-relevant rule topics</h4><table class="hoa-topics"><tbody>${topicRows}</tbody></table>` : '<p class="muted">No buyer-relevant HOA rule topics were confirmed from public docs in this pass.</p>'}
      ${openQuestions ? `<h4>Before offer</h4><ul class="hoa-open">${openQuestions}</ul>` : ''}
    </div>`;
}

function formatUtilityMoney(value) {
  if (value === null || value === undefined || value === '') return '--';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `$${numeric.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '--';
}

function formatUtilityRange(range) {
  if (!range || range.low == null || range.typical == null || range.high == null) return '--';
  return `${formatUtilityMoney(range.low)} / ${formatUtilityMoney(range.typical)} / ${formatUtilityMoney(range.high)}`;
}

function formatUtilityStatus(value) {
  return String(value ?? 'unconfirmed').replace(/[-_]+/g, ' ');
}

function utilityKindLabel(kind) {
  const labels = {
    electric: 'Electric',
    waterSewer: 'Water / Sewer',
    naturalGas: 'Natural Gas',
    internet: 'Internet',
  };
  return labels[kind] ?? String(kind ?? '').replace(/[-_]+/g, ' ');
}

function providerEstimateLabel(provider) {
  if (provider?.estimateMonthly) {
    return formatUtilityRange(provider.estimateMonthly);
  }
  const pricedPlans = (provider?.plans ?? [])
    .filter((plan) => plan.monthlyPrice != null)
    .sort((left, right) => Number(left.monthlyPrice) - Number(right.monthlyPrice));
  if (pricedPlans.length > 0) {
    return `${formatUtilityMoney(pricedPlans[0].monthlyPrice)}+`;
  }
  return '--';
}

function internetStatusRank(status) {
  const ranks = { confirmed: 0, reported: 1, likely: 2, unconfirmed: 3, blocked: 4, 'not-available': 5 };
  return ranks[String(status ?? '').toLowerCase()] ?? 6;
}

function chooseInternetDisplayPlan(provider) {
  const plans = provider?.plans ?? [];
  const pricedFast = plans
    .filter((plan) => plan.monthlyPrice != null && Number(plan.downloadMbps) >= 500)
    .sort((left, right) => Number(left.monthlyPrice) - Number(right.monthlyPrice));
  if (pricedFast[0]) return pricedFast[0];
  const fastestReported = plans
    .filter((plan) => plan.downloadMbps != null)
    .sort((left, right) => Number(right.downloadMbps) - Number(left.downloadMbps));
  return fastestReported[0] ?? null;
}

function buildInternetDisplayRows(utilities) {
  const providers = utilities.providers?.internet ?? [];
  const selected = utilities.selectedInternetPlan;
  const selectedKey = selected ? `${selected.provider}|${selected.name}`.toLowerCase() : '';
  const rows = [];
  const seen = new Set();

  if (selected) {
    rows.push({
      provider: selected.provider,
      status: selected.serviceStatus,
      plan: selected,
      selected: true,
      sourceUrl: selected.sourceUrl,
    });
    seen.add(selectedKey);
  }

  const candidates = providers
    .map((provider) => ({ provider, plan: chooseInternetDisplayPlan(provider) }))
    .sort((left, right) => (
      internetStatusRank(left.provider.serviceStatus) - internetStatusRank(right.provider.serviceStatus)
      || Number(right.plan?.downloadMbps ?? 0) - Number(left.plan?.downloadMbps ?? 0)
      || Number(left.plan?.monthlyPrice ?? 9999) - Number(right.plan?.monthlyPrice ?? 9999)
    ));

  for (const { provider, plan } of candidates) {
    const key = `${provider.name}|${plan?.name ?? ''}`.toLowerCase();
    if (key === selectedKey || seen.has(key)) continue;
    rows.push({ provider: provider.name, status: provider.serviceStatus, plan, selected: false, sourceUrl: provider.sourceUrl });
    seen.add(key);
    if (rows.length >= 6) break;
  }

  return {
    rows,
    omittedCount: Math.max(0, providers.length - rows.length),
  };
}

// ---------------------------------------------------------------------------
// Property Snapshot
//
// Renders the hazards / parcel / access sidecars. Every dimension shows its
// value AND how we came to know it, because the states are not
// interchangeable: a FEMA query that timed out must not look like a home
// outside the flood zone, and a home outside RDU's modelled noise contours
// must not look like a measurement of quiet.
// ---------------------------------------------------------------------------

const PROVENANCE_DISPLAY = {
  captured: { label: 'captured', className: 'prov-captured', hint: 'Read from the cited source.' },
  unconfirmed: { label: 'unconfirmed', className: 'prov-unconfirmed', hint: 'Checked, but the answer was inconclusive.' },
  blocked: { label: 'BLOCKED', className: 'prov-blocked', hint: 'Source unreachable — this is unknown, NOT an all-clear.' },
  unsupported: { label: 'unsupported', className: 'prov-unsupported', hint: 'No queryable source exists for this jurisdiction.' },
  'not-applicable': { label: 'n/a', className: 'prov-na', hint: 'Genuinely does not apply to this home.' },
};

function provenanceBadge(provenance) {
  const display = PROVENANCE_DISPLAY[provenance] ?? PROVENANCE_DISPLAY.unconfirmed;
  return `<span class="prov-badge ${display.className}" title="${escapeHtml(display.hint)}">${escapeHtml(display.label)}</span>`;
}

function snapshotDimensionRows(dimensions) {
  return Object.values(dimensions ?? {}).map((dim) => {
    if (!dim || !dim.label) return '';
    // Only a captured dimension gets to state a value. Everything else shows
    // an em dash so an unknown can never be skimmed as a finding.
    const value = dim.provenance === 'captured' && dim.value != null
      ? escapeHtml(String(dim.value))
      : '<span class="muted">&mdash;</span>';
    const detail = dim.detail ? `<div class="snapshot-detail">${escapeHtml(dim.detail)}</div>` : '';
    const note = dim.note ? `<div class="snapshot-note">${escapeHtml(dim.note)}</div>` : '';
    const source = dim.sourceUrl
      ? `<a class="snapshot-source" href="${escapeHtml(dim.sourceUrl)}">source &#8599;</a>`
      : '';
    return `
      <tr class="snapshot-row ${escapeHtml(PROVENANCE_DISPLAY[dim.provenance]?.className ?? 'prov-unconfirmed')}">
        <th>${escapeHtml(dim.label)}</th>
        <td class="snapshot-value">${value}${detail}${note}</td>
        <td class="snapshot-prov">${provenanceBadge(dim.provenance)}${source}</td>
      </tr>`;
  }).join('');
}

function snapshotGroup(title, sidecar, missingMessage) {
  if (!sidecar) {
    return `
      <div class="snapshot-group unreviewed">
        <h4>${escapeHtml(title)}</h4>
        <p class="muted">${escapeHtml(missingMessage)}</p>
      </div>`;
  }
  const rows = snapshotDimensionRows(sidecar.dimensions);
  if (!rows) {
    return `
      <div class="snapshot-group unreviewed">
        <h4>${escapeHtml(title)}</h4>
        <p class="muted">${escapeHtml(missingMessage)}</p>
      </div>`;
  }
  const blocked = (sidecar.sourceCoverage ?? []).filter((entry) => entry.status === 'blocked');
  const banner = blocked.length > 0
    ? `<p class="snapshot-blocked-banner">${blocked.length} source${blocked.length === 1 ? '' : 's'} could not be reached (${escapeHtml(blocked.map((entry) => entry.name).join(', '))}). Those dimensions are unknown, not clear.</p>`
    : '';
  const confidence = sidecar.confidence
    ? `<span class="subtle">confidence ${escapeHtml(sidecar.confidence)}</span>`
    : '';
  return `
    <div class="snapshot-group">
      <h4>${escapeHtml(title)} ${confidence}</h4>
      ${banner}
      <table class="snapshot-table">
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function buildPriceMovementRow(finalist) {
  const movement = finalist.listing?.priceMovement;
  if (!movement) {
    return `
      <div class="snapshot-group unreviewed">
        <h4>Price history</h4>
        <p class="muted">The listing page published no price history, so price movement is unconfirmed. Days on market alone does not show whether the ask has moved.</p>
      </div>`;
  }
  const money = (value) => (value == null ? '&mdash;' : `$${Math.round(value).toLocaleString('en-US')}`);
  const cutLabel = movement.cutCount === 0
    ? 'No cut since listing'
    : `${movement.cutCount} cut${movement.cutCount === 1 ? '' : 's'}, ${money(movement.totalCutAmount)} total (${movement.totalCutPct}%)`;
  return `
    <div class="snapshot-group">
      <h4>Price history <span class="subtle">from the portal's own table</span></h4>
      <table class="snapshot-table">
        <tbody>
          <tr class="snapshot-row prov-captured">
            <th>Original list</th>
            <td class="snapshot-value">${money(movement.originalListPrice)}</td>
            <td class="snapshot-prov">${provenanceBadge('captured')}</td>
          </tr>
          <tr class="snapshot-row prov-captured">
            <th>Movement</th>
            <td class="snapshot-value">${escapeHtml(cutLabel)}${movement.daysToFirstCut != null ? `<div class="snapshot-detail">First cut after ${movement.daysToFirstCut} days on market</div>` : ''}</td>
            <td class="snapshot-prov">${provenanceBadge('captured')}</td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

function buildGuidedChecksBlock(finalist) {
  const guides = [
    ...(finalist.access?.guidedChecks ?? []),
    finalist.parcel?.futureLandUseGuide,
    finalist.parcel?.billLookup,
  ].filter((guide) => guide && guide.url);
  if (guides.length === 0) return '';
  const items = guides.map((guide) => `
    <li>
      <a href="${escapeHtml(guide.url)}">${escapeHtml(guide.name)} &#8599;</a>
      <div class="snapshot-detail">${escapeHtml(guide.instructions ?? '')}</div>
    </li>`).join('');
  return `
    <div class="snapshot-group">
      <h4>Check these yourself <span class="subtle">no public API — nothing was scraped</span></h4>
      <ul class="guided-list">${items}</ul>
    </div>`;
}

function buildPropertySnapshotCard(finalist) {
  const groups = [
    snapshotGroup('Site hazards', finalist.hazards,
      'Site hazards have not been captured for this home. Flood zone, wetlands, radon, environmental sites, septic soil, and airport noise are all unknown — not clear.'),
    snapshotGroup('Parcel, assessment & tax', finalist.parcel,
      'The county parcel record has not been captured for this home. Assessed value and property tax are unknown.'),
    snapshotGroup('Access & traffic', finalist.access,
      'Road adjacency and drive times have not been captured for this home. Traffic exposure is unmeasured, not low.'),
    buildPriceMovementRow(finalist),
    buildGuidedChecksBlock(finalist),
  ].filter(Boolean).join('');

  return `
    <div class="panel wide snapshot">
      <h3>Property Snapshot</h3>
      <p class="snapshot-legend">
        ${provenanceBadge('captured')} read from the cited source &nbsp;
        ${provenanceBadge('unconfirmed')} checked, inconclusive &nbsp;
        ${provenanceBadge('blocked')} source unreachable &mdash; unknown, not clear &nbsp;
        ${provenanceBadge('unsupported')} nothing queryable here &nbsp;
        ${provenanceBadge('not-applicable')} does not apply
      </p>
      ${groups}
    </div>`;
}

function buildUtilitiesOptionsCard(finalist) {
  const utilities = finalist.utilities;
  if (!utilities) {
    return `
      <div class="panel wide utilities unreviewed">
        <h3>Utilities &amp; Monthly Bills</h3>
        <p class="muted">Utility/provider options have not been captured for this home yet. Availability and billing estimates are unknown, not favorable.</p>
      </div>`;
  }

  const estimate = utilities.monthlyEstimate ?? {};
  const included = (estimate.includedServices ?? []).join(', ') || 'None confirmed';
  const optional = (estimate.optionalServices ?? []).join(', ') || 'None listed';
  const blockedSources = (utilities.sourceCoverage ?? []).filter((entry) => ['blocked', 'error'].includes(entry.status));
  const sourceSummary = `${(utilities.sourceCoverage ?? []).length} utility source${(utilities.sourceCoverage ?? []).length === 1 ? '' : 's'} tracked${blockedSources.length ? `; ${blockedSources.length} blocked` : ''}`;

  const summaryRows = [
    ['Low / Typical / High', formatUtilityRange(estimate)],
    ['Confidence', estimate.confidence || 'low'],
    ['Included in total', included],
    ['Optional / not counted', optional],
  ].map(([label, value]) => `
    <tr>
      <th>${escapeHtml(label)}</th>
      <td>${escapeHtml(value)}</td>
    </tr>
  `).join('');

  const providerRows = Object.entries(utilities.providers ?? {})
    .filter(([kind]) => kind !== 'internet')
    .flatMap(([kind, providers]) => (providers ?? []).map((provider) => `
      <tr>
        <td>${escapeHtml(utilityKindLabel(kind))}</td>
        <td>${provider.sourceUrl ? `<a href="${escapeHtml(provider.sourceUrl)}">${escapeHtml(provider.name ?? '--')}</a>` : escapeHtml(provider.name ?? '--')}</td>
        <td>${escapeHtml(formatUtilityStatus(provider.serviceStatus))}</td>
        <td class="num">${escapeHtml(providerEstimateLabel(provider))}</td>
      </tr>
    `)).join('');

  const internetDisplay = buildInternetDisplayRows(utilities);
  const internetRows = internetDisplay.rows.map((entry) => {
    const plan = entry.plan;
    const providerLink = entry.sourceUrl
      ? `<a href="${escapeHtml(entry.sourceUrl)}">${escapeHtml(entry.provider ?? '--')}</a>`
      : escapeHtml(entry.provider ?? '--');
    const planLabel = plan
      ? (plan.sourceUrl ? `<a href="${escapeHtml(plan.sourceUrl)}">${escapeHtml(plan.name ?? 'Plan')}</a>` : escapeHtml(plan.name ?? 'Plan'))
      : '<span class="muted">No priced plan captured</span>';
    const speed = plan
      ? [plan.technology, plan.downloadMbps ? `${plan.downloadMbps} Mbps down` : '', plan.uploadMbps ? `${plan.uploadMbps} Mbps up` : ''].filter(Boolean).join(' / ')
      : '';
    return `
      <tr>
        <td>${providerLink}${entry.selected ? ' <span class="subtle">selected</span>' : ''}</td>
        <td>${escapeHtml(formatUtilityStatus(entry.status))}</td>
        <td>${planLabel}${speed ? `<br><span class="subtle">${escapeHtml(speed)}</span>` : ''}</td>
        <td class="num">${escapeHtml(formatUtilityMoney(plan?.monthlyPrice))}</td>
      </tr>`;
  }).join('');

  const assumptionRows = [
    utilities.assumptions?.electricKwh ? `Electric: ${utilities.assumptions.electricKwh.typical?.toLocaleString?.() ?? utilities.assumptions.electricKwh.typical} kWh/mo typical` : '',
    utilities.assumptions?.waterGallons ? `Water/sewer: ${utilities.assumptions.waterGallons.typical?.toLocaleString?.() ?? utilities.assumptions.waterGallons.typical} gal/mo typical` : '',
    utilities.assumptions?.gasTherms ? `Gas optional: ${utilities.assumptions.gasTherms.typical} therms/mo typical` : '',
  ].filter(Boolean);

  const warnings = [
    ...(utilities.warnings ?? []),
    ...blockedSources.slice(0, 3).map((source) => `${source.name || source.key || 'Utility source'}: ${source.note || source.status}`),
  ];
  const warningRows = warnings.slice(0, 3).map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  const hiddenWarningCount = Math.max(0, warnings.length - 3);

  return `
    <div class="panel wide utilities">
      <h3>Utilities &amp; Monthly Bills</h3>
      <table class="utility-summary"><tbody>${summaryRows}</tbody></table>
      <h4>Core providers</h4>
      <table class="utility-providers">
        <thead><tr><th>Service</th><th>Provider</th><th>Status</th><th class="num">Low / Typical / High</th></tr></thead>
        <tbody>${providerRows || '<tr><td colspan="4" class="muted">No electric, water/sewer, or gas provider estimates captured.</td></tr>'}</tbody>
      </table>
      <h4>Internet options</h4>
      <table class="utility-internet">
        <thead><tr><th>Provider</th><th>Status</th><th>Plan / speed</th><th class="num">Monthly</th></tr></thead>
        <tbody>${internetRows || '<tr><td colspan="4" class="muted">No internet plans captured.</td></tr>'}</tbody>
      </table>
      <p class="utility-source-note">${escapeHtml(sourceSummary)}${internetDisplay.omittedCount ? `; ${internetDisplay.omittedCount} additional internet provider${internetDisplay.omittedCount === 1 ? '' : 's'} in source ledger` : ''}.</p>
      ${assumptionRows.length ? `<p class="utility-assumptions">${escapeHtml(assumptionRows.join(' | '))}</p>` : ''}
      ${warningRows ? `<div class="utility-warnings"><h4>Gaps / cautions</h4><ul>${warningRows}${hiddenWarningCount ? `<li class="muted">${hiddenWarningCount} more caution${hiddenWarningCount === 1 ? '' : 's'} in the utility sidecar.</li>` : ''}</ul></div>` : ''}
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

function buildDevelopmentInfrastructureSection({ construction, permits, developmentText = '', finalist = null }) {
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
      ${finalist ? buildRiskRingMap(finalist) : ''}
      ${finalist?.axis?.riskBuilder?.resaleRiskNote ? `<p class="resale-note riskmap-note"><strong>Resale risk:</strong> ${escapeHtml(finalist.axis.riskBuilder.resaleRiskNote)}</p>` : ''}
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

  return `
    <div class="panel builder wide">
      <h3>Builder Reputation</h3>
      <p><strong>${escapeHtml(builderName)}</strong></p>
      ${rowHtml ? `<table class="builder-status"><tbody>${rowHtml}</tbody></table>` : ''}
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

  for (const flag of finalist?.axis?.sentiment?.redFlagsTriggered ?? []) {
    push(`Deal-breaker red flag from neighborhood sentiment: "${flag}"`);
  }
  if (finalist?.axis?.riskBuilder?.riskLevel === 'high') {
    const topProject = (finalist.axis.riskBuilder.nearbyProjects ?? [])[0];
    push(`Axis risk level HIGH${topProject?.description ? ` — nearest flagged project: ${topProject.description}` : ''}.`);
  }

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

function buildSchoolsCard(report, finalist = null) {
  const metadata = loadSchoolMetadata(report);
  const schoolRows = mergeSchoolRowsForPdf(metadata);

  const axisSchools = finalist?.axis?.schools;
  const axisFlags = (axisSchools?.flags ?? [])
    .map((flag) => `<li>${escapeHtml(String(flag).replace(/-/g, ' '))}</li>`)
    .join('');
  const axisExtras = `
    ${axisSchools?.weightedSchoolScore != null ? `<p class="schoolgauge-note school-weighted">Weighted school score ${gaugeSvg(axisSchools.weightedSchoolScore, { min: 0, max: 1 })} <span class="num pos">${escapeHtml(String(axisSchools.weightedSchoolScore))}</span></p>` : ''}
    ${axisFlags ? `<ul class="school-flags">${axisFlags}</ul>` : ''}`;

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
        ${axisExtras}
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
        ${axisExtras}
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
      ${axisExtras}
      ${footnote}
    </div>`;
}

// ---------------------------------------------------------------------------
// Overview dashboard builders (axis-first)
// ---------------------------------------------------------------------------

function photoDataUri(localPath) {
  const absolute = join(ROOT, localPath);
  if (!existsSync(absolute)) return '';
  try {
    const buffer = readFileSync(absolute);
    if (buffer.length > 2 * 1024 * 1024) return '';
    const ext = absolute.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
    return `data:image/${ext};base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
}

function buildPhotoStrip(finalist) {
  const localPaths = finalist.listing?.photos?.localPaths ?? [];
  const uris = localPaths.map(photoDataUri).filter(Boolean).slice(0, 3);
  if (uris.length === 0) return '';
  const [hero, ...thumbs] = uris;
  const thumbHtml = thumbs.map((uri) => `<div class="photo-thumb" style="background-image:url('${escapeHtml(uri)}')"></div>`).join('');
  return `
    <div class="photo-strip">
      <div class="photo-hero" style="background-image:url('${escapeHtml(hero)}')"></div>
      ${thumbHtml ? `<div class="photo-thumbs">${thumbHtml}</div>` : ''}
    </div>`;
}

function parseMoneyNumber(value) {
  const numeric = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

// The subject home's own tracker row is intentionally included in the median
// ("tracker median"), which biases the delta toward 0 at small n.
export function computeCityMedianPricePerSqft(trackerContent, city) {
  const wanted = String(city ?? '').toLowerCase().trim();
  if (!wanted) return null;
  const values = String(trackerContent ?? '')
    .split(/\r?\n/)
    .map((line, index) => (line.trim().startsWith('|') ? parseListingRow(line, index) : null))
    .filter(Boolean)
    .filter((row) => row.city.toLowerCase().trim() === wanted)
    .map((row) => {
      const price = parseMoneyNumber(row.price);
      const sqft = parseMoneyNumber(row.sqft);
      return price && sqft ? price / sqft : null;
    })
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (values.length < 3) return null;
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  return { median, sampleSize: values.length };
}

function buildKpiTiles(finalist, medianInfo) {
  const report = finalist.report;
  const listing = finalist.listing;
  const price = parseMoneyNumber(listing?.price) ?? parseMoneyNumber(report.metadata.price);
  const sqft = parseMoneyNumber(listing?.sqftFinished) ?? parseMoneyNumber(report.metadata.sqft);
  const pricePerSqft = price && sqft ? price / sqft : null;
  let ppsfDetail = '';
  if (pricePerSqft && medianInfo) {
    const deltaPct = Math.round(((pricePerSqft - medianInfo.median) / medianInfo.median) * 100);
    ppsfDetail = `${deltaPct >= 0 ? '+' : ''}${deltaPct}% vs ${report.city} tracker median (n=${medianInfo.sampleSize})`;
  }
  const tiles = [
    ['Price', price ? `$${price.toLocaleString()}` : firstNonEmpty(report.metadata.price, '--'), ''],
    ['$/SqFt', pricePerSqft ? `$${Math.round(pricePerSqft)}` : '--', ppsfDetail],
    ['Beds/Baths', firstNonEmpty(report.metadata.bedsBaths, listing?.beds != null ? `${listing.beds}/${listing.baths ?? '--'}` : '--'), ''],
    ['SqFt', sqft ? sqft.toLocaleString() : '--', ''],
    ['Lot', firstNonEmpty(report.metadata.lot, listing?.lotSqft ? `${Number(listing.lotSqft).toLocaleString()} sqft` : '--'), ''],
    ['Year', firstNonEmpty(report.metadata.yearBuilt, listing?.yearBuilt, '--'), ''],
    ['HOA', firstNonEmpty(report.metadata.hoa, listing?.hoaMonthly != null ? `$${listing.hoaMonthly}/mo` : '--'), ''],
    ['DOM', firstNonEmpty(report.metadata.daysOnMarket, listing?.daysOnMarket != null ? `${listing.daysOnMarket}d` : '--'), ''],
    ['Status', firstNonEmpty(report.metadata.verification, listing?.listingStatus, '--'), listing?.mls ? `MLS ${listing.mls}` : ''],
  ];
  const cells = tiles.map(([label, value, detail]) => `
    <div class="kpi-tile">
      <div class="kpi-value">${escapeHtml(String(value))}</div>
      <div class="kpi-label">${escapeHtml(label)}</div>
      ${detail ? `<div class="kpi-detail">${escapeHtml(detail)}</div>` : ''}
    </div>`).join('');
  return `<div class="kpi-band">${cells}</div>`;
}

export function parseGateRows(gateSection) {
  const rows = [];
  for (const line of String(gateSection ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || /^\|\s*:?-{2,}/.test(trimmed)) continue;
    const cols = trimmed.split('|').slice(1, -1).map((col) => col.trim());
    if (cols.length < 2) continue;
    const [requirement, result] = cols;
    if (!requirement || /^requirement$/i.test(requirement)) continue;
    const normalized = result.toLowerCase();
    let state = 'unknown';
    if (/^(pass|yes|meets)/.test(normalized)) state = 'pass';
    else if (/^(fail|no\b)/.test(normalized)) state = 'fail';
    rows.push({ requirement, result, state });
  }
  return rows;
}

function buildGateChips(report) {
  const rows = parseGateRows(report.sections['Hard Requirement Gate']);
  if (rows.length === 0) return '';
  const chips = rows.map((row) => {
    const mark = row.state === 'pass' ? '&#10003;' : row.state === 'fail' ? '&#10007;' : '?';
    return `<span class="gate-chip gate-${row.state}" title="${escapeHtml(row.result)}"><span class="gate-mark">${mark}</span>${escapeHtml(row.requirement)}</span>`;
  }).join('');
  return `
    <div class="panel wide gate">
      <h3>Hard Requirement Gate</h3>
      <div class="gate-chips">${chips}</div>
    </div>`;
}

function gaugeSvg(value, { min = -1, max = 1 } = {}) {
  const clamped = Math.max(min, Math.min(max, Number(value) || 0));
  const pct = (clamped - min) / (max - min);
  const width = 160;
  const fill = clamped < 0 ? '#dc2626' : '#16a34a';
  return `<svg class="gauge" width="${width}" height="10" viewBox="0 0 ${width} 10"><rect x="0" y="2" width="${width}" height="6" rx="3" fill="#e5e7eb"></rect><rect x="0" y="2" width="${Math.max(3, Math.round(pct * width))}" height="6" rx="3" fill="${fill}"></rect></svg>`;
}

function buildAxisScoreboard(finalist) {
  const axis = finalist.axis;
  if (!axis) return '';
  const rows = [];
  for (const [dimension, entry] of Object.entries(axis.sentiment?.sentimentScores ?? {})) {
    rows.push(`
      <tr>
        <th>${escapeHtml(dimension.replace(/_/g, ' '))}</th>
        <td>${gaugeSvg(entry?.score)}</td>
        <td class="num ${Number(entry?.score) < 0 ? 'neg' : 'pos'}">${escapeHtml(String(entry?.score ?? '--'))}</td>
      </tr>`);
  }
  if (axis.schools?.weightedSchoolScore != null) {
    rows.push(`
      <tr>
        <th>schools (weighted)</th>
        <td>${gaugeSvg(axis.schools.weightedSchoolScore, { min: 0, max: 1 })}</td>
        <td class="num pos">${escapeHtml(String(axis.schools.weightedSchoolScore))}</td>
      </tr>`);
  }
  const risk = axis.riskBuilder?.riskLevel;
  const riskChip = risk
    ? `<p><span class="risk-chip risk-chip-${escapeHtml(String(risk))}">${escapeHtml(String(risk).toUpperCase())} RISK</span></p>`
    : '';
  if (rows.length === 0 && !riskChip) return '';
  return `
    <div class="panel wide axis-scoreboard axis-panel">
      <h3>Axis Scores <span class="subtle">weight-applied, from axis agents</span></h3>
      ${riskChip}
      ${rows.length ? `<table><tbody>${rows.join('')}</tbody></table>` : ''}
    </div>`;
}

function buildConfidenceChips(finalist) {
  if (!finalist.axis) return '';
  return [
    ['sentiment', finalist.axis.sentiment?.confidence],
    ['risk', finalist.axis.riskBuilder?.confidence],
    ['schools', finalist.axis.schools?.confidence],
  ]
    .filter(([, level]) => level)
    .map(([label, level]) => `<span class="conf-badge conf-${escapeHtml(String(level))}">${escapeHtml(label)}: ${escapeHtml(String(level))}</span>`)
    .join('');
}

function divergingBarSvg(score) {
  const clamped = Math.max(-1, Math.min(1, Number(score) || 0));
  const width = 220;
  const half = width / 2;
  const barWidth = Math.round(Math.abs(clamped) * half);
  const x = clamped < 0 ? half - barWidth : half;
  const fill = clamped < 0 ? '#dc2626' : '#16a34a';
  return `<svg class="diverge" width="${width}" height="12" viewBox="0 0 ${width} 12"><rect x="0" y="3" width="${width}" height="6" rx="3" fill="#f3f4f6"></rect><line x1="${half}" y1="0" x2="${half}" y2="12" stroke="#9ca3af" stroke-width="1"></line><rect x="${x}" y="3" width="${Math.max(2, barWidth)}" height="6" rx="3" fill="${fill}"></rect></svg>`;
}

const PROXIMITY_TIER_LABELS = {
  subdivision: 'subdivision', street: 'street', 'school-zone': 'school-zone', municipal: 'city-wide',
};

// The specificity ladder (Phase 3/5 of the sentiment-capture goal prompt): a
// buyer reading "Community: neutral" is entitled to know whether that
// describes their cul-de-sac or the whole town. Named after the
// highest-priority tier that actually contributed evidence, with the full
// breakdown so a mostly-municipal score doesn't read as street-level.
function describeProximityMix(mix) {
  if (!mix || typeof mix !== 'object') return '';
  const order = ['subdivision', 'street', 'school-zone', 'municipal'];
  const withCounts = order
    .map((tier) => [tier, Number(mix[tier] ?? 0)])
    .filter(([, count]) => count > 0);
  if (withCounts.length === 0) return '';
  const dominant = withCounts[0][0];
  const breakdown = withCounts.map(([tier, count]) => `${PROXIMITY_TIER_LABELS[tier] ?? tier} ×${count}`).join(', ');
  return `tier: ${PROXIMITY_TIER_LABELS[dominant] ?? dominant} (${breakdown})`;
}

// Source-coverage statuses that describe a genuine, checked-but-quiet source
// vs. one that never got the chance to speak render as different chip
// colors -- collapsing them to one look would misreport a quiet
// neighborhood as an unconfirmed one, or vice versa.
function coverageChipClass(status) {
  if (status === 'captured') return 'coverage-chip-captured';
  if (status === 'no-match') return 'coverage-chip-quiet';
  if (status === 'blocked') return 'coverage-chip-blocked';
  if (status === 'skipped-below-tier') return 'coverage-chip-skipped';
  return 'coverage-chip-missing';
}

function buildSentimentAxisSection(finalist) {
  const axisSentiment = finalist.axis?.sentiment;
  if (!axisSentiment?.sentimentScores) return '';
  const dimensions = Object.entries(axisSentiment.sentimentScores).map(([dimension, entry]) => {
    const quotes = (entry?.quotes ?? []).slice(0, 3)
      .map((quote) => `<li class="quote">&ldquo;${escapeHtml(summarizeSection(quote, 200))}&rdquo;</li>`)
      .join('');
    const evidenceCount = Number(entry?.evidenceCount ?? 0);
    const meta = [
      `${evidenceCount} signal${evidenceCount === 1 ? '' : 's'}`,
      describeProximityMix(entry?.proximityMix),
      entry?.source ? String(entry.source) : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="sentiment-dimension">
        <div class="sentiment-row">
          <span class="sentiment-name">${escapeHtml(dimension.replace(/_/g, ' '))}</span>
          ${divergingBarSvg(entry?.score)}
          <span class="num ${Number(entry?.score) < 0 ? 'neg' : 'pos'}">${escapeHtml(String(entry?.score ?? '--'))}</span>
          <span class="subtle">${escapeHtml(meta)}</span>
        </div>
        ${quotes ? `<ul class="quote-list">${quotes}</ul>` : ''}
      </div>`;
  }).join('');
  const redFlags = (axisSentiment.redFlagsTriggered ?? [])
    .map((flag) => `<li>${escapeHtml(flag)}</li>`).join('');
  const coverage = Object.entries(axisSentiment.sourceCoverage ?? {})
    .map(([key, status]) => `<span class="coverage-chip ${coverageChipClass(status)}">${escapeHtml(key)}: ${escapeHtml(String(status))}</span>`)
    .join(' ');
  return `
    <div class="panel wide sentiment-axis">
      <h3>Neighborhood Sentiment <span class="subtle">axis-agent interpretation, buyer-weighted</span></h3>
      ${dimensions}
      ${redFlags ? `<div class="redflag-box"><h4>Deal-breaker red flags</h4><ul>${redFlags}</ul></div>` : ''}
      ${coverage ? `<p class="coverage-row">${coverage}</p>` : ''}
      ${axisSentiment.confidence ? `<p class="muted">Confidence: ${escapeHtml(String(axisSentiment.confidence))}</p>` : ''}
    </div>`;
}

const RING_MAX_MILES = 5;
const RING_MAX_RADIUS_PX = 130;

function hashAngle(value) {
  let hash = 0;
  const text = String(value ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return (Math.abs(hash) % 360) * (Math.PI / 180);
}

export function ringMapPoints(projects) {
  const points = [];
  const legendOnly = [];
  for (const [index, project] of (projects ?? []).entries()) {
    const label = index + 1;
    const distance = Number(project?.distanceMiles);
    if (!Number.isFinite(distance) || distance < 0 || distance > RING_MAX_MILES) {
      legendOnly.push({ label, project });
      continue;
    }
    const angle = hashAngle(project.caseId || project.description || label);
    const radius = (distance / RING_MAX_MILES) * RING_MAX_RADIUS_PX;
    points.push({
      label,
      project,
      x: 150 + radius * Math.cos(angle),
      y: 150 + radius * Math.sin(angle),
    });
  }
  return { points, legendOnly };
}

function projectDotColor(status) {
  const value = String(status ?? '').toLowerCase();
  if (/approved|proposed|planning|review|permit/.test(value)) return '#d97706';
  if (/active|under|construction/.test(value)) return '#dc2626';
  if (/complete|closed|built|open/.test(value)) return '#16a34a';
  return '#64748b';
}

// NOTE: elements below carry both the brief's literal class names (ring-map-wrap,
// ring-map, ring-legend, legend-dot) that tests assert on, and a "riskmap-*"
// companion class that the CSS actually styles against. This keeps the CSS
// text free of the literal substring "ring-map", so the appended stylesheet
// (always emitted, even with no axis data) can't make the negative assertion
// `!bareHtml.includes('ring-map')` false. See the matching CSS block below.
function buildRiskRingMap(finalist) {
  const riskBuilder = finalist?.axis?.riskBuilder;
  const projects = riskBuilder?.nearbyProjects;
  if (!Array.isArray(projects) || projects.length === 0) return '';
  const { points, legendOnly } = ringMapPoints(projects);
  const rings = [1, 3, 5].map((miles) => {
    const radius = (miles / RING_MAX_MILES) * RING_MAX_RADIUS_PX;
    return `<circle cx="150" cy="150" r="${radius}" fill="none" stroke="#cbd5e1" stroke-width="1"></circle><text x="150" y="${150 - radius - 3}" text-anchor="middle" font-size="8" fill="#94a3b8">${miles} mi</text>`;
  }).join('');
  const dots = points.map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="6" fill="${projectDotColor(point.project.status)}"></circle><text x="${point.x.toFixed(1)}" y="${(point.y + 2.6).toFixed(1)}" text-anchor="middle" font-size="7" fill="#ffffff">${point.label}</text>`).join('');
  const legendEntries = [...points, ...legendOnly].map(({ label, project }) => {
    const distanceText = Number.isFinite(Number(project.distanceMiles))
      ? `${Number(project.distanceMiles).toFixed(1)} mi`
      : 'distance unknown';
    return `
      <li>
        <span class="legend-dot riskmap-dot" style="background:${projectDotColor(project.status)}">${label}</span>
        ${escapeHtml(summarizeSection(firstNonEmpty(project.description, project.caseId, 'Project'), 110))}
        <span class="subtle">${escapeHtml(firstNonEmpty(project.status, 'status unknown'))} · ${escapeHtml(distanceText)}${project.source ? ` · ${escapeHtml(project.source)}` : ''}</span>
      </li>`;
  }).join('');
  return `
    <div class="ring-map-wrap riskmap-wrap">
      <svg class="ring-map riskmap-svg" width="300" height="300" viewBox="0 0 300 300">
        ${rings}
        <circle cx="150" cy="150" r="7" fill="#0f172a"></circle>
        <text x="150" y="140" text-anchor="middle" font-size="8" fill="#0f172a">HOME</text>
        ${dots}
      </svg>
      <ol class="ring-legend riskmap-legend">${legendEntries}</ol>
      <p class="muted">Distance rings are to scale; dot bearing is schematic (true direction not captured).</p>
    </div>`;
}

function wrapReportPage(content, extraClass = '') {
  const body = String(content ?? '').trim();
  if (!body) return '';
  const className = ['report-page', extraClass].filter(Boolean).join(' ');
  return `<article class="${escapeHtml(className)}">${body}</article>`;
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
  const hoaBlock = buildHoaRulesCard(finalist);
  const utilitiesBlock = buildUtilitiesOptionsCard(finalist);
  const infrastructureBlock = buildDevelopmentInfrastructureSection({ construction, permits, developmentText, finalist });
  const builderBlock = buildBuilderReputationCard(finalist);
  const schoolsBlock = buildSchoolsCard(report, finalist);
  const commuteBlock = buildCommuteCard(report, profile);
  const snapshotBlock = buildPropertySnapshotCard(finalist);
  const sourceLedgerBlock = buildSourceLedger(finalist);

  const topKpi = (sentiment?.kpiRollup ?? []).slice(0, 5).map((row) => `
    <tr>
      <td>${escapeHtml(row.category)}</td>
      <td class="num">${escapeHtml(String(row.weight))}</td>
      <td class="num">${escapeHtml(String(row.positiveHits))}</td>
      <td class="num">${escapeHtml(String(row.negativeHits))}</td>
      <td class="num ${row.weightedScore < 0 ? 'neg' : 'pos'}">${escapeHtml(String(row.weightedScore))}</td>
    </tr>
  `).join('');

  const sentimentBlock = buildSentimentAxisSection(finalist) || (sentiment
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
      </div>`);

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
  const concernBlock = `
    <div class="panel concerns wide">
      <h3>Top Concerns</h3>
      <ul>${(concerns.length ? concerns : ['(none captured)']).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
    </div>`;
  const medianInfo = computeCityMedianPricePerSqft(options.trackerContent ?? '', report.city);
  const verdict = finalist.axis?.verdict;
  const decisionBody = verdict
    ? `<p><strong>${escapeHtml(String(verdict.recommendation ?? '').toUpperCase())}</strong> — ${escapeHtml(summarizeSection(String(verdict.rationale ?? ''), 600))}</p>${(verdict.inPersonChecks ?? []).length ? `<h4>Check in person</h4><ul>${(verdict.inPersonChecks ?? []).map((check) => `<li>${escapeHtml(check)}</li>`).join('')}</ul>` : ''}`
    : `<p>${escapeHtml(summarizeSection(plainText(recommendationText), 800))}</p>`;
  const overviewPage = wrapReportPage(`
    ${buildPhotoStrip(finalist)}
    ${buildKpiTiles(finalist, medianInfo)}
    ${buildGateChips(report)}
    ${buildAxisScoreboard(finalist)}
    <div class="overview-grid">
      <div class="panel decision wide">
        <h3>Decision Read</h3>
        ${decisionBody}
      </div>
      ${concernBlock}
      ${gapBlock}
    </div>`, 'report-page-overview');
  const compactCards = [utilitiesBlock, hoaBlock, builderBlock, commuteBlock]
    .filter((block) => String(block ?? '').trim());
  const compactPages = [];
  for (let index = 0; index < compactCards.length; index += 2) {
    compactPages.push(wrapReportPage(compactCards.slice(index, index + 2).join('\n'), 'report-page-compact pagepack'));
  }
  const reportPages = [
    overviewPage,
    // The snapshot sits right after the dashboard: it is the deterministic,
    // cited layer the rest of the brief interprets.
    wrapReportPage(snapshotBlock, 'report-page-snapshot'),
    wrapReportPage(sentimentBlock, 'report-page-sentiment'),
    wrapReportPage(infrastructureBlock, 'report-page-infrastructure'),
    wrapReportPage(schoolsBlock, 'report-page-schools'),
    ...compactPages,
    wrapReportPage(sourceLedgerBlock, 'report-page-sources'),
  ].filter(Boolean).join('\n');

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
            ${buildConfidenceChips(finalist)}
          </div>
          ${linkRowHtml}
        </div>
      </header>

      <div class="pages-shell">
        ${reportPages}
      </div>
    </section>
  `;
}

export function buildHtml(finalists, profile, mode = 'batch', context = {}) {
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const showRank = mode === 'batch';
  const finalistSections = finalists
    .map((finalist, idx) => buildFinalistSection(finalist, profile, {
      showRank,
      isFirst: idx === 0,
      trackerContent: context.trackerContent ?? '',
    }))
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
      <p>Each home starts with a decision dashboard containing facts, decision read, top concerns, and research gaps, then deeper evidence sections get their own PDF pages.</p>
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

  /* Section pages and cards */
  .pages-shell { display: block; }
  .report-page {
    page-break-before: always;
    break-before: page;
    padding: 0;
  }
  .report-page:first-of-type {
    page-break-before: auto;
    break-before: auto;
  }
  .pagepack .panel,
  .pagepack .card {
    break-inside: avoid;
    page-break-inside: avoid;
    margin-bottom: 12px;
  }
  .school-flags { margin: 6px 0 0; padding-left: 16px; font-size: 8.6pt; color: #92400e; }
  .schoolgauge-note { font-size: 9pt; margin-top: 8px; }
  .overview-grid {
    display: grid;
    grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
    gap: 12px;
    align-items: start;
  }
  .report-page-overview .panel,
  .report-page-overview .card {
    padding: 10px 12px;
  }
  .report-page-overview .panel p,
  .report-page-overview .card p,
  .report-page-overview .panel li,
  .report-page-overview .card li {
    font-size: 8.9pt;
    line-height: 1.35;
  }
  .report-page-overview .panel h3,
  .report-page-overview .card h3 {
    margin-bottom: 6px;
  }
  .card, .panel {
    border: 1px solid #d1d5db; border-radius: 6px;
    padding: 12px 14px; background: #ffffff;
    break-inside: auto;
    page-break-inside: auto;
    overflow: visible;
  }
  .facts { break-inside: avoid; page-break-inside: avoid; }
  .card.wide, .panel.wide { grid-column: span 2; }
  .report-page > .card,
  .report-page > .panel,
  .report-page > .wide {
    width: 100%;
    grid-column: auto;
  }
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
  .decision h4 { margin: 8px 0 4px; color: #334155; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; }

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

  /* Property Snapshot
     The provenance states must stay visually distinct in print: a blocked
     source has to be impossible to skim as a clean reading. Colour alone is
     not enough for that, so blocked also carries an uppercase label and a
     heavy left rule that survives greyscale printing. */
  .snapshot-legend {
    font-size: 8pt; color: #6b7280; margin: 0 0 10px;
    padding-bottom: 8px; border-bottom: 1px solid #e5e7eb; line-height: 1.9;
  }
  .snapshot-group { margin-bottom: 14px; break-inside: avoid; }
  .snapshot-group h4 {
    font-size: 9pt; text-transform: uppercase; letter-spacing: 0.06em;
    color: #374151; margin: 0 0 6px;
  }
  .snapshot-group.unreviewed { border-left: 3px solid #d1d5db; padding-left: 10px; }
  .snapshot-table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  .snapshot-table th {
    width: 27%; vertical-align: top; text-transform: none;
    letter-spacing: 0; font-size: 8.5pt; background: #f9fafb;
  }
  .snapshot-table td { vertical-align: top; }
  .snapshot-value { font-size: 9.5pt; color: #111827; }
  .snapshot-prov { width: 20%; text-align: right; white-space: nowrap; }
  .snapshot-detail { font-size: 8pt; color: #4b5563; margin-top: 2px; }
  .snapshot-note { font-size: 7.5pt; color: #6b7280; margin-top: 3px; font-style: italic; }
  .snapshot-source { font-size: 7.5pt; color: #6366f1; display: block; margin-top: 3px; }
  .snapshot-blocked-banner {
    font-size: 8pt; color: #991b1b; background: #fef2f2;
    border: 1px solid #fecaca; border-radius: 4px;
    padding: 5px 8px; margin: 0 0 6px;
  }

  .prov-badge {
    display: inline-block; font-size: 7pt; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.04em;
    padding: 1px 5px; border-radius: 3px; border: 1px solid transparent;
  }
  .prov-badge.prov-captured    { background: #ecfdf5; color: #065f46; border-color: #a7f3d0; }
  .prov-badge.prov-unconfirmed { background: #fffbeb; color: #92400e; border-color: #fde68a; }
  .prov-badge.prov-blocked     { background: #fef2f2; color: #991b1b; border-color: #fca5a5; }
  .prov-badge.prov-unsupported { background: #f3f4f6; color: #4b5563; border-color: #d1d5db; }
  .prov-badge.prov-na          { background: #f5f3ff; color: #5b21b6; border-color: #ddd6fe; }

  /* Row-level rules repeat the state so it reads down the page, not just in
     the badge column, and survives a black-and-white print. */
  tr.snapshot-row > th { border-left: 3px solid transparent; }
  tr.snapshot-row.prov-captured    > th { border-left-color: #34d399; }
  tr.snapshot-row.prov-unconfirmed > th { border-left-color: #fbbf24; }
  tr.snapshot-row.prov-blocked     > th { border-left-color: #dc2626; }
  tr.snapshot-row.prov-blocked     > td { background: #fffafa; }
  tr.snapshot-row.prov-unsupported > th { border-left-color: #9ca3af; }
  tr.snapshot-row.prov-na          > th { border-left-color: #a78bfa; }

  .guided-list { margin: 0; padding-left: 16px; font-size: 9pt; }
  .guided-list li { margin-bottom: 6px; }

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
  .hoa {
    background: #f7fee7;
    border-color: #d9f99d;
  }
  .hoa h3 { color: #3f6212; }
  .hoa h4 {
    margin: 8px 0 5px;
    color: #4b5563;
    font-size: 8.5pt;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .hoa-status {
    width: 100%;
    margin-bottom: 8px;
    table-layout: fixed;
  }
  .hoa-status th,
  .hoa-topics th {
    width: 30%;
    text-transform: none;
    letter-spacing: 0;
    font-size: 8.5pt;
    background: #f8fafc;
  }
  .hoa-status td,
  .hoa-topics td { font-size: 9pt; }
  .hoa-docs,
  .hoa-open {
    margin: 0 0 8px;
    padding-left: 14px;
    font-size: 8.5pt;
  }
  .hoa-docs li,
  .hoa-open li { margin-bottom: 3px; }
  .utilities {
    background: #f0fdfa;
    border-color: #99f6e4;
  }
  .utilities h3 { color: #0f766e; }
  .utilities h4 {
    margin: 8px 0 5px;
    color: #334155;
    font-size: 8.5pt;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .utility-summary,
  .utility-providers,
  .utility-internet {
    width: 100%;
    margin-bottom: 8px;
    table-layout: fixed;
  }
  .utility-summary th {
    width: 32%;
    text-transform: none;
    letter-spacing: 0;
    font-size: 8.4pt;
    background: #f8fafc;
  }
  .utility-summary td,
  .utility-providers td,
  .utility-internet td { font-size: 8.7pt; }
  .utility-assumptions {
    border-top: 1px dashed #99f6e4;
    padding-top: 7px;
    color: #475569;
    font-size: 8.3pt !important;
  }
  .utility-source-note {
    color: #64748b;
    font-size: 8.1pt !important;
    margin: 2px 0 5px;
  }
  .utility-warnings {
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 5px;
    padding: 7px 9px;
    margin-top: 8px;
  }
  .utility-warnings ul {
    margin: 0;
    padding-left: 14px;
    font-size: 8.3pt;
  }
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

  /* Overview dashboard */
  .photo-strip { display: flex; gap: 6px; margin-bottom: 12px; height: 2.2in; }
  .photo-hero { flex: 2; border-radius: 8px; background-size: cover; background-position: center; }
  .photo-thumbs { flex: 1; display: flex; flex-direction: column; gap: 6px; }
  .photo-thumb { flex: 1; border-radius: 8px; background-size: cover; background-position: center; }
  .kpi-band {
    display: grid; grid-template-columns: repeat(9, minmax(0, 1fr));
    gap: 6px; margin-bottom: 12px;
  }
  .kpi-tile {
    border: 1px solid #e5e7eb; border-radius: 6px; padding: 7px 6px;
    text-align: center; background: #f8fafc;
  }
  .kpi-value { font-size: 10.5pt; font-weight: 700; color: #0f172a; }
  .kpi-label { font-size: 7pt; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin-top: 2px; }
  .kpi-detail { font-size: 6.6pt; color: #475569; margin-top: 2px; }
  .gate { margin-bottom: 12px; }
  .gate-chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .gate-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 9px; border-radius: 999px; font-size: 8pt; font-weight: 600;
  }
  .gate-pass { background: #dcfce7; color: #166534; }
  .gate-fail { background: #fee2e2; color: #991b1b; }
  .gate-unknown { background: #fef3c7; color: #92400e; }
  .gate-mark { font-weight: 800; }
  .axis-panel { margin-bottom: 12px; }
  .axis-panel th { width: 30%; text-transform: none; letter-spacing: 0; background: #f8fafc; }
  .gauge { vertical-align: middle; }
  .conf-badge {
    padding: 3px 8px; border-radius: 999px; font-size: 8pt; font-weight: 600;
  }
  .conf-high { background: #dcfce7; color: #166534; }
  .conf-medium { background: #fef3c7; color: #92400e; }
  .conf-low { background: #fee2e2; color: #991b1b; }
  .risk-chip {
    padding: 3px 10px; border-radius: 999px; font-size: 8.5pt; font-weight: 800;
    letter-spacing: 0.04em;
  }
  .risk-chip-low { background: #dcfce7; color: #166534; }
  .risk-chip-moderate { background: #fef3c7; color: #92400e; }
  .risk-chip-high { background: #fee2e2; color: #991b1b; }
  /* Sentiment axis page */
  .sentiment-dimension { padding: 6px 0; border-bottom: 1px dashed #e5e7eb; }
  .sentiment-dimension:last-of-type { border-bottom: 0; }
  .sentiment-row { display: flex; align-items: center; gap: 10px; }
  .sentiment-name { min-width: 110px; font-weight: 600; font-size: 9.5pt; color: #1f2937; }
  .quote-list { margin: 4px 0 0 120px; padding-left: 12px; }
  .quote { font-size: 8.6pt; color: #475569; font-style: italic; }
  .redflag-box {
    background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px;
    padding: 8px 10px; margin-top: 10px;
  }
  .redflag-box h4 { margin: 0 0 5px; color: #991b1b; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; }
  .redflag-box ul { margin: 0; padding-left: 14px; font-size: 8.8pt; }
  .coverage-row { margin-top: 8px; }
  .coverage-chip {
    display: inline-block; padding: 2px 8px; margin-right: 4px;
    border: 1px solid #e5e7eb; border-radius: 999px; font-size: 7.6pt; color: #475569;
  }
  /* captured (even with zero evidence -- a quiet area is a finding) reads
     neutral; blocked/skipped (never reached) read as an open question. */
  .coverage-chip-captured, .coverage-chip-quiet { background: #f8fafc; color: #475569; border-color: #e5e7eb; }
  .coverage-chip-blocked, .coverage-chip-skipped, .coverage-chip-missing { background: #fef3c7; color: #92400e; border-color: #fde68a; }
  /* Risk distance-ring map (styled via companion classes; see briefing-pdf.mjs
     comment above buildRiskRingMap for why the CSS selectors are renamed) */
  .riskmap-wrap { display: flex; gap: 14px; align-items: flex-start; margin: 8px 0 10px; }
  .riskmap-svg { flex-shrink: 0; }
  .riskmap-legend { margin: 0; padding-left: 0; list-style: none; font-size: 8.4pt; }
  .riskmap-legend li { margin-bottom: 6px; }
  .riskmap-dot {
    display: inline-flex; align-items: center; justify-content: center;
    width: 14px; height: 14px; border-radius: 50%;
    color: #ffffff; font-size: 7pt; font-weight: 700; margin-right: 5px;
  }
  .riskmap-note { font-size: 9pt; margin-top: 4px; }
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

export function loadFinalist(reportPath, rank = 1) {
  const report = parseReport(ROOT, reportPath);
  const constructionCompanion = loadCompanionForReport(report, CONSTRUCTION_DIR, 'Construction');
  const permitsCompanion = loadCompanionForReport(report, PERMITS_DIR, 'Permits');
  const sentimentCompanion = loadCompanionForReport(report, SENTIMENT_DIR, 'Sentiment');
  const packetCompanion = loadCompanionForReport(report, DEEP_PACKET_DIR, 'Deep packet');
  const builderCompanion = loadCompanionForReport(report, BUILDER_DIR, 'Builder');
  const hoaCompanion = loadCompanionForReport(report, HOA_DIR, 'HOA');
  const utilitiesCompanion = loadUtilityOptionsForReport(report);
  const hazardsCompanion = loadCompanionForReport(report, HAZARDS_DIR, 'Site hazards');
  const parcelCompanion = loadCompanionForReport(report, PARCEL_DIR, 'Parcel/tax');
  const accessCompanion = loadCompanionForReport(report, ACCESS_DIR, 'Access');
  const axisCompanion = loadCompanionForReport(report, AXIS_DIR, 'Axis');
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
    hoaRules: hoaCompanion.data,
    utilities: utilitiesCompanion.data,
    hazards: hazardsCompanion.data,
    parcel: parcelCompanion.data,
    access: accessCompanion.data,
    packet: packetCompanion.data,
    listing,
    community,
    axis: axisCompanion.data,
    constructionMismatch: constructionCompanion.mismatchMessage,
    permitsMismatch: permitsCompanion.mismatchMessage,
    sentimentMismatch: sentimentCompanion.mismatchMessage,
    builderMismatch: builderCompanion.mismatchMessage,
    hoaMismatch: hoaCompanion.mismatchMessage,
    utilitiesMismatch: utilitiesCompanion.mismatchMessage,
    hazardsMismatch: hazardsCompanion.mismatchMessage,
    parcelMismatch: parcelCompanion.mismatchMessage,
    accessMismatch: accessCompanion.mismatchMessage,
    packetMismatch: packetCompanion.mismatchMessage,
    axisMismatch: axisCompanion.mismatchMessage,
  };
}

function loadFinalists() {
  const shortlist = parseShortlist(ROOT);
  if (!shortlist.refinedTop3 || shortlist.refinedTop3.length === 0) {
    throw new Error('No refined top-3 homes found in data/shortlist.md. Run deep mode before generating the briefing.');
  }

  return shortlist.refinedTop3.map((row, index) => loadFinalist(row.reportPath, row.rank || index + 1));
}

async function renderPdf(html, outputPath, footerLeft = 'Home-Ops Decision Brief') {
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
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `
        <div style="width:100%;font-size:7pt;color:#9ca3af;padding:0 0.5in;display:flex;justify-content:space-between;">
          <span>${escapeHtml(footerLeft)}</span>
          <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
        </div>`,
      margin: { top: '0.5in', bottom: '0.65in', left: '0.5in', right: '0.5in' },
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

  const trackerContent = existsSync(LISTINGS_FILE) ? readFileSync(LISTINGS_FILE, 'utf8') : '';
  const html = buildHtml(finalists, profile, mode, { trackerContent });
  const footerLeft = mode === 'single'
    ? [finalists[0].report.address, finalists[0].report.city].filter(Boolean).join(', ') || 'Home-Ops Decision Brief'
    : mode === 'combined'
      ? 'Home-Ops URL Deep Briefing'
      : 'Home-Ops Top 3 Finalist Briefing';
  await renderPdf(html, outputPath, footerLeft);
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
