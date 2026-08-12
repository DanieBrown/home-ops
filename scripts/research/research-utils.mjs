import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import YAML from 'yaml';
import {
  ROOT,
  REPORTS_DIR,
  SHORTLIST_PATH,
  PROFILE_PATH,
  PORTALS_PATH,
} from '../shared/paths.mjs';
import { slugify } from '../shared/text-utils.mjs';
import { parseSubdivisionFromLegalDescription } from './neighborhood-resolution.mjs';
import { readResearchDefaults } from '../shared/research-defaults.mjs';

export { ROOT, REPORTS_DIR, SHORTLIST_PATH, PROFILE_PATH, PORTALS_PATH };

export const AUDIT_SECTION_DEFS = [
  {
    heading: 'Neighborhood Sentiment',
    sourcePatterns: [/facebook/i, /nextdoor/i, /google maps/i, /google reviews/i, /wral/i, /abc11/i, /news\s*&?\s*observer/i],
    gapPatterns: [
      /neighborhood sentiment was not expanded beyond the listing page evidence/i,
      /limited community sentiment/i,
      /no independent neighborhood/i,
      /not accessible/i,
      /not yet validated/i,
    ],
  },
  {
    heading: 'School Review',
    sourcePatterns: [/greatschools/i, /niche/i, /schooldigger/i, /report card/i, /nc report/i, /parent sentiment/i, /community sentiment/i],
    gapPatterns: [
      /assigned-school ratings were not surfaced/i,
      /no school ratings/i,
      /cannot verify schools/i,
      /critical gap/i,
      /no greatschools/i,
    ],
  },
  {
    heading: 'Development and Infrastructure',
    sourcePatterns: [/wake county/i, /imaps/i, /planning/i, /development services/i, /planning\s*&\s*zoning/i, /ncdot/i, /stip/i, /rezoning/i],
    gapPatterns: [
      /no separate development and infrastructure pass was completed/i,
      /no separate planning review was completed/i,
      /no separate county planning review was completed/i,
      /no broader planning pass was completed/i,
      /no separate planning or infrastructure review was completed/i,
      /no separate county\/planning review was completed/i,
      /no separate planning pass was completed beyond the listing data/i,
    ],
  },
];

const REPORT_SECTION_HEADINGS = [
  'Quick Take',
  'Summary Card',
  'Hard Requirement Gate',
  'Property Fit',
  'Neighborhood Sentiment',
  'School Review',
  'Development and Infrastructure',
  'Financial Snapshot',
  'Risks and Open Questions',
  'Recommendation',
];

const REPORT_SECTION_ALIASES = {
  'Quick Take': ['Executive Summary'],
  'Summary Card': ['Listing Facts'],
  'Property Fit': ['Listing Facts', 'Key Positives', 'Key Gaps / Risks', 'Axis 1 — Listing Facts & Property Assessment', 'Axis 1 - Listing Facts & Property Assessment'],
  'Neighborhood Sentiment': ['Axis 2 — Neighborhood Sentiment', 'Axis 2 - Neighborhood Sentiment'],
  'School Review': ['Schools', 'Schools (Preliminary)', 'Axis 3 — Schools', 'Axis 3 - Schools'],
  'Development and Infrastructure': ['Axis 4 — Development & Infrastructure Risk', 'Axis 4 - Development & Infrastructure Risk', 'Development Pipeline and Future Change'],
  'Financial Snapshot': ['Axis 7 — Financial Fit & Resale', 'Axis 7 - Financial Fit & Resale'],
  'Risks and Open Questions': ['Data Gap Summary', 'Key Gaps / Risks', 'Research Coverage'],
  Recommendation: ['Verdict', 'Recommendation (Preliminary)'],
};

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeWorkspacePath(rawPath) {
  return String(rawPath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

export function resolveWorkspacePath(projectRoot, rawPath) {
  const value = String(rawPath ?? '').trim();
  if (!value) {
    return projectRoot;
  }

  if (isAbsolute(value)) {
    return value;
  }

  return join(projectRoot, normalizeWorkspacePath(rawPath));
}

export function readUtf8(filePath) {
  return readFileSync(filePath, 'utf8');
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readUtf8(filePath));
  } catch {
    return null;
  }
}

function parseMarkdownTable(lines, startHeader) {
  const startIndex = lines.findIndex((line) => line.trim() === startHeader);
  if (startIndex === -1) {
    return [];
  }

  const rows = [];
  for (let index = startIndex + 2; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed.startsWith('|')) {
      break;
    }

    rows.push(trimmed.split('|').slice(1, -1).map((value) => value.trim()));
  }

  return rows;
}

function parseMarkdownTableByHeaders(lines, headers) {
  for (const header of headers) {
    const rows = parseMarkdownTable(lines, header);
    if (rows.length > 0 || lines.some((line) => line.trim() === header)) {
      return rows;
    }
  }

  return [];
}

function extractMarkdownLinkTarget(value) {
  const match = String(value ?? '').match(/\[[^\]]+\]\(([^)]+)\)/);
  return match ? match[1].trim() : null;
}

