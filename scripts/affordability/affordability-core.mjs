const DEFAULT_ROUNDING_INCREMENT = 5000;

export const PMMS_URL = 'https://www.freddiemac.com/pmms';

export const CREDIT_TIERS = [
  { key: '780_plus', label: '780+' },
  { key: '760_779', label: '760-779' },
  { key: '740_759', label: '740-759' },
  { key: '720_739', label: '720-739' },
  { key: '700_719', label: '700-719' },
  { key: '680_699', label: '680-699' },
  { key: '660_679', label: '660-679' },
  { key: '640_659', label: '640-659' },
  { key: '639_or_below', label: '639 or below' },
  { key: 'unknown', label: 'Unknown' },
];

const CREDIT_TIER_ALIASES = new Map([
  ['780+', '780_plus'],
  ['780 plus', '780_plus'],
  ['780_plus', '780_plus'],
  ['760-779', '760_779'],
  ['760_779', '760_779'],
  ['740-759', '740_759'],
  ['740_759', '740_759'],
  ['720-739', '720_739'],
  ['720_739', '720_739'],
  ['700-719', '700_719'],
  ['700_719', '700_719'],
  ['680-699', '680_699'],
  ['680_699', '680_699'],
  ['660-679', '660_679'],
  ['660_679', '660_679'],
  ['640-659', '640_659'],
  ['640_659', '640_659'],
  ['639 or below', '639_or_below'],
  ['639_or_below', '639_or_below'],
  ['<=639', '639_or_below'],
  ['unknown', 'unknown'],
]);

const UNKNOWN_CREDIT_ESTIMATE_TIER = '700_719';

const LLPA_BY_LTV_BUCKET = [
  {
    key: '75.01-80.00',
    minExclusive: 75,
    maxInclusive: 80,
    values: {
      '780_plus': 0.375,
      '760_779': 0.625,
      '740_759': 0.875,
      '720_739': 1.25,
      '700_719': 1.375,
      '680_699': 1.75,
      '660_679': 1.875,
      '640_659': 2.25,
      '639_or_below': 2.75,
    },
  },
  {
    key: '80.01-85.00',
    minExclusive: 80,
    maxInclusive: 85,
    values: {
      '780_plus': 0.375,
      '760_779': 0.625,
      '740_759': 1.0,
      '720_739': 1.25,
      '700_719': 1.5,
      '680_699': 1.875,
      '660_679': 2.125,
      '640_659': 2.5,
      '639_or_below': 2.875,
    },
  },
  {
    key: '85.01-90.00',
    minExclusive: 85,
    maxInclusive: 90,
    values: {
      '780_plus': 0.25,
      '760_779': 0.5,
      '740_759': 0.75,
      '720_739': 1.0,
      '700_719': 1.25,
      '680_699': 1.5,
      '660_679': 1.75,
      '640_659': 2.0,
      '639_or_below': 2.625,
    },
  },
  {
    key: '90.01-95.00',
    minExclusive: 90,
    maxInclusive: 95,
    values: {
      '780_plus': 0.25,
      '760_779': 0.5,
      '740_759': 0.625,
      '720_739': 0.875,
      '700_719': 1.125,
      '680_699': 1.375,
      '660_679': 1.625,
      '640_659': 1.875,
      '639_or_below': 2.25,
    },
  },
  {
    key: '>95.00',
    minExclusive: 95,
    maxInclusive: Number.POSITIVE_INFINITY,
    values: {
      '780_plus': 0.125,
      '760_779': 0.25,
      '740_759': 0.5,
      '720_739': 0.75,
      '700_719': 0.875,
      '680_699': 1.125,
      '660_679': 1.25,
      '640_659': 1.5,
      '639_or_below': 1.75,
    },
  },
];

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/[$,%\s,]/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function roundDown(value, increment = DEFAULT_ROUNDING_INCREMENT) {
  const numeric = toNumber(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric / increment) * increment;
}

export function formatMoney(value) {
  const numeric = toNumber(value);
  if (!Number.isFinite(numeric)) return '$0';
  return `$${Math.round(numeric).toLocaleString('en-US')}`;
}

export function normalizeCreditTier(value) {
  const normalized = String(value ?? 'unknown')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return CREDIT_TIER_ALIASES.get(normalized) ?? 'unknown';
}

export function creditTierLabel(key) {
  return CREDIT_TIERS.find((tier) => tier.key === normalizeCreditTier(key))?.label ?? 'Unknown';
}

