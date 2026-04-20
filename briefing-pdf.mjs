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
import { readSessionState } from './browser-session.mjs';
import {
  ROOT,
  parseReport,
  parseShortlist,
} from './research-utils.mjs';

const DEFAULT_PROFILE = 'chrome-host';
const OUTPUT_DIR = join(ROOT, 'output', 'briefings');
const SENTIMENT_DIR = join(ROOT, 'output', 'sentiment');
const CONSTRUCTION_DIR = join(ROOT, 'output', 'construction');
const DEEP_PACKET_DIR = join(ROOT, 'output', 'deep-packets');

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
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
  }
  return config;
}

function slugify(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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

function normalizeLocationToken(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function companionMatchesReport(companion, report) {
  if (!companion || !report) return false;
  return normalizeLocationToken(companion.address) === normalizeLocationToken(report.address)
    && normalizeLocationToken(companion.city) === normalizeLocationToken(report.city)
    && normalizeLocationToken(companion.state || 'NC') === normalizeLocationToken(report.state || 'NC');
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
  const match = String(raw ?? '').match(/(\d+)\s*\/?\s*\d+(?:\.\d+)?/);
  return match ? Number.parseInt(match[1], 10) : null;
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

  const buyerName = profile?.buyer?.full_name ? escapeHtml(profile.buyer.full_name.split(/\s+/)[0]) : 'you';

  return `
    <div class="card fit wide">
      <h3>Why this fits ${buyerName}</h3>
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

  const strengths = extractBullets(report.sections['Quick Take']).slice(0, 3);
  const concerns = extractBullets(report.sections['Risks and Open Questions']).slice(0, 3);

  const constructionBlock = construction
    ? `
      <div class="card construction">
        <h3>Construction Pressure</h3>
        <p class="pressure-level ${escapeHtml(construction.level)}">${escapeHtml(String(construction.level || 'unknown').toUpperCase())}</p>
        <p class="stat">Road-project score: <strong>${escapeHtml(String(construction.constructionPressure ?? 'n/a'))}/10</strong></p>
        <p class="stat">Active-phase hits: <strong>${escapeHtml(String(construction.phaseTotals?.active ?? 0))}</strong></p>
        <p class="stat">Matched snippets: <strong>${escapeHtml(String(construction.matches?.length ?? 0))}</strong></p>
      </div>`
    : `
      <div class="card construction unreviewed">
        <h3>Construction Pressure</h3>
        <p class="pressure-level unknown">NOT YET CAPTURED</p>
        <p class="muted">Flagged in the research gaps below so it can be filled in before you decide.</p>
      </div>`;

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
        <h3>Neighborhood Sentiment <span class="subtle">Facebook &middot; Nextdoor &middot; profile-weighted</span></h3>
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
          <p class="locality">${escapeHtml(report.city)}, ${escapeHtml(report.state)}</p>
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
        <div class="card strengths">
          <h3>Top Strengths</h3>
          <ul>${(strengths.length ? strengths : ['(none captured)']).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
        </div>
        <div class="card concerns">
          <h3>Top Concerns</h3>
          <ul>${(concerns.length ? concerns : ['(none captured)']).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
        </div>
        ${constructionBlock}
        ${sentimentBlock}
        ${gapBlock}
        <div class="card recommendation wide">
          <h3>Recommendation</h3>
          <p>${escapeHtml(summarizeSection(report.sections['Recommendation'], 700))}</p>
        </div>
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
</style>
</head>
<body>
  <section class="cover">
    <div class="brand">Home-Ops &middot; Decision Brief</div>
    <h1>Top 3 Finalist Briefing</h1>
    <p class="cover-meta">Generated ${escapeHtml(generatedAt)} UTC &middot; ${escapeHtml(String(finalists.length))} finalist${finalists.length === 1 ? '' : 's'}${buyerLabel}</p>
    ${toc}
    <div class="cover-legend">
      <p>Each page shows a quick take, a "why this fits" summary tied to your buyer profile, top strengths and concerns, construction pressure, neighborhood sentiment, research gaps, and the final recommendation.</p>
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
    return {
      rank: row.rank || index + 1,
      report,
      construction: constructionCompanion.data,
      sentiment: sentimentCompanion.data,
      packet: packetCompanion.data,
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
