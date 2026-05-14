#!/usr/bin/env node

/**
 * hoa-docs-check.mjs -- Public HOA document lookup for a single home.
 *
 * This is intentionally evidence-first: listing facts provide clues, public
 * HOA/community pages provide stronger confirmation, and hosted/recorded docs
 * provide the best source for buyer-relevant rule topics. Missing docs stay
 * unconfirmed rather than being inferred from generic HOA expectations.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { inflateSync } from 'zlib';
import { ROOT } from '../shared/paths.mjs';
import { slugify } from '../shared/text-utils.mjs';
import {
  extractSubdivisionHints,
  loadResearchConfig,
  parseReport,
  parseShortlist,
} from './research-utils.mjs';
import { crawl4aiFetchPage } from './crawl4ai-utils.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'hoa');
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_SEARCH_QUERIES = 4;
const MAX_DISCOVERED_PAGES = 8;
const MAX_DISCOVERED_DOCS = 12;

const HELP_TEXT = `Usage:
  node hoa-docs-check.mjs reports/039-7040-rex-rd-2026-05-13.md [--update-report]
  node hoa-docs-check.mjs --listing output/listings/7040-rex-rd-holly-springs-nc.json
  node hoa-docs-check.mjs --url <listing-url> [--url <alternate-url> ...]
  node hoa-docs-check.mjs --address "7040 Rex Rd" --city "Holly Springs" [--community Avocet]
  node hoa-docs-check.mjs --shortlist

Finds public HOA/community pages and governing docs, writes
output/hoa/<slug>.json, and optionally inserts a concise HOA Rules and
Restrictions section into a report.

Options:
  --listing <path>       Read listing facts JSON from output/listings/.
  --report <path>        Read one report. Positional report paths are also accepted.
  --url <url>            Listing/source URL. Repeatable; first URL can anchor address parsing.
  --address <value>      Manual address fallback.
  --city <value>         Manual city fallback.
  --state <value>        Manual state fallback. Defaults to NC.
  --community <value>    Manual subdivision/community/HOA hint.
  --hoa <value>          Manual HOA dues text, e.g. "$90/mo".
  --shortlist            Use current populated Top 10 rows.
  --top3                 Use current refined top 3 rows.
  --update-report        Insert/replace HOA Rules and Restrictions in the report.
  --no-search            Skip search-engine discovery; use known/source/community URLs only.
  --json                 Print JSON summary.
  --help                 Show this help text.`;

const KNOWN_HOA_SEEDS = [
  {
    key: '7040-rex-rd-holly-springs-nc-avocet',
    addressPattern: /\b7040\s+rex\s+rd\b/i,
    cityPattern: /\bholly\s+springs\b/i,
    communityPattern: /\bavocet\b/i,
    communityName: 'Avocet',
    associationName: 'Avocet Home Owners Association',
    managementCompany: 'Community Association Services, Inc.',
    urls: [
      {
        label: 'CAS Avocet community page',
        url: 'https://www.casnc.com/communities/avocet/',
        kind: 'management-page',
        sourceType: 'official-hoa-page',
      },
      {
        label: 'Avocet Covenants',
        url: 'https://www.casnc.com/docs/Avocet/Avocet%20Covenants.pdf',
        kind: 'governing-document',
        documentType: 'covenants',
        sourceType: 'official-hosted-document',
      },
      {
        label: 'Avocet Articles',
        url: 'https://www.casnc.com/docs/Avocet/Articles.pdf',
        kind: 'governing-document',
        documentType: 'articles',
        sourceType: 'official-hosted-document',
      },
    ],
  },
];

const TOPIC_DEFS = [
  {
    key: 'rentals',
    topic: 'Rental restrictions',
    patterns: [/\bleas(?:e|ing)\b/i, /\brent(?:al|ing|ed)?\b/i, /\btenant\b/i, /\bshort[-\s]?term\b/i, /\bairbnb\b/i, /\bvrbo\b/i],
    summary: 'Public HOA documents contain rental or leasing language. Review the exact clauses before relying on rental flexibility.',
  },
  {
    key: 'exterior',
    topic: 'Exterior and architectural approval',
    patterns: [/\barchitectural\b/i, /\barchitecture\b/i, /\barc\b/i, /\bapproval\b/i, /\bexterior\b/i, /\bfence\b/i, /\bpaint\b/i, /\bshed\b/i, /\baddition\b/i, /\blandscap/i],
    summary: 'Public HOA documents contain exterior or architectural-control language. Verify fence, shed, paint, addition, and landscaping approval rules before offer.',
  },
  {
    key: 'parking',
    topic: 'Parking, trailers, boats, and RVs',
    patterns: [/\bparking\b/i, /\bvehicle\b/i, /\btrailer\b/i, /\bboat\b/i, /\brv\b/i, /\brecreational vehicle\b/i, /\bcommercial vehicle\b/i, /\bstreet parking\b/i],
    summary: 'Public HOA documents contain vehicle, parking, or storage language. Confirm overnight street parking, RV, boat, trailer, and commercial-vehicle limits.',
  },
  {
    key: 'pets',
    topic: 'Pets and nuisance rules',
    patterns: [/\bpet\b/i, /\banimal\b/i, /\bdog\b/i, /\bcat\b/i, /\bnuisance\b/i, /\bnoise\b/i],
    summary: 'Public HOA documents contain pet, animal, nuisance, or noise language. Check whether any pet limits or nuisance standards affect the household.',
  },
  {
    key: 'amenities',
    topic: 'Amenities and pool rules',
    patterns: [/\bpool\b/i, /\bamenit(?:y|ies)\b/i, /\bclubhouse\b/i, /\brecreation\b/i, /\bcommon area\b/i],
    summary: 'Public HOA documents contain amenity, pool, or common-area language. Confirm access rights, guest rules, and any separate amenity fees.',
  },
  {
    key: 'enforcement',
    topic: 'Fines, enforcement, and assessments',
    patterns: [/\bfine\b/i, /\bviolation\b/i, /\benforce/i, /\bassessment\b/i, /\blien\b/i, /\bpenalt/i, /\bnotice\b/i],
    summary: 'Public HOA documents contain enforcement, assessment, lien, notice, or violation language. Request the current fine schedule, reserves, and pending-assessment status.',
  },
];

function parseArgs(argv) {
  const config = {
    files: [],
    listingPath: '',
    reportPath: '',
    urls: [],
    address: '',
    city: '',
    state: 'NC',
    community: '',
    hoa: '',
    shortlist: false,
    top3: false,
    updateReport: false,
    noSearch: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--update-report') { config.updateReport = true; continue; }
    if (arg === '--no-search') { config.noSearch = true; continue; }
    if (arg === '--listing') { config.listingPath = argv[++index] ?? ''; continue; }
    if (arg === '--report') { config.reportPath = argv[++index] ?? ''; continue; }
    if (arg === '--url' || arg === '--source-url') { config.urls.push(argv[++index] ?? ''); continue; }
    if (arg === '--address') { config.address = argv[++index] ?? ''; continue; }
    if (arg === '--city') { config.city = argv[++index] ?? ''; continue; }
    if (arg === '--state') { config.state = argv[++index] ?? 'NC'; continue; }
    if (arg === '--community' || arg === '--subdivision') { config.community = argv[++index] ?? ''; continue; }
    if (arg === '--hoa') { config.hoa = argv[++index] ?? ''; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    config.files.push(arg);
  }

  return config;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleCaseSlug(slug) {
  return String(slug ?? '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^(nc|sc|usa)$/i.test(part)) return part.toUpperCase();
      if (/^(rd|ln|dr|ct|st|ave|pl|pkwy|blvd|hwy)$/i.test(part)) return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(' ');
}

function parseHoaMonthly(value) {
  const text = String(value ?? '').toLowerCase();
  if (!text || /unknown|n\/a|not recorded/.test(text)) return null;
  if (/no\s+hoa|none|\$0(?:\.00)?/.test(text)) return 0;
  const match = text.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return null;
  if (/\bannual|year|\/yr|\/year\b/i.test(text)) return Math.round(amount / 12);
  return amount;
}

function loadListingCompanion(address, city, state = 'NC') {
  const slug = slugify(`${address}-${city}-${state || 'NC'}`);
  if (!slug) return null;
  const filePath = join(ROOT, 'output', 'listings', `${slug}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const listing = JSON.parse(readFileSync(filePath, 'utf8'));
    if (normalizeKey(listing.address) !== normalizeKey(address)) return null;
    if (normalizeKey(listing.city) !== normalizeKey(city)) return null;
    return listing;
  } catch {
    return null;
  }
}

function reportTarget(reportPath, config) {
  const report = parseReport(ROOT, reportPath);
  const listing = loadListingCompanion(report.address, report.city, report.state || 'NC');
  const subdivisions = extractSubdivisionHints(report);
  return {
    address: report.address,
    city: report.city,
    state: report.state || 'NC',
    zip: normalizeText(listing?.zip),
    communityName: config.community || listing?.communityName || listing?.subdivision || subdivisions[0] || '',
    hoaMonthly: listing?.hoaMonthly !== null && listing?.hoaMonthly !== undefined && listing?.hoaMonthly !== '' && Number.isFinite(Number(listing.hoaMonthly))
      ? Number(listing.hoaMonthly)
      : parseHoaMonthly(config.hoa || report.metadata.hoa || listing?.hoaText || listing?.hoa),
    hoaText: config.hoa || report.metadata.hoa || listing?.hoaText || (listing?.hoaMonthly != null ? `$${listing.hoaMonthly}/mo` : ''),
    sourceUrls: [report.metadata.url, listing?.canonicalUrl, listing?.url, ...config.urls].filter(Boolean),
    reportPath: report.relativePath,
    reportAbsolutePath: report.filePath,
    mls: normalizeText(listing?.mls),
    builderName: normalizeText(listing?.builderName),
    inputKind: 'report',
  };
}

function listingTarget(listingPath, config) {
  const listing = JSON.parse(readFileSync(listingPath, 'utf8'));
  return {
    address: normalizeText(listing.address),
    city: normalizeText(listing.city),
    state: normalizeText(listing.state || 'NC'),
    zip: normalizeText(listing.zip),
    communityName: normalizeText(config.community || listing.communityName || listing.subdivision),
    hoaMonthly: listing.hoaMonthly !== null && listing.hoaMonthly !== undefined && listing.hoaMonthly !== '' && Number.isFinite(Number(listing.hoaMonthly))
      ? Number(listing.hoaMonthly)
      : parseHoaMonthly(config.hoa || listing.hoaText || listing.hoa),
    hoaText: config.hoa || listing.hoaText || (listing.hoaMonthly != null ? `$${listing.hoaMonthly}/mo` : ''),
    sourceUrls: [listing.canonicalUrl, listing.url, ...config.urls].filter(Boolean),
    reportPath: null,
    reportAbsolutePath: null,
    mls: normalizeText(listing.mls),
    builderName: normalizeText(listing.builderName),
    inputKind: 'listing',
  };
}

function cityNamesFromProfile() {
  const context = loadResearchConfig(ROOT);
  const names = (context.profile.search?.areas ?? [])
    .map((area) => area?.name)
    .filter(Boolean);
  return [...new Set([...names, 'Holly Springs', 'Fuquay-Varina', 'Willow Spring', 'Apex', 'Cary', 'Raleigh'])];
}

function deriveTargetFromUrl(urls, config) {
  const cities = cityNamesFromProfile();
  for (const rawUrl of urls) {
    try {
      const url = new URL(rawUrl);
      const path = decodeURIComponent(url.pathname);
      const host = url.hostname.toLowerCase();

      if (host.includes('redfin.com')) {
        const parts = path.split('/').filter(Boolean);
        const state = parts[0] || config.state || 'NC';
        const city = titleCaseSlug(parts[1] || config.city);
        const addressSlug = String(parts[2] || '').replace(/-\d{5}(?:-\d{4})?$/i, '');
        if (addressSlug && city) {
          return manualTarget({
            ...config,
            address: titleCaseSlug(addressSlug),
            city,
            state,
          }, 'url');
        }
      }

      if (host.includes('realtor.com')) {
        const match = path.match(/realestateandhomes-detail\/([^/]+)/i);
        if (match) {
          const parts = match[1].split('_');
          if (parts.length >= 3) {
            return manualTarget({
              ...config,
              address: titleCaseSlug(parts[0]),
              city: titleCaseSlug(parts[1]),
              state: parts[2] || config.state || 'NC',
            }, 'url');
          }
        }
      }

      if (host.includes('homes.com')) {
        const match = path.match(/property\/([^/]+)/i);
        if (match) {
          const slug = match[1].toLowerCase();
          for (const cityName of cities) {
            const citySlug = slugify(cityName);
            const stateSlug = slugify(config.state || 'NC');
            const marker = `-${citySlug}-${stateSlug}`;
            const markerIndex = slug.indexOf(marker);
            if (markerIndex > 0) {
              return manualTarget({
                ...config,
                address: titleCaseSlug(slug.slice(0, markerIndex)),
                city: cityName,
                state: config.state || 'NC',
              }, 'url');
            }
          }
        }
      }
    } catch {
      // Try the next URL.
    }
  }

  throw new Error('Could not derive address/city from URL. Provide --address and --city, or use --listing/--report.');
}

function manualTarget(config, inputKind = 'manual') {
  if (!config.address || !config.city) {
    throw new Error('Manual HOA lookup requires --address and --city.');
  }
  return {
    address: normalizeText(config.address),
    city: normalizeText(config.city),
    state: normalizeText(config.state || 'NC'),
    zip: '',
    communityName: normalizeText(config.community),
    hoaMonthly: parseHoaMonthly(config.hoa),
    hoaText: normalizeText(config.hoa),
    sourceUrls: config.urls.filter(Boolean),
    reportPath: null,
    reportAbsolutePath: null,
    mls: '',
    builderName: '',
    inputKind,
  };
}

function resolveTargets(config) {
  if (config.shortlist || config.top3) {
    const shortlist = parseShortlist(ROOT);
    const rows = config.top3 ? shortlist.refinedTop3 : shortlist.top10;
    if (rows.length === 0) {
      throw new Error(config.top3 ? 'No refined top-3 homes found in data/shortlist.md.' : 'No populated top-10 homes found in data/shortlist.md.');
    }
    return rows.map((row) => reportTarget(row.reportPath, config));
  }

  const reportPaths = [config.reportPath, ...config.files].filter(Boolean);
  if (reportPaths.length > 0) {
    return reportPaths.map((path) => reportTarget(path, config));
  }

  if (config.listingPath) {
    return [listingTarget(config.listingPath, config)];
  }

  if (config.address || config.city) {
    return [manualTarget(config)];
  }

  if (config.urls.length > 0) {
    return [deriveTargetFromUrl(config.urls, config)];
  }

  throw new Error('Provide a report path, --listing, --url, --shortlist, or --address + --city.');
}

function matchKnownSeed(target) {
  const address = normalizeText(target.address);
  const city = normalizeText(target.city);
  const community = normalizeText(target.communityName);
  return KNOWN_HOA_SEEDS.find((seed) => (
    (seed.addressPattern.test(address) && seed.cityPattern.test(city))
    || (community && seed.communityPattern.test(community))
  )) ?? null;
}

function docTypeFromLabel(label, url) {
  const text = `${label} ${url}`.toLowerCase();
  if (/covenant|cc&r|ccr|restriction|declaration/.test(text)) return 'covenants';
  if (/bylaw/.test(text)) return 'bylaws';
  if (/article/.test(text)) return 'articles';
  if (/architectural|arc|design|guideline/.test(text)) return 'architectural-guidelines';
  if (/pool/.test(text)) return 'pool-rules';
  if (/rule|regulation/.test(text)) return 'rules';
  if (/amend/.test(text)) return 'amendment';
  return 'document';
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtml(html) {
  return decodeEntities(String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function extractHtmlLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html ?? '').matchAll(re)) {
    try {
      const url = normalizeDiscoveredUrl(match[1], baseUrl);
      if (!url) continue;
      const label = stripHtml(match[2]).slice(0, 160) || url;
      links.push({ label, url });
    } catch {
      // Ignore malformed links.
    }
  }
  return links;
}

function normalizeDiscoveredUrl(raw, baseUrl) {
  if (!raw || /^mailto:|^tel:|^javascript:/i.test(raw)) return '';
  const parsed = new URL(raw, baseUrl);
  if (parsed.hostname.includes('google.') && parsed.pathname === '/url' && parsed.searchParams.get('q')) {
    return parsed.searchParams.get('q');
  }
  return parsed.href.split('#')[0];
}

function dedupeByUrl(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const url = normalizeText(entry.url);
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...entry, url });
  }
  return out;
}

function isDocumentUrl(url, label = '') {
  const text = `${url} ${label}`.toLowerCase();
  return /\.pdf(?:$|\?)/i.test(url)
    || /\.(?:doc|docx)(?:$|\?)/i.test(url)
    || /covenant|bylaw|architectural|guideline|rules|regulations|declaration|amend|articles|pool/.test(text);
}

function sourceLabelFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return 'Source';
  }
}

function isRelevantCandidate(link, target) {
  const community = normalizeKey(target.communityName);
  const haystack = normalizeKey(`${link.label} ${link.url}`);
  if (!haystack) return false;
  if (community && haystack.includes(community)) return true;
  if (/\b(hoa|homeowners|association|covenant|bylaw|architectural|rules|declaration|casnc|management)\b/.test(haystack)) return true;
  return false;
}

function isListingPortal(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(redfin|realtor|homes\.com|zillow|trulia)\./.test(host);
  } catch {
    return false;
  }
}

function buildCommunityCandidateUrls(target) {
  const urls = [];
  const community = normalizeText(target.communityName);
  if (!community) return urls;
  const communitySlug = slugify(community);
  if (communitySlug) {
    urls.push({
      label: `${community} CAS community page candidate`,
      url: `https://www.casnc.com/communities/${communitySlug}/`,
      kind: 'management-page',
      sourceType: 'community-page-candidate',
    });
  }
  return urls;
}

function buildSearchQueries(target) {
  const queries = [];
  const city = target.city;
  const community = target.communityName;
  if (community) {
    queries.push(`"${community}" "${city}" HOA covenants`);
    queries.push(`"${community}" "Declaration of Covenants"`);
    queries.push(`"${community}" "architectural guidelines" HOA`);
    queries.push(`site:casnc.com "${community}"`);
  }
  queries.push(`"${target.address}" "${city}" HOA`);
  queries.push(`"${target.address}" "${city}" covenants`);
  return [...new Set(queries)].slice(0, MAX_SEARCH_QUERIES);
}

function buildSearchUrls(query) {
  return [
    `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  ];
}

function fetchWithTimeout(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    redirect: 'follow',
    signal: controller.signal,
    headers: {
      'User-Agent': 'home-ops/hoa-docs-check (+local buyer research)',
      'Accept': options.accept ?? 'text/html,application/xhtml+xml,application/pdf',
    },
  }).finally(() => clearTimeout(timer));
}

async function fetchHtml(url) {
  try {
    const response = await fetchWithTimeout(url, { accept: 'text/html,application/xhtml+xml' });
    if (response.ok) {
      const text = await response.text();
      return { ok: true, status: response.status, finalUrl: response.url || url, html: text, provider: 'fetch' };
    }
  } catch {
    // Fall through to crawl4ai.
  }

  const crawled = await crawl4aiFetchPage(url, { timeoutMs: DEFAULT_TIMEOUT_MS });
  if (crawled.ok && crawled.html) {
    return {
      ok: true,
      status: crawled.status || 200,
      finalUrl: crawled.finalUrl || url,
      html: crawled.html,
      provider: 'crawl4ai',
    };
  }

  return {
    ok: false,
    status: crawled.status || 0,
    finalUrl: crawled.finalUrl || url,
    html: crawled.html || '',
    provider: crawled.provider || 'fetch',
    error: crawled.error || 'unreachable',
  };
}

async function fetchBinary(url) {
  try {
    const response = await fetchWithTimeout(url, { accept: 'application/pdf,application/octet-stream,*/*' });
    if (!response.ok) {
      return { ok: false, status: response.status, finalUrl: response.url || url, buffer: null, error: `HTTP ${response.status}` };
    }
    const arrayBuffer = await response.arrayBuffer();
    return { ok: true, status: response.status, finalUrl: response.url || url, buffer: Buffer.from(arrayBuffer) };
  } catch (error) {
    return { ok: false, status: 0, finalUrl: url, buffer: null, error: String(error?.message ?? error) };
  }
}