export function normalizeKey(address, city) {
  return `${String(address ?? '').trim().toLowerCase()}|${String(city ?? '').trim().toLowerCase()}`;
}

export function parseShortlist(projectRoot = ROOT, shortlistPath = SHORTLIST_PATH) {
  const absoluteShortlistPath = resolveWorkspacePath(projectRoot, shortlistPath);
  const content = readUtf8(absoluteShortlistPath);
  const lines = content.split(/\r?\n/);
  const top10Rows = parseMarkdownTableByHeaders(lines, ['## Top 10 Homes', '## Compare Top 10', '## Tagged Homes']);
  const refinedRows = parseMarkdownTableByHeaders(lines, ['## Refined Top 3 After Deep', '## Refined Ranking After Deep']);

  const top10 = top10Rows.map((columns) => ({
    rank: columns[0],
    tag: columns[1],
    trackerNumber: columns[2],
    address: columns[3],
    city: columns[4],
    score: columns[5],
    status: columns[6],
    reportPath: extractMarkdownLinkTarget(columns[7]),
    notes: columns[8],
  })).filter((row) => row.reportPath);

  const top10Index = new Map(top10.map((row) => [normalizeKey(row.address, row.city), row]));

  const refinedTop3 = refinedRows.map((columns) => {
    const address = columns[1];
    const city = columns[2];

    return {
      rank: columns[0],
      address,
      city,
      updatedVerdict: columns[3],
      why: columns[4],
      reportPath: top10Index.get(normalizeKey(address, city))?.reportPath ?? null,
    };
  }).filter((row) => row.reportPath);

  return {
    filePath: absoluteShortlistPath,
    top10,
    refinedTop3,
  };
}

function parseHeaderField(content, label) {
  const pattern = new RegExp(`^\\*\\*${escapeForRegex(label)}:\\*\\*\\s*(.+)$`, 'mi');
  const match = content.match(pattern);
  return match ? match[1].trim() : '';
}

function parseScoreNumber(rawScore) {
  const match = String(rawScore ?? '').match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  return match ? Number.parseFloat(match[1]) : null;
}

