import { readFileSync } from 'fs';
import { dirname, isAbsolute, join, relative } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPORTS_DIR = join(ROOT, 'reports');
export const SHORTLIST_PATH = join(ROOT, 'data', 'shortlist.md');
export const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');
export const PORTALS_PATH = join(ROOT, 'portals.yml');

export const AUDIT_SECTION_DEFS = [
  {
    heading: 'Neighborhood Sentiment',
    sourcePatterns: [/reddit/i, /facebook/i, /nextdoor/i, /google maps/i, /google reviews/i, /wral/i, /abc11/i, /news\s*&?\s*observer/i],
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

export function parseReport(projectRoot = ROOT, reportPath) {
  const absoluteReportPath = resolveWorkspacePath(projectRoot, reportPath);
  const content = readUtf8(absoluteReportPath).replace(/^\uFEFF/, '');
  const lines = content.split(/\r?\n/);
  const titleLine = lines.find((line) => line.startsWith('# ')) ?? '';
  const titleMatch = titleLine.match(/^#\s+(.+)\s+-\s+([^,]+),\s*([A-Za-z]{2})\s*$/);

  const sections = Object.fromEntries(
    REPORT_SECTION_HEADINGS.map((heading) => [heading, getSection(content, heading)]),
  );

  return {
    filePath: absoluteReportPath,
    relativePath: normalizeWorkspacePath(relative(projectRoot, absoluteReportPath)),
    title: titleLine.replace(/^#\s+/, '').trim(),
    address: titleMatch ? titleMatch[1].trim() : '',
    city: titleMatch ? titleMatch[2].trim() : '',
    state: titleMatch ? titleMatch[3].trim() : '',
    metadata: {
      date: parseHeaderField(content, 'Date'),
      source: parseHeaderField(content, 'Source'),
      url: parseHeaderField(content, 'URL'),
      price: parseHeaderField(content, 'Price'),
      bedsBaths: parseHeaderField(content, 'Beds/Baths'),
      sqft: parseHeaderField(content, 'SqFt'),
      lot: parseHeaderField(content, 'Lot'),
      yearBuilt: parseHeaderField(content, 'Year Built'),
      hoa: parseHeaderField(content, 'HOA'),
      daysOnMarket: parseHeaderField(content, 'Days on Market'),
      overallScore: parseHeaderField(content, 'Overall Score'),
      recommendation: parseHeaderField(content, 'Recommendation'),
      confidence: parseHeaderField(content, 'Confidence'),
      verification: parseHeaderField(content, 'Verification'),
    },
    scoreNumber: parseScoreNumber(parseHeaderField(content, 'Overall Score')),
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
  };
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
  return dedupeStrings(Array.from(schoolText.matchAll(regex), (match) => match[1]));
}

export function extractSubdivisionHints(report) {
  const manualHint = report.manualSubdivisionHint ? [report.manualSubdivisionHint] : [];
  const sourceText = [
    report.sections['Quick Take'],
    report.sections['Neighborhood Sentiment'],
    report.sections['Development and Infrastructure'],
  ].filter(Boolean).join('\n');
  const regex = /\b([A-Z][A-Za-z0-9'&-]+(?:\s+[A-Z][A-Za-z0-9'&-]+)+)\s+(?:subdivision|community|presale|neighborhood|home)\b/g;

  return dedupeStrings([
    ...manualHint,
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

function buildSentimentQueries(key, report, areaContext) {
  const subdivisionHints = extractSubdivisionHints(report);
  const roadHints = extractRoadHints(report);
  const schoolNames = extractSchoolNames(report);
  const cityName = dedupeStrings([report.city, areaContext.matchedArea?.name])[0] ?? report.city;
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
  const sources = [];

  if (areaContext.counties.some((county) => normalizeLookupValue(county) === 'wake')) {
    sources.push(...(Array.isArray(developmentSources.wake_county) ? developmentSources.wake_county : []));
  }

  if (areaContext.counties.some((county) => normalizeLookupValue(county) === 'harnett')) {
    sources.push(...(Array.isArray(developmentSources.harnett_county) ? developmentSources.harnett_county : []));
  }

  const cityNeedles = dedupeStrings([report.city, areaContext.matchedArea?.name]).map(normalizeLookupValue);
  const municipalitySources = Array.isArray(developmentSources.municipalities)
    ? developmentSources.municipalities.filter((source) => {
      const haystack = normalizeLookupValue(`${source?.name ?? ''} ${source?.url ?? ''}`);
      return cityNeedles.some((needle) => needle && haystack.includes(needle));
    })
    : [];
  sources.push(...municipalitySources);

  sources.push(...(Array.isArray(developmentSources.ncdot) ? developmentSources.ncdot : []));

  return {
    areaContext,
    sources: dedupeSources(sources),
  };
}

export function buildDevelopmentSourcePlan(report, context) {
  const mapped = mapDevelopmentSources(report, context);
  return {
    areaContext: mapped.areaContext,
    subdivisionHints: extractSubdivisionHints(report),
    roadHints: extractRoadHints(report),
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

  if (key === 'reddit') {
    const subreddits = Array.isArray(source?.subreddits) ? source.subreddits : [];
    for (const subreddit of subreddits) {
      const clean = String(subreddit).replace(/^r\//i, '').trim();
      if (!clean) continue;
      for (const encoded of encodedQueries.slice(0, 3)) {
        urls.push(`https://www.reddit.com/r/${clean}/search/?q=${encoded}&restrict_sr=1&sort=new`);
      }
    }
    for (const encoded of encodedQueries.slice(0, 2)) {
      urls.push(`https://www.reddit.com/search/?q=${encoded}&sort=new`);
    }
  }

  if (key === 'google_maps') {
    for (const encoded of encodedQueries.slice(0, 3)) {
      urls.push(`https://www.google.com/maps/search/${encoded}`);
    }
  }

  if (key === 'nextdoor') {
    for (const encoded of encodedQueries.slice(0, 3)) {
      urls.push(`https://nextdoor.com/search/?query=${encoded}`);
    }
  }

  if (key === 'facebook') {
    for (const encoded of encodedQueries.slice(0, 3)) {
      urls.push(`https://www.facebook.com/search/posts/?q=${encoded}`);
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
        // Facebook and Nextdoor require login and are reached via Playwright
        // against the hosted session. Reddit and Google Maps are public and
        // reachable via WebFetch, so workers can hit searchUrls directly.
        browserSupported: key === 'facebook' || key === 'nextdoor',
        publicFetchSupported: key === 'reddit' || key === 'google_maps',
        searchUrls: buildSentimentSearchUrls(key, source, recommendedQueries),
        recommendedQueries,
      };
    }),
  };
}