function cleanPdfLiteral(value) {
  return String(value ?? '')
    .replace(/\\([nrtbf])/g, ' ')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
    .replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodePdfHex(value) {
  const hex = String(value ?? '').replace(/\s+/g, '');
  if (hex.length < 6 || hex.length % 2 !== 0) return '';
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      out += String.fromCharCode((bytes[index] << 8) + bytes[index + 1]);
    }
    return cleanPdfLiteral(out);
  }
  const ascii = bytes.toString('latin1');
  return cleanPdfLiteral(ascii);
}

function extractPdfOperatorStrings(pdfText) {
  const chunks = [];
  for (const match of String(pdfText ?? '').matchAll(/\((?:\\.|[^\\()]){2,}\)/g)) {
    const text = cleanPdfLiteral(match[0].slice(1, -1));
    if (/[A-Za-z]{3}/.test(text)) chunks.push(text);
  }
  for (const match of String(pdfText ?? '').matchAll(/<([0-9A-Fa-f\s]{6,})>/g)) {
    const text = decodePdfHex(match[1]);
    if (/[A-Za-z]{3}/.test(text)) chunks.push(text);
  }
  return chunks;
}

function trimPdfStreamBuffer(raw) {
  let buffer = raw;
  if (buffer[0] === 0x0d && buffer[1] === 0x0a) buffer = buffer.subarray(2);
  else if (buffer[0] === 0x0a) buffer = buffer.subarray(1);
  if (buffer[buffer.length - 2] === 0x0d && buffer[buffer.length - 1] === 0x0a) buffer = buffer.subarray(0, -2);
  else if (buffer[buffer.length - 1] === 0x0a) buffer = buffer.subarray(0, -1);
  return buffer;
}

