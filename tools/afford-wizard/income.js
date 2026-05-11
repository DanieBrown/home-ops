const CREDIT_TIERS = [
  ['780_plus', '780+'],
  ['760_779', '760-779'],
  ['740_759', '740-759'],
  ['720_739', '720-739'],
  ['700_719', '700-719'],
  ['680_699', '680-699'],
  ['660_679', '660-679'],
  ['640_659', '640-659'],
  ['639_or_below', '639 or below'],
  ['unknown', 'Unknown'],
];

const LLPA_BY_LTV_80 = {
  '780_plus': 0.375,
  '760_779': 0.625,
  '740_759': 0.875,
  '720_739': 1.25,
  '700_719': 1.375,
  '680_699': 1.75,
  '660_679': 1.875,
  '640_659': 2.25,
  '639_or_below': 2.75,
  unknown: 1.375,
};

const state = {
  profile: {},
  profileMin: null,
  profileMax: null,
  rates: null,
  ratesError: '',
};

function numeric(value) {
  const parsed = Number(String(value ?? '').replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value) {
  const numericValue = numeric(value);
  if (!Number.isFinite(numericValue)) return '--';
  return `$${Math.round(numericValue).toLocaleString('en-US')}`;
}

function monthlyPrincipalInterest(loanAmount, annualRatePct, termYears) {
  const principal = numeric(loanAmount);
  const rate = numeric(annualRatePct);
  const years = Number(termYears) === 15 ? 15 : 30;
  if (!Number.isFinite(principal) || principal <= 0) return 0;
  const months = years * 12;
  if (!Number.isFinite(rate) || rate <= 0) return principal / months;
  const monthlyRate = rate / 100 / 12;
  const factor = Math.pow(1 + monthlyRate, months);
  return principal * ((monthlyRate * factor) / (factor - 1));
}

function rateForTerm(answers) {
  const override = numeric(answers.interest_rate_override);
  if (Number.isFinite(override) && override > 0) return { rate: override, source: 'your rate override' };
  const termYears = Number(answers.loan_term_years) === 15 ? 15 : 30;
  const pmmsRate = termYears === 30 ? state.rates?.rate30Pct : state.rates?.rate15Pct;
  if (Number.isFinite(pmmsRate) && pmmsRate > 0) {
    return { rate: pmmsRate, source: `Freddie Mac PMMS${state.rates?.asOf ? `, ${state.rates.asOf}` : ''}` };
  }
  return { rate: null, source: '' };
}

function readForm(form) {
  const formData = new FormData(form);
  return {
    target_price: formData.get('target_price') || '',
    loan_term_years: formData.get('loan_term_years') || '30',
    credit_tier: formData.get('credit_tier') || 'unknown',
    housing_payment_pct: formData.get('housing_payment_pct') || '30',
    take_home_pct: formData.get('take_home_pct') || '70',
    monthly_contribution: formData.get('monthly_contribution') || '0',
    interest_rate_override: formData.get('interest_rate_override') || '',
    property_tax_pct: formData.get('property_tax_pct') || '1.0',
    insurance_pct: formData.get('insurance_pct') || '0.35',
    hoa_monthly: formData.get('hoa_monthly') || '0',
    closing_cost_pct_max: formData.get('closing_cost_pct_max') || '5',
  };
}

function setFieldValue(form, key, value) {
  const field = form.elements[key];
  if (!field) return;
  field.value = value ?? '';
}

function populateCreditTiers(select) {
  select.innerHTML = CREDIT_TIERS
    .map(([key, label]) => `<option value="${key}">${label}</option>`)
    .join('');
}

function calculateIncomeNeeded(answers) {
  const targetPrice = numeric(answers.target_price);
  const { rate, source } = rateForTerm(answers);
  if (!Number.isFinite(targetPrice) || targetPrice <= 0 || !Number.isFinite(rate) || rate <= 0) return null;

  const loanAmount = targetPrice * 0.8;
  const principalInterest = monthlyPrincipalInterest(loanAmount, rate, answers.loan_term_years);
  const propertyTax = targetPrice * ((numeric(answers.property_tax_pct) ?? 1) / 100) / 12;
  const insurance = targetPrice * ((numeric(answers.insurance_pct) ?? 0.35) / 100) / 12;
  const hoa = numeric(answers.hoa_monthly) ?? 0;
  const payment = principalInterest + propertyTax + insurance + hoa;

  const housingPct = Math.min(numeric(answers.housing_payment_pct) ?? 30, 45);
  const takeHomePct = numeric(answers.take_home_pct) ?? 70;
  const monthlyContribution = numeric(answers.monthly_contribution) ?? 0;
  const householdTakeHomeNeeded = payment / (housingPct / 100);
  const salaryTakeHomeNeeded = Math.max(0, householdTakeHomeNeeded - monthlyContribution);
  const grossSalary = salaryTakeHomeNeeded * 12 / (takeHomePct / 100);

  const termYears = Number(answers.loan_term_years) === 15 ? 15 : 30;
  const llpaPct = termYears === 30 ? (LLPA_BY_LTV_80[answers.credit_tier] ?? LLPA_BY_LTV_80.unknown) : 0;
  const cashNeeded = (targetPrice * 0.2)
    + (targetPrice * ((numeric(answers.closing_cost_pct_max) ?? 5) / 100))
    + (targetPrice * 0.8 * (llpaPct / 100));

  return {
    targetPrice,
    rate,
    source,
    payment,
    householdTakeHomeNeeded,
    grossSalary,
    cashNeeded,
    housingPct,
    takeHomePct,
  };
}

function updateEstimate(form) {
  const answers = readForm(form);
  const result = calculateIncomeNeeded(answers);
  if (!result) {
    document.getElementById('needed-salary').textContent = 'Add a price';
    document.getElementById('needed-summary').textContent = state.ratesError
      ? 'Rates did not load. Type a rate override to see an estimate.'
      : 'Use your current profile range or type a home price.';
    document.getElementById('needed-takehome').textContent = '--';
    document.getElementById('needed-gross').textContent = '--';
    document.getElementById('needed-payment').textContent = '--';
    document.getElementById('needed-cash').textContent = '--';
    document.getElementById('needed-note').textContent = '';
    return;
  }

  document.getElementById('needed-salary').textContent = money(result.grossSalary);
  document.getElementById('needed-summary').textContent = `Estimated gross household salary for a ${money(result.targetPrice)} home. Rate used: ${result.rate}% from ${result.source}.`;
  document.getElementById('needed-takehome').textContent = `${money(result.householdTakeHomeNeeded)} / mo`;
  document.getElementById('needed-gross').textContent = `${money(result.grossSalary)} / yr`;
  document.getElementById('needed-payment').textContent = `${money(result.payment)} / mo`;
  document.getElementById('needed-cash').textContent = money(result.cashNeeded);
  document.getElementById('needed-note').textContent = `This assumes the house payment can use ${result.housingPct}% of take-home pay, and take-home is about ${result.takeHomePct}% of gross salary.`;
}

function updateProfileNote() {
  const note = document.getElementById('profile-range-note');
  if (Number.isFinite(state.profileMin) && Number.isFinite(state.profileMax)) {
    note.textContent = `Current profile range: ${money(state.profileMin)} to ${money(state.profileMax)}.`;
  } else if (Number.isFinite(state.profileMax)) {
    note.textContent = `Current profile max: ${money(state.profileMax)}.`;
  } else {
    note.textContent = 'No profile price range found. Type a home price.';
  }
}

async function loadProfile(form) {
  try {
    const response = await fetch('/api/profile');
    const body = await response.json();
    state.profile = body.profile ?? {};
    const hard = state.profile?.search?.hard_requirements ?? {};
    state.profileMin = numeric(hard.price_min);
    state.profileMax = numeric(hard.price_max);
    const financial = state.profile?.financial ?? {};
    const soft = state.profile?.search?.soft_preferences ?? {};
    if (Number.isFinite(numeric(financial.loan_term_years))) setFieldValue(form, 'loan_term_years', financial.loan_term_years);
    if (Number.isFinite(numeric(financial.housing_payment_pct))) setFieldValue(form, 'housing_payment_pct', financial.housing_payment_pct);
    if (Number.isFinite(numeric(soft.hoa_max_monthly))) setFieldValue(form, 'hoa_monthly', soft.hoa_max_monthly);
    if (Number.isFinite(state.profileMax)) setFieldValue(form, 'target_price', state.profileMax);
  } catch (error) {
    console.warn('Unable to load profile.', error);
  }
  updateProfileNote();
}

async function loadRates() {
  try {
    const response = await fetch('/api/rates');
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
    state.rates = body.rates;
  } catch (error) {
    state.ratesError = error.message;
  }
}

async function bootstrap() {
  const form = document.getElementById('income-form');
  populateCreditTiers(form.elements.credit_tier);
  setFieldValue(form, 'loan_term_years', '30');
  setFieldValue(form, 'credit_tier', 'unknown');
  setFieldValue(form, 'housing_payment_pct', '30');
  setFieldValue(form, 'take_home_pct', '70');
  setFieldValue(form, 'monthly_contribution', '0');
  setFieldValue(form, 'property_tax_pct', '1.0');
  setFieldValue(form, 'insurance_pct', '0.35');
  setFieldValue(form, 'hoa_monthly', '0');
  setFieldValue(form, 'closing_cost_pct_max', '5');

  await loadProfile(form);
  updateEstimate(form);

  form.addEventListener('input', () => updateEstimate(form));
  form.addEventListener('change', () => updateEstimate(form));
  document.getElementById('use-profile-min').addEventListener('click', () => {
    if (Number.isFinite(state.profileMin)) {
      setFieldValue(form, 'target_price', state.profileMin);
      updateEstimate(form);
    }
  });
  document.getElementById('use-profile-max').addEventListener('click', () => {
    if (Number.isFinite(state.profileMax)) {
      setFieldValue(form, 'target_price', state.profileMax);
      updateEstimate(form);
    }
  });

  await loadRates();
  updateEstimate(form);
}

bootstrap();
