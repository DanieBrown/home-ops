#!/usr/bin/env node

import { existsSync, readdirSync } from 'fs';
import { basename, join, resolve } from 'path';
import { ROOT, REPORTS_DIR } from '../shared/paths.mjs';
import {
  auditEvaluationReport,
} from './research-utils.mjs';

const HELP_TEXT = `Usage:
  node research-coverage-audit.mjs
  node research-coverage-audit.mjs reports/003-foo.md reports/011-bar.md
  node research-coverage-audit.mjs --strict

Audits evaluation reports for explicit neighborhood, school, and development evidence coverage.

Options:
  --strict   Exit with code 1 when explicit coverage gaps are found.
  --help     Show this help text.`;

function parseArgs(argv) {
  const config = {
    strict: false,
    help: false,
    files: [],
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      config.help = true;
      continue;
    }

    if (arg === '--strict') {
      config.strict = true;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    config.files.push(arg);
  }

  return config;
}

function getDefaultReportPaths() {
  if (!existsSync(REPORTS_DIR)) {
    return [];
  }

  return readdirSync(REPORTS_DIR)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => !name.startsWith('deep-'))
    .sort()
    .map((name) => join(REPORTS_DIR, name));
}

function resolveReportPaths(files) {
  if (files.length === 0) {
    return getDefaultReportPaths();
  }

  return files.map((entry) => resolve(ROOT, entry));
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

  const reportPaths = resolveReportPaths(config.files).filter((filePath) => existsSync(filePath));
  if (reportPaths.length === 0) {
    console.log('No evaluation reports found to audit.');
    return;
  }

  console.log('\nResearch coverage audit\n');

  const audited = reportPaths
    .filter((filePath) => !basename(filePath).startsWith('deep-'))
    .map((filePath) => auditEvaluationReport(filePath));

  let issueCount = 0;
  let warningCount = 0;

  for (const report of audited) {
    if (report.issues.length === 0 && report.warnings.length === 0) {
      continue;
    }

    console.log(`${basename(report.filePath)}`);
    for (const issue of report.issues) {
      console.log(`  ISSUE ${issue.heading}: ${issue.message}`);
      issueCount += 1;
    }
    for (const warning of report.warnings) {
      console.log(`  WARN  ${warning.heading}: ${warning.message}`);
      warningCount += 1;
    }
    console.log('');
  }

  console.log(`Scanned ${audited.length} evaluation report(s).`);
  console.log(`Explicit coverage gaps: ${issueCount}`);
  console.log(`Weak-source warnings: ${warningCount}`);

  if (issueCount === 0 && warningCount === 0) {
    console.log('Research coverage looks explicit for the scanned reports.');
  } else {
    console.log('Use this audit to distinguish actual source-backed research from prompt-only expectations.');
  }

  if (config.strict && issueCount > 0) {
    process.exit(1);
  }
}

main();
