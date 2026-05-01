#!/usr/bin/env node

import { ROOT } from '../shared/paths.mjs';
import {
  auditParsedReport,
  getCriticalAuditFindings,
  parseReport,
  parseShortlist,
} from './research-utils.mjs';

const HELP_TEXT = `Usage:
  node shortlist-finalist-gate.mjs
  node shortlist-finalist-gate.mjs --allow-warnings
  node shortlist-finalist-gate.mjs --json

Validates the current refined top 3 against the research coverage audit before finalists are promoted.

Options:
  --allow-warnings   Only explicit gap issues block finalists. External-source warnings become advisory.
  --json             Print JSON instead of human-readable text.
  --help             Show this help text.`;

function parseArgs(argv) {
  const config = {
    allowWarnings: false,
    json: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      config.help = true;
      continue;
    }

    if (arg === '--allow-warnings') {
      config.allowWarnings = true;
      continue;
    }

    if (arg === '--json') {
      config.json = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return config;
}

function evaluateRows(projectRoot, rows, strictWarnings) {
  return rows.map((row) => {
    const report = parseReport(projectRoot, row.reportPath);
    const audit = auditParsedReport(report);
    const blockers = getCriticalAuditFindings(audit, {
      headings: ['Neighborhood Sentiment', 'School Review', 'Development and Infrastructure'],
      strictWarnings,
    });

    return {
      ...row,
      reportPath: report.relativePath,
      scoreNumber: report.scoreNumber,
      recommendation: report.metadata.recommendation,
      blockers,
      eligible: blockers.length === 0,
    };
  });
}

function printRow(prefix, row) {
  console.log(`${prefix} ${row.address}, ${row.city} (${row.reportPath})`);
  row.blockers.forEach((finding) => console.log(`  - ${finding.heading}: ${finding.message}`));
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

  const shortlist = parseShortlist(ROOT);
  if (shortlist.refinedTop3.length === 0) {
    console.error('No refined top-3 rows found in data/shortlist.md.');
    process.exit(1);
  }

  const finalistResults = evaluateRows(ROOT, shortlist.refinedTop3, !config.allowWarnings);
  const top10Results = evaluateRows(ROOT, shortlist.top10, !config.allowWarnings);
  const blockedFinalists = finalistResults.filter((row) => !row.eligible);
  const eligibleTop10 = top10Results.filter((row) => row.eligible);

  const payload = {
    strictWarnings: !config.allowWarnings,
    finalistsChecked: finalistResults.length,
    blockedFinalists,
    eligibleTop10,
  };

  if (config.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('\nShortlist finalist gate\n');
    console.log(`Strict warnings: ${config.allowWarnings ? 'off' : 'on'}`);
    console.log(`Refined top 3 checked: ${finalistResults.length}`);

    if (blockedFinalists.length === 0) {
      console.log('Result: pass. The current refined top 3 clears the research gate.');
    } else {
      console.log('Result: blocked. The current refined top 3 does not clear the research gate.');
      console.log('');
      console.log('Blocked finalists:');
      blockedFinalists.forEach((row) => printRow('-', row));

      console.log('');
      if (eligibleTop10.length === 0) {
        console.log('Eligible replacements: none. The broader top 10 still lacks source-backed coverage.');
      } else {
        console.log('Eligible replacements from the current top 10:');
        eligibleTop10.slice(0, 3).forEach((row) => {
          console.log(`- ${row.address}, ${row.city} (${row.reportPath})`);
        });
      }

      console.log('');
      console.log('Next step: run node research-source-plan.mjs --top3 --type all to see the missing development and school lookups.');
    }
  }

  if (blockedFinalists.length > 0) {
    process.exit(1);
  }
}

main();