export function getSection(content, heading) {
  const pattern = new RegExp(`## ${escapeForRegex(heading)}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
  const match = content.match(pattern);
  return match ? match[1].trim() : '';
}

function getSectionAny(content, headings) {
  return headings
    .map((heading) => getSection(content, heading))
    .find((section) => section && section.trim()) ?? '';
}

function parseTitleLocation(titleLine) {
  const rawTitle = titleLine.replace(/^#\s+/, '').trim();
  const normalizedTitle = rawTitle
    .replace(/^Deep\s+Brief\s*[—-]\s*/i, '')
    .replace(/^\d+\s*[—-]\s*/, '')
    .trim();

  const dashMatch = normalizedTitle.match(/^(.+?)\s+-\s+([^,]+),\s*([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/);
  if (dashMatch) {
    return {
      address: dashMatch[1].trim(),
      city: dashMatch[2].trim(),
      state: dashMatch[3].trim(),
    };
  }

  const commaMatch = normalizedTitle.match(/^(.+?),\s*([^,]+),\s*([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/);
  if (commaMatch) {
    return {
      address: commaMatch[1].trim(),
      city: commaMatch[2].trim(),
      state: commaMatch[3].trim(),
    };
  }

  return { address: '', city: '', state: '' };
}

function stripMarkdown(value) {
  return String(value ?? '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
}

function extractMarkdownLink(value) {
  const match = String(value ?? '').match(/\[[^\]]+\]\(([^)]+)\)/);
  return match ? match[1].trim() : '';
}

function parseTableField(content, labels) {
  const labelPattern = labels.map(escapeForRegex).join('|');
  const pattern = new RegExp(`^\\|\\s*(?:${labelPattern})\\s*\\|\\s*([^|]+?)\\s*\\|`, 'mi');
  const match = content.match(pattern);
  return match ? stripMarkdown(match[1]) : '';
}

function parseCombinedBedsBaths(content) {
  const combined = parseHeaderField(content, 'Beds/Baths') || parseTableField(content, ['Beds/Baths', 'Bed/Bath']);
  if (combined) return combined;
  const beds = parseTableField(content, ['Beds', 'Bedrooms']);
  const baths = parseTableField(content, ['Baths', 'Bathrooms']);
  if (beds || baths) return `${beds || '--'}/${baths || '--'}`;
  return '';
}

function parseOverallScore(content) {
  const header = parseHeaderField(content, 'Overall Score');
  if (header) return header;
  const table = parseTableField(content, ['Overall Score', 'Score']);
  if (table && /\d/.test(table)) return table;
  const finalScore = getSection(content, 'Final Score').match(/(\d+(?:\.\d+)?)\s*\/\s*5/i);
  if (finalScore) return `${finalScore[1]}/5`;
  const preliminary = content.match(/\b(?:Preliminary\s+)?score\s*:\s*(\d+(?:\.\d+)?)\s*\/\s*5/i);
  return preliminary ? `${preliminary[1]}/5` : '';
}

export function parseReport(projectRoot = ROOT, reportPath) {
  const absoluteReportPath = resolveWorkspacePath(projectRoot, reportPath);
  const content = readUtf8(absoluteReportPath).replace(/^\uFEFF/, '');
  const lines = content.split(/\r?\n/);
  const titleLine = lines.find((line) => line.startsWith('# ')) ?? '';
  const titleLocation = parseTitleLocation(titleLine);

  const sections = Object.fromEntries(
    REPORT_SECTION_HEADINGS.map((heading) => {
      const aliases = REPORT_SECTION_ALIASES[heading] ?? [];
      return [heading, getSectionAny(content, [heading, ...aliases])];
    }),
  );

  const source = parseHeaderField(content, 'Source');
  const sourceUrl = extractMarkdownLink(source);

  return {
    filePath: absoluteReportPath,
    relativePath: normalizeWorkspacePath(relative(projectRoot, absoluteReportPath)),
    title: titleLine.replace(/^#\s+/, '').trim(),
    address: titleLocation.address,
    city: titleLocation.city,
    state: titleLocation.state,
    metadata: {
      date: parseHeaderField(content, 'Date'),
      source,
      url: parseHeaderField(content, 'URL') || sourceUrl,
      price: parseHeaderField(content, 'Price') || parseTableField(content, ['Price', 'List price', 'List Price']),
      bedsBaths: parseCombinedBedsBaths(content),
      sqft: parseHeaderField(content, 'SqFt') || parseTableField(content, ['SqFt', 'Finished SqFt', 'Finished Sqft', 'Square Feet']),
      lot: parseHeaderField(content, 'Lot') || parseTableField(content, ['Lot', 'Lot size', 'Lot Size']),
      yearBuilt: parseHeaderField(content, 'Year Built') || parseTableField(content, ['Year Built', 'Built']),
      hoa: parseHeaderField(content, 'HOA') || parseTableField(content, ['HOA', 'HOA monthly', 'HOA Monthly']),
      daysOnMarket: parseHeaderField(content, 'Days on Market') || parseTableField(content, ['Days on Market', 'DOM']),
      overallScore: parseOverallScore(content),
      recommendation: parseHeaderField(content, 'Recommendation'),
      confidence: parseHeaderField(content, 'Confidence'),
      verification: parseHeaderField(content, 'Verification'),
    },
    scoreNumber: parseScoreNumber(parseOverallScore(content)),
    sections,
    content,
  };
}

export function auditParsedReport(report) {
  const audit = {
    filePath: report.filePath,
    relativePath: report.relativePath,
    issues: [],
    warnings: [],
  };

  for (const sectionDef of AUDIT_SECTION_DEFS) {
    const section = report.sections[sectionDef.heading] ?? '';
    if (!section) {
      audit.issues.push({ heading: sectionDef.heading, message: 'missing section' });
      continue;
    }

    const matchedGap = sectionDef.gapPatterns.find((pattern) => pattern.test(section));
    if (matchedGap) {
      audit.issues.push({ heading: sectionDef.heading, message: 'explicit gap noted in report' });
      continue;
    }

    const hasSourceReference = sectionDef.sourcePatterns.some((pattern) => pattern.test(section));
    if (!hasSourceReference) {
      audit.warnings.push({ heading: sectionDef.heading, message: 'no explicit external source reference found' });
    }
  }

  return audit;
}

export function auditEvaluationReport(projectRoot = ROOT, reportPath) {
  return auditParsedReport(parseReport(projectRoot, reportPath));
}

export function getCriticalAuditFindings(audit, options = {}) {
  const headings = options.headings ?? AUDIT_SECTION_DEFS.map((definition) => definition.heading);
  const strictWarnings = options.strictWarnings ?? true;
  const headingSet = new Set(headings);
  const findings = [...audit.issues.filter((finding) => headingSet.has(finding.heading))];

  if (strictWarnings) {
    findings.push(...audit.warnings.filter((finding) => headingSet.has(finding.heading)));
  }

  return findings;
}

function normalizeLookupValue(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function splitCountyValue(value) {
  return String(value ?? '')
    .split(/[\/,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function dedupeStrings(values) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function dedupeSources(entries) {
  const seen = new Set();
  const unique = [];

  for (const entry of entries) {
    const key = `${String(entry.name ?? '').trim().toLowerCase()}|${String(entry.url ?? '').trim().toLowerCase()}`;
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(entry);
  }

  return unique;
}

function humanizeKey(key) {
  return String(key ?? '')
    .split(/[_-]+/)
    .map((part) => {
      if (part.toLowerCase() === 'nc') {
        return 'NC';
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function getAllProfileCounties(profile) {
  return dedupeStrings((profile.search?.areas ?? []).flatMap((area) => splitCountyValue(area?.county)));
}

export function loadResearchConfig(projectRoot = ROOT) {
  return {
    profile: YAML.parse(readUtf8(join(projectRoot, 'config', 'profile.yml'))) ?? {},
    portals: YAML.parse(readUtf8(join(projectRoot, 'portals.yml'))) ?? {},
    generatedDevelopmentSources: readJsonIfExists(join(projectRoot, 'output', 'development-sources.json')),
    generatedStateSources: readJsonIfExists(join(projectRoot, 'output', 'state-sources.json')),
    generatedUtilitySources: readJsonIfExists(join(projectRoot, 'output', 'utility-sources.json')),
  };
}

// ── ArcGIS REST client ──────────────────────────────────────────────
//
// Shared by every spatial capture script (county-permits-check,
// site-hazards-check, parcel-tax-check, access-check) so radius handling,
// timeouts, and error shape stay identical across sources.

export const ARCGIS_TIMEOUT_MS = 25000;
export const ARCGIS_USER_AGENT = 'home-ops/spatial-check (+https://github.com/)';

/**
 * Query an ArcGIS REST feature/map layer.
 *
 * Pass `point: {lat, lng}` for a spatial query (optionally with
 * `radiusMeters`), or `where` alone for an attribute query. Never throws: a
 * dead source comes back as `{ ok: false, error }` so the caller can record
 * `blocked` rather than imply "no hazard found".
 */
export async function arcgisQuery(serviceUrl, options = {}) {
  const {
    point = null,
    radiusMeters = null,
    where = '1=1',
    outFields = '*',
    returnGeometry = false,
    outSR = 4326,
    inSR = 4326,
    resultRecordCount = null,
    timeoutMs = ARCGIS_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;

  const params = new URLSearchParams({
    f: 'json',
    where,
    outFields,
    returnGeometry: String(Boolean(returnGeometry)),
  });

  if (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) {
    params.set('geometry', `${point.lng},${point.lat}`);
    params.set('geometryType', 'esriGeometryPoint');
    params.set('inSR', String(inSR));
    params.set('spatialRel', 'esriSpatialRelIntersects');
    if (Number.isFinite(radiusMeters) && radiusMeters > 0) {
      params.set('distance', String(radiusMeters));
      params.set('units', 'esriSRUnit_Meter');
    }
  }
  if (returnGeometry) params.set('outSR', String(outSR));
  if (Number.isFinite(resultRecordCount)) params.set('resultRecordCount', String(resultRecordCount));

  const url = `${serviceUrl}/query?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': ARCGIS_USER_AGENT },
    });
    if (!response.ok) {
      return { ok: false, status: response.status, features: [], error: `HTTP ${response.status}`, url };
    }
    const body = await response.json();
    if (body?.error) {
      return { ok: false, status: response.status, features: [], error: body.error.message || 'service error', url };
    }
    return { ok: true, status: response.status, features: body.features ?? [], url };
  } catch (error) {
    return { ok: false, status: 0, features: [], error: String(error?.message ?? error), url };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Escapes a value for an ArcGIS `where` string literal. ArcGIS uses SQL-92
 * quoting, so a single quote is doubled.
 */
export function arcgisLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

export function resolveAreaContext(report, context) {
  const areas = context.profile.search?.areas ?? [];
  const cityLookup = normalizeLookupValue(report.city);
  const matchedArea = areas.find((area) => normalizeLookupValue(area?.name) === cityLookup)
    ?? areas.find((area) => cityLookup && normalizeLookupValue(area?.name).includes(cityLookup));

  const manualCounties = splitCountyValue(report.manualCountyHint);
  const counties = manualCounties.length > 0
    ? manualCounties
    : matchedArea
      ? splitCountyValue(matchedArea.county)
      : getAllProfileCounties(context.profile);

  return {
    matchedArea,
    counties: dedupeStrings(counties),
  };
}

export function extractSchoolNames(report) {
  const schoolText = [
    report.sections['School Review'],
    report.sections['Hard Requirement Gate'],
  ].filter(Boolean).join('\n');

  const regex = /\b([A-Z][A-Za-z0-9.'&-]*(?:\s+[A-Z][A-Za-z0-9.'&-]*)*\s(?:Elementary|Middle|High|Academy|School))\b/g;
  const names = dedupeStrings(Array.from(schoolText.matchAll(regex), (match) => match[1]))
    .filter((name) => {
      const value = name.toLowerCase();
      if (/\b(elementary|middle|high|academy)\b/.test(value)) return true;
      if (/\b(public|county|district|system|assigned|magnet|charter)\b/.test(value)) return false;
      return true;
    });
  const nameSet = new Set(names.map((name) => name.toLowerCase()));
  return names.filter((name) => {
    const value = name.toLowerCase();
    if (/\bschool$/.test(value)) return true;
    return !nameSet.has(`${value} school`);
  });
}

