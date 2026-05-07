#!/usr/bin/env node

/**
 * builder-check.mjs -- Detect the home's builder from report text and look
 * up their quality reputation on Avid Ratings and Eliant. Writes one record
 * per home to output/builder/{slug}.json so the Risk & Builder Quality axis
 * agent can include builder context in the deep brief and briefing PDF.
 *
 * If no builder is detected from the report text, writes status:
 * "no-builder-detected" and exits cleanly without making any HTTP requests.
 * Absent or unreachable review sites degrade to status: "not-found" so
 * downstream agents can reason about coverage gaps.
 *
 * Avid Ratings and Eliant are public sites -- no login or hosted browser
 * session is required.
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from '../shared/paths.mjs';
import {
  parseReport,
  parseShortlist,
} from './research-utils.mjs';
import { crawl4aiFetchPage } from './crawl4ai-utils.mjs';
import { slugify } from '../shared/text-utils.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'builder');
const LISTING_DIR = join(ROOT, 'output', 'listings');
const PERMITS_DIR = join(ROOT, 'output', 'permits');
const DEFAULT_TIMEOUT_MS = 20000;
const BBB_TIMEOUT_MS = 30000;
const BUILDER_ONLINE_TIMEOUT_MS = 30000;
const BUILDER_SEARCH_TIMEOUT_MS = 30000;

// Well-known builder brands, ordered longest-first to prefer the more specific
// match (e.g. "Smith Douglas Homes" before "Smith Douglas").
const KNOWN_BUILDERS = [
  'Smith Douglas Homes',
  'David Weekley Homes',
  'Stanley Martin Homes',
  'Taylor Morrison',
  'Century Communities',
  'Caviness & Cates',
  'Toll Brothers',
  'Meritage Homes',
  'Beazer Homes',
  'Ashton Woods',
  'Eastwood Homes',
  'Essex Homes',
  'Chesmar Homes',
  'True Homes',
  'Epcon Communities',
  'Dan Ryan Builders',
  'D.R. Horton',
  'DR Horton',
  'Ryan Homes',
  'Pulte Homes',
  'PulteGroup',
  'KB Homes',
  'KB Home',
  'Meritage',
  'Lennar',
  'NVHomes',
  'NVR',
  'Centex',
  'Del Webb',
  'DiVosta',
  'Beazer',
  'Chesmar',
  'Pulte',
  'Epcon',
  'Smith Douglas',
  'David Weekley',
  'Stanley Martin',
  'Dan Ryan',
  'M/I Homes',
  'MI Homes',
];

// Canonical name for display (normalises dot-notation variants).
const BUILDER_CANONICAL = {
  'D.R. Horton': 'DR Horton',
  'NVHomes': 'NVR',
  'MI Homes': 'M/I Homes',
  'Pulte Homes': 'Pulte',
  'PulteGroup': 'Pulte',
};

const BBB_PROFILE_OVERRIDES = {
  'taylor morrison|nc': 'https://www.bbb.org/us/nc/cary/profile/home-builders/taylor-morrison-raleigh-division-0593-90289760/addressId/118685',
  'taylor morrison|raleigh': 'https://www.bbb.org/us/nc/cary/profile/home-builders/taylor-morrison-raleigh-division-0593-90289760/addressId/118685',
  'taylor morrison|cary': 'https://www.bbb.org/us/nc/cary/profile/home-builders/taylor-morrison-raleigh-division-0593-90289760/addressId/118685',
  'taylor morrison|fuquay varina': 'https://www.bbb.org/us/nc/cary/profile/home-builders/taylor-morrison-raleigh-division-0593-90289760/addressId/118685',
  'taylor morrison|holly springs': 'https://www.bbb.org/us/nc/cary/profile/home-builders/taylor-morrison-raleigh-division-0593-90289760/addressId/118685',
};

const HELP_TEXT = `Usage:
  node builder-check.mjs reports/001-foo.md
  node builder-check.mjs --shortlist
  node builder-check.mjs --top3
  node builder-check.mjs --address "200 Meadowcrest Pl" --city "Holly Springs"

Detects the home's builder from report text and looks up their quality
reputation on Avid Ratings, Eliant, and BBB. Writes output/builder/{slug}.json
for each target.

Options:
  --shortlist       Use the current top-10 cohort from data/shortlist.md.
  --top3            Use the current refined top-3 from data/shortlist.md.
  --address <val>   Manual target address.
  --city <val>      Manual target city.
  --state <val>     Manual target state. Defaults to NC.
  --json            Print JSON instead of human-readable text.
  --help            Show this help text.
`;

function parseArgs(argv) {
  const config = {
    shortlist: false, top3: false, json: false, help: false,
    address: '', city: '', state: 'NC', files: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--shortlist') { config.shortlist = true; continue; }
    if (arg === '--top3') { config.top3 = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--address') { config.address = argv[++i] ?? ''; continue; }
    if (arg === '--city') { config.city = argv[++i] ?? ''; continue; }
    if (arg === '--state') { config.state = argv[++i] ?? 'NC'; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    config.files.push(arg);
  }
  return config;
}

function buildOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'builder-target';
  return join(OUTPUT_DIR, `${slug}.json`);
}

function readListingFactsForTarget(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'builder-target';
  const filePath = join(LISTING_DIR, `${slug}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const payload = JSON.parse(readFileSync(filePath, 'utf8'));
    const sameAddress = String(payload.address ?? '').trim().toLowerCase() === String(target.address ?? '').trim().toLowerCase();
    const sameCity = String(payload.city ?? '').trim().toLowerCase() === String(target.city ?? '').trim().toLowerCase();
    if (!sameAddress || !sameCity) return null;
    return payload;
  } catch {
    return null;
  }
}

function readPermitsRecordForTarget(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'builder-target';
  const filePath = join(PERMITS_DIR, `${slug}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const payload = JSON.parse(readFileSync(filePath, 'utf8'));
    const sameAddress = String(payload.address ?? '').trim().toLowerCase() === String(target.address ?? '').trim().toLowerCase();
    const sameCity = String(payload.city ?? '').trim().toLowerCase() === String(target.city ?? '').trim().toLowerCase();
    if (!sameAddress || !sameCity) return null;
    return payload;
  } catch {
    return null;
  }
}

function resolveTargets(config) {
  if (config.shortlist || config.top3) {
    const shortlist = parseShortlist(ROOT);
    const rows = config.top3 ? shortlist.refinedTop3 : shortlist.top10;
    if (rows.length === 0) {
      throw new Error(config.top3
        ? 'No refined top-3 homes found in data/shortlist.md.'
        : 'No populated top-10 homes found in data/shortlist.md.');
    }
    const targets = [];
    for (const row of rows) {
      try {
        targets.push(parseReport(ROOT, row.reportPath));
      } catch (err) {
        if (err.code === 'ENOENT' || String(err.message).includes('ENOENT')) {
          console.warn(`[warn] Skipping shortlist entry — report not found: ${row.reportPath}`);
        } else {
          throw err;
        }
      }
    }
    if (targets.length === 0) {
      throw new Error('No shortlist entries have readable reports. Re-run evaluate to generate fresh reports.');
    }
    return targets;
  }

  if (config.address || config.city) {
    return [{
      address: config.address,
      city: config.city,
      state: config.state || 'NC',
      content: '',
      metadata: {},
      sections: {},
      relativePath: '',
    }];
  }

  if (config.files.length === 0) {
    throw new Error('Provide at least one report path, or use --shortlist or --top3.');
  }
  return config.files.map((filePath) => parseReport(ROOT, filePath));
}

function detectBuilder(target) {
  const text = String(target.content ?? '');
  const listingFacts = readListingFactsForTarget(target);
  const listingBuilder = listingFacts?.builderName ?? listingFacts?.builder?.name ?? null;
  if (String(listingBuilder ?? '').trim().length >= 3) {
    const name = String(listingBuilder).trim();
    return {
      builderName: BUILDER_CANONICAL[name] ?? name,
      detectionSource: 'listing_sidecar',
      detectionConfidence: 'high',
      detectionSourceUrl: listingFacts?.canonicalUrl || listingFacts?.url || null,
    };
  }

  if (!text.trim()) {
    const permitDetection = detectBuilderFromPermits(target);
    return permitDetection ?? { builderName: null, detectionSource: null, detectionConfidence: null };
  }

  // 1. Explicit metadata field: **Builder:** Value
  const fieldMatch = text.match(/\*\*Builder:\*\*\s*([A-Za-z0-9'&. -]+?)(?=\n|\r|$)/i)
    || text.match(/^Builder:\s*([A-Za-z0-9'&. -]+?)(?=\n|\r|$)/im);
  if (fieldMatch) {
    const name = fieldMatch[1].trim();
    if (name.length >= 3) {
      return { builderName: BUILDER_CANONICAL[name] ?? name, detectionSource: 'report_field', detectionConfidence: 'high', detectionSourceUrl: null };
    }
  }

  // 2. Known builder brand scan (word-boundary match, longest name wins)
  for (const builder of KNOWN_BUILDERS) {
    const escaped = builder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
      const canonical = BUILDER_CANONICAL[builder] ?? builder;
      return { builderName: canonical, detectionSource: 'known_brand', detectionConfidence: 'high', detectionSourceUrl: null };
    }
  }

  // 3. Generic "built by NAME" pattern
  const builtByMatch = text.match(/built by ([A-Z][A-Za-z0-9'&. -]{2,48?})(?:[.,\n\r]|$)/i);
  if (builtByMatch) {
    const name = builtByMatch[1].trim().replace(/\s+/g, ' ');
    if (name.length >= 3) {
      return { builderName: name, detectionSource: 'description', detectionConfidence: 'medium', detectionSourceUrl: null };
    }
  }

  const permitDetection = detectBuilderFromPermits(target);
  return permitDetection ?? { builderName: null, detectionSource: null, detectionConfidence: null };
}

function buildBuilderSearchQuery(target) {
  return [target.address, target.city, target.state || 'NC', 'builder']
    .filter(Boolean)
    .join(', ')
    .replace(/,\s*builder$/i, ' builder');
}

function buildBuilderSearchUrls(target) {
  const query = buildBuilderSearchQuery(target);
  return [
    `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  ];
}

function extractSearchResultLinks(html) {
  const links = [];
  const seen = new Set();
  const patterns = [
    /href=["']\/url\?q=([^"'&]+)[^"']*["']/gi,
    /href=["']https?:\/\/www\.google\.com\/url\?q=([^"'&]+)[^"']*["']/gi,
    /href=["'](https?:\/\/[^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(String(html ?? ''))) !== null) {
      let url = decodeURIComponent(decodeHtmlEntities(match[1]));
      url = url.replace(/&amp;.*$/i, '').replace(/[?&]utm_[^=]+=[^&]+/gi, '');
      if (!/^https?:\/\//i.test(url)) continue;
      let host = '';
      try {
        host = new URL(url).host.toLowerCase();
      } catch {
        continue;
      }
      if (/(google|gstatic|bing|microsoft|youtube|facebook|instagram|x\.com|twitter)\./i.test(host)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      links.push(url);
    }
  }
  return links.slice(0, 8);
}

function compactAddress(value) {
  return normalizeSearchKey(value)
    .replace(/\b(drive)\b/g, 'dr')
    .replace(/\b(road)\b/g, 'rd')
    .replace(/\b(street)\b/g, 'st')
    .replace(/\b(court)\b/g, 'ct')
    .replace(/\b(lane)\b/g, 'ln')
    .replace(/\b(avenue)\b/g, 'ave')
    .replace(/\b(circle)\b/g, 'cir')
    .replace(/\b(place)\b/g, 'pl')
    .replace(/\b(north)\b/g, 'n')
    .replace(/\b(south)\b/g, 's')
    .replace(/\b(east)\b/g, 'e')
    .replace(/\b(west)\b/g, 'w')
    .trim();
}

function addressMatchesPage(text, target) {
  const body = compactAddress(text);
  const address = compactAddress(target.address);
  if (!address) return false;
  const addressTerms = address.split(' ').filter((term) => term.length > 1 || /^\d+$/.test(term));
  const streetNumber = addressTerms.find((term) => /^\d+$/.test(term));
  const streetWords = addressTerms.filter((term) => !/^\d+$/.test(term) && !/^(n|s|e|w)$/.test(term));
  const city = normalizeSearchKey(target.city);
  const zip = normalizeSearchKey(target.zip);
  const numberOk = !streetNumber || body.includes(streetNumber);
  const streetHits = streetWords.filter((term) => body.includes(term)).length;
  const locationOk = (city && body.includes(city)) || (zip && body.includes(zip)) || !city;
  return numberOk && streetHits >= Math.min(2, streetWords.length) && locationOk;
}

function cleanBuilderCandidate(value) {
  const cleaned = String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\b(?:homes?|builder|builders?|construction|inc|llc)\b\.?\s*$/i, (suffix) => suffix.trim())
    .replace(/[|•].*$/g, '')
    .replace(/\s+-\s+.*$/g, '')
    .trim();
  if (cleaned.length < 3 || cleaned.length > 80) return null;
  if (/(realty|realtor|listing|broker|mls|zillow|redfin|homes\.com|property|school|county)/i.test(cleaned)) return null;
  return BUILDER_CANONICAL[cleaned] ?? cleaned;
}

function permitCandidateName(value) {
  const cleaned = cleanBuilderCandidate(value);
  if (!cleaned) return null;
  if (/(trust|bank|mortgage|holdings|properties|realty|hoa|homeowners|town of|county|city of)/i.test(cleaned)) return null;
  return cleaned;
}

function detectBuilderFromPermits(target) {
  const permits = readPermitsRecordForTarget(target);
  if (!permits) return null;

  for (const match of permits.matches ?? []) {
    const fields = [
      ['builder', match.builder],
      ['contractor', match.contractor],
      ['developer', match.developer],
      ['applicant', match.applicant],
    ];
    for (const [field, value] of fields) {
      const builderName = permitCandidateName(value);
      if (!builderName) continue;
      return {
        builderName,
        detectionSource: `permit_${field}`,
        detectionConfidence: field === 'builder' || field === 'contractor' ? 'high' : 'medium',
        detectionSourceUrl: (permits.sourcesChecked ?? []).find((source) => source?.url)?.url ?? null,
        detectionNotes: {
          permitCaseId: match.caseId ?? null,
          permitKind: match.kind ?? null,
          permitStatus: match.status ?? null,
          permitSource: match.service ?? null,
        },
      };
    }
  }
  return null;
}

function extractBuilderNameFromPage(html, target) {
  const text = compactPlainText(html);
  const patterns = [
    /\bBuilder\s*Name\s*:?\s*([A-Z][A-Za-z0-9'&./ -]{2,80})/i,
    /\bBuilder\s*:?\s*([A-Z][A-Za-z0-9'&./ -]{2,80})/i,
    /\bBuilt\s+by\s+([A-Z][A-Za-z0-9'&./ -]{2,80})/i,
    /\bHome\s+by\s+([A-Z][A-Za-z0-9'&./ -]{2,80})/i,
    /\bNew\s+home\s+by\s+([A-Z][A-Za-z0-9'&./ -]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const candidate = cleanBuilderCandidate(text.match(pattern)?.[1]);
    if (candidate) return candidate;
  }

  for (const builder of KNOWN_BUILDERS) {
    const escaped = builder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
      return BUILDER_CANONICAL[builder] ?? builder;
    }
  }

  const titleMatch = String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(stripHtml(titleMatch[1])) : '';
  const titleCandidate = cleanBuilderCandidate(title.match(/\b(?:by|builder)\s+([A-Z][A-Za-z0-9'&./ -]{2,80})/i)?.[1]);
  if (titleCandidate && addressMatchesPage(`${title} ${text}`, target)) return titleCandidate;
  return null;
}

async function lookupBuilderFromAddressSearch(target) {
  if (!target.address || !target.city) {
    return { builderName: null, detectionSource: null, detectionConfidence: null };
  }

  const checkedSearches = [];
  const checkedPages = [];
  for (const searchUrl of buildBuilderSearchUrls(target)) {
    const searchPage = await crawl4aiFetchPage(searchUrl, { timeoutMs: BUILDER_SEARCH_TIMEOUT_MS });
    checkedSearches.push({
      url: searchUrl,
      finalUrl: searchPage.finalUrl || searchUrl,
      ok: searchPage.ok,
      status: searchPage.status,
      error: searchPage.error ?? null,
    });
    if (!searchPage.html) continue;
    const resultLinks = extractSearchResultLinks(searchPage.html);
    for (const resultUrl of resultLinks.slice(0, 8)) {
      const page = await crawl4aiFetchPage(resultUrl, { timeoutMs: BUILDER_SEARCH_TIMEOUT_MS });
      checkedPages.push({
        url: resultUrl,
        finalUrl: page.finalUrl || resultUrl,
        ok: page.ok,
        status: page.status,
        error: page.error ?? null,
      });
      if (!page.html) continue;
      const text = compactPlainText(page.html);
      if (!addressMatchesPage(text, target)) continue;
      const builderName = extractBuilderNameFromPage(page.html, target);
      if (!builderName) continue;
      return {
        builderName,
        detectionSource: 'address_builder_search',
        detectionConfidence: 'medium',
        detectionSourceUrl: page.finalUrl || resultUrl,
        detectionNotes: {
          searchQuery: buildBuilderSearchQuery(target),
          checkedSearches,
          checkedPages,
        },
      };
    }
  }

  return {
    builderName: null,
    detectionSource: null,
    detectionConfidence: null,
    detectionSourceUrl: null,
    detectionNotes: {
      searchQuery: buildBuilderSearchQuery(target),
      checkedSearches,
      checkedPages,
    },
  };
}

function toBuilderSlug(builderName) {
  return String(builderName ?? '')
    .toLowerCase()
    .replace(/\bd\.r\.\s*horton\b/i, 'dr-horton')
    .replace(/\bm\/i\s+homes\b/i, 'mi-homes')
    .replace(/[.\s/&]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function fetchText(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'home-ops/builder-check (+https://github.com/)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timer);
    if (!response.ok) return { ok: false, status: response.status, text: '', url };
    const text = await response.text();
    return { ok: true, status: response.status, text, url };
  } catch (error) {
    return { ok: false, status: 0, text: '', url, error: String(error?.message ?? error) };
  }
}

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

async function fetchBbbPage(url) {
  const crawled = await crawl4aiFetchPage(url, { timeoutMs: BBB_TIMEOUT_MS });
  if (crawled.ok && crawled.html) {
    return {
      ok: true,
      status: crawled.status || 200,
      text: crawled.html,
      url: crawled.finalUrl || url,
      requestedUrl: url,
      provider: 'crawl4ai',
    };
  }
  // BBB can return usable profile markup while also including bot-check
  // language that makes the generic crawl4ai guard mark it as blocked. Keep
  // that partial HTML when it is a 200 response so the parser can extract
  // public rating/accreditation fields without a brittle browser workflow.
  if (crawled.status === 200 && crawled.html && /\/profile\/|BBB Rating|BBB Accreditation/i.test(crawled.html)) {
    return {
      ok: true,
      status: crawled.status,
      text: crawled.html,
      url: crawled.finalUrl || url,
      requestedUrl: url,
      provider: 'crawl4ai-partial',
      crawl4aiError: crawled.error ?? null,
    };
  }

  const fetched = await fetchText(url);
  return {
    ...fetched,
    requestedUrl: url,
    provider: 'fetch',
    crawl4aiError: crawled.error ?? null,
  };
}

function bbbOverrideUrl(builderName, target) {
  const builderKey = normalizeSearchKey(builderName);
  const marketKeys = [
    normalizeSearchKey(target.city),
    normalizeSearchKey(target.state),
    'nc',
  ].filter(Boolean);

  for (const market of marketKeys) {
    const direct = BBB_PROFILE_OVERRIDES[`${builderKey}|${market}`];
    if (direct) return direct;
  }
  return '';
}

function buildBbbSearchUrls(builderName, target) {
  const loc = [target.city, target.state || 'NC'].filter(Boolean).join(', ');
  const regionalLoc = target.state ? `Raleigh, ${target.state}` : 'Raleigh, NC';
  const urls = [];
  for (const location of [loc, regionalLoc, target.state || 'NC']) {
    const params = new URLSearchParams();
    params.set('find_text', builderName);
    if (location) params.set('find_loc', location);
    params.set('find_country', 'USA');
    urls.push(`https://www.bbb.org/search?${params.toString()}`);
  }
  return [...new Set(urls)];
}

function extractBbbProfileLinks(html) {
  const links = [];
  const pattern = /href=["']([^"']*\/profile\/[^"']+)["']/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    let href = decodeHtmlEntities(match[1]);
    if (href.startsWith('/')) href = `https://www.bbb.org${href}`;
    if (!/^https:\/\/www\.bbb\.org\//i.test(href)) continue;
    if (!links.includes(href)) links.push(href);
  }
  return links;
}

function scoreBbbLink(url, builderName, target) {
  const haystack = normalizeSearchKey(url);
  const builderTerms = normalizeSearchKey(builderName).split(' ').filter((term) => term.length > 2);
  let score = 0;
  for (const term of builderTerms) {
    if (haystack.includes(term)) score += 3;
  }
  if (/home-builder|home-builders|construction/i.test(url)) score += 2;
  if (target.state && haystack.includes(normalizeSearchKey(target.state))) score += 1;
  if (target.city && haystack.includes(normalizeSearchKey(target.city))) score += 1;
  if (/raleigh|cary|triangle/i.test(url) && String(target.state || '').toUpperCase() === 'NC') score += 1;
  return score;
}

function chooseBbbProfileLink(links, builderName, target) {
  return [...links]
    .map((url) => ({ url, score: scoreBbbLink(url, builderName, target) }))
    .filter((entry) => entry.score >= 3)
    .sort((a, b) => b.score - a.score)[0]?.url ?? '';
}

function compactPlainText(html) {
  return stripHtml(html)
    .replace(/\s+/g, ' ')
    .trim();
}

function firstRegex(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function parseBbbProfile(html, url, requestedUrl, provider, crawl4aiError = null) {
  const body = compactPlainText(html);
  const rating = firstRegex(body, [
    /BBB\s+Rating\s*&?\s*Accreditation\s*([A-F][+-]?)/i,
    /BBB\s+Rating\s*([A-F][+-]?)/i,
    /Rating\s*([A-F][+-]?)/i,
  ]);
  const accredited = /\bBBB\s+Accredited\s+Business\b/i.test(body)
    || /\bAccredited\s+Since\b/i.test(body)
    || /\bBBB\s+Accreditation\b/i.test(body);
  const customerRating = firstRegex(body, [
    /Average\s+of\s+(\d+(?:\.\d+)?)\s+Customer\s+Reviews/i,
    /Customer\s+Reviews\s+(\d+(?:\.\d+)?)\s*\/\s*5/i,
    /(\d+(?:\.\d+)?)\s*\/\s*5\s+average customer/i,
  ]);
  const reviewCount = firstRegex(body, [
    /(\d+)\s+Customer\s+Reviews/i,
    /Customer\s+Reviews\s+(\d+)/i,
  ]);
  const complaintCount = firstRegex(body, [
    /(\d+)\s+complaints?\s+closed\s+in\s+last\s+3\s+years/i,
    /Complaints\s+closed\s+in\s+last\s+3\s+years\s+(\d+)/i,
  ]);
  const twelveMonthComplaints = firstRegex(body, [
    /(\d+)\s+complaints?\s+closed\s+in\s+last\s+12\s+months/i,
    /Complaints\s+closed\s+in\s+last\s+12\s+months\s+(\d+)/i,
  ]);

  const found = Boolean(rating || customerRating || complaintCount || /\/profile\//i.test(url));
  return {
    found,
    url,
    requestedUrl,
    provider,
    crawl4aiError,
    rating,
    accredited,
    customerRating: customerRating ? Number.parseFloat(customerRating) : null,
    reviewCount: reviewCount ? Number.parseInt(reviewCount.replace(/,/g, ''), 10) : null,
    complaintsClosedLast3Years: complaintCount ? Number.parseInt(complaintCount.replace(/,/g, ''), 10) : null,
    complaintsClosedLast12Months: twelveMonthComplaints ? Number.parseInt(twelveMonthComplaints.replace(/,/g, ''), 10) : null,
  };
}

function currentBuilder100Year() {
  return new Date().getFullYear();
}

function builder100Url(year = currentBuilder100Year()) {
  return `https://www.builderonline.com/builder-100/builder-100-list/${year}/`;
}

async function lookupBuilderOnline(builderName) {
  const year = currentBuilder100Year();
  const previousYear = year - 1;
  const url = builder100Url(year);
  const page = await crawl4aiFetchPage(url, { timeoutMs: BUILDER_ONLINE_TIMEOUT_MS });
  if (!page.ok || !page.html) {
    return {
      found: false,
      url,
      year,
      provider: 'crawl4ai',
      httpStatus: page.status,
      error: page.error ?? null,
    };
  }

  const body = compactPlainText(page.html);
  const escaped = builderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fullPattern = new RegExp(
    `(?:^|\\s)(\\d{1,3})\\s+${escaped}\\b[\\s\\S]{0,120}?${year}\\s+Rank\\s+(\\d{1,3})[\\s\\S]{0,120}?${previousYear}\\s+Total Closings:\\s+([\\d,]+)[\\s\\S]{0,120}?${previousYear}\\s+Gross Revenue:\\s+\\$([\\d,]+)[\\s\\S]{0,120}?${previousYear}\\s+Rank:\\s+(\\d{1,3})`,
    'i',
  );
  const fullMatch = body.match(fullPattern);
  if (fullMatch) {
    const rank = Number.parseInt(fullMatch[2], 10);
    return {
      found: true,
      url: page.finalUrl || url,
      requestedUrl: url,
      year,
      rank,
      priorYearRank: Number.parseInt(fullMatch[5], 10),
      totalClosings: Number.parseInt(fullMatch[3].replace(/,/g, ''), 10),
      grossRevenueMillions: Number.parseInt(fullMatch[4].replace(/,/g, ''), 10),
      provider: 'crawl4ai',
      standing: deriveBuilder100Standing(rank),
    };
  }

  const loosePattern = new RegExp(`\\b${escaped}\\b`, 'i');
  const looseMatch = body.match(loosePattern);
  if (!looseMatch) {
    return { found: false, url: page.finalUrl || url, requestedUrl: url, year, provider: 'crawl4ai', reason: 'builder-not-listed' };
  }

  const start = Math.max(0, looseMatch.index - 160);
  const snippet = body.slice(start, looseMatch.index + 360);
  const rankMatch = snippet.match(new RegExp(`${year}\\s+Rank\\s+(\\d{1,3})`, 'i'));
  const rank = rankMatch ? Number.parseInt(rankMatch[1], 10) : null;
  return {
    found: true,
    url: page.finalUrl || url,
    requestedUrl: url,
    year,
    rank,
    provider: 'crawl4ai',
    snippet,
    standing: rank ? deriveBuilder100Standing(rank) : {
      label: 'listed',
      summary: `${builderName} appears on the ${year} Builder 100 list, but rank details were not parsed from the captured page.`,
      source: 'Builder 100',
      url: page.finalUrl || url,
    },
  };
}

function scoreStanding(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return null;
  if (value >= 4.5) return 'excellent';
  if (value >= 4.0) return 'strong';
  if (value >= 3.5) return 'mixed-positive';
  if (value >= 3.0) return 'mixed';
  return 'weak';
}

function bbbLetterStanding(rating) {
  const normalized = String(rating ?? '').trim().toUpperCase();
  if (!normalized) return null;
  if (/^A\+?$/.test(normalized)) return 'strong';
  if (normalized === 'A-') return 'generally-positive';
  if (/^B/.test(normalized)) return 'mixed';
  if (/^[CDF]/.test(normalized)) return 'weak';
  return 'unrated';
}

function deriveBuilder100Standing(rank) {
  const value = Number(rank);
  if (!Number.isFinite(value)) return null;
  let label = 'listed';
  if (value <= 10) label = 'top-10-national-builder';
  else if (value <= 25) label = 'top-25-national-builder';
  else if (value <= 50) label = 'top-50-national-builder';
  else if (value <= 100) label = 'builder-100-listed';
  return {
    label,
    summary: `Ranked #${value} on the ${currentBuilder100Year()} Builder 100 list.`,
    source: 'Builder 100',
    url: builder100Url(),
  };
}

function deriveBbbStanding(bbb) {
  if (!bbb?.found) return null;
  const letterStanding = bbbLetterStanding(bbb.rating);
  const customerStanding = scoreStanding(bbb.customerRating);
  const complaints = Number(bbb.complaintsClosedLast3Years);
  let label = letterStanding ?? customerStanding ?? 'profile-found';
  if (Number.isFinite(complaints) && complaints >= 25 && !['weak', 'mixed'].includes(label)) {
    label = 'watch-complaints';
  }
  const reasons = [];
  if (bbb.rating) reasons.push(`BBB rating ${bbb.rating}`);
  if (bbb.accredited) reasons.push('BBB accredited');
  if (bbb.customerRating != null) reasons.push(`customer rating ${bbb.customerRating}/5`);
  if (Number.isFinite(complaints)) reasons.push(`${complaints} complaints closed in 3 years`);
  return {
    label,
    summary: reasons.length ? reasons.join('; ') : 'BBB profile found, but detailed rating fields were limited in the captured page.',
    source: 'BBB',
    url: bbb.url,
  };
}

function deriveScoreStanding(source, score, reviewCount, categoryDetails = null, url = '') {
  const label = scoreStanding(score);
  if (!label) return null;
  const reasons = [`${score}/5`];
  if (reviewCount != null) reasons.push(`${Number(reviewCount).toLocaleString()} review/survey count`);
  if (categoryDetails?.qualityOfHome != null) reasons.push(`quality of home ${categoryDetails.qualityOfHome}/5`);
  if (categoryDetails?.responsiveness != null) reasons.push(`responsiveness ${categoryDetails.responsiveness}/5`);
  return {
    label,
    summary: reasons.join('; '),
    source,
    url,
  };
}

function deriveOverallBuilderStanding(reviews) {
  const standings = [
    deriveScoreStanding('Avid Ratings', reviews.avidRatings?.overall, reviews.avidRatings?.reviewCount, reviews.avidRatings?.categories, reviews.avidRatings?.url),
    deriveScoreStanding('Eliant', reviews.eliant?.overall, reviews.eliant?.reviewCount, null, reviews.eliant?.url),
    deriveBbbStanding(reviews.bbb),
    reviews.builderOnline?.standing ?? null,
  ].filter(Boolean);
  if (standings.length === 0) return null;

  const priority = {
    excellent: 5,
    strong: 4,
    'generally-positive': 3.5,
    'mixed-positive': 3,
    mixed: 2,
    'watch-complaints': 1.5,
    weak: 1,
    unrated: 0.5,
    'profile-found': 0.5,
    'top-10-national-builder': 4,
    'top-25-national-builder': 3.5,
    'top-50-national-builder': 3,
    'builder-100-listed': 2.5,
    listed: 2,
  };
  const average = standings.reduce((sum, entry) => sum + (priority[entry.label] ?? 0), 0) / standings.length;
  let label = 'mixed';
  if (average >= 4.5) label = 'excellent';
  else if (average >= 3.6) label = 'strong';
  else if (average >= 2.6) label = 'mixed-positive';
  else if (average < 1.7) label = 'weak-or-limited';

  return {
    label,
    summary: standings.map((entry) => `${entry.source}: ${entry.summary}`).join(' | '),
    sources: standings.map((entry) => ({ source: entry.source, label: entry.label, url: entry.url })),
  };
}

async function lookupBbb(builderName, target) {
  const directUrl = bbbOverrideUrl(builderName, target);
  if (directUrl) {
    const page = await fetchBbbPage(directUrl);
    if (page.ok && page.text) {
      return parseBbbProfile(page.text, page.url, directUrl, page.provider, page.crawl4aiError);
    }
    return {
      found: false,
      url: directUrl,
      requestedUrl: directUrl,
      provider: page.provider,
      httpStatus: page.status,
      error: page.error ?? page.crawl4aiError ?? null,
    };
  }

  const searchUrls = buildBbbSearchUrls(builderName, target);
  const checkedSearches = [];
  for (const searchUrl of searchUrls) {
    const searchPage = await fetchBbbPage(searchUrl);
    checkedSearches.push({
      url: searchUrl,
      finalUrl: searchPage.url,
      ok: searchPage.ok,
      status: searchPage.status,
      provider: searchPage.provider,
      error: searchPage.error ?? searchPage.crawl4aiError ?? null,
    });
    if (!searchPage.ok || !searchPage.text) continue;
    const profileLink = chooseBbbProfileLink(extractBbbProfileLinks(searchPage.text), builderName, target);
    if (!profileLink) continue;
    const profilePage = await fetchBbbPage(profileLink);
    if (profilePage.ok && profilePage.text) {
      return {
        ...parseBbbProfile(profilePage.text, profilePage.url, profileLink, profilePage.provider, profilePage.crawl4aiError),
        searchUrl,
        checkedSearches,
      };
    }
  }

  return {
    found: false,
    url: '',
    checkedSearches,
    reason: 'bbb-profile-not-found',
  };
}

async function lookupAvidRatings(builderSlug) {
  const url = `https://www.avidratings.com/reviews/${builderSlug}`;
  const page = await fetchText(url);

  if (!page.ok) {
    // Try stripping a common "homes" suffix (e.g. "smith-douglas-homes" → "smith-douglas")
    if (builderSlug.endsWith('-homes')) {
      const shortSlug = builderSlug.slice(0, -6);
      const retryPage = await fetchText(`https://www.avidratings.com/reviews/${shortSlug}`);
      if (retryPage.ok) {
        return parseAvidPage(retryPage.text, retryPage.url);
      }
    }
    return { found: false, url, httpStatus: page.status, error: page.error ?? null };
  }

  return parseAvidPage(page.text, page.url);
}

function parseAvidPage(html, url) {
  const body = stripHtml(html);

  // "4.3 / 5 from 361 surveys" — the canonical Avid Ratings summary line
  const overallMatch = body.match(/(\d+\.\d+)\s*\/\s*5\s+from\s+([\d,]+)\s+survey/i);
  if (!overallMatch) {
    return { found: false, url, reason: 'score-not-found' };
  }

  const overall = parseFloat(overallMatch[1]);
  const reviewCount = parseInt(overallMatch[2].replace(/,/g, ''), 10);

  const categoryPatterns = {
    qualityOfHome: /quality of home[^0-9]*(\d+\.\d+)/i,
    qualityOfExperience: /quality of experience[^0-9]*(\d+\.\d+)/i,
    caringDisplayed: /caring displayed[^0-9]*(\d+\.\d+)/i,
    responsiveness: /(?:overall\s+)?responsiveness[^0-9]*(\d+\.\d+)/i,
  };

  const categories = {};
  for (const [key, pattern] of Object.entries(categoryPatterns)) {
    const match = body.match(pattern);
    if (match) categories[key] = parseFloat(match[1]);
  }

  // Extract short review snippets: look for quoted text or sentences after
  // a star/date pattern that suggest homeowner comments.
  const snippets = [];
  const snippetCandidatePattern = /"([^"]{40,280})"/g;
  let match;
  while (snippets.length < 5 && (match = snippetCandidatePattern.exec(body)) !== null) {
    const candidate = match[1].trim();
    if (candidate.split(' ').length >= 8 && !snippets.includes(candidate)) {
      snippets.push(candidate);
    }
  }

  return {
    found: true,
    overall,
    reviewCount,
    categories: Object.keys(categories).length > 0 ? categories : null,
    snippets: snippets.length > 0 ? snippets : null,
    url,
  };
}

async function lookupEliant(builderSlug) {
  const url = `https://reviews.eliant.com/${builderSlug}`;
  const page = await fetchText(url);

  if (!page.ok) {
    return { found: false, url, httpStatus: page.status, error: page.error ?? null };
  }

  const body = stripHtml(page.text);
  const scoreMatch = body.match(/(\d+\.\d+)\s*\/\s*5/);
  if (!scoreMatch) {
    return { found: false, url, reason: 'score-not-found' };
  }

  const overall = parseFloat(scoreMatch[1]);
  const reviewCountMatch = body.match(/([\d,]+)\s+(?:homeowner\s+)?review/i);
  const reviewCount = reviewCountMatch ? parseInt(reviewCountMatch[1].replace(/,/g, ''), 10) : null;

  return { found: true, overall, reviewCount, url };
}

function buildRecord(target, detection, reviews) {
  const { builderName, detectionSource, detectionConfidence, detectionSourceUrl, detectionNotes } = detection;

  if (!builderName) {
    return {
      generatedAt: new Date().toISOString(),
      address: target.address,
      city: target.city,
      state: target.state,
      reportPath: target.relativePath || null,
      builderName: null,
      builderSlug: null,
      detectionSource: null,
      detectionConfidence: null,
      detectionSourceUrl: null,
      detectionNotes: detectionNotes ?? null,
      reviews: {},
      status: 'no-builder-detected',
    };
  }

  const builderSlug = toBuilderSlug(builderName);
  const avidFound = reviews.avidRatings?.found === true;
  const eliantFound = reviews.eliant?.found === true;
  const bbbFound = reviews.bbb?.found === true;
  const builderOnlineFound = reviews.builderOnline?.found === true;
  const status = (avidFound || eliantFound || bbbFound || builderOnlineFound) ? 'found' : 'not-found';

  return {
    generatedAt: new Date().toISOString(),
    address: target.address,
    city: target.city,
    state: target.state,
    reportPath: target.relativePath || null,
    builderName,
    builderSlug,
    detectionSource,
    detectionConfidence,
    detectionSourceUrl: detectionSourceUrl ?? null,
    detectionNotes: detectionNotes ?? null,
    reviews: {
      ...(avidFound ? {
        avidRatings: {
          overall: reviews.avidRatings.overall,
          reviewCount: reviews.avidRatings.reviewCount,
          categories: reviews.avidRatings.categories ?? null,
          snippets: reviews.avidRatings.snippets ?? null,
          url: reviews.avidRatings.url,
          standing: deriveScoreStanding('Avid Ratings', reviews.avidRatings.overall, reviews.avidRatings.reviewCount, reviews.avidRatings.categories, reviews.avidRatings.url),
        },
      } : {}),
      ...(eliantFound ? {
        eliant: {
          overall: reviews.eliant.overall,
          reviewCount: reviews.eliant.reviewCount,
          url: reviews.eliant.url,
          standing: deriveScoreStanding('Eliant', reviews.eliant.overall, reviews.eliant.reviewCount, null, reviews.eliant.url),
        },
      } : {}),
      ...(bbbFound ? {
        bbb: {
          rating: reviews.bbb.rating,
          accredited: reviews.bbb.accredited,
          customerRating: reviews.bbb.customerRating,
          reviewCount: reviews.bbb.reviewCount,
          complaintsClosedLast3Years: reviews.bbb.complaintsClosedLast3Years,
          complaintsClosedLast12Months: reviews.bbb.complaintsClosedLast12Months,
          url: reviews.bbb.url,
          provider: reviews.bbb.provider,
          standing: deriveBbbStanding(reviews.bbb),
        },
      } : {}),
      ...(builderOnlineFound ? {
        builderOnline: {
          url: reviews.builderOnline.url,
          year: reviews.builderOnline.year,
          rank: reviews.builderOnline.rank ?? null,
          priorYearRank: reviews.builderOnline.priorYearRank ?? null,
          totalClosings: reviews.builderOnline.totalClosings ?? null,
          grossRevenueMillions: reviews.builderOnline.grossRevenueMillions ?? null,
          provider: reviews.builderOnline.provider,
          standing: reviews.builderOnline.standing ?? null,
        },
      } : {}),
    },
    standing: deriveOverallBuilderStanding(reviews),
    status,
  };
}

function printSummary(records) {
  console.log('\nBuilder check\n');
  for (const record of records) {
    console.log(`${record.address} | ${record.city}, ${record.state}`);
    if (record.status === 'no-builder-detected') {
      console.log('  Builder: not detected from listing/report text or address search');
    } else if (record.status === 'not-found') {
      console.log(`  Builder: ${record.builderName} — no review data found on Avid Ratings, Eliant, BBB, or Builder 100`);
    } else {
      console.log(`  Builder: ${record.builderName} (${record.detectionConfidence} confidence, source: ${record.detectionSource})`);
      const avid = record.reviews.avidRatings;
      const eliant = record.reviews.eliant;
      const bbb = record.reviews.bbb;
      const builderOnline = record.reviews.builderOnline;
      if (avid) console.log(`  Avid Ratings: ${avid.overall}/5 from ${avid.reviewCount ?? '?'} surveys — QoH: ${avid.categories?.qualityOfHome ?? '?'}`);
      if (eliant) console.log(`  Eliant: ${eliant.overall}/5 from ${eliant.reviewCount ?? '?'} reviews`);
      if (bbb) console.log(`  BBB: ${bbb.rating ?? '?'} rating; customer ${bbb.customerRating ?? '?'}/5; complaints 3yr: ${bbb.complaintsClosedLast3Years ?? '?'}`);
      if (builderOnline) console.log(`  Builder 100: #${builderOnline.rank ?? '?'} in ${builderOnline.year}`);
    }
    console.log('');
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

  if (config.help) {
    console.log(HELP_TEXT);
    return;
  }

  const targets = resolveTargets(config);
  await mkdir(OUTPUT_DIR, { recursive: true });
  const records = [];

  for (const target of targets) {
    let detection = detectBuilder(target);
    if (!detection.builderName) {
      detection = await lookupBuilderFromAddressSearch(target);
    }
    let reviews = {};

    if (detection.builderName) {
      const builderSlug = toBuilderSlug(detection.builderName);
      const [avidResult, eliantResult, bbbResult, builderOnlineResult] = await Promise.all([
        lookupAvidRatings(builderSlug),
        lookupEliant(builderSlug),
        lookupBbb(detection.builderName, target),
        lookupBuilderOnline(detection.builderName),
      ]);
      reviews = { avidRatings: avidResult, eliant: eliantResult, bbb: bbbResult, builderOnline: builderOnlineResult };
    }

    const record = buildRecord(target, detection, reviews);
    const outputPath = buildOutputPath(target);
    await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    records.push({ ...record, outputPath });
  }

  if (config.json) {
    console.log(JSON.stringify({ count: records.length, records }, null, 2));
    return;
  }

  printSummary(records);
}

const isDirectEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectEntry) {
  run().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}

export function readBuilderRecord(target) {
  const outputPath = buildOutputPath(target);
  if (!existsSync(outputPath)) return null;
  return JSON.parse(readFileSync(outputPath, 'utf8'));
}

export { buildOutputPath as builderRecordPath };
