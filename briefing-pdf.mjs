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

function buildFinalistSection(finalist) {
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
        <p class="stat">NCDOT score: <strong>${escapeHtml(String(construction.constructionPressure ?? 'n/a'))}/10</strong></p>
        <p class="stat">Match count: <strong>${escapeHtml(String(construction.matches?.length ?? 0))}</strong></p>
        <p class="muted">Sources reachable: ${escapeHtml(String((construction.sourcesChecked ?? []).filter((s) => s.ok).length))}/${escapeHtml(String((construction.sourcesChecked ?? []).length))}</p>
      </div>`
    : `
      <div class="card construction unreviewed">
        <h3>Construction Pressure</h3>
        <p class="pressure-level unknown">NOT REVIEWED</p>
        <p class="muted">Run <code>npm run check:construction -- --top3</code> to populate.</p>
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
        <h3>Sentiment KPIs <span class="subtle">FB &middot; Nextdoor &middot; profile-weighted</span></h3>
        <table>
          <thead>
            <tr><th>Category</th><th class="num">Weight</th><th class="num">+ Hits</th><th class="num">- Hits</th><th class="num">Weighted</th></tr>
          </thead>
          <tbody>${topKpi || '<tr><td colspan="5" class="muted">No KPI rollup captured.</td></tr>'}</tbody>
        </table>
      </div>`
    : `
      <div class="card wide unreviewed">
        <h3>Sentiment KPIs</h3>
        <p class="muted">No browser-captured sentiment. Run <code>npm run extract:sentiment -- --top3 --profile chrome-host</code> first.</p>
      </div>`;

  const auditBlockers = packet?.audit?.criticalFindings ?? [];
  const auditBlock = auditBlockers.length > 0
    ? `
      <div class="card wide warn">
        <h3>Open Research Gaps</h3>
        <ul>${auditBlockers.slice(0, 5).map((f) => `<li><strong>${escapeHtml(f.heading)}:</strong> ${escapeHtml(f.message)}</li>`).join('')}</ul>
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
        ${auditBlock}
        <div class="card recommendation wide">
          <h3>Recommendation</h3>
          <p>${escapeHtml(summarizeSection(report.sections['Recommendation'], 700))}</p>
        </div>
      </div>
    </section>
  `;
}

function buildHtml(finalists) {
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const finalistSections = finalists.map((finalist) => buildFinalistSection(finalist)).join('\n');
  const toc = buildCoverToc(finalists);

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
  code {
    background: #f3f4f6; padding: 1px 5px; border-radius: 4px;
    font-size: 8.5pt; color: #1f2937; font-family: "SF Mono", Menlo, Consolas, monospace;
  }

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
    <p class="cover-meta">Generated ${escapeHtml(generatedAt)} UTC &middot; ${escapeHtml(String(finalists.length))} finalist${finalists.length === 1 ? '' : 's'}</p>
    ${toc}
    <div class="cover-legend">
      <p>Each page summarizes quick take, top strengths and concerns, construction pressure (NCDOT), profile-weighted sentiment KPIs, open research gaps, and the final recommendation from the evaluation report.</p>
      <p>Signals marked <strong>NOT REVIEWED</strong> have not been captured yet and should be treated as unknown, not favorable. Tap a finalist above to jump to its page; listing links on each page open directly in the browser.</p>
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
    const slug = slugify(`${report.address}-${report.city}-${report.state || 'NC'}`);
    return {
      rank: row.rank || index + 1,
      report,
      construction: readJsonIfExists(join(CONSTRUCTION_DIR, `${slug}.json`)),
      sentiment: readJsonIfExists(join(SENTIMENT_DIR, `${slug}.json`)),
      packet: readJsonIfExists(join(DEEP_PACKET_DIR, `${slug}.json`)),
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
  const html = buildHtml(finalists);
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
