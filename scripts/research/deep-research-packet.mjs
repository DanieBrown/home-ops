#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { ROOT } from '../shared/paths.mjs';
import { parseArgs as _parseArgs, printHelp } from '../shared/cli.mjs';
import {
  auditParsedReport,
  buildDevelopmentSourcePlan,
  buildSchoolSourcePlan,
  buildSentimentSourcePlan,
  getCriticalAuditFindings,
  loadResearchConfig,
  parseReport,
  parseShortlist,
} from './research-utils.mjs';
import { readConstructionRecord } from './construction-check.mjs';
import { slugify } from '../shared/text-utils.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'deep-packets');
const SENTIMENT_DIR = join(ROOT, 'output', 'sentiment');
const COMMUNITY_DIR = join(ROOT, 'output', 'communities');
// Composite weights. construction_pressure is a modifier applied to resale_risk
// rather than a new top-level slot so the sum still equals 1.0. Schools are no
// longer a scored dimension -- they are captured as metadata on the report.
const COMPOSITE_WEIGHTS = {
  property_fit: 0.40,
  neighborhood_sentiment: 0.35,
  financial_fit: 0.10,
  resale_risk: 0.15,
};

const HELP_TEXT = `Usage:
  node deep-research-packet.mjs reports/001-foo.md
  node deep-research-packet.mjs reports/001-foo.md reports/002-bar.md
  node deep-research-packet.mjs --shortlist
  node deep-research-packet.mjs --top3

Builds one deterministic deep-research packet per target under output/deep-packets/.

Options:
  --shortlist   Use the current populated Top 10 cohort from data/shortlist.md.
  --top3        Use the current refined top 3 from data/shortlist.md.
  --json        Print JSON instead of human-readable text.
  --help        Show this help text.`;

const DEEP_SCHEMA = {
  '--shortlist': { type: 'flag', key: 'shortlist' },
  '--top3':      { type: 'flag', key: 'top3' },
  '--json':      { type: 'flag', key: 'json' },
};
const DEEP_DEFAULTS = { shortlist: false, top3: false, json: false };

function normalizeText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function dedupeStrings(values) {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

function toWorkspacePath(filePath) {
  return String(filePath ?? '').replace(`${ROOT}\\`, '').replace(/\\/g, '/');
}

function resolveTargets(config) {
  if (config.shortlist || config.top3) {
    const shortlist = parseShortlist(ROOT);
    const rows = config.top3 ? shortlist.refinedTop3 : shortlist.top10;
    if (rows.length === 0) {
      throw new Error(config.top3 ? 'No refined top-3 homes found in data/shortlist.md.' : 'No populated top-10 homes found in data/shortlist.md.');
    }

    return rows.map((row) => parseReport(ROOT, row.reportPath));
  }

  if (config.files.length === 0) {
    throw new Error('Provide at least one report path, or use --shortlist or --top3.');
  }

  return config.files.map((filePath) => parseReport(ROOT, filePath));
}

function buildOutputPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'deep-target';
  return join(OUTPUT_DIR, `${slug}.json`);
}

function buildSentimentPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'deep-target';
  return join(SENTIMENT_DIR, `${slug}.json`);
}

function buildCommunityPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'deep-target';
  return join(COMMUNITY_DIR, `${slug}.json`);
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function inferSourceStatus(queryResults) {
  const counts = {
    okQueries: 0,
    blockedQueries: 0,
    emptyQueries: 0,
    errorQueries: 0,
  };

  for (const result of queryResults) {
    if (result.status === 'ok') {
      counts.okQueries += 1;
      continue;
    }

    if (result.status === 'blocked') {
      counts.blockedQueries += 1;
      continue;
    }

    if (result.status === 'empty') {
      counts.emptyQueries += 1;
      continue;
    }

    counts.errorQueries += 1;
  }

  let status = 'not-captured';
  if (counts.okQueries > 0) {
    status = 'captured';
  } else if (counts.blockedQueries > 0) {
    status = 'blocked';
  } else if (counts.emptyQueries > 0) {
    status = 'no-match';
  } else if (counts.errorQueries > 0) {
    status = 'error';
  }

  return {
    status,
    ...counts,
  };
}

function buildSignalDirection(entry) {
  if (entry.negativeHits > entry.positiveHits) {
    return 'negative';
  }

  if (entry.positiveHits > entry.negativeHits) {
    return 'positive';
  }

  if (entry.hits > 0) {
    return 'mixed-or-neutral';
  }

  return 'none';
}