function slugForReport(report) {
  return slugify(`${report?.address ?? ''}-${report?.city ?? ''}-${report?.state || 'NC'}`);
}

function readPropertySidecar(kind, report) {
  const slug = slugForReport(report);
  if (!slug) return null;
  return readJsonIfExists(join(ROOT, 'output', kind, `${slug}.json`));
}

/**
 * The report is written before capture runs, and the agent writing it
 * doesn't know the subdivision either -- so subdivision hints can't come
 * from report prose alone without being circular. These sidecars are
 * populated earlier in the deep pipeline (community-lookup, parcel-tax-check,
 * extract-listing-details, hoa-docs-check) and are read here as a purely
 * additive seed; a report with no sidecars yet falls through to prose
 * unchanged.
 */
function subdivisionHintsFromSidecars(report) {
  const hints = [];

  const community = readPropertySidecar('communities', report);
  if (community?.community) hints.push(community.community);

  const parcel = readPropertySidecar('parcel', report);
  const legalName = parcel?.parcel?.legalDescription
    ? parseSubdivisionFromLegalDescription(parcel.parcel.legalDescription)
    : null;
  if (legalName) hints.push(legalName);

  const listing = readPropertySidecar('listings', report);
  if (listing?.communityName) hints.push(listing.communityName);

  const hoa = readPropertySidecar('hoa', report);
  const hoaName = hoa?.hoa?.communityName || hoa?.hoa?.associationName;
  if (hoaName) hints.push(hoaName);

  return dedupeStrings(hints);
}

