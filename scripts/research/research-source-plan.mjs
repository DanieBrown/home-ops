#!/usr/bin/env node

import { basename } from 'path';
import { ROOT } from '../shared/paths.mjs';
import {
  auditParsedReport,
  buildDevelopmentSourcePlan,
  buildSentimentSourcePlan,
  buildSchoolSourcePlan,
  getCriticalAuditFindings,
  loadResearchConfig,
  parseReport,
  parseShortlist,
} from './research-utils.mjs';

const HELP_TEXT = `Usage:
  node research-source-plan.mjs reports/003-foo.md
  node research-source-plan.mjs reports/003-foo.md reports/011-bar.md --type all
  node research-source-plan.mjs --shortlist --type development
  node research-source-plan.mjs --top3 --type school
  node research-source-plan.mjs --top3 --type sentiment
  node research-source-plan.mjs --address "200 Meadowcrest Pl" --city "Holly Springs" [--county Wake] [--subdivision "Sunset Oaks"]

Builds a deterministic research source plan from portals.yml for neighborhood sentiment, development, and school evidence.

Options:
  --shortlist          Use the current populated Top 10 cohort from data/shortlist.md.
  --top3               Use the current refined top 3 from data/shortlist.md.
  --address <value>    Manual target address when no report exists yet.
  --city <value>       Manual target city.
  --state <value>      Manual target state. Defaults to NC.
  --county <value>     Manual county hint.
  --subdivision <val>  Manual subdivision or community hint.
  --type <value>       One of sentiment, development, school, or all. Defaults to all.
  --json               Print JSON instead of human-readable text.
  --help               Show this help text.`;

function parseArgs(argv) {
  const config = {
    shortlist: false,
    top3: false,
    address: '',
    city: '',
    state: 'NC',
    county: '',
    subdivision: '',
    type: 'all',
    json: false,
    help: false,
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      config.help = true;
      continue;
    }

    if (arg === '--shortlist') {
      config.shortlist = true;
      continue;
    }

    if (arg === '--top3') {
      config.top3 = true;
      continue;
    }

    if (arg === '--json') {
      config.json = true;
      continue;
    }

    if (arg === '--address') {
      config.address = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--city') {
      config.city = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--state') {
      config.state = argv[index + 1] ?? 'NC';
      index += 1;
      continue;
    }

    if (arg === '--county') {
      config.county = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--subdivision') {
      config.subdivision = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--type') {
      config.type = (argv[index + 1] ?? 'all').trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    config.files.push(arg);
  }

  if (!['sentiment', 'development', 'school', 'all'].includes(config.type)) {
    throw new Error(`Unsupported type: ${config.type}`);
  }

  return config;
}

function buildManualTarget(config) {
  if (!config.address || !config.city) {
    throw new Error('Manual source planning requires both --address and --city.');
  }

  return {
    filePath: null,
    relativePath: null,
    address: config.address.trim(),
    city: config.city.trim(),
    state: (config.state || 'NC').trim(),
    title: `${config.address.trim()} - ${config.city.trim()}, ${(config.state || 'NC').trim()}`,
    metadata: {
      recommendation: '',
      overallScore: '',
    },
    scoreNumber: null,
    manualCountyHint: config.county.trim(),
    manualSubdivisionHint: config.subdivision.trim(),
    sections: {
      'Quick Take': '',
      'Summary Card': '',
      'Hard Requirement Gate': config.county ? `County hint: ${config.county.trim()}` : '',
      'Property Fit': '',
      'Neighborhood Sentiment': '',
      'School Review': '',
      'Development and Infrastructure': '',
      'Financial Snapshot': '',
      'Risks and Open Questions': '',
      'Recommendation': '',
    },
  };
}

function resolveTargets(projectRoot, config) {
  if (config.shortlist || config.top3) {
    const shortlist = parseShortlist(projectRoot);
    const rows = config.top3 ? shortlist.refinedTop3 : shortlist.top10;
    if (rows.length === 0) {
      throw new Error(config.top3 ? 'No refined top-3 homes found in data/shortlist.md.' : 'No populated top-10 homes found in data/shortlist.md.');
    }

    const targets = [];
    for (const row of rows) {
      try {
        targets.push(parseReport(projectRoot, row.reportPath));
      } catch (err) {
        if (err.code === 'ENOENT' || String(err.message).includes('ENOENT')) {
          console.warn(`[warn] Skipping shortlist entry — report not found: ${row.reportPath}`);
          console.warn('[warn] The shortlist may reference a report from a previous run. Re-run hunt to generate fresh reports.');
        } else {
          throw err;
        }
      }
    }
    if (targets.length === 0) {
      throw new Error('No shortlist entries have readable reports. Re-run hunt to generate fresh evaluation reports.');
    }
    return targets;
  }

  if (config.address || config.city) {
    return [buildManualTarget(config)];
  }

  if (config.files.length === 0) {
    throw new Error('Provide at least one report path, or use --shortlist, --top3, or manual address/city arguments.');
  }

  return config.files.map((filePath) => parseReport(projectRoot, filePath));
}

function formatSourceEntry(entry) {
  const lines = [`- ${entry.name}`];
  if (entry.url) {
    lines.push(`  URL: ${entry.url}`);
  }
  if (entry.note) {
    lines.push(`  Note: ${entry.note}`);
  }
  if (entry.recommendedQueries.length > 0) {
    lines.push(`  Queries: ${entry.recommendedQueries.join(' | ')}`);
  }
  return lines.join('\n');
}

