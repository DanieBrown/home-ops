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

const DEFAULT_ANSWERS = {
  target_state: '',
  target_area: '',
  loan_term_years: '30',
  monthly_take_home: '',
  monthly_debt: '0',
  cash_available: '',
  down_payment_pct: '20',
  credit_tier: 'unknown',
  housing_payment_pct: '25',
  hoa_monthly: '0',
  price_floor_mode: 'current_profile',
  price_floor_custom: '',
  property_tax_pct: '1',
  insurance_pct: '0.35',
  closing_cost_pct_min: '2',
  closing_cost_pct_max: '5',
  include_comparison: true,
};

const steps = [
  { key: 'target', label: 'Target', title: 'Target state and area', hint: 'Home-Ops will prefill this from the profile when it can.' },
  { key: 'term', label: 'Term', title: 'Preferred fixed loan term', hint: 'Choose the fixed-rate term the main estimate should use.' },
  { key: 'takehome', label: 'Take-home', title: 'Actual monthly household take-home pay', hint: 'Use the amount that lands in the household after taxes and normal payroll deductions.' },
  { key: 'debt', label: 'Debt', title: 'Monthly non-mortgage debt payments', hint: 'Include car payments, student loans, credit cards, personal loans, and other required monthly debt.' },
  { key: 'cash', label: 'Cash', title: 'Cash you can comfortably use for the home purchase', hint: 'Include money for down payment and closing costs. Do not include emergency savings or money you want to keep untouched.' },
  { key: 'down', label: 'Down', title: 'Target down-payment percentage', hint: 'Lower down payments may keep more cash available, but can add mortgage insurance.' },
  { key: 'credit', label: 'Credit', title: 'Rough credit-score band', hint: 'A broad band is enough. The result stores the pricing assumption, not your exact score.' },
  { key: 'cap', label: 'Cap', title: 'Housing-payment cap as percent of take-home', hint: 'Home-Ops applies this to take-home pay after subtracting monthly debt.' },
  { key: 'hoa', label: 'HOA', title: 'HOA monthly budget or estimate', hint: 'Use a comfortable monthly HOA number, or 0 if you want the search to assume none.' },
  { key: 'floor', label: 'Floor', title: 'Minimum search floor preference', hint: 'Choose how Home-Ops should set the lower end of the profile search range.' },
];

const state = {
  step: 0,
  profile: {},
  answers: { ...DEFAULT_ANSWERS },
  estimate: null,
  estimateError: '',
  estimating: false,
  saveTimer: null,
  estimateTimer: null,
};

const el = {
  tile: document.querySelector('#tile'),
  stepLabel: document.querySelector('#step-label'),
  stepTotal: document.querySelector('#step-total'),
  progressFill: document.querySelector('#progress-fill'),
  breadcrumbs: document.querySelector('#breadcrumbs'),
  back: document.querySelector('#back-btn'),
  next: document.querySelector('#next-btn'),
  submit: document.querySelector('#submit-btn'),
  done: document.querySelector('#done'),
};

function money(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '$0';
  return `$${Math.round(numeric).toLocaleString('en-US')}`;
}

