#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import YAML from 'yaml';
import {
  buildProfilePatchPreview,
  calculateAffordability,
  calculateIncomeNeeded,
  formatMoney,
  normalizeAffordabilityAnswers,
  toNumber,
} from './affordability-core.mjs';
import { fetchPmmsRates, getPmmsRates } from './pmms-rates.mjs';
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
  --target-price     Also report the income needed to afford this purchase price under the same assumptions.
  --help             Show this help text.`;

function parseArgs(argv) {
  const options = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT, fetchRates: true, help: false, targetPrice: null };
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
    } else if (arg === '--target-price') {
      options.targetPrice = toNumber(argv[index + 1]);
      if (!Number.isFinite(options.targetPrice) || options.targetPrice <= 0) {
        throw new Error('--target-price requires a positive number.');
      }
      index += 1;
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

export { fetchPmmsRates, getPmmsRates };

function printSummary(result) {
  const selected = result.selected;
  console.log('\n=== home-ops affordability estimate ===\n');
  console.log(`Selected term: ${selected.term_years}-year fixed`);
  console.log(`Recommended range: ${formatMoney(result.recommended_price_min)} to ${formatMoney(result.recommended_price_max)}`);
  console.log(`Binding constraint: ${selected.constraint === 'cash_available' ? 'cash available for down payment/closing' : `${selected.assumptions.housingPaymentPct}% debt-adjusted monthly payment cap`}`);
  const payment = selected.payment_at_recommended;
  const paymentParts = [
    `P&I ${formatMoney(payment.principal_interest)}`,
    `tax ${formatMoney(payment.property_tax)}`,
    `insurance ${formatMoney(payment.homeowners_insurance)}`,
  ];
  if (payment.mortgage_insurance > 0) paymentParts.push(`PMI ${formatMoney(payment.mortgage_insurance)}`);
  if (payment.hoa > 0) paymentParts.push(`HOA ${formatMoney(payment.hoa)}`);
  console.log(`Estimated payment at max: ${formatMoney(payment.total)} / month (${paymentParts.join(', ')})`);
  const upfront = selected.upfront_cash_at_recommended;
  console.log(`Cash to close at max (high estimate): ${formatMoney(upfront.total_high)} (down payment ${formatMoney(upfront.down_payment)}, closing up to ${formatMoney(upfront.closing_cost_high)}, pricing pressure ${formatMoney(upfront.llpa_pricing_pressure)})`);
  console.log(`Cash remaining after purchase: ${formatMoney(selected.cash_remaining_at_recommended)}`);
  if (selected.dti_check) {
    console.log(`Estimated DTI vs gross income: front-end ${selected.dti_check.front_end_pct.toFixed(1)}%, back-end ${selected.dti_check.back_end_pct.toFixed(1)}% (${selected.dti_check.status})`);
  }
  console.log(`Rate assumption: ${selected.assumptions.rateAssumptionPct}% (${selected.assumptions.rate_source})`);
  if (result.comparison) {
    console.log(`Comparison max (${result.comparison.term_years}-year fixed): ${formatMoney(result.comparison.recommended_price_max)}`);
  }
  if (result.income_needed) {
    const needed = result.income_needed;
    console.log(`\nIncome needed for ${formatMoney(needed.target_price)}: ${formatMoney(needed.required_household_monthly_take_home)} take-home / month (about ${formatMoney(needed.required_annual_gross_salary)} gross salary / year), with ${formatMoney(needed.upfront_cash_at_target.total_high)} cash to close.`);
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
      pmmsRates = await getPmmsRates();
      if (pmmsRates.fromCache) {
        console.warn(`WARN: PMMS rate lookup failed (${pmmsRates.fetchError}); using cached rates from ${pmmsRates.cachedAt ?? 'an earlier run'}.`);
      }
    } catch (error) {
      const hasOverride = Number.isFinite(toNumber(answers.interest_rate_override)) && toNumber(answers.interest_rate_override) > 0;
      if (!hasOverride) throw error;
      console.warn(`WARN: PMMS rate lookup failed, using user override only: ${error.message}`);
    }
  }

  const normalized = normalizeAffordabilityAnswers(answers, profile, pmmsRates);
  const result = calculateAffordability(normalized);
  if (Number.isFinite(options.targetPrice) && options.targetPrice > 0) {
    result.income_needed = calculateIncomeNeeded({
      targetPrice: options.targetPrice,
      termYears: normalized.termYears,
      rateAssumptionPct: normalized.rateAssumptionPct,
      housingPaymentPct: normalized.housingPaymentPct,
      takeHomePct: toNumber(answers.take_home_pct) ?? 70,
      monthlyContribution: toNumber(answers.other_monthly_contribution) ?? 0,
      creditTier: normalized.creditTier,
      downPaymentPct: normalized.downPaymentPct,
      propertyTaxPct: normalized.propertyTaxPct,
      insurancePct: normalized.insurancePct,
      hoaMonthly: normalized.hoaMonthly,
      closingCostPctMin: normalized.closingCostPctMin,
      closingCostPctMax: normalized.closingCostPctMax,
      rateSource: normalized.rateSource,
    });
  }
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
