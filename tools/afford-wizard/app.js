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
  rates: null,
  ratesError: '',
  answers: {
    loan_term_years: '30',
    primary_annual_salary: '',
    secondary_annual_salary: '',
    other_annual_income: '',
    other_monthly_contribution: '0',
    take_home_pct: '70',
    monthly_take_home_override: '',
    monthly_debt: '0',
    credit_tier: 'unknown',
    housing_payment_pct: '25',
    property_tax_pct: '1.0',
    insurance_pct: '0.35',
    hoa_monthly: '0',
    closing_cost_pct_min: '2',
    closing_cost_pct_max: '5',
    include_comparison: true,
  },
};

function firstArea(profile) {
  const areas = profile?.search?.areas;
  if (!Array.isArray(areas) || areas.length === 0) return { state: '', label: '' };
  return {
    state: areas[0]?.state ?? '',
    label: areas.map((area) => area.name).filter(Boolean).join(', '),
  };
}

function seedFromProfile(profile, { useProfileTerm = false } = {}) {
  const area = firstArea(profile);
  if (!state.answers.target_state && area.state) state.answers.target_state = area.state;
  if (!state.answers.target_area && area.label) state.answers.target_area = area.label;
  const term = profile?.financial?.loan_term_years;
  if (useProfileTerm && (term === 15 || term === 30)) state.answers.loan_term_years = String(term);
  const paymentPct = profile?.financial?.housing_payment_pct;
  if (Number.isFinite(Number(paymentPct))) state.answers.housing_payment_pct = String(paymentPct);
  const hoa = profile?.search?.soft_preferences?.hoa_max_monthly;
  if ((state.answers.hoa_monthly === undefined || state.answers.hoa_monthly === '0') && Number.isFinite(Number(hoa))) {
    state.answers.hoa_monthly = String(hoa);
  }
}

function setFieldValue(form, key, value) {
  const field = form.elements[key];
  if (!field) return;
  if (field instanceof RadioNodeList) {
    [...field].forEach((node) => { node.checked = String(node.value) === String(value); });
    return;
  }
  if (field.type === 'checkbox') {
    field.checked = !!value;
    return;
  }
  field.value = value ?? '';
}

function readForm(form) {
  const formData = new FormData(form);
  const partial = {
    primary_annual_salary: formData.get('primary_annual_salary') || '',
    secondary_annual_salary: formData.get('secondary_annual_salary') || '',
    other_annual_income: formData.get('other_annual_income') || '',
    other_monthly_contribution: formData.get('other_monthly_contribution') || '0',
    take_home_pct: formData.get('take_home_pct') || '70',
    monthly_take_home_override: formData.get('monthly_take_home_override') || '',
  };
  const takeHome = estimateMonthlyTakeHome(partial).value;
  const answers = {
    loan_term_years: formData.get('loan_term_years') || '30',
    ...partial,
    monthly_take_home: takeHome > 0 ? String(Math.round(takeHome)) : '',
    monthly_debt: formData.get('monthly_debt') || '0',
    cash_available: formData.get('cash_available') || '',
    credit_tier: formData.get('credit_tier') || 'unknown',
    housing_payment_pct: formData.get('housing_payment_pct') || '25',
    target_state: formData.get('target_state') || '',
    target_area: formData.get('target_area') || '',
    interest_rate_override: formData.get('interest_rate_override') || '',
    property_tax_pct: formData.get('property_tax_pct') || '1.0',
    insurance_pct: formData.get('insurance_pct') || '0.35',
    hoa_monthly: formData.get('hoa_monthly') || '0',
    closing_cost_pct_min: formData.get('closing_cost_pct_min') || '2',
    closing_cost_pct_max: formData.get('closing_cost_pct_max') || '5',
    include_comparison: form.elements.include_comparison.checked,
  };
  state.answers = answers;
  return answers;
}