export function normalizeTermYears(value) {
  const numeric = Number.parseInt(String(value ?? '').replace(/[^\d]/g, ''), 10);
  if (numeric === 15) return 15;
  return 30;
}

export function normalizeHousingPaymentPct(value) {
  const numeric = toNumber(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 25;
  return Math.min(numeric, 45);
}

export function firstProfileState(profile) {
  const area = profile?.search?.areas?.[0];
  return area?.state ?? '';
}

export function firstProfileArea(profile) {
  const areas = profile?.search?.areas;
  if (!Array.isArray(areas) || areas.length === 0) return '';
  return areas.map((area) => area.name).filter(Boolean).join(', ');
}

export function estimateMonthlyTakeHomeFromAnswers(answers = {}) {
  const direct = toNumber(answers.monthly_take_home);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const annualGross = (toNumber(answers.primary_annual_salary) ?? 0)
    + (toNumber(answers.secondary_annual_salary) ?? 0)
    + (toNumber(answers.other_annual_income) ?? 0);
  const takeHomePct = toNumber(answers.take_home_pct) ?? 70;
  const monthlyHelp = toNumber(answers.other_monthly_contribution) ?? 0;
  const override = toNumber(answers.monthly_take_home_override);
  if (Number.isFinite(override) && override > 0) return override + monthlyHelp;
  if (annualGross > 0 || monthlyHelp > 0) return (annualGross * (takeHomePct / 100) / 12) + monthlyHelp;
  return direct;
}

export function normalizeAffordabilityAnswers(answers = {}, profile = {}, pmmsRates = null) {
  const termYears = normalizeTermYears(answers.loan_term_years ?? answers.term_years);
  const overrideRate = toNumber(answers.interest_rate_override);
  const selectedPmmsRate = termYears === 30 ? pmmsRates?.rate30Pct : pmmsRates?.rate15Pct;
  const rateAssumptionPct = Number.isFinite(overrideRate) && overrideRate > 0 ? overrideRate : selectedPmmsRate;

  if (!Number.isFinite(rateAssumptionPct) || rateAssumptionPct <= 0) {
    throw new Error('No interest rate is available. Reopen the affordability wizard and enter an interest-rate override, then submit again.');
  }

  const rateSource = Number.isFinite(overrideRate) && overrideRate > 0
    ? 'User override'
    : `Freddie Mac PMMS (${pmmsRates?.asOf ?? 'latest available'})`;
  const profileHoa = toNumber(profile?.search?.soft_preferences?.hoa_max_monthly);
  const hard = profile?.search?.hard_requirements ?? {};

  return {
    termYears,
    monthlyTakeHomePay: estimateMonthlyTakeHomeFromAnswers(answers),
    monthlyDebt: toNumber(answers.monthly_debt) ?? 0,
    cashAvailable: toNumber(answers.cash_available),
    creditTier: answers.credit_tier ?? 'unknown',
    targetState: answers.target_state || firstProfileState(profile),
    targetArea: answers.target_area || firstProfileArea(profile),
    rateAssumptionPct,
    rate30Pct: pmmsRates?.rate30Pct,
    rate15Pct: pmmsRates?.rate15Pct,
    rateSource,
    comparisonRateSource: pmmsRates ? `Freddie Mac PMMS (${pmmsRates.asOf ?? 'latest available'})` : rateSource,
    propertyTaxPct: toNumber(answers.property_tax_pct) ?? 1.0,
    insurancePct: toNumber(answers.insurance_pct) ?? 0.35,
    hoaMonthly: toNumber(answers.hoa_monthly) ?? profileHoa ?? 0,
    closingCostPctMin: toNumber(answers.closing_cost_pct_min) ?? 2,
    closingCostPctMax: toNumber(answers.closing_cost_pct_max) ?? 5,
    housingPaymentPct: toNumber(answers.housing_payment_pct) ?? 25,
    downPaymentPct: toNumber(answers.down_payment_pct) ?? toNumber(profile?.financial?.down_payment_pct) ?? 20,
    priceFloorMode: answers.price_floor_mode ?? 'current_profile',
    priceFloorCustom: toNumber(answers.price_floor_custom),
    currentPriceMin: toNumber(hard.price_min),
    includeComparison: answers.include_comparison !== false,
  };
}

function ltvBucket(ltvPct) {
  const ltv = toNumber(ltvPct);
  if (!Number.isFinite(ltv)) return LLPA_BY_LTV_BUCKET[0];
  const match = LLPA_BY_LTV_BUCKET.find((bucket) => ltv > bucket.minExclusive && ltv <= bucket.maxInclusive);
  return match ?? LLPA_BY_LTV_BUCKET[LLPA_BY_LTV_BUCKET.length - 1];
}

export function getLlpaPct({ termYears = 30, creditTier = 'unknown', ltvPct = 80 } = {}) {
  const normalizedTerm = normalizeTermYears(termYears);
  const normalizedTier = normalizeCreditTier(creditTier);
  const effectiveTier = normalizedTier === 'unknown' ? UNKNOWN_CREDIT_ESTIMATE_TIER : normalizedTier;

  if (normalizedTerm <= 15) {
    return {
      pct: 0,
      applied: false,
      creditTierKey: normalizedTier,
      effectiveCreditTierKey: effectiveTier,
      ltvBucket: null,
      note: 'The Fannie Mae purchase LLPA credit/LTV table used here applies to loan terms greater than 15 years.',
    };
  }

  const bucket = ltvBucket(ltvPct);
  return {
    pct: bucket.values[effectiveTier] ?? bucket.values[UNKNOWN_CREDIT_ESTIMATE_TIER],
    applied: true,
    creditTierKey: normalizedTier,
    effectiveCreditTierKey: effectiveTier,
    ltvBucket: bucket.key,
    note: normalizedTier === 'unknown'
      ? `Credit tier is unknown, so the estimate uses ${creditTierLabel(effectiveTier)} for pricing pressure.`
      : `Uses the ${creditTierLabel(effectiveTier)} tier and ${bucket.key}% LTV bucket for 30-year pricing pressure.`,
  };
}

export function monthlyPrincipalInterest(loanAmount, annualRatePct, termYears) {
  const principal = toNumber(loanAmount);
  const rate = toNumber(annualRatePct);
  const years = normalizeTermYears(termYears);
  if (!Number.isFinite(principal) || principal <= 0) return 0;
  const months = years * 12;
  if (!Number.isFinite(rate) || rate <= 0) return principal / months;
  const monthlyRate = rate / 100 / 12;
  const factor = Math.pow(1 + monthlyRate, months);
  return principal * ((monthlyRate * factor) / (factor - 1));
}

function paymentForPrice(price, assumptions) {
  const purchasePrice = toNumber(price) ?? 0;
  const downPaymentPct = assumptions.downPaymentPct / 100;
  const loanAmount = purchasePrice * (1 - downPaymentPct);
  const principalInterest = monthlyPrincipalInterest(loanAmount, assumptions.rateAssumptionPct, assumptions.termYears);
  const propertyTax = purchasePrice * (assumptions.propertyTaxPct / 100) / 12;
  const homeownersInsurance = purchasePrice * (assumptions.insurancePct / 100) / 12;
  const mortgageInsurance = assumptions.downPaymentPct < 20
    ? loanAmount * (assumptions.mortgageInsurancePct / 100) / 12
    : 0;
  const hoa = assumptions.hoaMonthly;
  const total = principalInterest + propertyTax + homeownersInsurance + mortgageInsurance + hoa;

  return {
    principal_interest: principalInterest,
    property_tax: propertyTax,
    homeowners_insurance: homeownersInsurance,
    mortgage_insurance: mortgageInsurance,
    hoa,
    total,
  };
}

function priceCapByPayment(monthlyPaymentCap, assumptions) {
  const cap = toNumber(monthlyPaymentCap) ?? 0;
  if (cap <= assumptions.hoaMonthly) return 0;
  const downPaymentRatio = assumptions.downPaymentPct / 100;
  const loanRatio = 1 - downPaymentRatio;
  const piPerDollar = monthlyPrincipalInterest(loanRatio, assumptions.rateAssumptionPct, assumptions.termYears);
  const taxPerDollar = assumptions.propertyTaxPct / 100 / 12;
  const insurancePerDollar = assumptions.insurancePct / 100 / 12;
  const pmiPerDollar = assumptions.downPaymentPct < 20
    ? loanRatio * (assumptions.mortgageInsurancePct / 100) / 12
    : 0;
  const monthlyPerDollar = piPerDollar + taxPerDollar + insurancePerDollar + pmiPerDollar;
  if (monthlyPerDollar <= 0) return 0;
  return (cap - assumptions.hoaMonthly) / monthlyPerDollar;
}

function priceCapByCash(cashAvailable, assumptions, llpaPct) {
  const cash = toNumber(cashAvailable) ?? 0;
  if (cash <= 0) return 0;
  const downPaymentRatio = assumptions.downPaymentPct / 100;
  const loanRatio = 1 - downPaymentRatio;
  const closingRatio = assumptions.closingCostPctMax / 100;
  const llpaRatio = (llpaPct ?? 0) / 100;
  const requiredCashPerDollar = downPaymentRatio + closingRatio + (loanRatio * llpaRatio);
  if (requiredCashPerDollar <= 0) return 0;
  return cash / requiredCashPerDollar;
}

export function calculateScenario(input) {
  const monthlyTakeHomePay = toNumber(input.monthlyTakeHomePay);
  const cashAvailable = toNumber(input.cashAvailable);
  const monthlyDebt = toNumber(input.monthlyDebt) ?? 0;
  const termYears = normalizeTermYears(input.termYears);
  const rateAssumptionPct = toNumber(input.rateAssumptionPct);
  const housingPaymentPct = normalizeHousingPaymentPct(input.housingPaymentPct);

  const errors = [];
  if (!Number.isFinite(monthlyTakeHomePay) || monthlyTakeHomePay <= 0) errors.push('monthly_take_home must be greater than 0.');
  if (!Number.isFinite(cashAvailable) || cashAvailable <= 0) errors.push('cash_available must be greater than 0.');
  if (!Number.isFinite(rateAssumptionPct) || rateAssumptionPct <= 0) errors.push('rate_assumption_pct must be greater than 0.');
  if (errors.length > 0) {
    const error = new Error(errors.join(' '));
    error.validationErrors = errors;
    throw error;
  }

  const assumptions = {
    termYears,
    rateAssumptionPct,
    housingPaymentPct,
    downPaymentPct: toNumber(input.downPaymentPct) ?? 20,
    closingCostPctMin: toNumber(input.closingCostPctMin) ?? 2,
    closingCostPctMax: toNumber(input.closingCostPctMax) ?? 5,
    propertyTaxPct: toNumber(input.propertyTaxPct) ?? 1.0,
    insurancePct: toNumber(input.insurancePct) ?? 0.35,
    hoaMonthly: toNumber(input.hoaMonthly) ?? 0,
    mortgageInsurancePct: toNumber(input.mortgageInsurancePct) ?? 0.55,
  };

  const debtAdjustedTakeHomePay = Math.max(0, monthlyTakeHomePay - Math.max(0, monthlyDebt));
  const ltvPct = 100 - assumptions.downPaymentPct;
  const llpa = getLlpaPct({ termYears, creditTier: input.creditTier, ltvPct });
  const monthlyPaymentCap = debtAdjustedTakeHomePay * (housingPaymentPct / 100);
  const paymentCap = priceCapByPayment(monthlyPaymentCap, assumptions);
  const cashCap = priceCapByCash(cashAvailable, assumptions, llpa.pct);
  const unroundedRecommended = Math.min(paymentCap, cashCap);
  const recommendedPriceMax = roundDown(unroundedRecommended);
  const paymentAtRecommended = paymentForPrice(recommendedPriceMax, assumptions);
  const upfrontCash = {
    down_payment: recommendedPriceMax * (assumptions.downPaymentPct / 100),
    closing_cost_low: recommendedPriceMax * (assumptions.closingCostPctMin / 100),
    closing_cost_high: recommendedPriceMax * (assumptions.closingCostPctMax / 100),
    llpa_pricing_pressure: recommendedPriceMax * (1 - assumptions.downPaymentPct / 100) * (llpa.pct / 100),
  };
  upfrontCash.total_high = upfrontCash.down_payment + upfrontCash.closing_cost_high + upfrontCash.llpa_pricing_pressure;

  const warnings = [];
  if (monthlyDebt > 0) {
    warnings.push(`Existing monthly debt reduced the ${housingPaymentPct}% housing cap before estimating the purchase range; have a lender review total DTI before relying on this estimate.`);
  }
  if (llpa.creditTierKey === 'unknown') {
    warnings.push(llpa.note);
  }
  if (termYears === 15) {
    warnings.push('15-year fixed estimates skip the >15-year LLPA table, but credit score can still affect lender pricing and approval.');
  }
  if (recommendedPriceMax <= 0) {
    warnings.push('The required cash or monthly-payment cap is too low for a positive purchase-price estimate under these assumptions.');
  }

  return {
    term_years: termYears,
    recommended_price_max: recommendedPriceMax,
    unrounded_recommended_price_max: unroundedRecommended,
    payment_price_cap: paymentCap,
    cash_price_cap: cashCap,
    constraint: paymentCap <= cashCap ? 'monthly_payment_cap' : 'cash_available',
    monthly_payment_cap: monthlyPaymentCap,
    debt_adjusted_monthly_take_home: debtAdjustedTakeHomePay,
    payment_at_recommended: paymentAtRecommended,
    upfront_cash_at_recommended: upfrontCash,
    assumptions: {
      ...assumptions,
      credit_tier: normalizeCreditTier(input.creditTier),
      credit_tier_label: creditTierLabel(input.creditTier),
      effective_credit_tier: llpa.effectiveCreditTierKey,
      effective_credit_tier_label: creditTierLabel(llpa.effectiveCreditTierKey),
      llpa_pct: llpa.pct,
      llpa_applied: llpa.applied,
      llpa_ltv_bucket: llpa.ltvBucket,
      ltv_pct: ltvPct,
      rate_source: input.rateSource ?? 'Unknown',
    },
    warnings,
  };
}

export function resolveRecommendedPriceMin({
  mode = 'current_profile',
  customAmount = null,
  currentPriceMin = null,
  recommendedPriceMax = 0,
} = {}) {
  const max = toNumber(recommendedPriceMax) ?? 0;
  if (max <= 0) return 0;

  if (mode === 'none') return 0;
  if (mode === 'custom') {
    const custom = toNumber(customAmount);
    if (!Number.isFinite(custom) || custom <= 0) return roundDown(max * 0.85);
    return Math.min(roundDown(custom), max);
  }

  if (mode === 'current_profile') {
    const current = toNumber(currentPriceMin);
    if (Number.isFinite(current) && current > 0 && current <= max) return roundDown(current);
    return roundDown(max * 0.85);
  }

  return roundDown(max * 0.85);
}

export function calculateAffordability(input) {
  const selectedTermYears = normalizeTermYears(input.termYears);
  const selected = calculateScenario({ ...input, termYears: selectedTermYears });
  const recommendedPriceMin = resolveRecommendedPriceMin({
    mode: input.priceFloorMode ?? 'current_profile',
    customAmount: input.priceFloorCustom,
    currentPriceMin: input.currentPriceMin,
    recommendedPriceMax: selected.recommended_price_max,
  });
  let comparison = null;

  if (input.includeComparison !== false) {
    const comparisonTermYears = selectedTermYears === 30 ? 15 : 30;
    const comparisonRate = comparisonTermYears === 30 ? input.rate30Pct : input.rate15Pct;
    if (Number.isFinite(toNumber(comparisonRate))) {
      comparison = calculateScenario({
        ...input,
        termYears: comparisonTermYears,
        rateAssumptionPct: comparisonRate,
        rateSource: input.comparisonRateSource ?? input.rateSource,
      });
    }
  }

  const sourceNotes = [
    `Primary cap uses ${selected.assumptions.housingPaymentPct}% of monthly take-home pay after subtracting non-mortgage monthly debt.`,
    'Monthly payment includes principal, interest, estimated property tax, homeowners insurance, HOA, and mortgage insurance when applicable.',
    '30-year conventional estimates include Fannie Mae purchase LLPA credit/LTV pricing pressure for terms greater than 15 years.',
    'Freddie Mac PMMS rates are national averages, not lender quotes or preapproval.',
  ];

  return {
    calculated_at: new Date().toISOString(),
    selected_term_years: selectedTermYears,
    recommended_price_min: recommendedPriceMin,
    recommended_price_max: selected.recommended_price_max,
    monthly_payment_cap: selected.monthly_payment_cap,
    selected,
    comparison,
    warnings: selected.warnings,
    source_notes: sourceNotes,
  };
}

export function calculateIncomeNeeded(input) {
  const targetPrice = toNumber(input.targetPrice);
  const termYears = normalizeTermYears(input.termYears);
  const rateAssumptionPct = toNumber(input.rateAssumptionPct);
  const housingPaymentPct = normalizeHousingPaymentPct(input.housingPaymentPct);
  const takeHomePct = toNumber(input.takeHomePct) ?? 70;
  const monthlyContribution = toNumber(input.monthlyContribution) ?? 0;

  const errors = [];
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) errors.push('target_price must be greater than 0.');
  if (!Number.isFinite(rateAssumptionPct) || rateAssumptionPct <= 0) errors.push('rate_assumption_pct must be greater than 0.');
  if (!Number.isFinite(takeHomePct) || takeHomePct <= 0) errors.push('take_home_pct must be greater than 0.');
  if (errors.length > 0) {
    const error = new Error(errors.join(' '));
    error.validationErrors = errors;
    throw error;
  }

  const assumptions = {
    termYears,
    rateAssumptionPct,
    housingPaymentPct,
    takeHomePct,
    monthlyContribution,
    downPaymentPct: toNumber(input.downPaymentPct) ?? 20,
    closingCostPctMin: toNumber(input.closingCostPctMin) ?? 2,
    closingCostPctMax: toNumber(input.closingCostPctMax) ?? 5,
    propertyTaxPct: toNumber(input.propertyTaxPct) ?? 1.0,
    insurancePct: toNumber(input.insurancePct) ?? 0.35,
    hoaMonthly: toNumber(input.hoaMonthly) ?? 0,
    mortgageInsurancePct: toNumber(input.mortgageInsurancePct) ?? 0.55,
  };

  const ltvPct = 100 - assumptions.downPaymentPct;
  const llpa = getLlpaPct({ termYears, creditTier: input.creditTier, ltvPct });
  const payment = paymentForPrice(targetPrice, assumptions);
  const requiredHouseholdMonthlyTakeHome = payment.total / (housingPaymentPct / 100);
  const requiredSalaryMonthlyTakeHome = Math.max(0, requiredHouseholdMonthlyTakeHome - monthlyContribution);
  const requiredAnnualGrossSalary = requiredSalaryMonthlyTakeHome * 12 / (takeHomePct / 100);
  const upfrontCash = {
    down_payment: targetPrice * (assumptions.downPaymentPct / 100),
    closing_cost_low: targetPrice * (assumptions.closingCostPctMin / 100),
    closing_cost_high: targetPrice * (assumptions.closingCostPctMax / 100),
    llpa_pricing_pressure: targetPrice * (1 - assumptions.downPaymentPct / 100) * (llpa.pct / 100),
  };
  upfrontCash.total_high = upfrontCash.down_payment + upfrontCash.closing_cost_high + upfrontCash.llpa_pricing_pressure;

  return {
    target_price: targetPrice,
    term_years: termYears,
    required_household_monthly_take_home: requiredHouseholdMonthlyTakeHome,
    required_salary_monthly_take_home: requiredSalaryMonthlyTakeHome,
    required_annual_gross_salary: requiredAnnualGrossSalary,
    payment_at_target: payment,
    upfront_cash_at_target: upfrontCash,
    assumptions: {
      ...assumptions,
      credit_tier: normalizeCreditTier(input.creditTier),
      credit_tier_label: creditTierLabel(input.creditTier),
      effective_credit_tier: llpa.effectiveCreditTierKey,
      effective_credit_tier_label: creditTierLabel(llpa.effectiveCreditTierKey),
      llpa_pct: llpa.pct,
      llpa_applied: llpa.applied,
      llpa_ltv_bucket: llpa.ltvBucket,
      ltv_pct: ltvPct,
      rate_source: input.rateSource ?? 'Unknown',
    },
  };
}

export function buildProfilePatchPreview(profile, result) {
  const newMax = result.recommended_price_max;
  const newMin = toNumber(result.recommended_price_min) ?? resolveRecommendedPriceMin({
    mode: 'current_profile',
    currentPriceMin: profile?.search?.hard_requirements?.price_min,
    recommendedPriceMax: newMax,
  });
  const selected = result.selected;

  return {
    search: {
      hard_requirements: {
        price_min: newMin,
        price_max: newMax,
      },
    },
    financial: {
      down_payment_pct: selected.assumptions.downPaymentPct,
      closing_cost_pct_min: selected.assumptions.closingCostPctMin,
      closing_cost_pct_max: selected.assumptions.closingCostPctMax,
      loan_term_years: selected.term_years,
      housing_payment_pct: selected.assumptions.housingPaymentPct,
      rate_assumption_pct: selected.assumptions.rateAssumptionPct,
      rate_source: selected.assumptions.rate_source,
    },
  };
}
