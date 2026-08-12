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
  normalizeKey,
  parseReport,
  parseShortlist,
} from './research-utils.mjs';
import { readConstructionRecord } from './construction-check.mjs';
import { readBuilderRecord } from './builder-check.mjs';
import { slugify } from '../shared/text-utils.mjs';
import { PROXIMITY_TIER_ORDER } from './sentiment-scoring.mjs';

const OUTPUT_DIR = join(ROOT, 'output', 'deep-packets');
const SENTIMENT_DIR = join(ROOT, 'output', 'sentiment');
const COMMUNITY_DIR = join(ROOT, 'output', 'communities');
const BUILDER_DIR = join(ROOT, 'output', 'builder');
const HOA_DIR = join(ROOT, 'output', 'hoa');
const UTILITY_DIR = join(ROOT, 'output', 'utilities');
const HAZARDS_DIR = join(ROOT, 'output', 'hazards');
const PARCEL_DIR = join(ROOT, 'output', 'parcel');
const ACCESS_DIR = join(ROOT, 'output', 'access');
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

function buildBuilderPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'deep-target';
  return join(BUILDER_DIR, `${slug}.json`);
}

function buildHoaPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'deep-target';
  return join(HOA_DIR, `${slug}.json`);
}

function buildUtilityPath(target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'deep-target';
  return join(UTILITY_DIR, `${slug}.json`);
}