export function extractSubdivisionHints(report) {
  const manualHint = report.manualSubdivisionHint ? [report.manualSubdivisionHint] : [];
  const sidecarHints = subdivisionHintsFromSidecars(report);
  const sourceText = [
    report.sections['Quick Take'],
    report.sections['Neighborhood Sentiment'],
    report.sections['Development and Infrastructure'],
  ].filter(Boolean).join('\n');
  const regex = /\b([A-Z][A-Za-z0-9'&-]+(?:\s+[A-Z][A-Za-z0-9'&-]+)+)\s+(?:subdivision|community|presale|neighborhood|home)\b/g;

  return dedupeStrings([
    ...manualHint,
    ...sidecarHints,
    ...Array.from(sourceText.matchAll(regex), (match) => match[1]),
  ]);
}

export function extractRoadHints(report) {
  const sourceText = [
    report.sections['Development and Infrastructure'],
    report.sections['Risks and Open Questions'],
    report.sections['Recommendation'],
  ].filter(Boolean).join('\n');

  const regexes = [
    /\b(?:Highway|Hwy)\s+\d+\b/g,
    /\b(?:I|US|NC|SR)[-\s]?\d+\b/g,
    /\b[A-Z][A-Za-z0-9'&.-]+(?:\s+[A-Z][A-Za-z0-9'&.-]+)*\s(?:Road|Rd|Highway|Hwy|Pkwy|Parkway|Boulevard|Blvd|Street|St|Avenue|Ave)\b/g,
  ];

  return dedupeStrings(regexes.flatMap((regex) => Array.from(sourceText.matchAll(regex), (match) => match[0])));
}

function appendQuery(targets, value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed) {
    targets.push(trimmed);
  }
}

function buildDevelopmentQueries(source, report, areaContext) {
  const subdivisionHints = extractSubdivisionHints(report);
  const roadHints = extractRoadHints(report);
  const targets = [];
  const sourceName = String(source.name ?? '').toLowerCase();

  if (sourceName.includes('imaps')) {
    appendQuery(targets, report.address);
    subdivisionHints.forEach((hint) => appendQuery(targets, hint));
    appendQuery(targets, `${report.city} parcel search`);
    return dedupeStrings(targets);
  }

  if (sourceName.includes('permit') || sourceName.includes('epermit') || sourceName.includes('cityview') || sourceName.includes('click2gov')) {
    appendQuery(targets, report.address);
    appendQuery(targets, `${report.address} permit`);
    appendQuery(targets, `${report.city} permit search`);
    appendQuery(targets, `${report.city} service address permit`);
    return dedupeStrings(targets);
  }

  if (sourceName.includes('planning') || sourceName.includes('development') || sourceName.includes('zoning') || sourceName.includes('inspections')) {
    subdivisionHints.forEach((hint) => appendQuery(targets, `${hint} site plan`));
    subdivisionHints.forEach((hint) => appendQuery(targets, `${hint} rezoning`));
    appendQuery(targets, `${report.city} rezoning`);
    appendQuery(targets, `${report.city} site plan`);
    appendQuery(targets, report.address);
    return dedupeStrings(targets);
  }

  if (sourceName.includes('ncdot') || sourceName.includes('stip') || sourceName.includes('project')) {
    roadHints.forEach((hint) => appendQuery(targets, hint));
    appendQuery(targets, `${report.city} road widening`);
    appendQuery(targets, `${report.city} traffic improvement`);
    areaContext.counties.forEach((county) => appendQuery(targets, `${county} County STIP`));
    return dedupeStrings(targets);
  }

  appendQuery(targets, report.address);
  subdivisionHints.forEach((hint) => appendQuery(targets, hint));
  appendQuery(targets, `${report.city} development`);
  return dedupeStrings(targets);
}

function methodLabel(method) {
  const labels = {
    address: 'address',
    'service-address': 'service address',
    pin: 'PIN',
    parcel: 'parcel ID',
    owner: 'owner name',
    'permit-number': 'permit number',
    'application-search': 'application search',
    'property-search': 'property search',
    'inspection-results': 'inspection results',
    'application-permit': 'application/permit search',
    'related-permit-summary': 'related permit summary',
    'parcel-address-pin-owner': 'parcel search by parcel ID, PIN, address, or owner name',
    inspection: 'inspection search',
  };
  return labels[method] ?? String(method ?? '').replace(/[-_]+/g, ' ');
}