function extractPdfText(buffer) {
  if (!buffer) return { text: '', streamCount: 0, extractedChunks: 0 };
  const raw = buffer.toString('latin1');
  const chunks = extractPdfOperatorStrings(raw);
  let streamCount = 0;
  const streamPattern = /(<<[\s\S]{0,1200}?>>)\s*stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
  for (const match of raw.matchAll(streamPattern)) {
    streamCount += 1;
    const dict = match[1];
    const rawStream = trimPdfStreamBuffer(Buffer.from(match[2], 'latin1'));
    const candidates = [rawStream];
    if (/FlateDecode/i.test(dict)) {
      try {
        candidates.push(inflateSync(rawStream));
      } catch {
        // Leave compressed stream unparsed.
      }
    }
    for (const candidate of candidates) {
      chunks.push(...extractPdfOperatorStrings(candidate.toString('latin1')));
    }
  }
  const text = [...new Set(chunks)]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, streamCount, extractedChunks: chunks.length };
}

async function fetchDocument(entry) {
  const binary = await fetchBinary(entry.url);
  if (!binary.ok || !binary.buffer) {
    return {
      ...entry,
      status: 'unreachable',
      finalUrl: binary.finalUrl || entry.url,
      error: binary.error || `HTTP ${binary.status}`,
      text: '',
      textExtractedLength: 0,
    };
  }
  const isPdf = /\.pdf(?:$|\?)/i.test(binary.finalUrl || entry.url);
  const parsed = isPdf
    ? extractPdfText(binary.buffer)
    : { text: binary.buffer.toString('utf8'), streamCount: 0, extractedChunks: 0 };
  return {
    ...entry,
    status: 'captured',
    finalUrl: binary.finalUrl || entry.url,
    sizeBytes: binary.buffer.length,
    text: parsed.text,
    textExtractedLength: parsed.text.length,
    pdfStreamCount: parsed.streamCount,
    pdfTextChunks: parsed.extractedChunks,
  };
}