function buildSnapshotPath(dir, target) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`) || 'deep-target';
  return join(dir, `${slug}.json`);
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Folds one snapshot sidecar (hazards / parcel / access) into the packet.
 *
 * The sidecar's address must match the report's before anything is consumed --
 * the same rule DATA_CONTRACT.md states for utilities. Slugs collide across
 * similarly named streets, and attaching another home's flood zone or
 * assessment to this report would be worse than reporting nothing.
 */
function summarizeSnapshotSidecar(record, filePath, target, kind) {
  if (!record) {
    return {
      filePath: null,
      status: 'not-run',
      confidence: null,
      dimensions: {},
      sourceCoverage: [],
      note: `${kind} capture has not run for this home. Treat every ${kind} dimension as unconfirmed.`,
    };
  }

  const sameAddress = normalizeKey(record.address, record.city) === normalizeKey(target.address, target.city);
  if (!sameAddress) {
    return {
      filePath: toWorkspacePath(filePath),
      status: 'address-mismatch',
      confidence: null,
      dimensions: {},
      sourceCoverage: [],
      note: `${kind} sidecar is for "${record.address}, ${record.city}" but this report is "${target.address}, ${target.city}". Not consumed.`,
    };
  }

  return {
    filePath: toWorkspacePath(filePath),
    status: record.status ?? 'reviewed',
    confidence: record.confidence ?? null,
    dimensions: record.dimensions ?? {},
    sourceCoverage: record.sourceCoverage ?? [],
    warnings: record.warnings ?? [],
    note: null,
  };
}

function inferSourceStatus(queryResults) {
  const counts = {
    okQueries: 0,
    blockedQueries: 0,
    emptyQueries: 0,
    skippedBelowTierQueries: 0,
    errorQueries: 0,
  };
  // The highest (most specific) tier actually reached by an attempted query
  // -- distinct from tierNeeded/tierReached on a skipped-below-tier record,
  // which describe a tier that was never attempted at all.
  let tier = null;

  for (const result of queryResults) {
    if (result.tier && (!tier || PROXIMITY_TIER_ORDER.indexOf(result.tier) < PROXIMITY_TIER_ORDER.indexOf(tier))) {
      tier = result.tier;
    }

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

    // skipped-below-tier is a deliberate architectural gate (Nextdoor has no
    // sub-subdivision feed URL to fall back to) -- it must never collapse
    // into the generic "error" bucket, which would misreport a design
    // decision as a capture failure.
    if (result.status === 'skipped-below-tier') {
      counts.skippedBelowTierQueries += 1;
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
  } else if (counts.skippedBelowTierQueries > 0) {
    status = 'skipped-below-tier';
  } else if (counts.errorQueries > 0) {
    status = 'error';
  }

  return {
    status,
    tier,
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
      tier: coverage.tier,
      okQueries: coverage.okQueries,
      blockedQueries: coverage.blockedQueries,
      emptyQueries: coverage.emptyQueries,
      skippedBelowTierQueries: coverage.skippedBelowTierQueries,
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
    spatialStip: record.spatialStip
      ? {
        status: record.spatialStip.status,
        radiusMeters: record.spatialStip.radiusMeters,
        matchCount: Array.isArray(record.spatialStip.matches) ? record.spatialStip.matches.length : 0,
        sourcesChecked: record.spatialStip.sourcesChecked ?? [],
        matches: (record.spatialStip.matches ?? []).slice(0, 10),
      }
      : null,
    roadHints: record.roadHints ?? [],
    counties: record.counties ?? [],
    note: record.reviewed
      ? null
      : 'NCDOT index pages were unreachable during the last check; downstream workers should not rely on this signal.',
  };
}

function summarizeUtilityOptions(record, filePath) {
  if (!record) {
    return {
      filePath: null,
      status: 'not-run',
      monthlyEstimate: {
        low: null,
        typical: null,
        high: null,
        includedServices: [],
        optionalServices: [],
        confidence: 'low',
      },
      assumptions: null,
      selectedInternetPlan: null,
      providerSummary: [],
      sourceCoverage: [],
      warnings: ['utility-options-check.mjs has not been run for this home.'],
    };
  }

  const providerSummary = Object.entries(record.providers ?? {}).flatMap(([kind, providers]) => (
    Array.isArray(providers)
      ? providers.map((provider) => ({
        kind,
        name: provider.name,
        serviceStatus: provider.serviceStatus ?? 'unconfirmed',
        sourceUrl: provider.sourceUrl ?? '',
        checkedAt: provider.checkedAt ?? null,
        estimateMonthly: provider.estimateMonthly ?? null,
        planCount: Array.isArray(provider.plans) ? provider.plans.length : 0,
      }))
      : []
  ));

  const blockedCoverage = (record.sourceCoverage ?? []).filter((entry) => ['blocked', 'error'].includes(entry.status));
  const availableSignals = providerSummary.filter((provider) => ['confirmed', 'reported', 'likely'].includes(provider.serviceStatus));
  let status = 'captured';
  if (blockedCoverage.length > 0) status = 'captured-with-gaps';
  if (availableSignals.length === 0) status = 'unconfirmed';

  return {
    filePath: existsSync(filePath) ? toWorkspacePath(filePath) : null,
    status,
    monthlyEstimate: record.monthlyEstimate ?? null,
    assumptions: record.assumptions ?? null,
    selectedInternetPlan: record.selectedInternetPlan ?? null,
    providerSummary,
    optionalEstimates: record.optionalEstimates ?? {},
    sourceCoverage: record.sourceCoverage ?? [],
    warnings: record.warnings ?? [],
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
  const builderRecord = readBuilderRecord(target);
  const hoaPath = buildHoaPath(target);
  const hoaRecord = readJsonIfExists(hoaPath);
  const utilityPath = buildUtilityPath(target);
  const utilityRecord = readJsonIfExists(utilityPath);
  const utilitySummary = summarizeUtilityOptions(utilityRecord, utilityPath);

  const hazardsPath = buildSnapshotPath(HAZARDS_DIR, target);
  const parcelPath = buildSnapshotPath(PARCEL_DIR, target);
  const accessPath = buildSnapshotPath(ACCESS_DIR, target);
  const hazardsSummary = summarizeSnapshotSidecar(readJsonIfExists(hazardsPath), hazardsPath, target, 'site hazards');
  const parcelSummary = summarizeSnapshotSidecar(readJsonIfExists(parcelPath), parcelPath, target, 'parcel/tax');
  const accessSummary = summarizeSnapshotSidecar(readJsonIfExists(accessPath), accessPath, target, 'access');
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
        propertyPermitGuides: developmentPlan.propertyPermitGuides ?? [],
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
    communityUrls: communityEvidence?.communityUrls ?? { nextdoor: null, facebook: null, twitter: null },
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
      note: 'Workers must capture these fields per assigned school from the listing or district assignment source first, then GreatSchools or configured school metadata sources when available. Leave missing values null.',
    },
    constructionEvidence: constructionSummary,
    builderEvidence: {
      filePath: existsSync(buildBuilderPath(target)) ? toWorkspacePath(buildBuilderPath(target)) : null,
      status: builderRecord?.status ?? 'not-run',
      builderName: builderRecord?.builderName ?? null,
      builderSlug: builderRecord?.builderSlug ?? null,
      detectionSource: builderRecord?.detectionSource ?? null,
      detectionConfidence: builderRecord?.detectionConfidence ?? null,
      detectionSourceUrl: builderRecord?.detectionSourceUrl ?? null,
      avidRatingsOverall: builderRecord?.reviews?.avidRatings?.overall ?? null,
      avidRatingsReviewCount: builderRecord?.reviews?.avidRatings?.reviewCount ?? null,
      avidRatingsCategories: builderRecord?.reviews?.avidRatings?.categories ?? null,
      eliantOverall: builderRecord?.reviews?.eliant?.overall ?? null,
      bbbRating: builderRecord?.reviews?.bbb?.rating ?? null,
      bbbAccredited: builderRecord?.reviews?.bbb?.accredited ?? null,
      builder100Rank: builderRecord?.reviews?.builderOnline?.rank ?? null,
      builder100Year: builderRecord?.reviews?.builderOnline?.year ?? null,
      builderStanding: builderRecord?.standing ?? null,
    },
    hoaRulesEvidence: {
      filePath: existsSync(hoaPath) ? toWorkspacePath(hoaPath) : null,
      status: hoaRecord?.status ?? 'not-run',
      confidence: hoaRecord?.confidence ?? null,
      communityName: hoaRecord?.hoa?.communityName ?? null,
      associationName: hoaRecord?.hoa?.associationName ?? null,
      managementCompany: hoaRecord?.hoa?.managementCompany ?? null,
      monthlyDues: hoaRecord?.hoa?.monthlyDues ?? null,
      documents: (hoaRecord?.documents ?? []).slice(0, 8),
      topics: (hoaRecord?.topics ?? []).slice(0, 8),
      openQuestions: hoaRecord?.openQuestions ?? [],
    },
    utilityOptionsEvidence: utilitySummary,
    // The property snapshot: deterministic, cited, provenance-tagged facts
    // that used to be inferred from listing prose or not captured at all.
    siteHazardsEvidence: hazardsSummary,
    parcelTaxEvidence: parcelSummary,
    accessEvidence: accessSummary,
    reportSections: {
      neighborhoodSentiment: target.sections['Neighborhood Sentiment'],
      schoolReview: target.sections['School Review'],
      developmentAndInfrastructure: target.sections['Development and Infrastructure'],
      risksAndOpenQuestions: target.sections['Risks and Open Questions'],
      recommendation: target.sections['Recommendation'],
    },
    workerRequirements: [
      'Explicitly mark Facebook, Nextdoor, NCDOT, county planning, municipal planning, and school-source coverage as captured, blocked, no-match, or still missing.',
      'Use profileWeights.sentiment when explaining metric importance and deep rerank changes. Facebook and Nextdoor only contribute to crime_safety, community, and livability; traffic_commute must come from Google Maps or the NCDOT construction record.',
      'Sentiment capture degrades in specificity, never to silence: each source is tagged with the tier its query reached -- subdivision, street, school-zone, or municipal (sourceCoverage[].tier; every snippet also carries its own tier). Score every tier\'s evidence, but discount it by profile.sentiment.proximity_tiers and describe subdivision-tier and municipal-tier evidence differently in prose -- never present city-wide chatter as if it described this street.',
      'Nextdoor is the one source that may still skip below subdivision tier: its neighborhood-feed URL has no street- or city-scoped fallback. When it does, sourceCoverage records status "skipped-below-tier" with tierNeeded and tierReached -- this is an architectural limit, not a capture failure, and must not be described as an error.',
      'Facebook and Twitter degrade through the full ladder (subdivision search, then street, then school-zone, then a plain city search) and will nearly always have at least municipal-tier evidence. Filter out membership-announcement posts ("X joined the group", "Welcome X to the neighborhood") before scoring.',
      'Return schoolMetadata as an array of per-school objects matching schoolMetadataPlan.fields. Do not return a schoolMetrics sentiment rollup -- schools are metadata-only.',
      'After the main agent collects schoolMetadata from all workers, write it to output/school-metadata/<slug>.json (slug matches the sentiment and construction sidecars). The briefing PDF reads that file to render the Schools & Metadata table.',
      'Do not claim browser-backed neighborhood sentiment if sentimentEvidence.status is not captured.',
      'Do not give full development confidence when NCDOT or local planning sources were not reviewed directly.',
      'For property permit history, use sourcePlans.development.propertyPermitGuides as a manual lookup guide. Include the portal URL and 2-4 sentence instructions for the buyer to search the address themselves when automation is not reliable.',
      'Separate property permit history from nearby development pressure. A clean or missing address permit search does not prove there are no nearby rezonings, road projects, or subdivision cases.',
      'Treat constructionEvidence.level as a resale-risk modifier: "high" should lower the deep rerank unless the pressure is clearly benign (e.g. completed projects only).',
      'If constructionEvidence.status is "not-reviewed" or "unreachable", flag construction risk as an open question rather than claiming clear air.',
      'Include builder reputation in the Risk & Builder Quality section when builderEvidence.status is "found". If status is "not-found" or "no-builder-detected", omit the builder section rather than speculating.',
      'Include HOA rules only from hoaRulesEvidence when status is "captured" or "partial"; otherwise mark HOA rules as unconfirmed and request the resale/disclosure packet.',
      'Use utilityOptionsEvidence for utility/provider billing assumptions. Treat blocked, unconfirmed, and address-gated provider data as a gap, never as confirmed availability.',
      'siteHazardsEvidence, parcelTaxEvidence, and accessEvidence carry one entry per dimension with a provenance of captured, unconfirmed, blocked, unsupported, or not-applicable. Only "captured" licenses a factual claim. A "blocked" dimension means the source could not be reached -- report it as an open question and lower confidence; never write it up as no hazard found, no busy road, or no tax burden.',
      'Flood exposure comes from siteHazardsEvidence.dimensions.flood (FEMA NFHL), never from listing text. Major road adjacency comes from accessEvidence.dimensions.nearestRoad (NCDOT AADT) with its measured distance, never from the words "busy road" in a listing description.',
      'Property taxes come from parcelTaxEvidence.dimensions.estimatedTax and are an estimate that excludes special district levies. Always present the county bill lookup alongside it and never state it as the actual bill.',
      'A snapshot sidecar whose status is "address-mismatch" was written for a different home and must not be used at all.',
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
    builderStatus: builderRecord?.status ?? 'not-run',
    builderName: builderRecord?.builderName ?? null,
    hoaStatus: hoaRecord?.status ?? 'not-run',
    hazardsStatus: hazardsSummary.status,
    floodZone: hazardsSummary.dimensions?.flood?.value ?? null,
    parcelStatus: parcelSummary.status,
    estimatedAnnualTax: parcelSummary.dimensions?.estimatedTax?.value ?? null,
    accessStatus: accessSummary.status,
    nearestRoad: accessSummary.dimensions?.nearestRoad?.value ?? null,
    utilityStatus: utilitySummary.status,
    utilityEstimateTypical: utilitySummary.monthlyEstimate?.typical ?? null,
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
    console.log(`Builder evidence: ${result.builderStatus}${result.builderName ? ` (${result.builderName})` : ''}`);
    console.log(`HOA rules evidence: ${result.hoaStatus}`);
    console.log(`Utility/provider options: ${result.utilityStatus}${result.utilityEstimateTypical == null ? '' : ` ($${Number(result.utilityEstimateTypical).toFixed(0)}/mo typical)`}`);
    // A null value here means the dimension was not captured -- say "unconfirmed"
    // rather than print an empty field that could read as "nothing found".
    console.log(`Site hazards: ${result.hazardsStatus} (flood zone ${result.floodZone ?? 'unconfirmed'})`);
    console.log(`Parcel & tax: ${result.parcelStatus} (est. annual tax ${result.estimatedAnnualTax ?? 'unconfirmed'})`);
    console.log(`Road access: ${result.accessStatus} (nearest counted road ${result.nearestRoad ?? 'unconfirmed'})`);
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
