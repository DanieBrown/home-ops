#!/usr/bin/env node

import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import YAML from 'yaml';
import {
  calculateAffordability,
  calculateIncomeNeeded,
  getLlpaPct,
  monthlyPrincipalInterest,
  normalizeAffordabilityAnswers,
  roundDown,
} from '../affordability/affordability-core.mjs';
import { applyAffordabilityToFiles } from '../affordability/apply-affordability.mjs';

function approx(actual, expected, tolerance = 0.5) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${actual} to be within ${tolerance} of ${expected}`);
}

{
  const payment30 = monthlyPrincipalInterest(240000, 6, 30);
  const payment15 = monthlyPrincipalInterest(240000, 6, 15);
  approx(payment30, 1438.92);
  assert.ok(payment15 > payment30, '15-year principal/interest should exceed 30-year principal/interest for same loan.');
}

{
  const llpa30 = getLlpaPct({ termYears: 30, creditTier: '740_759', ltvPct: 80 });
  assert.equal(llpa30.applied, true);
  assert.equal(llpa30.pct, 0.875);

  const llpa15 = getLlpaPct({ termYears: 15, creditTier: '740_759', ltvPct: 80 });
  assert.equal(llpa15.applied, false);
  assert.equal(llpa15.pct, 0);
}

{
  const result = calculateAffordability({
    termYears: 30,
    monthlyTakeHomePay: 10000,
    monthlyDebt: 0,
    cashAvailable: 60000,
    creditTier: '780_plus',
    rateAssumptionPct: 6.5,
    rate30Pct: 6.5,
    rate15Pct: 5.8,
    rateSource: 'fixture',
    propertyTaxPct: 1,
    insurancePct: 0.35,
    hoaMonthly: 0,
    closingCostPctMin: 2,
    closingCostPctMax: 5,
  });
  assert.equal(result.selected.constraint, 'cash_available');
  assert.ok(result.recommended_price_max <= 240000, 'Cash cap should keep max near cash / 25%.');
  assert.equal(result.comparison.term_years, 15);
}

{
  const result = calculateAffordability({
    termYears: 30,
    monthlyTakeHomePay: 4500,
    monthlyDebt: 250,
    cashAvailable: 250000,
    creditTier: 'unknown',
    rateAssumptionPct: 6.5,
    rate30Pct: 6.5,
    rate15Pct: 5.8,
    rateSource: 'fixture',
    propertyTaxPct: 1,
    insurancePct: 0.35,
    hoaMonthly: 150,
    closingCostPctMin: 2,
    closingCostPctMax: 5,
  });
  assert.equal(result.selected.constraint, 'monthly_payment_cap');
  assert.ok(result.warnings.some((warning) => warning.includes('Credit tier is unknown')));
  assert.ok(result.warnings.some((warning) => warning.includes('Existing monthly debt reduced')));
}

{
  const base = {
    termYears: 30,
    monthlyTakeHomePay: 8000,
    monthlyDebt: 0,
    cashAvailable: 500000,
    creditTier: '760_779',
    rateAssumptionPct: 6.5,
    rate30Pct: 6.5,
    rate15Pct: 5.8,
    rateSource: 'fixture',
    propertyTaxPct: 1,
    insurancePct: 0.35,
    hoaMonthly: 0,
    closingCostPctMin: 2,
    closingCostPctMax: 5,
  };
  const veryCareful = calculateAffordability({ ...base, housingPaymentPct: 20 });
  const lessCareful = calculateAffordability({ ...base, housingPaymentPct: 30 });
  const capped = calculateAffordability({ ...base, housingPaymentPct: 50 });
  assert.ok(lessCareful.recommended_price_max > veryCareful.recommended_price_max);
  assert.equal(veryCareful.selected.assumptions.housingPaymentPct, 20);
  assert.equal(lessCareful.source_notes[0], 'Primary cap uses 30% of monthly take-home pay after subtracting non-mortgage monthly debt.');
  assert.equal(capped.selected.assumptions.housingPaymentPct, 45);
  assert.equal(capped.source_notes[0], 'Primary cap uses 45% of monthly take-home pay after subtracting non-mortgage monthly debt.');
}

{
  const base = {
    termYears: 30,
    monthlyTakeHomePay: 9000,
    cashAvailable: 500000,
    creditTier: '760_779',
    rateAssumptionPct: 6.5,
    rate30Pct: 6.5,
    rate15Pct: 5.8,
    rateSource: 'fixture',
    propertyTaxPct: 1,
    insurancePct: 0.35,
    hoaMonthly: 0,
    closingCostPctMin: 2,
    closingCostPctMax: 5,
    housingPaymentPct: 25,
  };
  const noDebt = calculateAffordability({ ...base, monthlyDebt: 0 });
  const withDebt = calculateAffordability({ ...base, monthlyDebt: 1500 });
  assert.ok(withDebt.recommended_price_max < noDebt.recommended_price_max);
  assert.equal(withDebt.selected.monthly_payment_cap, (9000 - 1500) * 0.25);
}

{
  const highDown = calculateAffordability({
    termYears: 30,
    monthlyTakeHomePay: 9000,
    monthlyDebt: 0,
    cashAvailable: 90000,
    creditTier: '760_779',
    rateAssumptionPct: 6.5,
    rate30Pct: 6.5,
    rate15Pct: 5.8,
    rateSource: 'fixture',
    propertyTaxPct: 1,
    insurancePct: 0.35,
    hoaMonthly: 0,
    closingCostPctMin: 2,
    closingCostPctMax: 5,
    downPaymentPct: 20,
  });
  const lowDown = calculateAffordability({
    ...highDown.selected.assumptions,
    termYears: 30,
    monthlyTakeHomePay: 9000,
    monthlyDebt: 0,
    cashAvailable: 90000,
    creditTier: '760_779',
    rateAssumptionPct: 6.5,
    rate30Pct: 6.5,
    rate15Pct: 5.8,
    rateSource: 'fixture',
    propertyTaxPct: 1,
    insurancePct: 0.35,
    hoaMonthly: 0,
    closingCostPctMin: 2,
    closingCostPctMax: 5,
    downPaymentPct: 5,
  });
  assert.ok(lowDown.selected.payment_at_recommended.mortgage_insurance > 0);
  assert.ok(lowDown.selected.assumptions.downPaymentPct < highDown.selected.assumptions.downPaymentPct);
  assert.ok(lowDown.selected.cash_price_cap > highDown.selected.cash_price_cap, 'Lower down payment should relax the cash cap in this fixture.');
}

{
  const normalized = normalizeAffordabilityAnswers({
    target_state: 'NC',
    target_area: 'Apex',
    loan_term_years: '15',
    monthly_take_home: '12000',
    monthly_debt: '500',
    cash_available: '125000',
    down_payment_pct: '10',
    credit_tier: '740_759',
    housing_payment_pct: '28',
    hoa_monthly: '250',
    price_floor_mode: 'custom',
    price_floor_custom: '450000',
    interest_rate_override: '6.1',
  }, {
    search: {
      areas: [{ name: 'Cary', state: 'NC' }],
      hard_requirements: { price_min: 500000 },
    },
  }, null);
  assert.equal(normalized.termYears, 15);
  assert.equal(normalized.monthlyTakeHomePay, 12000);
  assert.equal(normalized.monthlyDebt, 500);
  assert.equal(normalized.downPaymentPct, 10);
  assert.equal(normalized.priceFloorMode, 'custom');
  const result = calculateAffordability(normalized);
  assert.equal(result.recommended_price_min, Math.min(450000, result.recommended_price_max));
}

{
  const needed = calculateIncomeNeeded({
    targetPrice: 775000,
    termYears: 30,
    rateAssumptionPct: 6.5,
    housingPaymentPct: 30,
    takeHomePct: 70,
    monthlyContribution: 0,
    creditTier: '760_779',
    propertyTaxPct: 1,
    insurancePct: 0.35,
    hoaMonthly: 0,
    closingCostPctMin: 2,
    closingCostPctMax: 5,
  });
  assert.ok(needed.required_household_monthly_take_home > 15000);
  assert.ok(needed.required_annual_gross_salary > 250000);
  assert.ok(needed.upfront_cash_at_target.total_high > 190000);

  const helped = calculateIncomeNeeded({
    targetPrice: 775000,
    termYears: 30,
    rateAssumptionPct: 6.5,
    housingPaymentPct: 30,
    takeHomePct: 70,
    monthlyContribution: 1000,
    creditTier: '760_779',
    propertyTaxPct: 1,
    insurancePct: 0.35,
    hoaMonthly: 0,
    closingCostPctMin: 2,
    closingCostPctMax: 5,
  });
  assert.ok(helped.required_annual_gross_salary < needed.required_annual_gross_salary);
}

{
  assert.equal(roundDown(612999), 610000);
  assert.equal(roundDown(0), 0);
}

{
  const dir = mkdtempSync(join(tmpdir(), 'home-ops-afford-'));
  try {
    const inputPath = join(dir, 'salary-submission.json');
    const outputPath = join(dir, 'salary-result.json');
    writeFileSync(inputPath, JSON.stringify({
      source: 'afford-wizard',
      payload: {
        answers: {
          loan_term_years: '30',
          primary_annual_salary: '140000',
          secondary_annual_salary: '80000',
          other_annual_income: '0',
          other_monthly_contribution: '0',
          take_home_pct: '70',
          monthly_debt: '0',
          cash_available: '1000000',
          credit_tier: '760_779',
          housing_payment_pct: '25',
          interest_rate_override: '6.5',
          property_tax_pct: '1',
          insurance_pct: '0.35',
          hoa_monthly: '0',
          closing_cost_pct_min: '2',
          closing_cost_pct_max: '5',
        },
      },
    }), 'utf8');
    execFileSync(process.execPath, [
      'scripts/affordability/calculate-affordability.mjs',
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--no-fetch-rates',
    ], { stdio: 'pipe' });
    const salaryResult = JSON.parse(readFileSync(outputPath, 'utf8'));
    approx(salaryResult.selected.monthly_payment_cap, 3208.33, 1);
    assert.ok(salaryResult.recommended_price_max > 500000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), 'home-ops-afford-'));
  try {
    const profilePath = join(dir, 'profile.yml');
    const buyerProfilePath = join(dir, 'buyer-profile.md');
    const profileModePath = join(dir, '_profile.md');
    writeFileSync(profilePath, YAML.stringify({
      search: {
        hard_requirements: {
          price_min: 600000,
          price_max: 775000,
        },
      },
      financial: {
        down_payment_pct: 10,
        closing_cost_pct_min: 2,
        closing_cost_pct_max: 3,
      },
    }), 'utf8');
    writeFileSync(buyerProfilePath, '# Buyer Profile\n\nExisting context.\n', 'utf8');
    writeFileSync(profileModePath, '# Buyer Heuristics\n\nExisting heuristic.\n', 'utf8');

    const result = calculateAffordability({
      termYears: 30,
      monthlyTakeHomePay: 9876,
      monthlyDebt: 4321,
      cashAvailable: 123456,
      creditTier: '760_779',
      rateAssumptionPct: 6.5,
      rate30Pct: 6.5,
      rate15Pct: 5.8,
      rateSource: 'fixture',
      propertyTaxPct: 1,
      insurancePct: 0.35,
      hoaMonthly: 0,
      closingCostPctMin: 2,
      closingCostPctMax: 5,
    });
    result.profile_patch_preview = {
      search: { hard_requirements: { price_min: 410000, price_max: 485000 } },
      financial: {
        down_payment_pct: 20,
        closing_cost_pct_min: 2,
        closing_cost_pct_max: 5,
        loan_term_years: 30,
        housing_payment_pct: 25,
        rate_assumption_pct: 6.5,
        rate_source: 'fixture',
      },
    };

    const summary = applyAffordabilityToFiles({
      result,
      profilePath,
      buyerProfilePath,
      profileModePath,
    });

    assert.equal(summary.searchPriceMin, 410000);
    assert.equal(summary.searchPriceMax, 485000);

    const nextProfile = YAML.parse(readFileSync(profilePath, 'utf8'));
    assert.equal(nextProfile.search.hard_requirements.price_max, 485000);
    assert.equal(nextProfile.financial.loan_term_years, 30);
    assert.equal(nextProfile.financial.housing_payment_pct, 25);

    const combined = [
      readFileSync(profilePath, 'utf8'),
      readFileSync(buyerProfilePath, 'utf8'),
      readFileSync(profileModePath, 'utf8'),
    ].join('\n');
    assert.equal(combined.includes('9876'), false, 'Raw take-home income should not be written.');
    assert.equal(combined.includes('4321'), false, 'Raw debt should not be written.');
    assert.equal(combined.includes('123456'), false, 'Raw cash available should not be written.');
    assert.equal(combined.includes('760_779'), false, 'Raw credit-tier key should not be written.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('Affordability tests passed.');