function findAssociationNames(text, target, seed) {
  const values = [];
  if (seed?.associationName) values.push(seed.associationName);
  const community = normalizeText(target.communityName || seed?.communityName);
  if (community) {
    const direct = text.match(new RegExp(`(${community.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(?:Home\\s*Owners|Homeowners|Property\\s*Owners)?\\s*Association)`, 'i'))?.[1];
    if (direct) values.push(direct);
  }
  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9'& -]{2,80}\s+(?:Home\s*Owners|Homeowners|Property\s*Owners)\s+Association)\b/g)) {
    values.push(match[1]);
  }
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function managementCompanyFromSources(sources, seed) {
  if (seed?.managementCompany) return seed.managementCompany;
  for (const source of sources) {
    const haystack = `${source.label ?? ''} ${source.url ?? ''} ${source.text ?? ''}`;
    if (/casnc\.com|Community Association Services/i.test(haystack)) {
      return 'Community Association Services, Inc.';
    }
  }
  return '';
}

function topicMatches(record) {
  const text = `${record.label ?? ''} ${record.url ?? ''} ${record.text ?? ''}`;
  return TOPIC_DEFS
    .filter((topic) => topic.patterns.some((pattern) => pattern.test(text)))
    .map((topic) => topic.key);
}

function buildTopics(documents) {
  return TOPIC_DEFS.map((topic) => {
    const source = documents.find((doc) => (doc.topicKeys ?? []).includes(topic.key));
    if (!source) {
      return {
        key: topic.key,
        topic: topic.topic,
        status: 'not-found',
        summary: 'Not confirmed from the public HOA documents captured in this pass.',
        sourceLabel: '',
        sourceUrl: '',
      };
    }
    return {
      key: topic.key,
      topic: topic.topic,
      status: 'found',
      summary: topic.summary,
      sourceLabel: source.label,
      sourceUrl: source.finalUrl || source.url,
    };
  });
}