function summarizeSentimentEvidence(sentimentEvidence, weights) {
  if (!sentimentEvidence) {
    return {
      status: 'not-captured',
      coverageSummary: {
        configuredSources: 0,
        sourcesWithEvidence: 0,
        blockedSources: [],
        missingSources: [],
      },
      sourceCoverage: [],
      weightedSignals: [],
    };
  }

  const categoryMap = new Map();
  const sourceCoverage = sentimentEvidence.sources.map((source) => {
    const coverage = inferSourceStatus(source.queryResults ?? []);

    for (const queryResult of source.queryResults ?? []) {
      if (queryResult.status !== 'ok') {
        continue;
      }

      for (const theme of queryResult.themes ?? []) {
        const current = categoryMap.get(theme.category) ?? {
          category: theme.category,
          hits: 0,
          recentHits: 0,
          positiveHits: 0,
          negativeHits: 0,
          contributingSources: new Set(),
          queries: new Set(),
          examples: [],
        };

        current.hits += Number(theme.hits ?? 0);
        current.recentHits += Number(theme.recentHits ?? 0);
        current.positiveHits += Number(theme.positiveHits ?? 0);
        current.negativeHits += Number(theme.negativeHits ?? 0);
        current.contributingSources.add(source.key);
        current.queries.add(queryResult.query);
        current.examples.push(...(theme.examples ?? []).slice(0, 2));
        categoryMap.set(theme.category, current);
      }
    }

    return {
      key: source.key,
      name: source.name,
      status: coverage.status,
      okQueries: coverage.okQueries,
      blockedQueries: coverage.blockedQueries,
      emptyQueries: coverage.emptyQueries,
      errorQueries: coverage.errorQueries,
      lookbackDays: source.lookbackDays ?? null,
    };
  });

  const weightedSignals = [...categoryMap.values()]
    .map((entry) => {
      const weight = Number(weights?.[entry.category] ?? 0);
      return {
        category: entry.category,
        weight,
        hits: entry.hits,
        recentHits: entry.recentHits,
        positiveHits: entry.positiveHits,
        negativeHits: entry.negativeHits,
        signalDirection: buildSignalDirection(entry),
        weightedEvidence: Number((entry.hits * weight).toFixed(3)),
        weightedRecentEvidence: Number((entry.recentHits * weight).toFixed(3)),
        contributingSources: [...entry.contributingSources],
        queries: [...entry.queries].slice(0, 4),
        examples: dedupeStrings(entry.examples).slice(0, 2),
      };
    })
    .sort((left, right) => right.weightedEvidence - left.weightedEvidence || right.hits - left.hits);

  const blockedSources = sourceCoverage.filter((entry) => entry.status === 'blocked').map((entry) => entry.key);
  const missingSources = sourceCoverage
    .filter((entry) => entry.status !== 'captured')
    .map((entry) => entry.key);

  return {
    status: sourceCoverage.some((entry) => entry.status === 'captured') ? 'captured' : blockedSources.length > 0 ? 'blocked-or-empty' : 'not-captured',
    coverageSummary: {
      configuredSources: sourceCoverage.length,
      sourcesWithEvidence: sourceCoverage.filter((entry) => entry.status === 'captured').length,
      blockedSources,
      missingSources,
    },
    sourceCoverage,
    weightedSignals,
  };
}

function decorateSentimentPlan(entries, sentimentSummary) {
  const coverageByKey = new Map((sentimentSummary.sourceCoverage ?? []).map((entry) => [entry.key, entry]));
  return entries.map((entry) => {
    const coverage = coverageByKey.get(entry.key);
    return {
      key: entry.key,
      name: entry.name,
      url: entry.url,
      note: entry.note,
      loginRequired: entry.loginRequired,
      lookbackDays: entry.lookbackDays,
      browserSupported: entry.browserSupported,
      publicFetchSupported: entry.publicFetchSupported ?? false,
      searchUrls: entry.searchUrls ?? [],
      recommendedQueries: entry.recommendedQueries,
      captureStatus: coverage?.status ?? (entry.browserSupported ? 'not-captured' : 'planned-public-source'),
      okQueries: coverage?.okQueries ?? 0,
      blockedQueries: coverage?.blockedQueries ?? 0,
    };
  });
}