function numeric(value) {
  const parsed = Number(String(value ?? '').replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value) {
  const numericValue = numeric(value);
  if (!Number.isFinite(numericValue)) return '--';
  return `$${Math.round(numericValue).toLocaleString('en-US')}`;
}

function estimateMonthlyTakeHome(answers) {
  const annualGross = (numeric(answers.primary_annual_salary) ?? 0)
    + (numeric(answers.secondary_annual_salary) ?? 0)
    + (numeric(answers.other_annual_income) ?? 0);
  const takeHomePct = numeric(answers.take_home_pct) ?? 70;
  const monthlyHelp = numeric(answers.other_monthly_contribution) ?? 0;
  const override = numeric(answers.monthly_take_home_override);
  const salaryTakeHome = Number.isFinite(override) && override > 0
    ? override
    : annualGross * (takeHomePct / 100) / 12;
  const value = salaryTakeHome + monthlyHelp;
  return {
    value,
    source: Number.isFinite(override) && override > 0
      ? 'manual take-home override'
      : `${takeHomePct}% of annual income, divided by 12`,
  };
}

function roundDown(value, increment = 5000) {
  const numericValue = numeric(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return 0;
  return Math.floor(numericValue / increment) * increment;
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

function paymentForPrice(price, answers, rate) {
  const purchasePrice = numeric(price) ?? 0;
  const loanAmount = purchasePrice * 0.8;
  const principalInterest = monthlyPrincipalInterest(loanAmount, rate, answers.loan_term_years);
  const propertyTax = purchasePrice * ((numeric(answers.property_tax_pct) ?? 1) / 100) / 12;
  const insurance = purchasePrice * ((numeric(answers.insurance_pct) ?? 0.35) / 100) / 12;
  const hoa = numeric(answers.hoa_monthly) ?? 0;
  return {
    total: principalInterest + propertyTax + insurance + hoa,
    principalInterest,
    propertyTax,
    insurance,
    hoa,
  };
}

function estimatePriceCapByPayment(paymentCap, answers, rate) {
  const cap = numeric(paymentCap) ?? 0;
  const hoa = numeric(answers.hoa_monthly) ?? 0;
  if (cap <= hoa) return 0;
  const loanRatio = 0.8;
  const piPerDollar = monthlyPrincipalInterest(loanRatio, rate, answers.loan_term_years);
  const taxPerDollar = ((numeric(answers.property_tax_pct) ?? 1) / 100) / 12;
  const insurancePerDollar = ((numeric(answers.insurance_pct) ?? 0.35) / 100) / 12;
  const monthlyPerDollar = piPerDollar + taxPerDollar + insurancePerDollar;
  if (monthlyPerDollar <= 0) return 0;
  return (cap - hoa) / monthlyPerDollar;
}

function estimatePriceCapByCash(cashAvailable, answers) {
  const cash = numeric(cashAvailable) ?? 0;
  if (cash <= 0) return 0;
  const termYears = Number(answers.loan_term_years) === 15 ? 15 : 30;
  const llpaPct = termYears === 30 ? (LLPA_BY_LTV_80[answers.credit_tier] ?? LLPA_BY_LTV_80.unknown) : 0;
  const closingPct = (numeric(answers.closing_cost_pct_max) ?? 5) / 100;
  const requiredCashPerDollar = 0.2 + closingPct + (0.8 * (llpaPct / 100));
  return requiredCashPerDollar > 0 ? cash / requiredCashPerDollar : 0;
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

function calculateLiveEstimate(answers) {
  const takeHomeEstimate = estimateMonthlyTakeHome(answers);
  const takeHome = takeHomeEstimate.value;
  const cash = numeric(answers.cash_available);
  const housingPct = numeric(answers.housing_payment_pct) ?? 25;
  const { rate, source } = rateForTerm(answers);
  if (!Number.isFinite(takeHome) || takeHome <= 0 || !Number.isFinite(cash) || cash <= 0 || !Number.isFinite(rate) || rate <= 0) {
    return null;
  }
  const paymentCap = takeHome * (housingPct / 100);
  const paymentPriceCap = estimatePriceCapByPayment(paymentCap, answers, rate);
  const cashPriceCap = estimatePriceCapByCash(cash, answers);
  const maxPrice = roundDown(Math.min(paymentPriceCap, cashPriceCap));
  const payment = paymentForPrice(maxPrice, answers, rate);
  const llpaPct = Number(answers.loan_term_years) === 30 ? (LLPA_BY_LTV_80[answers.credit_tier] ?? LLPA_BY_LTV_80.unknown) : 0;
  const cashNeeded = maxPrice * 0.2 + maxPrice * ((numeric(answers.closing_cost_pct_max) ?? 5) / 100) + (maxPrice * 0.8 * (llpaPct / 100));
  return {
    maxPrice,
    paymentCap,
    payment,
    cashNeeded,
    constraint: paymentPriceCap <= cashPriceCap ? 'monthly payment' : 'cash available',
    housingPct,
    rate,
    source,
    takeHomeSource: takeHomeEstimate.source,
  };
}

function validate(answers) {
  const messages = [];
  if (![15, 30].includes(Number(answers.loan_term_years))) messages.push('Choose a fixed loan term.');
  if (!numeric(answers.monthly_take_home) || numeric(answers.monthly_take_home) <= 0) {
    messages.push('Enter salary, monthly help, or a monthly take-home override.');
  }
  if (numeric(answers.monthly_debt) === null || numeric(answers.monthly_debt) < 0) messages.push('Enter monthly debt, even if it is 0.');
  if (!numeric(answers.cash_available) || numeric(answers.cash_available) <= 0) messages.push('Enter cash available after reserves.');
  if (!answers.credit_tier) messages.push('Choose a rough credit score band.');
  if (!answers.target_state.trim()) messages.push('Enter a target state.');
  if (!answers.target_area.trim()) messages.push('Enter a target area.');
  if (numeric(answers.closing_cost_pct_max) < numeric(answers.closing_cost_pct_min)) {
    messages.push('Closing costs high should be greater than or equal to closing costs low.');
  }
  return messages;
}

function carefulnessText(housingPct) {
  if (housingPct <= 22) {
    return `Very careful: about $${housingPct} of every $100 you take home can go to the house. This leaves more money for savings, repairs, food, cars, kids, and surprises.`;
  }
  if (housingPct <= 26) {
    return `Careful: about $${housingPct} of every $100 you take home can go to the house. This is the default because it leaves breathing room.`;
  }
  if (housingPct <= 30) {
    return `Moderate: about $${housingPct} of every $100 you take home can go to the house. The home budget is bigger, but monthly life is tighter.`;
  }
  if (housingPct <= 38) {
    return `Less careful: about $${housingPct} of every $100 you take home can go to the house. This may feel tight unless the rest of your budget is very steady.`;
  }
  return `High limit: about $${housingPct} of every $100 you take home can go to the house. This is the top end. Use it only if you are comfortable with a tight monthly budget.`;
}

function updateLiveEstimate(form) {
  const answers = readForm(form);
  const housingPct = numeric(answers.housing_payment_pct) ?? 25;
  document.getElementById('careful-value').textContent = `${housingPct}%`;
  document.getElementById('careful-copy').textContent = carefulnessText(housingPct);

  const estimate = calculateLiveEstimate(answers);
  if (!estimate) {
    document.getElementById('live-price').textContent = 'Add your numbers';
    document.getElementById('live-summary').textContent = state.ratesError
      ? 'Rates did not load. Type a rate override under Advanced assumptions to see an estimate.'
      : 'The estimate will update as you type.';
    document.getElementById('live-payment-cap').textContent = '--';
    document.getElementById('live-takehome').textContent = '--';
    document.getElementById('live-payment').textContent = '--';
    document.getElementById('live-cash').textContent = '--';
    document.getElementById('live-constraint').textContent = '--';
    document.getElementById('live-note').textContent = '';
    return;
  }

  document.getElementById('live-price').textContent = money(estimate.maxPrice);
  document.getElementById('live-summary').textContent = `Estimated max price for a ${answers.loan_term_years}-year fixed loan. Rate used: ${estimate.rate}% from ${estimate.source}.`;
  document.getElementById('live-payment-cap').textContent = `${money(estimate.paymentCap)} / mo`;
  document.getElementById('live-takehome').textContent = `${money(estimate.paymentCap / (estimate.housingPct / 100))} / mo`;
  document.getElementById('live-payment').textContent = `${money(estimate.payment.total)} / mo`;
  document.getElementById('live-cash').textContent = money(estimate.cashNeeded);
  document.getElementById('live-constraint').textContent = estimate.constraint;
  document.getElementById('live-note').textContent = estimate.constraint === 'cash available'
    ? 'Your monthly payment could support more, but cash for down payment and closing costs is the smaller bucket.'
    : 'Your cash can support more, but the monthly payment limit is the smaller bucket.';
}

function buildSummary(answers) {
  return [
    `Loan term: ${answers.loan_term_years}-year fixed`,
    `Annual income entered: primary ${answers.primary_annual_salary || '0'}, secondary ${answers.secondary_annual_salary || '0'}, other ${answers.other_annual_income || '0'}`,
    `Monthly take-home used: ${answers.monthly_take_home || '0'} (${estimateMonthlyTakeHome(answers).source})`,
    `Housing payment cap: ${answers.housing_payment_pct}% of monthly take-home pay`,
    `Credit tier: ${CREDIT_TIERS.find(([key]) => key === answers.credit_tier)?.[1] ?? 'Unknown'}`,
    `Target: ${answers.target_area}, ${answers.target_state}`,
    `Advanced: tax ${answers.property_tax_pct || '1.0'}%, insurance ${answers.insurance_pct || '0.35'}%, HOA $${answers.hoa_monthly || '0'}/mo, closing ${answers.closing_cost_pct_min || '2'}-${answers.closing_cost_pct_max || '5'}%`,
  ].join('\n');
}

let saveTimer = null;
function saveAnswersDebounced(form) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const answers = readForm(form);
    fetch('/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    }).catch(() => {});
  }, 400);
}

async function submit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const answers = readForm(form);
  const validation = validate(answers);
  const validationNode = document.getElementById('validation');
  if (validation.length > 0) {
    validationNode.textContent = validation.join(' ');
    return;
  }
  validationNode.textContent = '';
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Submitting...';

  try {
    const response = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers, summary: buildSummary(answers) }),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
    document.getElementById('form-card').hidden = true;
    document.getElementById('done').hidden = false;
  } catch (error) {
    validationNode.textContent = error.message;
    button.disabled = false;
    button.textContent = 'Submit affordability inputs';
  }
}

function populateCreditTiers(select) {
  select.innerHTML = CREDIT_TIERS
    .map(([key, label]) => `<option value="${key}">${label}</option>`)
    .join('');
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
  const form = document.getElementById('afford-form');
  populateCreditTiers(form.elements.credit_tier);

  try {
    const response = await fetch('/api/profile');
    const body = await response.json();
    state.profile = body.profile ?? {};
    const hasSavedAnswers = !!body.savedAnswers?.answers;
    if (hasSavedAnswers) {
      state.answers = { ...state.answers, ...body.savedAnswers.answers };
    }
    seedFromProfile(state.profile, { useProfileTerm: !hasSavedAnswers });
  } catch (error) {
    console.warn('Unable to load current profile, starting from defaults.', error);
  }

  Object.entries(state.answers).forEach(([key, value]) => setFieldValue(form, key, value));
  updateLiveEstimate(form);

  form.addEventListener('input', () => {
    updateLiveEstimate(form);
    saveAnswersDebounced(form);
  });
  form.addEventListener('change', () => {
    updateLiveEstimate(form);
    saveAnswersDebounced(form);
  });
  form.addEventListener('submit', submit);

  await loadRates();
  updateLiveEstimate(form);
}

bootstrap();