function serializeTarget(target, context, config) {
  const developmentPlan = buildDevelopmentSourcePlan(target, context);
  const sentimentPlan = buildSentimentSourcePlan(target, context);
  const schoolPlan = buildSchoolSourcePlan(target, context);
  const audit = target.filePath ? auditParsedReport(target) : null;
  const auditBlockers = audit
    ? getCriticalAuditFindings(audit, {
      headings: config.type === 'sentiment'
        ? ['Neighborhood Sentiment']
        : config.type === 'development'
        ? ['Development and Infrastructure']
        : config.type === 'school'
          ? ['School Review']
          : ['Neighborhood Sentiment', 'School Review', 'Development and Infrastructure'],
      strictWarnings: true,
    })
    : [];

  return {
    address: target.address,
    city: target.city,
    state: target.state,
    reportPath: target.relativePath,
    auditBlockers,
    sentiment: {
      matchedArea: sentimentPlan.areaContext.matchedArea?.name ?? null,
      subdivisionHints: sentimentPlan.subdivisionHints,
      roadHints: sentimentPlan.roadHints,
      schoolNames: sentimentPlan.schoolNames,
      sources: sentimentPlan.entries,
    },
    development: {
      matchedArea: developmentPlan.areaContext.matchedArea?.name ?? null,
      counties: developmentPlan.areaContext.counties,
      subdivisionHints: developmentPlan.subdivisionHints,
      roadHints: developmentPlan.roadHints,
      sources: developmentPlan.entries,
    },
    school: {
      minimumRating: schoolPlan.minimumRating,
      schoolNames: schoolPlan.schoolNames,
      sources: schoolPlan.entries,
    },
  };
}

function printTarget(serialized, config) {
  const lines = [`${serialized.address} | ${serialized.city}, ${serialized.state}`];
  if (serialized.reportPath) {
    lines.push(`Report: ${serialized.reportPath}`);
  }

  if (serialized.auditBlockers.length > 0) {
    lines.push('Audit blockers:');
    serialized.auditBlockers.forEach((finding) => lines.push(`- ${finding.heading}: ${finding.message}`));
  } else {
    lines.push('Audit blockers: none for the selected source types.');
  }

  if (config.type === 'sentiment' || config.type === 'all') {
    lines.push('');
    lines.push('Sentiment sources');
    lines.push(`- Matched profile area: ${serialized.sentiment.matchedArea ?? 'none'}`);
    if (serialized.sentiment.subdivisionHints.length > 0) {
      lines.push(`- Subdivision hints: ${serialized.sentiment.subdivisionHints.join(', ')}`);
    }
    if (serialized.sentiment.roadHints.length > 0) {
      lines.push(`- Road hints: ${serialized.sentiment.roadHints.join(', ')}`);
    }
    if (serialized.sentiment.schoolNames.length > 0) {
      lines.push(`- Related school names: ${serialized.sentiment.schoolNames.join(', ')}`);
    }
    if (serialized.sentiment.sources.length === 0) {
      lines.push('- No sentiment sources resolved from portals.yml.');
    } else {
      serialized.sentiment.sources.forEach((entry) => lines.push(formatSourceEntry(entry)));
    }
  }

  if (config.type === 'development' || config.type === 'all') {
    lines.push('');
    lines.push('Development sources');
    lines.push(`- Matched profile area: ${serialized.development.matchedArea ?? 'none'}`);
    lines.push(`- County coverage: ${serialized.development.counties.join(', ') || 'none'}`);
    if (serialized.development.subdivisionHints.length > 0) {
      lines.push(`- Subdivision hints: ${serialized.development.subdivisionHints.join(', ')}`);
    }
    if (serialized.development.roadHints.length > 0) {
      lines.push(`- Road hints: ${serialized.development.roadHints.join(', ')}`);
    }
    if (serialized.development.sources.length === 0) {
      lines.push('- No development sources resolved from portals.yml.');
    } else {
      serialized.development.sources.forEach((entry) => lines.push(formatSourceEntry(entry)));
    }
  }

  if (config.type === 'school' || config.type === 'all') {
    lines.push('');
    lines.push('School sources');
    lines.push(`- Rating floor: ${serialized.school.minimumRating ?? 'not configured'}`);
    lines.push(`- Extracted school names: ${serialized.school.schoolNames.join(', ') || 'none'}`);
    if (serialized.school.sources.length === 0) {
      lines.push('- No school sources resolved from portals.yml.');
    } else {
      serialized.school.sources.forEach((entry) => lines.push(formatSourceEntry(entry)));
    }
  }

  console.log(lines.join('\n'));
}

function main() {
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

  const context = loadResearchConfig(ROOT);
  const targets = resolveTargets(ROOT, config).map((target) => serializeTarget(target, context, config));

  if (config.json) {
    console.log(JSON.stringify({ type: config.type, count: targets.length, targets }, null, 2));
    return;
  }

  console.log('\nResearch source plan\n');
  targets.forEach((target, index) => {
    if (index > 0) {
      console.log('');
    }
    printTarget(target, config);
  });

  if (targets.some((target) => target.auditBlockers.length > 0)) {
    console.log('\nUse this plan to close the blocking research gaps before promoting finalists.');
  } else {
    console.log('\nSource inventories are resolved cleanly for the selected targets.');
  }
}

main();