function numberValue(key) {
  const value = Number(state.answers[key]);
  return Number.isFinite(value) ? value : 0;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function firstProfileState(profile) {
  return profile?.search?.areas?.[0]?.state ?? '';
}

function firstProfileArea(profile) {
  const areas = profile?.search?.areas;
  return Array.isArray(areas) ? areas.map((area) => area.name).filter(Boolean).join(', ') : '';
}

function hydrateFromProfile(profile, savedAnswers) {
  const hard = profile?.search?.hard_requirements ?? {};
  const financial = profile?.financial ?? {};
  const soft = profile?.search?.soft_preferences ?? {};
  state.answers = {
    ...DEFAULT_ANSWERS,
    target_state: firstProfileState(profile),
    target_area: firstProfileArea(profile),
    loan_term_years: String(financial.loan_term_years ?? DEFAULT_ANSWERS.loan_term_years),
    down_payment_pct: String(financial.down_payment_pct ?? DEFAULT_ANSWERS.down_payment_pct),
    housing_payment_pct: String(financial.housing_payment_pct ?? DEFAULT_ANSWERS.housing_payment_pct),
    hoa_monthly: String(soft.hoa_max_monthly ?? DEFAULT_ANSWERS.hoa_monthly),
    property_tax_pct: String(financial.property_tax_pct ?? DEFAULT_ANSWERS.property_tax_pct),
    insurance_pct: String(financial.insurance_pct ?? DEFAULT_ANSWERS.insurance_pct),
    closing_cost_pct_min: String(financial.closing_cost_pct_min ?? DEFAULT_ANSWERS.closing_cost_pct_min),
    closing_cost_pct_max: String(financial.closing_cost_pct_max ?? DEFAULT_ANSWERS.closing_cost_pct_max),
    current_price_min: hard.price_min ?? '',
    ...(savedAnswers?.answers ?? {}),
  };
}

function input(name, attrs = {}) {
  const value = state.answers[name] ?? '';
  const attrText = Object.entries(attrs)
    .map(([key, attrValue]) => `${key}="${escapeHtml(attrValue)}"`)
    .join(' ');
  return `<input class="${attrs.type === 'text' ? 'text-input' : 'number-input'}" name="${name}" value="${escapeHtml(value)}" ${attrText} />`;
}

function optionGrid(name, options) {
  return `<div class="options">${options.map((option) => {
    const checked = String(state.answers[name]) === String(option.value);
    return `
      <label class="option${checked ? ' checked' : ''}">
        <input type="radio" name="${name}" value="${escapeHtml(option.value)}" ${checked ? 'checked' : ''} />
        <span class="label">${escapeHtml(option.label)}${option.detail ? `<span class="sublabel">${escapeHtml(option.detail)}</span>` : ''}</span>
      </label>`;
  }).join('')}</div>`;
}

function resultPreview() {
  if (state.estimating) {
    return '<section class="agent-note">Updating the affordability estimate...</section>';
  }
  if (state.estimateError) {
    return `<section class="validation">${escapeHtml(state.estimateError)}</section>`;
  }
  const result = state.estimate?.result;
  if (!result) {
    return '<section class="agent-note">Finish the required answers to preview the range.</section>';
  }
  const selected = result.selected;
  return `
    <section class="results-panel">
      <div>
        <p class="eyebrow">Profile range preview</p>
        <h3>${money(result.recommended_price_min)} to ${money(result.recommended_price_max)}</h3>
        <p>${selected.term_years}-year fixed, ${selected.assumptions.housingPaymentPct}% debt-adjusted payment cap.</p>
      </div>
      <div class="result-grid">
        <div><span>Monthly cap</span><strong>${money(selected.monthly_payment_cap)}</strong></div>
        <div><span>Payment at max</span><strong>${money(selected.payment_at_recommended.total)}</strong></div>
        <div><span>Cash needed high</span><strong>${money(selected.upfront_cash_at_recommended.total_high)}</strong></div>
        <div><span>Constraint</span><strong>${selected.constraint === 'cash_available' ? 'Cash' : 'Payment'}</strong></div>
      </div>
    </section>`;
}

function renderStepBody(step) {
  switch (step.key) {
    case 'target':
      return `
        <div class="identity-grid">
          <label><span>State</span>${input('target_state', { type: 'text', required: true, placeholder: 'NC' })}</label>
          <label><span>Area</span>${input('target_area', { type: 'text', required: true, placeholder: 'Apex, Cary, Holly Springs' })}</label>
        </div>`;
    case 'term':
      return optionGrid('loan_term_years', [
        { value: '30', label: '30-year fixed', detail: 'Lower monthly payment, higher total interest.' },
        { value: '15', label: '15-year fixed', detail: 'Higher monthly payment, faster payoff.' },
      ]);
    case 'takehome':
      return `<label class="conversation-field compact"><span>Monthly take-home pay</span>${input('monthly_take_home', { type: 'number', min: 1, step: 100, placeholder: '11000', required: true })}</label>`;
    case 'debt':
      return `<label class="conversation-field compact"><span>Monthly non-mortgage debt</span>${input('monthly_debt', { type: 'number', min: 0, step: 25, placeholder: '0', required: true })}</label>`;
    case 'cash':
      return `<label class="conversation-field compact"><span>Cash for purchase</span>${input('cash_available', { type: 'number', min: 1, step: 1000, placeholder: '150000', required: true })}</label>`;
    case 'down':
      return `
        ${optionGrid('down_payment_pct', [
          { value: '3', label: '3%', detail: 'Keeps cash lower, likely uses mortgage insurance.' },
          { value: '5', label: '5%', detail: 'Common low-down conventional target.' },
          { value: '10', label: '10%', detail: 'Middle ground between cash and payment.' },
          { value: '20', label: '20%', detail: 'Avoids mortgage insurance in this model.' },
        ])}
        <label class="conversation-field compact"><span>Custom percentage</span>${input('down_payment_pct', { type: 'number', min: 0, max: 100, step: 0.5 })}</label>`;
    case 'credit':
      return `<label class="conversation-field compact"><span>Credit band</span><select name="credit_tier" class="text-input">${CREDIT_TIERS.map(([key, label]) => `<option value="${key}" ${state.answers.credit_tier === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
    case 'cap':
      return `
        <div class="slider-wrap">
          <div class="slider-row">
            <label for="housing-payment-pct">Housing-payment cap</label>
            <input id="housing-payment-pct" name="housing_payment_pct" type="range" min="20" max="45" step="1" value="${escapeHtml(state.answers.housing_payment_pct)}" />
            <span class="value">${escapeHtml(state.answers.housing_payment_pct)}%</span>
          </div>
          <div class="slider-scale"><span>More room left over</span><span>Middle</span><span>Less room left over</span></div>
        </div>`;
    case 'hoa':
      return `<label class="conversation-field compact"><span>Monthly HOA budget</span>${input('hoa_monthly', { type: 'number', min: 0, step: 25, placeholder: '0', required: true })}</label>`;
    case 'floor':
      return `
        ${optionGrid('price_floor_mode', [
          { value: 'current_profile', label: 'Keep current profile min', detail: 'Use the saved profile minimum when it fits under the new max.' },
          { value: 'auto_85', label: 'Auto 85% of max', detail: 'Set a broad lower bound from the new ceiling.' },
          { value: 'custom', label: 'Custom amount', detail: 'Use the amount below as the search floor.' },
          { value: 'none', label: 'No floor', detail: 'Let Home-Ops search from zero upward.' },
        ])}
        <label class="conversation-field compact"><span>Custom floor amount</span>${input('price_floor_custom', { type: 'number', min: 0, step: 5000, placeholder: '450000' })}</label>
        ${resultPreview()}`;
    default:
      return '';
  }
}

function render() {
  const step = steps[state.step];
  el.stepLabel.textContent = `Step ${state.step + 1}`;
  el.stepTotal.textContent = `${state.step + 1} of ${steps.length}`;
  el.progressFill.style.width = `${((state.step + 1) / steps.length) * 100}%`;

  el.breadcrumbs.innerHTML = steps.map((item, index) => {
    const classes = ['crumb'];
    if (index === state.step) classes.push('current');
    if (index <= state.step) classes.push('reachable');
    return `<button type="button" class="${classes.join(' ')}" data-step="${index}" ${index > state.step ? 'disabled' : ''}><span class="crumb-num">${index + 1}</span><span class="crumb-label">${escapeHtml(item.label)}</span></button>`;
  }).join('');

  el.tile.innerHTML = `
    <h2>${escapeHtml(step.title)}</h2>
    <p class="tile-hint">${escapeHtml(step.hint)}</p>
    ${renderStepBody(step)}
    <p id="validation" class="validation" aria-live="polite"></p>`;
  el.tile.classList.remove('step-enter');
  void el.tile.offsetWidth;
  el.tile.classList.add('step-enter');

  el.back.disabled = state.step === 0;
  el.next.hidden = state.step === steps.length - 1;
  el.submit.hidden = state.step !== steps.length - 1;
  bindTileEvents();
}

function bindTileEvents() {
  el.tile.querySelectorAll('input, select').forEach((field) => {
    field.addEventListener('input', () => {
      const type = field.getAttribute('type');
      if (type === 'radio' && !field.checked) return;
      state.answers[field.name] = type === 'checkbox' ? field.checked : field.value;
      scheduleSave();
      scheduleEstimate();
      if (type === 'range') {
        const value = field.closest('.slider-row')?.querySelector('.value');
        if (value) value.textContent = `${field.value}%`;
      }
    });
    field.addEventListener('change', () => {
      const type = field.getAttribute('type');
      if (type === 'radio' && !field.checked) return;
      state.answers[field.name] = type === 'checkbox' ? field.checked : field.value;
      scheduleSave();
      scheduleEstimate();
      render();
    });
  });
}

function validateStep() {
  const step = steps[state.step];
  const errors = [];
  if (step.key === 'target') {
    if (!state.answers.target_state.trim()) errors.push('Enter a target state.');
    if (!state.answers.target_area.trim()) errors.push('Enter a target area.');
  }
  if (step.key === 'takehome' && numberValue('monthly_take_home') <= 0) errors.push('Enter monthly take-home pay.');
  if (step.key === 'cash' && numberValue('cash_available') <= 0) errors.push('Enter cash available for the purchase.');
  if (step.key === 'down' && (numberValue('down_payment_pct') < 0 || numberValue('down_payment_pct') >= 100)) errors.push('Enter a down-payment percentage below 100.');
  if (step.key === 'cap' && numberValue('housing_payment_pct') <= 0) errors.push('Choose a housing-payment cap.');
  if (step.key === 'floor' && state.answers.price_floor_mode === 'custom' && numberValue('price_floor_custom') <= 0) errors.push('Enter a custom floor amount.');

  const validation = el.tile.querySelector('#validation');
  if (validation) validation.textContent = errors[0] ?? '';
  return errors.length === 0;
}

function canEstimate() {
  return numberValue('monthly_take_home') > 0
    && numberValue('cash_available') > 0
    && numberValue('down_payment_pct') >= 0
    && numberValue('down_payment_pct') < 100;
}

async function estimateNow() {
  if (!canEstimate()) return;
  state.estimating = true;
  state.estimateError = '';
  try {
    const response = await fetch('/api/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: state.answers }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || 'Estimate failed.');
    state.estimate = payload;
  } catch (error) {
    state.estimateError = error.message;
  } finally {
    state.estimating = false;
    if (state.step === steps.length - 1) render();
  }
}

function scheduleEstimate() {
  clearTimeout(state.estimateTimer);
  state.estimateTimer = setTimeout(() => { estimateNow(); }, 300);
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    try {
      await fetch('/api/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: state.answers }),
      });
    } catch {
      // Autosave failures should not block the consult.
    }
  }, 250);
}