function confidenceFor(record) {
  const capturedDocs = record.documents.filter((doc) => doc.status === 'captured');
  const officialDocs = capturedDocs.filter((doc) => /official|casnc\.com/i.test(`${doc.sourceType ?? ''} ${doc.url ?? ''}`));
  if (officialDocs.length > 0 && record.topics.some((topic) => topic.status === 'found')) return 'medium-high';
  if (officialDocs.length > 0 || record.documents.length > 0) return 'medium';
  if (record.hoa.associationName || record.hoa.communityName) return 'low';
  return 'unconfirmed';
}

function statusFor(record) {
  if (record.documents.some((doc) => doc.status === 'captured')) return 'captured';
  if (record.sourcesChecked.some((source) => source.status === 'captured')) return 'partial';
  return 'unconfirmed';
}

function renderMoney(value) {
  return Number.isFinite(value) ? `$${Number(value).toLocaleString()}/mo` : '';
}

function formatReportSection(record) {
  const foundTopics = record.topics.filter((topic) => topic.status === 'found');
  const docs = record.documents
    .filter((doc) => doc.status === 'captured' || doc.status === 'found')
    .slice(0, 8);
  const sourceName = record.hoa.managementCompany || record.hoa.associationName || record.hoa.communityName || 'public HOA sources';
  const docsLine = docs.length
    ? docs.map((doc) => `[${doc.label}](${doc.finalUrl || doc.url})`).join(', ')
    : 'No public governing documents confirmed.';
  const monthly = renderMoney(record.hoa.monthlyDues);
  const rows = foundTopics.length
    ? foundTopics.map((topic) => `| ${topic.topic} | ${topic.summary} | [source](${topic.sourceUrl}) |`).join('\n')
    : '| Public rules | No buyer-relevant HOA rule text was confirmed from public docs in this pass. | -- |';

  return `## HOA Rules and Restrictions

**HOA status:** ${record.status}
**Likely HOA/community:** ${record.hoa.associationName || record.hoa.communityName || 'Unconfirmed'}
**Manager/source:** ${sourceName}
**Monthly dues:** ${monthly || record.hoa.duesText || 'Unconfirmed from captured listing facts'}
**Documents found online:** ${docsLine}
**Confidence:** ${record.confidence}

| Topic | Summary | Source |
|---|---|---|
${rows}

**Open questions before offer:** Request the full HOA resale/disclosure packet; confirm current dues, reserves, transfer fees, pending assessments, fine schedule, and any lot-specific architectural restrictions.`;
}