const WAKE_ENERGOV_PERMIT_SOURCE = {
  name: 'Wake County Permit Portal (EnerGov SelfService)',
  url: 'https://wakecountync-energovpub.tylerhost.net/apps/SelfService#/search',
  note: 'Use for current Wake County permit records. Populate the search bar with the target service address before extracting permit, inspection, applicant, contractor, builder, or owner details.',
};

function normalizeWakePermitSource(source) {
  const haystack = normalizeLookupValue(`${source?.appliesTo ?? ''} ${source?.jurisdiction ?? ''} ${source?.name ?? ''} ${source?.url ?? ''}`);
  const isWakePermitSource = haystack.includes('wake')
    && (haystack.includes('permit') || haystack.includes('planning development inspections'))
    && !haystack.includes('pre 2018')
    && !haystack.includes('permitsearch wake gov');
  if (!isWakePermitSource) {
    return source;
  }
  return {
    ...source,
    name: WAKE_ENERGOV_PERMIT_SOURCE.name,
    url: WAKE_ENERGOV_PERMIT_SOURCE.url,
    note: WAKE_ENERGOV_PERMIT_SOURCE.note,
    lookupMethods: source.lookupMethods ?? ['address', 'pin', 'permit-number'],
  };
}

function buildPermitLookupInstructions(source, report) {
  const methods = Array.isArray(source.lookupMethods) ? source.lookupMethods : [];
  const labels = methods.map(methodLabel).filter(Boolean);
  const city = report.city || 'the city';
  const address = report.address || 'the listing address';

  if (/wakecountync-energovpub|EnerGov SelfService/i.test(`${source.name ?? ''} ${source.url ?? ''}`)) {
    return [
      'Open the Wake County EnerGov SelfService search page.',
      `Populate the global search bar with the service address: ${address}.`,
      'Wait for matching records before extracting permit or inspection details.',
      'Record permit number, work type, status, issued/finaled dates, inspection result, applicant, contractor, builder, and owner when the portal exposes them.',
      'If no match appears, note that the address search was tried, then retry PIN/parcel or permit number if available.',
    ];
  }

  if (/durham/i.test(`${source.name ?? ''} ${source.jurisdiction ?? ''} ${source.url ?? ''}`)) {
    return [
      'Open the Durham LDO search link and choose "Perform a new search" if it lands on the results page.',
      `Start with Application/Permit and search the service address: ${address}.`,
      'If that is thin, use Parcel by Parcel ID, PIN, Address or Owner Name with the street address first, then parcel/PIN or owner if available from the listing or county record.',
      'Use Permit/Related Permit Summary and Inspection to spot related permits, finaled inspections, or open items.',
      'Record permit number, work type, status, issued/finaled dates, and inspection result; note "no matching record found" only after trying address plus parcel/PIN or owner.',
    ];
  }

  const methodPhrase = labels.length
    ? labels.join(', ')
    : 'address, parcel/PIN, owner, and permit-number search where available';
  return [
    `Open the ${source.name ?? `${city} permit portal`}.`,
    `Search for ${address} first, then try ${methodPhrase}.`,
    'Record permit number, work type, status, issued/finaled dates, and inspection result when the portal exposes them.',
    'If no match appears, note which lookup methods were tried instead of treating the home as permit-clear.',
  ];
}

function buildPropertyPermitGuides(report, context, areaContext) {
  const generated = context.generatedDevelopmentSources ?? {};
  const cityNeedles = dedupeStrings([report.city, areaContext.matchedArea?.name]).map(normalizeLookupValue);
  const countyNeedles = areaContext.counties.map(normalizeLookupValue);
  const sources = Array.isArray(generated.propertyPermitSources)
    ? generated.propertyPermitSources.filter((source) => {
      const haystack = normalizeLookupValue(`${source?.appliesTo ?? ''} ${source?.jurisdiction ?? ''} ${source?.name ?? ''}`);
      return cityNeedles.some((needle) => needle && haystack.includes(needle))
        || countyNeedles.some((needle) => needle && haystack.includes(needle));
    })
    : [];

  return dedupeSources(sources.map(normalizeWakePermitSource)).map((source) => ({
    name: source.name ?? 'Property permit lookup',
    url: source.url ?? '',
    jurisdiction: source.jurisdiction ?? source.appliesTo ?? '',
    sourceLevel: source.sourceLevel ?? '',
    lookupMethods: source.lookupMethods ?? [],
    note: source.note ?? '',
    recommendedQueries: buildDevelopmentQueries(source, report, areaContext),
    instructions: buildPermitLookupInstructions(source, report),
  }));
}

function buildSchoolQueries(key, report) {
  const schoolNames = extractSchoolNames(report);
  if (schoolNames.length === 0) {
    return dedupeStrings([
      `${report.address} assigned schools`,
      `${report.city} assigned schools`,
      `${report.city} school ratings`,
    ]);
  }

  if (key === 'nc_report_cards' || key === 'state_report_cards') {
    return dedupeStrings(schoolNames.map((name) => `${name} NC report card`));
  }

  return schoolNames;
}