async function submit() {
  if (!validateStep()) return;
  await estimateNow();
  const response = await fetch('/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers: state.answers }),
  });
  const payload = await response.json();
  if (!payload.ok) {
    const validation = el.tile.querySelector('#validation');
    if (validation) validation.textContent = payload.error || 'Submission failed.';
    return;
  }
  el.tile.hidden = true;
  document.querySelector('.nav').hidden = true;
  el.done.hidden = false;
}

el.back.addEventListener('click', () => {
  if (state.step > 0) {
    state.step -= 1;
    render();
  }
});

el.next.addEventListener('click', () => {
  if (!validateStep()) return;
  if (state.step < steps.length - 1) {
    state.step += 1;
    render();
    scheduleEstimate();
  }
});

el.submit.addEventListener('click', submit);
el.breadcrumbs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-step]');
  if (!button || button.disabled) return;
  const nextStep = Number(button.dataset.step);
  if (Number.isFinite(nextStep) && nextStep <= state.step) {
    state.step = nextStep;
    render();
  }
});

async function init() {
  const response = await fetch('/api/profile');
  const payload = await response.json();
  state.profile = payload.profile ?? {};
  hydrateFromProfile(state.profile, payload.savedAnswers);
  render();
  scheduleEstimate();
}

init().catch((error) => {
  el.tile.innerHTML = `<p class="validation">${escapeHtml(error.message)}</p>`;
});
