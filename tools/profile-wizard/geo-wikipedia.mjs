/**
 * geo-wikipedia.mjs -- Fetch state / county / town lists from Wikipedia with
 * an on-disk JSON cache so the wizard can populate auto-complete fields
 * quickly on subsequent calls.
 *
 * Cache layout (under .home-ops/wizard-geo-cache/):
 *   states.json                                     -> [{ name, slug }]
 *   counties-{state-slug}.json                      -> [{ name, slug }]
 *   towns-{state-slug}-{county-slug}.json           -> [{ name }]
 *
 * Wikipedia calls use the MediaWiki action=parse API with prop=wikitext.
 * Wikitext list items are easy to regex for and avoids HTML parsing.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// Wikipedia's API policy requires a descriptive User-Agent with a contact
// method. A generic string triggers 429/403 responses quickly, especially
// after any burst traffic.
const USER_AGENT = 'home-ops-profile-wizard/1.0 (local dev; contact=home-ops@example.invalid)';
const WIKI_API = 'https://en.wikipedia.org/w/api.php';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function slugForFilename(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    || 'unknown';
}

function ensureCacheDir(cacheRoot) {
  if (!existsSync(cacheRoot)) {
    mkdirSync(cacheRoot, { recursive: true });
  }
}

function cacheRead(cacheRoot, file) {
  const fullPath = join(cacheRoot, file);
  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch {
    return null;
  }
}

function cacheWrite(cacheRoot, file, payload) {
  ensureCacheDir(cacheRoot);
  writeFileSync(join(cacheRoot, file), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function fetchWikitext(pageTitle, { maxAttempts = 4 } = {}) {
  const url = `${WIKI_API}?action=parse&format=json&redirects=1&prop=wikitext&page=${encodeURIComponent(pageTitle)}`;
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { headers });
    } catch (error) {
      lastError = new Error(`Wikipedia fetch failed for ${pageTitle}: ${error.message}`);
      if (attempt < maxAttempts) { await sleep(500 * attempt); continue; }
      throw lastError;
    }

    if (response.status === 429 || response.status === 503) {
      const retryAfterRaw = response.headers.get('retry-after');
      const retrySeconds = Number.parseInt(retryAfterRaw ?? '', 10);
      const backoffMs = Number.isFinite(retrySeconds) && retrySeconds > 0
        ? Math.min(retrySeconds * 1000, 15000)
        : Math.min(1000 * 2 ** (attempt - 1), 8000);
      lastError = new Error(`Wikipedia ${response.status} for ${pageTitle}`);
      if (attempt < maxAttempts) { await sleep(backoffMs); continue; }
      throw lastError;
    }

    if (!response.ok) throw new Error(`Wikipedia ${response.status} for ${pageTitle}`);

    const body = await response.json();
    if (body?.error) throw new Error(`Wikipedia error: ${body.error.info ?? body.error.code}`);
    const text = body?.parse?.wikitext?.['*'] ?? body?.parse?.wikitext ?? '';
    if (!text) throw new Error(`Wikipedia returned no wikitext for ${pageTitle}`);
    return text;
  }
  throw lastError ?? new Error(`Wikipedia request failed for ${pageTitle}`);
}

// Strip wikilinks to their display form: [[Foo|Bar]] -> Bar, [[Foo]] -> Foo.
function cleanLinkText(raw) {
  return String(raw ?? '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^}]+\}\}/g, '')
    .trim();
}

const US_STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado',
  'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho',
  'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine',
  'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi',
  'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
  'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
  'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina',
  'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia',
  'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
];

const STATE_ABBREVIATIONS = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS',
  Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
  Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI',
  Wyoming: 'WY',
};

export function stateAbbreviation(stateName) {
  return STATE_ABBREVIATIONS[stateName] ?? '';
}

export async function loadStates(cacheRoot) {
  const cached = cacheRead(cacheRoot, 'states.json');
  if (cached && Array.isArray(cached) && cached.length >= 50) return cached;
  const payload = US_STATES.map((name) => ({ name, abbr: STATE_ABBREVIATIONS[name] ?? '' }));
  cacheWrite(cacheRoot, 'states.json', payload);
  return payload;
}

// County-name heuristics: Wikipedia "List of counties in X" pages use a table
// where the first column links to "[[Foo County, X]]". Louisiana uses parishes,
// Alaska uses boroughs/census areas; we accept all three suffixes.
const COUNTY_SUFFIX_RE = /\b(County|Parish|Borough|Census Area|Municipality)\b/i;

export async function loadCounties(cacheRoot, stateName) {
  const file = `counties-${slugForFilename(stateName)}.json`;
  const cached = cacheRead(cacheRoot, file);
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;

  const pageTitle = `List of counties in ${stateName}`;
  const wikitext = await fetchWikitext(pageTitle);

  const counties = new Map();
  const linkPattern = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = linkPattern.exec(wikitext)) !== null) {
    const raw = match[1].trim();
    if (!COUNTY_SUFFIX_RE.test(raw)) continue;
    if (!raw.includes(stateName)) continue;
    const [left] = raw.split(',');
    const baseName = left.trim().replace(/\s+(County|Parish|Borough|Census Area|Municipality)$/i, '').trim();
    if (!baseName) continue;
    if (!counties.has(baseName)) counties.set(baseName, { name: baseName, wikiPage: raw });
  }

  const payload = Array.from(counties.values()).sort((a, b) => a.name.localeCompare(b.name));
  if (payload.length === 0) {
    throw new Error(`Could not parse counties for ${stateName} from Wikipedia.`);
  }
  cacheWrite(cacheRoot, file, payload);
  return payload;
}

const TOWN_SECTION_HEADINGS = [
  'Cities', 'Towns', 'Cities and towns', 'Towns and cities',
  'Villages', 'Townships', 'Municipalities', 'Boroughs',
  'Census-designated places', 'Unincorporated communities',
  'Communities', 'Incorporated places', 'Places', 'Unincorporated areas',
];

function collectSectionBodies(wikitext) {
  // Split on == Heading == lines. Returns [{ title, body }] objects.
  const sections = [];
  const lines = wikitext.split(/\r?\n/);
  let currentTitle = '';
  let currentBody = [];
  for (const line of lines) {
    const header = line.match(/^\s*==+\s*(.+?)\s*==+\s*$/);
    if (header) {
      if (currentTitle) sections.push({ title: currentTitle, body: currentBody.join('\n') });
      currentTitle = header[1].replace(/<[^>]+>/g, '').trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentTitle) sections.push({ title: currentTitle, body: currentBody.join('\n') });
  return sections;
}

function extractPlacesFromSection(body) {
  const results = new Set();

  // Bullet list items. [[Place, State|Place]] or [[Place]] at start of line.
  const bulletPattern = /^[*#:]+\s*(.+)$/gm;
  let match;
  while ((match = bulletPattern.exec(body)) !== null) {
    const line = match[1];
    const linkMatch = line.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    if (!linkMatch) continue;
    const display = cleanLinkText(linkMatch[2] ? linkMatch[2] : linkMatch[1]);
    // Drop trailing ", State" fragments.
    const cleaned = display.split(',')[0].trim();
    if (!cleaned || cleaned.length < 2) continue;
    if (/^(See also|References|Notes|Further reading|External links)/i.test(cleaned)) continue;
    results.add(cleaned);
  }

  return Array.from(results);
}

export async function loadTowns(cacheRoot, stateName, countyName) {
  const file = `towns-${slugForFilename(stateName)}-${slugForFilename(countyName)}.json`;
  const cached = cacheRead(cacheRoot, file);
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;

  const pageTitle = `${countyName} County, ${stateName}`;
  let wikitext;
  try {
    wikitext = await fetchWikitext(pageTitle);
  } catch (error) {
    // Louisiana parishes, Alaska boroughs etc.
    const alternatives = [
      `${countyName} Parish, ${stateName}`,
      `${countyName} Borough, ${stateName}`,
      `${countyName} Census Area, ${stateName}`,
      `${countyName}, ${stateName}`,
    ];
    let found = null;
    for (const alt of alternatives) {
      try {
        found = await fetchWikitext(alt);
        break;
      } catch {
        // keep trying
      }
    }
    if (!found) throw error;
    wikitext = found;
  }

  const sections = collectSectionBodies(wikitext);
  const places = new Set();
  for (const section of sections) {
    if (!TOWN_SECTION_HEADINGS.some((heading) => new RegExp(`^${heading}$`, 'i').test(section.title))) continue;
    for (const place of extractPlacesFromSection(section.body)) {
      places.add(place);
    }
  }

  // Some county pages put places under "Communities" with sub-sections named
  // "Cities", "Towns", etc. at level 3. The flat splitter above already
  // catches those because level-3 headings share the same == ... == form.

  const payload = Array.from(places).sort((a, b) => a.localeCompare(b)).map((name) => ({ name }));
  if (payload.length === 0) {
    throw new Error(`Could not parse towns for ${countyName} County, ${stateName} from Wikipedia.`);
  }
  cacheWrite(cacheRoot, file, payload);
  return payload;
}