function buildGreatSchoolsUrl(report) {
  const address = String(report.address ?? '').trim();
  const city = String(report.city ?? '').trim();
  const state = String(report.state ?? 'NC').trim();
  if (!city || !state) return '';
  const locationLabel = [address, city, state, 'USA'].filter(Boolean).join(' ');
  const params = new URLSearchParams();
  params.set('city', city);
  params.set('locationLabel', locationLabel);
  params.append('st[]', 'public');
  params.set('state', state);
  return `https://www.greatschools.org/search/search.page?${params.toString()}`;
}

function buildNicheUrl(report) {
  const city = String(report.city ?? '').trim();
  const state = String(report.state ?? 'NC').trim();
  if (!city || !state) return '';
  const slugCity = city.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `https://www.niche.com/places-to-live/${slugCity}-${state.toLowerCase()}/`;
}

function buildSchoolSourceUrl(key, fallbackUrl, report) {
  if (key === 'greatschools') {
    const url = buildGreatSchoolsUrl(report);
    if (url) return url;
  }
  if (key === 'niche') {
    const url = buildNicheUrl(report);
    if (url) return url;
  }
  return fallbackUrl;
}

/**
 * Google Maps queries built from schools or a single address return
 * directory entries (name, hours) with zero review text -- those targets
 * don't accumulate reviews. This targets places that do: HOA amenities,
 * parks, grocery, and named intersections, seeded from
 * templates/research-defaults.yml sentiment.google_maps_poi_categories so
 * the catalog stays editable without a code change. Only the first three
 * queries become search URLs (buildSentimentSearchUrls), so category order
 * here is the priority order.
 */
function buildGoogleMapsPoiQueries(subdivisionHints, roadHints, cityName) {
  const categories = readResearchDefaults().sentiment?.google_maps_poi_categories ?? [];
  const subdivision = subdivisionHints[0] ?? null;
  const road = roadHints[0] ?? null;
  const queries = [];

  for (const category of categories) {
    if (category.requires === 'subdivision' && !subdivision) continue;
    if (category.requires === 'road' && !road) continue;
    const query = String(category.query_template ?? '')
      .replace('{subdivision_or_city}', subdivision || cityName)
      .replace('{subdivision}', subdivision ?? '')
      .replace('{city}', cityName)
      .replace('{road}', road ?? '')
      .trim();
    appendQuery(queries, query);
  }

  return dedupeStrings(queries);
}

function buildSentimentQueries(key, report, areaContext) {
  const subdivisionHints = extractSubdivisionHints(report);
  const roadHints = extractRoadHints(report);
  const schoolNames = extractSchoolNames(report);
  const cityName = dedupeStrings([report.city, areaContext.matchedArea?.name])[0] ?? report.city;

  if (key === 'google_maps') {
    const poiQueries = buildGoogleMapsPoiQueries(subdivisionHints, roadHints, cityName);
    if (poiQueries.length > 0) {
      appendQuery(poiQueries, `${cityName} traffic`);
      return dedupeStrings(poiQueries).slice(0, 5);
    }
    // No subdivision/road hints at all for this home -- fall through to the
    // generic query set below rather than searching nothing.
  }

  const queries = [];
  subdivisionHints.forEach((hint) => appendQuery(queries, hint));
  subdivisionHints.forEach((hint) => appendQuery(queries, `${hint} ${cityName}`));
  schoolNames.slice(0, 2).forEach((name) => appendQuery(queries, name));
  roadHints.slice(0, 2).forEach((hint) => appendQuery(queries, `${hint} traffic`));

  if (queries.length === 0) {
    appendQuery(queries, `${report.address} ${cityName}`.trim());
  }

  appendQuery(queries, `${cityName} neighborhood`);
  appendQuery(queries, `${cityName} traffic`);

  const unique = dedupeStrings(queries);
  if (key === 'facebook' || key === 'nextdoor') {
    return unique.slice(0, 6);
  }

  return unique.slice(0, 5);
}