function decorateGenericPlan(entries) {
  return entries.map((entry) => ({
    key: entry.key || slugify(entry.name) || 'source',
    name: entry.name,
    url: entry.url,
    note: entry.note,
    recommendedQueries: entry.recommendedQueries,
    reviewStatus: 'required',
  }));
}

function summarizeConstruction(record) {
  if (!record) {
    return {
      status: 'not-reviewed',
      level: 'unknown',
      constructionPressure: null,
      phaseTotals: null,
      matchCount: 0,
      sourcesChecked: [],
      matches: [],
      note: 'construction-check.mjs has not been run for this home.',
    };
  }

  return {
    status: record.reviewed ? 'captured' : 'unreachable',
    level: record.level,
    constructionPressure: record.constructionPressure,
    phaseTotals: record.phaseTotals,
    matchCount: Array.isArray(record.matches) ? record.matches.length : 0,
    sourcesChecked: record.sourcesChecked ?? [],
    matches: (record.matches ?? []).slice(0, 5),
    roadHints: record.roadHints ?? [],
    counties: record.counties ?? [],
    note: record.reviewed
      ? null
      : 'NCDOT index pages were unreachable during the last check; downstream workers should not rely on this signal.',
  };
}

async function buildPacket(target, researchContext) {
  const sentimentPlan = buildSentimentSourcePlan(target, researchContext);
  const developmentPlan = buildDevelopmentSourcePlan(target, researchContext);
  const schoolPlan = buildSchoolSourcePlan(target, researchContext);
  const sentimentPath = buildSentimentPath(target);
  const sentimentEvidence = readJsonIfExists(sentimentPath);
  const sentimentSummary = summarizeSentimentEvidence(sentimentEvidence, researchContext.profile.sentiment?.weights ?? {});
  const constructionSummary = summarizeConstruction(readConstructionRecord(target));
  const communityPath = buildCommunityPath(target);
  const communityEvidence = readJsonIfExists(communityPath);
  const audit = auditParsedReport(target);
  const criticalFindings = getCriticalAuditFindings(audit, {
    headings: ['Neighborhood Sentiment', 'School Review', 'Development and Infrastructure'],
    strictWarnings: true,
  });

  const outputPath = buildOutputPath(target);
  const packet = {
    generatedAt: new Date().toISOString(),
    address: target.address,
    city: target.city,
    state: target.state,
    reportPath: target.relativePath,
    baseline: {
      overallScore: target.metadata.overallScore,
      scoreNumber: target.scoreNumber,
      recommendation: target.metadata.recommendation,
      confidence: target.metadata.confidence,
      verification: target.metadata.verification,
    },
    profileWeights: {
      composite: COMPOSITE_WEIGHTS,
      sentiment: researchContext.profile.sentiment?.weights ?? {},
    },
    audit: {
      issues: audit.issues,
      warnings: audit.warnings,
      criticalFindings,
    },
    sourcePlans: {
      sentiment: {
        matchedArea: sentimentPlan.areaContext.matchedArea?.name ?? null,
        subdivisionHints: sentimentPlan.subdivisionHints,
        roadHints: sentimentPlan.roadHints,
        schoolNames: sentimentPlan.schoolNames,
        entries: decorateSentimentPlan(sentimentPlan.entries, sentimentSummary),
      },
      development: {
        matchedArea: developmentPlan.areaContext.matchedArea?.name ?? null,
        counties: developmentPlan.areaContext.counties,
        subdivisionHints: developmentPlan.subdivisionHints,
        roadHints: developmentPlan.roadHints,
        entries: decorateGenericPlan(developmentPlan.entries),
      },
      school: {
        minimumRating: schoolPlan.minimumRating,
        schoolNames: schoolPlan.schoolNames,
        entries: decorateGenericPlan(schoolPlan.entries),
      },
    },
    community: communityEvidence?.community ?? null,
    communityStatus: communityEvidence?.status
      ?? (communityEvidence ? 'ok' : 'community-lookup-missing'),
    communityUrls: communityEvidence?.communityUrls ?? { nextdoor: null, facebook: null },
    sentimentEvidence: {
      filePath: existsSync(sentimentPath) ? toWorkspacePath(sentimentPath) : null,
      status: sentimentSummary.status,
      coverageSummary: sentimentSummary.coverageSummary,
      sourceCoverage: sentimentSummary.sourceCoverage,
      weightedSignals: sentimentSummary.weightedSignals,
    },
    schoolMetadataPlan: {
      minimumRating: schoolPlan.minimumRating,
      assignedSchools: schoolPlan.schoolNames,
      fields: [
        'name',
        'gradeLevel',
        'greatSchoolsRating',
        'stateRating',
        'enrollment',
        'studentTeacherRatio',
        'ethnicityDistribution',
        'url',
      ],
      note: 'Workers must capture these fields per assigned school from GreatSchools plus the listing source (Redfin / Zillow). Leave missing values null.',
    },
    constructionEvidence: constructionSummary,
    reportSections: {
      neighborhoodSentiment: target.sections['Neighborhood Sentiment'],
      schoolReview: target.sections['School Review'],
      developmentAndInfrastructure: target.sections['Development and Infrastructure'],
      risksAndOpenQuestions: target.sections['Risks and Open Questions'],
      recommendation: target.sections['Recommendation'],
    },
    workerRequirements: [
      'Explicitly mark Facebook, Nextdoor, NCDOT, county planning, municipal planning, and school-source coverage as captured, blocked, no-match, or still missing.',
      'Use profileWeights.sentiment when explaining metric importance and deep rerank changes. Facebook and Nextdoor only contribute to crime_safety, community, and livability; traffic_commute must come from Reddit, Google Maps, or the NCDOT construction record.',
      'Nextdoor must be loaded via communityUrls.nextdoor (built from the mapdevelopers community lookup). If community is null, skip Nextdoor and record nextdoor: { status: "no-community-match" } in sourceCoverage -- do not fall back to a generic Nextdoor search.',
      'Facebook must be loaded via communityUrls.facebook (the /search/top?q=<community> neighborhood <city> URL). Filter out membership-announcement posts ("X joined the group", "Welcome X to the neighborhood") before scoring.',
      'Return schoolMetadata as an array of per-school objects matching schoolMetadataPlan.fields. Do not return a schoolMetrics sentiment rollup -- schools are metadata-only.',
      'After the main agent collects schoolMetadata from all workers, write it to output/school-metadata/<slug>.json (slug matches the sentiment and construction sidecars). The briefing PDF reads that file to render the Schools & Metadata table.',
      'Do not claim browser-backed neighborhood sentiment if sentimentEvidence.status is not captured.',
      'Do not give full development confidence when NCDOT or local planning sources were not reviewed directly.',
      'Treat constructionEvidence.level as a resale-risk modifier: "high" should lower the deep rerank unless the pressure is clearly benign (e.g. completed projects only).',
      'If constructionEvidence.status is "not-reviewed" or "unreachable", flag construction risk as an open question rather than claiming clear air.',
    ],
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');

  return {
    address: target.address,
    city: target.city,
    state: target.state,
    reportPath: target.relativePath,
    outputPath: toWorkspacePath(outputPath),
    sentimentStatus: sentimentSummary.status,
    constructionStatus: constructionSummary.status,
    constructionLevel: constructionSummary.level,
    developmentSources: packet.sourcePlans.development.entries.length,
    schoolSources: packet.sourcePlans.school.entries.length,
    auditBlockers: criticalFindings.length,
  };
}

function printSummary(results) {
  console.log('\nDeep research packets\n');
  for (const result of results) {
    console.log(`${result.address} | ${result.city}, ${result.state}`);
    console.log(`Report: ${result.reportPath}`);
    console.log(`Packet: ${result.outputPath}`);
    console.log(`Sentiment evidence: ${result.sentimentStatus}`);
    console.log(`Construction evidence: ${result.constructionStatus} (${result.constructionLevel})`);
    console.log(`Development sources queued: ${result.developmentSources}`);
    console.log(`School sources queued: ${result.schoolSources}`);
    console.log(`Audit blockers carried forward: ${result.auditBlockers}`);
    console.log('');
  }
}

async function main() {
  let config;
  try {
    config = _parseArgs(process.argv.slice(2), DEEP_SCHEMA, { defaults: DEEP_DEFAULTS, allowPositional: true, positionalKey: 'files' });
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
  const researchContext = loadResearchConfig(ROOT);
  const results = [];

  for (const target of targets) {
    results.push(await buildPacket(target, researchContext));
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