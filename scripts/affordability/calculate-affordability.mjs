#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import YAML from 'yaml';
import {
  PMMS_URL,
  buildProfilePatchPreview,
  calculateAffordability,
  formatMoney,
  normalizeAffordabilityAnswers,
  toNumber,
} from './affordability-core.mjs';
import { HOME_OPS_DIR, OUTPUT_DIR, PROFILE_PATH, ROOT } from '../shared/paths.mjs';
import { expiresInDays, makeCommandId, recordArtifact, withSidecarMetadata } from '../shared/knowledge-store.mjs';

const DEFAULT_INPUT = join(HOME_OPS_DIR, 'afford-wizard-submission.json');
const DEFAULT_OUTPUT = join(OUTPUT_DIR, 'affordability', 'latest.json');

const HELP_TEXT = `Usage:
  node scripts/affordability/calculate-affordability.mjs
  node scripts/affordability/calculate-affordability.mjs --input .home-ops/afford-wizard-submission.json --output output/affordability/latest.json

Options:
  --input            Affordability wizard submission JSON. Defaults to .home-ops/afford-wizard-submission.json.
  --output           Result JSON path. Defaults to output/affordability/latest.json.
  --no-fetch-rates   Do not fetch Freddie Mac PMMS rates. Requires an interest-rate override in the input.
  --help             Show this help text.`;

function parseArgs(argv) {
  const options = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT, fetchRates: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--input') {
      options.input = resolve(ROOT, argv[index + 1] ?? '');
      index += 1;
    } else if (arg === '--output') {
      options.output = resolve(ROOT, argv[index + 1] ?? '');
      index += 1;
    } else if (arg === '--no-fetch-rates') {
      options.fetchRates = false;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function readJson(path) {
  if (!existsSync(path)) {
    throw new Error(`Input file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readProfile() {
  if (!existsSync(PROFILE_PATH)) return {};
  return YAML.parse(readFileSync(PROFILE_PATH, 'utf8')) ?? {};
}

function extractAnswers(input) {
  return input?.payload?.answers ?? input?.answers ?? input;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchPmmsRates({ timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(PMMS_URL, {
      headers: { 'user-agent': 'home-ops-affordability/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Freddie Mac PMMS returned HTTP ${response.status}`);
    const text = stripTags(await response.text());
    const asOf = text.match(/as of ([A-Za-z]+ \d{1,2}, \d{4})/)?.[1] ?? null;
    const rate30Pct = toNumber(text.match(/30-year fixed-rate mortgage\s+averaged\s+([\d.]+)%/i)?.[1]);
    const rate15Pct = toNumber(text.match(/15-year fixed-rate mortgage\s+averaged\s+([\d.]+)%/i)?.[1]);
    if (!Number.isFinite(rate30Pct) && !Number.isFinite(rate15Pct)) {
      throw new Error('Could not parse 30-year or 15-year PMMS rates.');
    }
    return {
      source: PMMS_URL,
      asOf,
      rate30Pct,
      rate15Pct,
    };
  } finally {
    clearTimeout(timer);
  }
}

function printSummary(result) {
  const selected = result.selected;
  console.log('\n=== home-ops affordability estimate ===\n');
  console.log(`Selected term: ${selected.term_years}-year fixed`);
  console.log(`Recommended range: ${formatMoney(result.recommended_price_min)} to ${formatMoney(result.recommended_price_max)}`);
  console.log(`Binding constraint: ${selected.constraint === 'cash_available' ? 'cash available for down payment/closing' : `${selected.assumptions.housingPaymentPct}% debt-adjusted monthly payment cap`}`);
  console.log(`Estimated payment at max: ${formatMoney(selected.payment_at_recommended.total)} / month`);
  console.log(`Rate assumption: ${selected.assumptions.rateAssumptionPct}% (${selected.assumptions.rate_source})`);
  if (result.comparison) {
    console.log(`Comparison max (${result.comparison.term_years}-year fixed): ${formatMoney(result.comparison.recommended_price_max)}`);
  }
  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    result.warnings.forEach((warning) => console.log(`- ${warning}`));
  }
  console.log('\nProfile patch preview:');
  console.log(`- price_min: ${formatMoney(result.profile_patch_preview.search.hard_requirements.price_min)}`);
  console.log(`- price_max: ${formatMoney(result.profile_patch_preview.search.hard_requirements.price_max)}`);
  console.log('');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const input = readJson(options.input);
  const answers = extractAnswers(input);
  const profile = readProfile();
  let pmmsRates = null;
  if (options.fetchRates) {
    try {
      pmmsRates = await fetchPmmsRates();
    } catch (error) {
      const hasOverride = Number.isFinite(toNumber(answers.interest_rate_override)) && toNumber(answers.interest_rate_override) > 0;
      if (!hasOverride) throw error;
      console.warn(`WARN: PMMS rate lookup failed, using user override only: ${error.message}`);
    }
  }

  const normalized = normalizeAffordabilityAnswers(answers, profile, pmmsRates);
  const result = calculateAffordability(normalized);
  const commandId = input?.commandId ?? makeCommandId('affordability');
  result.target = {
    state: normalized.targetState,
    area: normalized.targetArea,
  };
  result.profile_patch_preview = buildProfilePatchPreview(profile, result);
  result.submission_source = input?.source ?? 'afford-wizard';
  const outputRecord = withSidecarMetadata(result, {
    kind: 'affordability',
    scope: 'buyer',
    subjectKey: 'buyer-affordability',
    commandId,
    generatedAt: result.calculated_at,
    expiresAt: expiresInDays(14, result.calculated_at),
    sourceUrls: pmmsRates?.source ? [pmmsRates.source] : [],
    status: 'ok',
    warnings: result.warnings,
  });

  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(outputRecord, null, 2)}\n`, 'utf8');
  try {
    recordArtifact({
      path: options.output,
      kind: 'affordability',
      scope: 'buyer',
      subjectKey: 'buyer-affordability',
      commandId,
      generatedAt: outputRecord.generatedAt,
      expiresAt: outputRecord.expiresAt,
      sourceUrls: outputRecord.sourceUrls,
      status: outputRecord.status,
      warnings: outputRecord.warnings,
    });
  } catch (error) {
    if (!/outside repo root|under output/.test(error.message)) throw error;
  }
  if (options.input === DEFAULT_INPUT && existsSync(DEFAULT_INPUT)) {
    unlinkSync(DEFAULT_INPUT);
  }
  printSummary(outputRecord);
  console.log(`Result written to ${options.output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