function mapDevelopmentSources(report, context) {
  const areaContext = resolveAreaContext(report, context);
  const developmentSources = context.portals.development_sources ?? {};
  const generatedDevelopment = context.generatedDevelopmentSources ?? {};
  const sources = [];

  const countySources = [
    ...(Array.isArray(developmentSources.county) ? developmentSources.county : []),
    ...(Array.isArray(developmentSources.wake_county) ? developmentSources.wake_county : []),
    ...(Array.isArray(developmentSources.harnett_county) ? developmentSources.harnett_county : []),
  ];
  if (countySources.length > 0) {
    const countyNeedles = areaContext.counties.map(normalizeLookupValue);
    sources.push(...countySources.filter((source) => {
      const haystack = normalizeLookupValue(`${source?.name ?? ''} ${source?.url ?? ''}`);
      return countyNeedles.length === 0 || countyNeedles.some((needle) => needle && haystack.includes(needle));
    }));
  }

  if (areaContext.counties.some((county) => normalizeLookupValue(county) === 'wake')) {
    sources.push(...(Array.isArray(developmentSources.wake_county) ? developmentSources.wake_county : []));
  }

  if (areaContext.counties.some((county) => normalizeLookupValue(county) === 'harnett')) {
    sources.push(...(Array.isArray(developmentSources.harnett_county) ? developmentSources.harnett_county : []));
  }

  const cityNeedles = dedupeStrings([report.city, areaContext.matchedArea?.name]).map(normalizeLookupValue);
  const municipalitySources = Array.isArray(developmentSources.municipalities)
    ? developmentSources.municipalities
    : Array.isArray(developmentSources.municipality)
      ? developmentSources.municipality
      : [];
  const matchedMunicipalitySources = municipalitySources.length > 0
    ? municipalitySources.filter((source) => {
      const haystack = normalizeLookupValue(`${source?.name ?? ''} ${source?.url ?? ''}`);
      return cityNeedles.some((needle) => needle && haystack.includes(needle));
    })
    : [];
  sources.push(...matchedMunicipalitySources);

  sources.push(...(Array.isArray(developmentSources.ncdot) ? developmentSources.ncdot : []));
  sources.push(...(Array.isArray(developmentSources.transportation) ? developmentSources.transportation : []));
  sources.push(...(Array.isArray(developmentSources.mpo) ? developmentSources.mpo : []));

  const generatedMunicipalitySources = Array.isArray(generatedDevelopment.municipalities)
    ? generatedDevelopment.municipalities.filter((source) => {
      const haystack = normalizeLookupValue(`${source?.city ?? ''} ${source?.name ?? ''} ${source?.url ?? ''}`);
      return cityNeedles.some((needle) => needle && haystack.includes(needle));
    })
    : [];
  sources.push(...generatedMunicipalitySources);

  const generatedPermitSources = Array.isArray(generatedDevelopment.propertyPermitSources)
    ? generatedDevelopment.propertyPermitSources.filter((source) => {
      const haystack = normalizeLookupValue(`${source?.appliesTo ?? ''} ${source?.jurisdiction ?? ''} ${source?.name ?? ''}`);
      return cityNeedles.some((needle) => needle && haystack.includes(needle))
        || areaContext.counties.some((county) => haystack.includes(normalizeLookupValue(county)));
    })
    : [];
  sources.push(...generatedPermitSources.map(normalizeWakePermitSource));

  return {
    areaContext,
    sources: dedupeSources(sources),
  };
}

export function buildDevelopmentSourcePlan(report, context) {
  const mapped = mapDevelopmentSources(report, context);
  const propertyPermitGuides = buildPropertyPermitGuides(report, context, mapped.areaContext);
  return {
    areaContext: mapped.areaContext,
    subdivisionHints: extractSubdivisionHints(report),
    roadHints: extractRoadHints(report),
    propertyPermitGuides,
    entries: mapped.sources.map((source) => ({
      name: source.name ?? 'Unnamed development source',
      url: source.url ?? '',
      note: source.note ?? '',
      recommendedQueries: buildDevelopmentQueries(source, report, mapped.areaContext),
    })),
  };
}

export function buildSchoolSourcePlan(report, context) {
  const schoolSources = context.portals.school_sources ?? {};
  return {
    minimumRating: context.profile.search?.hard_requirements?.schools_min_rating ?? null,
    schoolNames: extractSchoolNames(report),
    entries: Object.entries(schoolSources).map(([key, source]) => ({
      key,
      name: source.name ?? humanizeKey(key),
      url: buildSchoolSourceUrl(key, source.url ?? '', report),
      note: source.note ?? '',
      recommendedQueries: buildSchoolQueries(key, report),
    })),
  };
}

function buildSentimentSearchUrls(key, source, queries) {
  const urls = [];
  const encodedQueries = queries.map((query) => encodeURIComponent(query));

  if (key === 'google_maps') {
    for (const encoded of encodedQueries.slice(0, 3)) {
      urls.push(`https://www.google.com/maps/search/${encoded}`);
    }
  }

  return urls;
}

export function buildSentimentSourcePlan(report, context) {
  const sentimentSources = context.portals.sentiment_sources ?? {};
  const areaContext = resolveAreaContext(report, context);

  return {
    areaContext,
    subdivisionHints: extractSubdivisionHints(report),
    roadHints: extractRoadHints(report),
    schoolNames: extractSchoolNames(report),
    entries: Object.entries(sentimentSources).map(([key, source]) => {
      const recommendedQueries = buildSentimentQueries(key, report, areaContext);
      return {
        key,
        name: source.name ?? humanizeKey(key),
        url: source.base_url ?? source.url ?? '',
        note: source.note ?? '',
        loginRequired: source.login_required !== false,
        lookbackDays: Number.isFinite(source.lookback_days) ? source.lookback_days : null,
        // Facebook, Nextdoor, and Twitter require login and are reached via
        // Playwright against the hosted session via communityUrls from
        // community-lookup. Google Maps is public and can expose searchUrls
        // directly.
        browserSupported: key === 'facebook' || key === 'nextdoor' || key === 'twitter',
        publicFetchSupported: key === 'google_maps',
        searchUrls: buildSentimentSearchUrls(key, source, recommendedQueries),
        recommendedQueries,
      };
    }),
  };
}