function upsertReportSection(reportPath, record) {
  const content = readFileSync(reportPath, 'utf8').replace(/\r\n/g, '\n');
  const section = formatReportSection(record);
  const existing = /\n## HOA Rules and Restrictions\n[\s\S]*?(?=\n## |$)/;
  let next;
  if (existing.test(content)) {
    next = content.replace(existing, `\n${section}\n`);
  } else if (/\n## Risks and Open Questions\n/.test(content)) {
    next = content.replace(/\n## Risks and Open Questions\n/, `\n${section}\n\n## Risks and Open Questions\n`);
  } else {
    next = `${content.trimEnd()}\n\n${section}\n`;
  }
  writeFileSync(reportPath, next.replace(/\n{3,}/g, '\n\n'), 'utf8');
}

async function discoverFromSearch(target) {
  const discovered = [];
  for (const query of buildSearchQueries(target)) {
    for (const searchUrl of buildSearchUrls(query)) {
      const page = await fetchHtml(searchUrl);
      discovered.push({
        label: `Search: ${query}`,
        url: searchUrl,
        finalUrl: page.finalUrl || searchUrl,
        status: page.ok ? 'captured' : 'blocked',
        sourceType: 'search',
        error: page.error ?? null,
      });
      if (!page.ok || !page.html) continue;
      const links = extractHtmlLinks(page.html, page.finalUrl || searchUrl)
        .filter((link) => isRelevantCandidate(link, target))
        .map((link) => ({
          label: link.label,
          url: link.url,
          kind: isDocumentUrl(link.url, link.label) ? 'governing-document' : 'candidate-page',
          sourceType: 'search-result',
          sourceQuery: query,
        }));
      discovered.push(...links);
    }
  }
  return discovered;
}

async function runTarget(target, config) {
  const seed = matchKnownSeed(target);
  if (seed?.communityName && !target.communityName) target.communityName = seed.communityName;

  const sourcesChecked = target.sourceUrls.map((url) => ({
    label: sourceLabelFromUrl(url),
    url,
    status: isListingPortal(url) ? 'input-listing-source' : 'input-source',
    sourceType: 'listing-or-input',
  }));

  const seedEntries = [
    ...(seed?.urls ?? []),
    ...buildCommunityCandidateUrls(target),
  ];

  const searched = config.noSearch ? [] : await discoverFromSearch(target);
  sourcesChecked.push(...searched.filter((entry) => entry.sourceType === 'search'));

  let candidatePages = dedupeByUrl([
    ...seedEntries.filter((entry) => entry.kind !== 'governing-document'),
    ...searched.filter((entry) => entry.kind === 'candidate-page'),
  ]).filter((entry) => !isListingPortal(entry.url)).slice(0, MAX_DISCOVERED_PAGES);

  let documentCandidates = dedupeByUrl([
    ...seedEntries.filter((entry) => entry.kind === 'governing-document'),
    ...searched.filter((entry) => entry.kind === 'governing-document' || isDocumentUrl(entry.url, entry.label)),
  ]).slice(0, MAX_DISCOVERED_DOCS);

  const capturedPages = [];
  for (const pageEntry of candidatePages) {
    const page = await fetchHtml(pageEntry.url);
    const pageRecord = {
      ...pageEntry,
      status: page.ok ? 'captured' : 'unreachable',
      finalUrl: page.finalUrl || pageEntry.url,
      provider: page.provider,
      error: page.error ?? null,
      text: page.ok ? stripHtml(page.html).slice(0, 20000) : '',
    };
    capturedPages.push(pageRecord);
    sourcesChecked.push({
      label: pageEntry.label,
      url: pageEntry.url,
      finalUrl: pageRecord.finalUrl,
      status: pageRecord.status,
      sourceType: pageEntry.sourceType || 'candidate-page',
      error: pageRecord.error,
    });
    if (page.ok && page.html) {
      const pageDocs = extractHtmlLinks(page.html, pageRecord.finalUrl)
        .filter((link) => isDocumentUrl(link.url, link.label) && isRelevantCandidate(link, target))
        .map((link) => ({
          label: link.label,
          url: link.url,
          kind: 'governing-document',
          documentType: docTypeFromLabel(link.label, link.url),
          sourceType: 'linked-governing-document',
          sourcePage: pageRecord.finalUrl,
        }));
      documentCandidates = dedupeByUrl([...documentCandidates, ...pageDocs]).slice(0, MAX_DISCOVERED_DOCS);
    }
  }

  const documents = [];
  for (const docEntry of documentCandidates) {
    const fetched = await fetchDocument({
      ...docEntry,
      documentType: docEntry.documentType || docTypeFromLabel(docEntry.label, docEntry.url),
    });
    fetched.topicKeys = topicMatches(fetched);
    documents.push(fetched);
    sourcesChecked.push({
      label: fetched.label,
      url: fetched.url,
      finalUrl: fetched.finalUrl,
      status: fetched.status,
      sourceType: fetched.sourceType || 'governing-document',
      error: fetched.error ?? null,
    });
  }

  const combinedSourceText = [...capturedPages, ...documents]
    .map((record) => `${record.label ?? ''} ${record.text ?? ''}`)
    .join(' ');
  const associationNames = findAssociationNames(combinedSourceText, target, seed);
  const topics = buildTopics(documents);

  const record = {
    generatedAt: new Date().toISOString(),
    address: target.address,
    city: target.city,
    state: target.state || 'NC',
    zip: target.zip || '',
    reportPath: target.reportPath,
    status: 'unconfirmed',
    confidence: 'unconfirmed',
    input: {
      kind: target.inputKind,
      urls: target.sourceUrls,
      mls: target.mls || null,
      builderName: target.builderName || null,
    },
    hoa: {
      communityName: target.communityName || seed?.communityName || '',
      associationName: associationNames[0] || '',
      managementCompany: managementCompanyFromSources([...capturedPages, ...documents], seed),
      monthlyDues: target.hoaMonthly,
      duesText: target.hoaText || '',
    },
    sourceOrder: [
      'listing facts and listing/source URLs',
      'public listing/community corroboration',
      'official HOA or management-company pages',
      'hosted or recorded governing documents',
    ],
    sourcesChecked: dedupeByUrl(sourcesChecked),
    documents: documents.map((doc) => ({
      label: doc.label,
      url: doc.url,
      finalUrl: doc.finalUrl || doc.url,
      documentType: doc.documentType,
      sourceType: doc.sourceType,
      status: doc.status,
      textExtractedLength: doc.textExtractedLength,
      sizeBytes: doc.sizeBytes,
      topicKeys: doc.topicKeys ?? [],
      error: doc.error ?? null,
    })),
    topics,
    reportFindings: topics
      .filter((topic) => topic.status === 'found')
      .map((topic) => ({
        topic: topic.topic,
        summary: topic.summary,
        sourceLabel: topic.sourceLabel,
        sourceUrl: topic.sourceUrl,
      })),
    openQuestions: [
      'Request the full HOA resale/disclosure packet before offer.',
      'Confirm current dues, transfer fees, reserves, pending assessments, and fine schedule.',
      'Confirm lot-specific architectural restrictions for fencing, sheds, exterior changes, and parking/storage.',
    ],
  };
  record.confidence = confidenceFor(record);
  record.status = statusFor(record);

  await mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = join(OUTPUT_DIR, `${slugify(`${record.address}-${record.city}-${record.state || 'NC'}`)}.json`);
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  if (config.updateReport && target.reportAbsolutePath) {
    upsertReportSection(target.reportAbsolutePath, record);
  }

  return {
    address: record.address,
    city: record.city,
    state: record.state,
    outputPath: outputPath.replace(`${ROOT}\\`, '').replace(/\\/g, '/'),
    status: record.status,
    confidence: record.confidence,
    documentsFound: record.documents.filter((doc) => doc.status === 'captured').length,
    topicsFound: record.topics.filter((topic) => topic.status === 'found').length,
    reportUpdated: Boolean(config.updateReport && target.reportAbsolutePath),
  };
}

function printSummary(results) {
  console.log('\nHOA document lookup\n');
  for (const result of results) {
    console.log(`${result.address} | ${result.city}, ${result.state}`);
    console.log(`Output: ${result.outputPath}`);
    console.log(`Status: ${result.status} (${result.confidence})`);
    console.log(`Documents captured: ${result.documentsFound}`);
    console.log(`Rule topics found: ${result.topicsFound}`);
    console.log(`Report updated: ${result.reportUpdated ? 'yes' : 'no'}`);
    console.log('');
  }
}

async function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(HELP_TEXT);
    process.exit(1);
  }

  if (config.help) {
    console.log(HELP_TEXT);
    return;
  }

  const targets = resolveTargets(config);
  const results = [];
  for (const target of targets) {
    results.push(await runTarget(target, config));
  }

  if (config.json) {
    console.log(JSON.stringify({ count: results.length, results }, null, 2));
    return;
  }

  printSummary(results);
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exit(1);
});
