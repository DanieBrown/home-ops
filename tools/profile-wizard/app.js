/* Home-Ops Profile Wizard client
 *
 * Renders a progress-based questionnaire that mirrors the filter fields used
 * by Zillow, Redfin, Realtor.com, and Homes.com, plus sentiment and school
 * weight sliders. On submit, POSTs the full answer payload to /api/submit.
 */

const state = {
  profile: {},
  answers: {},
  stepIndex: 0,
};

const STEPS = [
  {
    id: 'areas',
    title: 'Which cities or towns should we search?',
    hint: 'Multi-select. Leave checked items as-is to keep them. Add any custom city below.',
    render: () => renderMultiSelect({
      field: 'areas',
      currentValues: (state.profile?.search?.areas ?? []).map((a) => a.name).filter(Boolean),
      suggestions: ['Holly Springs', 'Apex', 'Cary', 'Fuquay-Varina', 'Morrisville', 'Wake Forest', 'Willow Springs', 'Durham', 'Raleigh', 'Clayton', 'Garner'],
      allowCustom: true,
    }),
    read: () => ({ areas: state.answers.areas ?? [] }),
  },
  {
    id: 'price',
    title: 'What price range fits your plan?',
    hint: 'Typed in dollars. Leave current values to keep them.',
    render: () => renderRangeInputs({
      field: 'price',
      minLabel: 'Price minimum ($)',
      maxLabel: 'Price maximum ($)',
      currentMin: state.profile?.search?.hard_requirements?.price_min,
      currentMax: state.profile?.search?.hard_requirements?.price_max,
      step: 10000,
    }),
    read: () => ({ price: state.answers.price ?? {} }),
  },
  {
    id: 'beds-baths',
    title: 'Minimum bedrooms and bathrooms?',
    hint: 'Pick your floor. Portal filters will be seeded from these values.',
    render: () => renderMultipleSingleChoice({
      questions: [
        {
          field: 'beds_min',
          label: 'Bedrooms minimum',
          options: ['2+', '3+', '4+', '5+', '6+'],
          current: state.profile?.search?.hard_requirements?.beds_min,
          currentSuffix: '+',
        },
        {
          field: 'baths_min',
          label: 'Bathrooms minimum',
          options: ['1+', '1.5+', '2+', '2.5+', '3+'],
          current: state.profile?.search?.hard_requirements?.baths_min,
          currentSuffix: '+',
        },
      ],
    }),
    read: () => ({ beds_min: state.answers.beds_min, baths_min: state.answers.baths_min }),
  },
  {
    id: 'size',
    title: 'House and lot size',
    hint: 'What floor keeps a listing in contention for your family?',
    render: () => renderMultipleSingleChoice({
      questions: [
        {
          field: 'sqft_min',
          label: 'Minimum square footage',
          options: ['1500+', '1800+', '2200+', '2700+', '3200+'],
          current: state.profile?.search?.hard_requirements?.sqft_min,
          currentSuffix: '+',
        },
        {
          field: 'garage_min',
          label: 'Garage spaces minimum',
          options: ['0', '1+', '2+', '3+', '4+'],
          current: state.profile?.search?.hard_requirements?.garage_min,
          currentSuffix: '+',
        },
        {
          field: 'lot_min',
          label: 'Lot size minimum (acres)',
          options: ['No minimum', '0.15+', '0.25+', '0.5+', '1+'],
          current: state.profile?.search?.hard_requirements?.lot_min_acres,
        },
      ],
    }),
    read: () => ({
      sqft_min: state.answers.sqft_min,
      garage_min: state.answers.garage_min,
      lot_min: state.answers.lot_min,
    }),
  },
  {
    id: 'home-type',
    title: 'Home type and age',
    hint: 'Used on every portal filter. Pick what applies.',
    render: () => renderMultipleSingleChoice({
      questions: [
        {
          field: 'home_type_preference',
          label: 'Home type preference',
          options: ['Resale preferred', 'Resale only', 'New construction ok', 'New construction preferred', 'No preference'],
          current: state.profile?.search?.hard_requirements?.home_type_preference,
        },
        {
          field: 'year_built_min',
          label: 'Year built minimum',
          options: ['No preference', '1990+', '2000+', '2010+', '2020+'],
          current: state.profile?.search?.soft_preferences?.year_built_min,
          currentSuffix: '+',
        },
        {
          field: 'stories_preferred',
          label: 'Stories preferred',
          options: ['No preference', '1 story', '2 stories', '3+ stories'],
          current: state.profile?.search?.soft_preferences?.stories_preferred,
        },
      ],
      propertyTypesField: {
        field: 'property_types',
        label: 'Which property types should stay in the results?',
        options: ['Single-family detached', 'Townhome', 'Condo', 'Multi-family', 'Land'],
        current: state.profile?.search?.soft_preferences?.property_types,
      },
    }),
    read: () => ({
      home_type_preference: state.answers.home_type_preference,
      year_built_min: state.answers.year_built_min,
      stories_preferred: state.answers.stories_preferred,
      property_types: state.answers.property_types ?? [],
    }),
  },
  {
    id: 'financial',
    title: 'Financial posture',
    hint: 'HOA cap, down payment, and closing-cost expectation. These numbers feed the mortgage estimate on each listing report.',
    render: () => renderMultipleSingleChoice({
      questions: [
        {
          field: 'hoa_max',
          label: 'HOA max monthly',
          options: ['No cap', '$100/mo', '$200/mo', '$300/mo', '$500/mo'],
          current: state.profile?.search?.soft_preferences?.hoa_max_monthly,
          currentPrefix: '$', currentSuffix: '/mo',
        },
        {
          field: 'down_payment_pct',
          label: 'Down payment percent',
          options: ['10%', '15%', '20%', '25%+'],
          current: state.profile?.financial?.down_payment_pct,
          currentSuffix: '%',
        },
        {
          field: 'closing_pct',
          label: 'Closing costs expectation',
          options: ['1-2%', '2-3%', '3-4%', '4%+'],
          current: formatClosingPct(state.profile?.financial),
        },
      ],
    }),
    read: () => ({
      hoa_max: state.answers.hoa_max,
      down_payment_pct: state.answers.down_payment_pct,
      closing_pct: state.answers.closing_pct,
    }),
  },
  {
    id: 'schools',
    title: 'Schools and listing freshness',
    hint: 'Used for the hard-requirement gate and scan freshness.',
    render: () => renderMultipleSingleChoice({
      questions: [
        {
          field: 'schools_min_rating',
          label: 'School rating minimum (GreatSchools 0-10)',
          options: ['5+', '6+', '7+', '8+', '9+'],
          current: state.profile?.search?.hard_requirements?.schools_min_rating,
          currentSuffix: '+',
        },
        {
          field: 'max_listing_age',
          label: 'Maximum days on market',
          options: ['3 days', '7 days', '14 days', '30 days', '60 days'],
          current: state.profile?.search?.hard_requirements?.max_listing_age_days,
          currentSuffix: ' days',
        },
      ],
    }),
    read: () => ({
      schools_min_rating: state.answers.schools_min_rating,
      max_listing_age: state.answers.max_listing_age,
    }),
  },
  {
    id: 'commute',
    title: 'Commute destinations',
    hint: 'Pick each place someone in the household commutes to. Add custom destinations below.',
    render: () => renderMultiSelect({
      field: 'commute',
      currentValues: (state.profile?.commute?.destinations ?? []).map((d) => d.name).filter(Boolean),
      suggestions: ['Downtown Raleigh', 'Research Triangle Park', 'Cary office parks', 'Durham', 'Chapel Hill', 'Apex', 'Remote / work-from-home'],
      allowCustom: true,
    }),
    read: () => ({ commute: state.answers.commute ?? [] }),
  },
  {
    id: 'research-sources',
    title: 'Which sources should power your research?',
    hint: 'Pick the listing portals and background-research sites Home-Ops should use. Each affects one stage of the pipeline -- see the short note under each group.',
    render: renderResearchSources,
    read: () => ({ research_sources: state.answers.research_sources ?? {} }),
  },
  {
    id: 'sentiment-weights',
    title: 'Neighborhood weight preferences',
    hint: 'Slide each factor to show how strongly it matters. 0 = not important, 100 = critical.',
    render: () => renderSliders({
      field: 'sentiment_weights',
      factors: [
        { key: 'crime_safety', label: 'Crime and personal safety' },
        { key: 'traffic_commute', label: 'Traffic and daily commute friction' },
        { key: 'community', label: 'Neighbor quality and community feel' },
        { key: 'school_quality', label: 'School reputation in the area' },
        { key: 'livability', label: 'Parks, groceries, everyday livability' },
      ],
      currentValues: normalizedToScale(state.profile?.sentiment?.weights),
    }),
    read: () => ({ sentiment_weights: state.answers.sentiment_weights ?? {} }),
  },
  {
    id: 'school-weights',
    title: 'School weight preferences',
    hint: 'Same 0-100 scale for each school-quality dimension.',
    render: () => renderSliders({
      field: 'school_weights',
      factors: [
        { key: 'academic_performance', label: 'Academic performance' },
        { key: 'parent_community_sentiment', label: 'Parent and community trust' },
        { key: 'teacher_staff_quality', label: 'Teacher and staff quality' },
        { key: 'safety_environment', label: 'School safety and student environment' },
        { key: 'extracurriculars_resources', label: 'Extracurriculars and resources' },
      ],
      currentValues: normalizedToScale(state.profile?.school_sentiment?.weights),
    }),
    read: () => ({ school_weights: state.answers.school_weights ?? {} }),
  },
  {
    id: 'narrative',
    title: 'Describe the house you want in your own words',
    hint: 'Write freely. Mention features you want, things you\'d avoid, family context, and how aggressive to be. The chips below insert common phrases -- Home-Ops maps them into search filters and listing keywords automatically.',
    render: renderNarrative,
    read: readNarrative,
  },
  {
    id: 'review',
    title: 'Review and submit',
    hint: 'Scan the summary. If anything is wrong, go back and adjust. Submit writes to .home-ops/profile-wizard-submission.json.',
    render: renderReview,
    read: () => ({}),
    isReview: true,
  },
];

function collectCurrentFeatures() {
  const soft = state.profile?.search?.soft_preferences ?? {};
  const collected = [];
  if (soft.fenced_yard) collected.push('Fenced yard');
  if (soft.updated_kitchen) collected.push('Updated kitchen');
  if (soft.floor_plan && soft.floor_plan.toString().toLowerCase().includes('open')) collected.push('Open-concept plan');
  if (Array.isArray(soft.flooring) && soft.flooring.length) collected.push('Hardwood or LVP floors');
  if (soft.street_type && soft.street_type.toString().toLowerCase().includes('cul-de-sac')) {
    collected.push('Cul-de-sac or low-traffic street');
  }
  if (Array.isArray(soft.features)) collected.push(...soft.features);
  return Array.from(new Set(collected));
}

function formatClosingPct(financial) {
  if (!financial) return null;
  const min = financial.closing_cost_pct_min;
  const max = financial.closing_cost_pct_max;
  if (!Number.isFinite(min) && !Number.isFinite(max)) return null;
  return `${min}-${max}%`;
}

function normalizedToScale(weights) {
  if (!weights) return {};
  const scaled = {};
  for (const [key, value] of Object.entries(weights)) {
    if (Number.isFinite(value)) scaled[key] = Math.round(value * 100);
  }
  return scaled;
}

function findAnswerFromCurrent(options, current, prefix = '', suffix = '') {
  if (current === null || current === undefined) return null;
  const formatted = `${prefix}${current}${suffix}`.toLowerCase();
  return options.find((opt) => opt.toLowerCase() === formatted) ?? null;
}

function renderMultiSelect({ field, currentValues, suggestions, allowCustom }) {
  const selected = new Set((state.answers[field] ?? currentValues ?? []).map(String));
  const customAdditions = state.answers[`${field}__custom`] ?? [];

  const combined = [
    ...currentValues.map((value) => ({ value, preChecked: true })),
    ...suggestions.filter((value) => !currentValues.includes(value)).map((value) => ({ value, preChecked: false })),
    ...customAdditions.map((value) => ({ value, preChecked: true, custom: true })),
  ];

  const target = document.getElementById('tile');
  target.innerHTML = `
    <h2>${escapeHtml(CURRENT_STEP.title)}</h2>
    <p class="tile-hint">${escapeHtml(CURRENT_STEP.hint ?? '')}</p>
    <div class="options">
      ${combined.map(({ value, custom }) => `
        <label class="option ${selected.has(value) ? 'checked' : ''}" data-value="${escapeAttr(value)}">
          <input type="checkbox" ${selected.has(value) ? 'checked' : ''} />
          <span class="label">${escapeHtml(value)}${custom ? ' <span class="sublabel">custom</span>' : ''}</span>
        </label>
      `).join('')}
    </div>
    ${allowCustom ? `
      <div class="custom-row">
        <input type="text" id="custom-input" placeholder="Add a custom entry..." />
        <button type="button" class="primary" id="custom-add">Add</button>
      </div>
      <div class="validation" id="validation"></div>
    ` : ''}
  `;

  target.querySelectorAll('.option').forEach((node) => {
    node.addEventListener('click', (event) => {
      const checkbox = node.querySelector('input');
      if (event.target !== checkbox) checkbox.checked = !checkbox.checked;
      node.classList.toggle('checked', checkbox.checked);
      const current = new Set(readCheckedOptions());
      state.answers[field] = Array.from(current);
    });
  });

  if (allowCustom) {
    const input = document.getElementById('custom-input');
    const addBtn = document.getElementById('custom-add');
    const onAdd = () => {
      const value = (input.value ?? '').trim();
      if (!value) return;
      const additions = state.answers[`${field}__custom`] ?? [];
      if (!additions.includes(value)) additions.push(value);
      state.answers[`${field}__custom`] = additions;
      const current = new Set(state.answers[field] ?? currentValues ?? []);
      current.add(value);
      state.answers[field] = Array.from(current);
      input.value = '';
      renderStep();
    };
    addBtn.addEventListener('click', onAdd);
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); onAdd(); } });
  }

  if (!state.answers[field]) {
    state.answers[field] = currentValues.slice();
  }
}

function readCheckedOptions() {
  return Array.from(document.querySelectorAll('.option')).filter((node) => node.querySelector('input').checked).map((node) => node.dataset.value);
}

function renderRangeInputs({ field, minLabel, maxLabel, currentMin, currentMax, step }) {
  const current = state.answers[field] ?? {};
  const resolvedMin = current.min ?? currentMin ?? '';
  const resolvedMax = current.max ?? currentMax ?? '';
  const target = document.getElementById('tile');
  target.innerHTML = `
    <h2>${escapeHtml(CURRENT_STEP.title)}</h2>
    <p class="tile-hint">${escapeHtml(CURRENT_STEP.hint ?? '')}</p>
    <div class="range-grid">
      <label>${escapeHtml(minLabel)}
        <input class="number-input" type="number" id="range-min" step="${step}" value="${escapeAttr(resolvedMin)}" />
      </label>
      <label>${escapeHtml(maxLabel)}
        <input class="number-input" type="number" id="range-max" step="${step}" value="${escapeAttr(resolvedMax)}" />
      </label>
    </div>
    <div class="validation" id="validation"></div>
  `;

  const save = () => {
    state.answers[field] = {
      min: parseNumberOrNull(document.getElementById('range-min').value),
      max: parseNumberOrNull(document.getElementById('range-max').value),
    };
  };
  document.getElementById('range-min').addEventListener('input', save);
  document.getElementById('range-max').addEventListener('input', save);
}

function parseNumberOrNull(value) {
  const num = Number.parseFloat(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

function renderMultipleSingleChoice({ questions, propertyTypesField }) {
  const target = document.getElementById('tile');
  const blocks = questions.map((question) => renderSingleChoiceBlock(question)).join('');
  const propertyBlock = propertyTypesField ? renderMultiSelectBlock(propertyTypesField) : '';
  target.innerHTML = `
    <h2>${escapeHtml(CURRENT_STEP.title)}</h2>
    <p class="tile-hint">${escapeHtml(CURRENT_STEP.hint ?? '')}</p>
    ${blocks}
    ${propertyBlock}
    <div class="validation" id="validation"></div>
  `;
  questions.forEach((question) => wireSingleChoiceBlock(question));
  if (propertyTypesField) wireMultiSelectBlock(propertyTypesField);
}

function renderSingleChoiceBlock({ field, label, options, current, currentPrefix = '', currentSuffix = '' }) {
  const currentFormatted = current === null || current === undefined ? null : `${currentPrefix}${current}${currentSuffix}`;
  const matched = findAnswerFromCurrent(options, current, currentPrefix, currentSuffix);
  const selected = state.answers[field] ?? matched ?? currentFormatted;
  const optionList = [...options];
  if (currentFormatted && !optionList.some((opt) => opt.toLowerCase() === currentFormatted.toLowerCase())) {
    optionList.push(`Keep current (${currentFormatted})`);
  }
  optionList.push('Custom');
  return `
    <div class="sub-question" data-sc-field="${escapeAttr(field)}">
      <h3 class="tile-subtitle">${escapeHtml(label)}</h3>
      <div class="options">
        ${optionList.map((opt) => `
          <label class="option ${selected === opt ? 'checked' : ''}" data-value="${escapeAttr(opt)}">
            <input type="radio" name="sc-${escapeAttr(field)}" ${selected === opt ? 'checked' : ''} />
            <span class="label">${escapeHtml(opt)}</span>
          </label>
        `).join('')}
      </div>
      <div class="custom-row" data-sc-custom="${escapeAttr(field)}" ${selected && selected.toLowerCase().startsWith('custom:') ? '' : 'hidden'}>
        <input type="text" placeholder="Custom value..." value="${escapeAttr(selected && selected.toLowerCase().startsWith('custom:') ? selected.slice(7).trim() : '')}" />
      </div>
    </div>
  `;
}

function wireSingleChoiceBlock({ field }) {
  const scope = document.querySelector(`[data-sc-field="${CSS.escape(field)}"]`);
  if (!scope) return;
  scope.querySelectorAll('.option').forEach((node) => {
    node.addEventListener('click', () => {
      scope.querySelectorAll('.option').forEach((opt) => opt.classList.remove('checked'));
      node.classList.add('checked');
      node.querySelector('input').checked = true;
      const value = node.dataset.value;
      const customRow = scope.querySelector(`[data-sc-custom="${CSS.escape(field)}"]`);
      if (value === 'Custom') {
        customRow.hidden = false;
        const input = customRow.querySelector('input');
        setTimeout(() => input.focus(), 40);
        input.addEventListener('input', () => {
          state.answers[field] = input.value.trim() ? `Custom: ${input.value.trim()}` : 'Custom';
        });
      } else {
        customRow.hidden = true;
        state.answers[field] = value;
      }
    });
  });
}

function renderMultiSelectBlock({ field, label, options, current }) {
  const selected = new Set((state.answers[field] ?? current ?? []).map(String));
  return `
    <div class="sub-question" data-ms-field="${escapeAttr(field)}">
      <h3 class="tile-subtitle">${escapeHtml(label)}</h3>
      <div class="options">
        ${options.map((opt) => `
          <label class="option ${selected.has(opt) ? 'checked' : ''}" data-value="${escapeAttr(opt)}">
            <input type="checkbox" ${selected.has(opt) ? 'checked' : ''} />
            <span class="label">${escapeHtml(opt)}</span>
          </label>
        `).join('')}
      </div>
    </div>
  `;
}

function wireMultiSelectBlock({ field }) {
  const scope = document.querySelector(`[data-ms-field="${CSS.escape(field)}"]`);
  if (!scope) return;
  const save = () => {
    const values = Array.from(scope.querySelectorAll('.option')).filter((node) => node.querySelector('input').checked).map((node) => node.dataset.value);
    state.answers[field] = values;
  };
  scope.querySelectorAll('.option').forEach((node) => {
    node.addEventListener('click', (event) => {
      const checkbox = node.querySelector('input');
      if (event.target !== checkbox) checkbox.checked = !checkbox.checked;
      node.classList.toggle('checked', checkbox.checked);
      save();
    });
  });
  if (!state.answers[field]) save();
}

function renderSliders({ field, factors, currentValues }) {
  state.answers[field] = state.answers[field] ?? { ...currentValues };
  const target = document.getElementById('tile');
  const rows = factors.map((factor) => {
    const value = state.answers[field][factor.key] ?? currentValues[factor.key] ?? 50;
    return `
      <div class="slider-row" data-slider-key="${escapeAttr(factor.key)}">
        <label>${escapeHtml(factor.label)}</label>
        <input type="range" min="0" max="100" step="5" value="${value}" />
        <span class="value">${value}</span>
      </div>
    `;
  }).join('');
  target.innerHTML = `
    <h2>${escapeHtml(CURRENT_STEP.title)}</h2>
    <p class="tile-hint">${escapeHtml(CURRENT_STEP.hint ?? '')}</p>
    <div class="slider-wrap">${rows}</div>
  `;
  target.querySelectorAll('.slider-row').forEach((row) => {
    const key = row.dataset.sliderKey;
    const slider = row.querySelector('input[type="range"]');
    const valueLabel = row.querySelector('.value');
    slider.addEventListener('input', () => {
      valueLabel.textContent = slider.value;
      state.answers[field][key] = Number.parseInt(slider.value, 10);
    });
  });
}

const RESEARCH_SOURCE_GROUPS = [
  {
    key: 'portals',
    title: 'Listing portals',
    note: 'Drives /home-ops scan. Unchecked portals are skipped when Home-Ops looks for new listings.',
    sources: [
      { key: 'zillow', label: 'Zillow', defaultOn: true },
      { key: 'redfin', label: 'Redfin', defaultOn: true },
      { key: 'realtor', label: 'Realtor.com', defaultOn: true },
      { key: 'homes', label: 'Homes.com', defaultOn: false },
    ],
  },
  {
    key: 'sentiment',
    title: 'Neighborhood sentiment',
    note: 'Drives /home-ops deep and the sentiment extract. Used to pull community sentiment about subdivisions, schools, and streets.',
    sources: [
      { key: 'reddit', label: 'Reddit (local subreddits)', defaultOn: true },
      { key: 'nextdoor', label: 'Nextdoor', defaultOn: true },
      { key: 'facebook', label: 'Facebook neighborhood groups', defaultOn: true },
      { key: 'google_maps', label: 'Google Maps reviews', defaultOn: true },
    ],
  },
  {
    key: 'schools',
    title: 'Schools',
    note: 'Drives school sentiment and the hard-requirement gate. Picking more sources improves the school evidence coverage score.',
    sources: [
      { key: 'greatschools', label: 'GreatSchools', defaultOn: true },
      { key: 'niche', label: 'Niche', defaultOn: true },
      { key: 'state_report_cards', label: 'State report cards', defaultOn: true },
      { key: 'schooldigger', label: 'SchoolDigger', defaultOn: false },
    ],
  },
  {
    key: 'development',
    title: 'Development and infrastructure',
    note: 'Drives construction-pressure checks. Picks up planned roads, subdivisions, and rezonings near a property.',
    sources: [
      { key: 'state_dot', label: 'State DOT project list', defaultOn: true },
      { key: 'county_planning', label: 'County planning department', defaultOn: true },
      { key: 'municipal_planning', label: 'Municipal planning', defaultOn: true },
      { key: 'mpo', label: 'Regional MPO (transportation planning)', defaultOn: false },
    ],
  },
];

function collectCurrentResearchSources() {
  const stored = state.profile?.research_sources;
  const result = {};
  for (const group of RESEARCH_SOURCE_GROUPS) {
    const currentForGroup = stored?.[group.key];
    for (const source of group.sources) {
      const key = `${group.key}.${source.key}`;
      if (currentForGroup && typeof currentForGroup === 'object' && source.key in currentForGroup) {
        result[key] = Boolean(currentForGroup[source.key]);
      } else if (Array.isArray(currentForGroup)) {
        result[key] = currentForGroup.includes(source.key);
      } else {
        result[key] = source.defaultOn;
      }
    }
  }
  return result;
}

function renderResearchSources() {
  state.answers.research_sources = state.answers.research_sources ?? collectCurrentResearchSources();
  const checks = state.answers.research_sources;
  const target = document.getElementById('tile');
  const blocks = RESEARCH_SOURCE_GROUPS.map((group) => {
    const rows = group.sources.map((source) => {
      const id = `${group.key}.${source.key}`;
      const isChecked = Boolean(checks[id]);
      return `
        <label class="option ${isChecked ? 'checked' : ''}" data-source-id="${escapeAttr(id)}">
          <input type="checkbox" ${isChecked ? 'checked' : ''} />
          <span class="label">${escapeHtml(source.label)}</span>
        </label>
      `;
    }).join('');
    return `
      <div class="sub-question" data-source-group="${escapeAttr(group.key)}">
        <h3 class="tile-subtitle">${escapeHtml(group.title)}</h3>
        <p class="tile-hint" style="margin: 0 0 10px;">${escapeHtml(group.note)}</p>
        <div class="options">${rows}</div>
      </div>
    `;
  }).join('');
  target.innerHTML = `
    <h2>${escapeHtml(CURRENT_STEP.title)}</h2>
    <p class="tile-hint">${escapeHtml(CURRENT_STEP.hint ?? '')}</p>
    ${blocks}
  `;
  target.querySelectorAll('.option[data-source-id]').forEach((node) => {
    node.addEventListener('click', (event) => {
      const checkbox = node.querySelector('input');
      if (event.target !== checkbox) checkbox.checked = !checkbox.checked;
      node.classList.toggle('checked', checkbox.checked);
      state.answers.research_sources[node.dataset.sourceId] = checkbox.checked;
    });
  });
}

const FEATURE_CHIPS = [
  'Large backyard',
  'Fenced yard',
  'Open-concept plan',
  'Updated kitchen',
  'Hardwood or LVP floors',
  'Bonus room or office',
  'First-floor primary suite',
  'Two-story layout',
  'Cul-de-sac or low-traffic street',
  'Community pool',
  'Mature neighborhood',
  'Home office',
  'Basement',
  'Finished garage',
  'Pool',
  'Screened porch',
  'Three-car garage',
];

const DEAL_BREAKER_CHIPS = [
  'Busy road or cut-through traffic',
  'Floodplain or drainage concern',
  'Small or unusable backyard',
  'Weak assigned schools',
  'Townhome or condo',
  'Backs to commercial or highway',
  'Major immediate repairs',
  'Too far from preferred commute',
  'Builder-heavy new construction',
];

function seedNarrativeWants() {
  if (state.answers.narrative?.wants !== undefined) return state.answers.narrative.wants;
  const prior = collectCurrentFeatures();
  return prior.length ? `Looking for: ${prior.join(', ')}.` : '';
}

function seedNarrativeAvoids() {
  if (state.answers.narrative?.avoids !== undefined) return state.answers.narrative.avoids;
  const prior = state.profile?.search?.deal_breakers ?? [];
  return prior.length ? `Avoid: ${prior.join(', ')}.` : '';
}

function renderNarrative() {
  const target = document.getElementById('tile');
  const wants = seedNarrativeWants();
  const avoids = seedNarrativeAvoids();
  target.innerHTML = `
    <h2>${escapeHtml(CURRENT_STEP.title)}</h2>
    <p class="tile-hint">${escapeHtml(CURRENT_STEP.hint)}</p>

    <label style="display:flex; flex-direction:column; gap:6px; color: var(--ink-soft); font-size: 13px;">What you want in the home
      <textarea class="text-input" id="n-wants" rows="5" placeholder="e.g. Open floor plan, fenced yard, updated kitchen, cul-de-sac lot...">${escapeHtml(wants)}</textarea>
    </label>
    <div class="chip-row" data-chip-target="n-wants" style="display:flex; flex-wrap:wrap; gap:6px; margin-top: 6px;">
      ${FEATURE_CHIPS.map((v) => `<button type="button" class="chip" data-chip-value="${escapeAttr(v)}">+ ${escapeHtml(v)}</button>`).join('')}
    </div>

    <label style="display:flex; flex-direction:column; gap:6px; color: var(--ink-soft); font-size: 13px; margin-top: 16px;">What would make you skip a listing
      <textarea class="text-input" id="n-avoids" rows="4" placeholder="e.g. Busy roads, floodplain, tiny yards, HOA with pool maintenance we don't want...">${escapeHtml(avoids)}</textarea>
    </label>
    <div class="chip-row" data-chip-target="n-avoids" style="display:flex; flex-wrap:wrap; gap:6px; margin-top: 6px;">
      ${DEAL_BREAKER_CHIPS.map((v) => `<button type="button" class="chip" data-chip-value="${escapeAttr(v)}">+ ${escapeHtml(v)}</button>`).join('')}
    </div>

    <label style="display:flex; flex-direction:column; gap:6px; color: var(--ink-soft); font-size: 13px; margin-top: 16px;">Family and household context
      <textarea class="text-input" id="n-family" rows="3" placeholder="Kids, pets, work-from-home, multi-generational...">${escapeHtml(state.answers.narrative?.family ?? '')}</textarea>
    </label>

    <label style="display:flex; flex-direction:column; gap:6px; color: var(--ink-soft); font-size: 13px; margin-top: 12px;">How aggressive should we be in a tight market?
      <select class="text-input" id="n-aggr">
        ${['Wait for the perfect fit', 'Move on strong fits', 'Compete hard', 'Keep current'].map((v) => `
          <option value="${escapeAttr(v)}" ${state.answers.narrative?.aggressiveness === v ? 'selected' : ''}>${escapeHtml(v)}</option>
        `).join('')}
      </select>
    </label>

    <label style="display:flex; flex-direction:column; gap:6px; color: var(--ink-soft); font-size: 13px; margin-top: 12px;">Anything else we should know
      <textarea class="text-input" id="n-notes" rows="3" placeholder="Free-form notes for the buyer profile">${escapeHtml(state.answers.narrative?.notes ?? '')}</textarea>
    </label>
  `;

  target.querySelectorAll('.chip-row').forEach((row) => {
    const targetId = row.dataset.chipTarget;
    const textarea = document.getElementById(targetId);
    row.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const value = chip.dataset.chipValue;
        appendChipToTextarea(textarea, value);
        readNarrative();
      });
    });
  });
}

function appendChipToTextarea(textarea, value) {
  if (!textarea || !value) return;
  const current = textarea.value ?? '';
  if (current.toLowerCase().includes(value.toLowerCase())) {
    textarea.focus();
    return;
  }
  const trimmed = current.trim();
  const needsSeparator = trimmed.length > 0 && !/[.,;]\s*$/.test(trimmed);
  textarea.value = trimmed.length === 0
    ? `${value}.`
    : needsSeparator
      ? `${trimmed}, ${value}.`
      : `${trimmed} ${value}.`;
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function readNarrative() {
  const narrative = {
    wants: document.getElementById('n-wants')?.value ?? '',
    avoids: document.getElementById('n-avoids')?.value ?? '',
    family: document.getElementById('n-family')?.value.trim() ?? '',
    aggressiveness: document.getElementById('n-aggr')?.value ?? '',
    notes: document.getElementById('n-notes')?.value.trim() ?? '',
  };
  state.answers.narrative = narrative;
  return { narrative };
}

function renderReview() {
  const summary = buildSummary();
  const target = document.getElementById('tile');
  target.innerHTML = `
    <h2>${escapeHtml(CURRENT_STEP.title)}</h2>
    <p class="tile-hint">${escapeHtml(CURRENT_STEP.hint)}</p>
    <pre style="white-space:pre-wrap; background:var(--panel-alt); border:1px solid var(--border); border-radius:12px; padding:16px; font-size:13px; color:var(--ink); max-height:60vh; overflow:auto;">${escapeHtml(summary)}</pre>
  `;
}

function buildSummary() {
  const lines = [];
  const push = (label, value) => { if (value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)) lines.push(`${label}: ${Array.isArray(value) ? value.join(', ') : value}`); };
  push('Areas', state.answers.areas);
  if (state.answers.price) push('Price', `${state.answers.price.min ?? '?'} - ${state.answers.price.max ?? '?'}`);
  push('Beds min', state.answers.beds_min);
  push('Baths min', state.answers.baths_min);
  push('Sqft min', state.answers.sqft_min);
  push('Garage min', state.answers.garage_min);
  push('Lot min', state.answers.lot_min);
  push('Home type', state.answers.home_type_preference);
  push('Year built min', state.answers.year_built_min);
  push('Stories', state.answers.stories_preferred);
  push('Property types', state.answers.property_types);
  push('HOA max', state.answers.hoa_max);
  push('Down payment', state.answers.down_payment_pct);
  push('Closing costs', state.answers.closing_pct);
  push('School min', state.answers.schools_min_rating);
  push('Max DOM', state.answers.max_listing_age);
  push('Commute destinations', state.answers.commute);
  if (state.answers.research_sources && Object.keys(state.answers.research_sources).length) {
    const on = Object.entries(state.answers.research_sources).filter(([, value]) => value).map(([key]) => key);
    if (on.length) lines.push(`Research sources: ${on.join(', ')}`);
  }
  if (state.answers.sentiment_weights) lines.push(`Neighborhood weights: ${JSON.stringify(state.answers.sentiment_weights)}`);
  if (state.answers.school_weights) lines.push(`School weights: ${JSON.stringify(state.answers.school_weights)}`);
  if (state.answers.narrative?.wants) push('Wants', state.answers.narrative.wants);
  if (state.answers.narrative?.avoids) push('Avoids', state.answers.narrative.avoids);
  if (state.answers.narrative?.family) push('Family', state.answers.narrative.family);
  if (state.answers.narrative?.aggressiveness) push('Aggressiveness', state.answers.narrative.aggressiveness);
  if (state.answers.narrative?.notes) push('Notes', state.answers.narrative.notes);
  return lines.join('\n');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function escapeAttr(value) { return escapeHtml(value); }

let CURRENT_STEP = STEPS[0];

function renderStep() {
  CURRENT_STEP = STEPS[state.stepIndex];
  CURRENT_STEP.render();
  document.getElementById('step-label').textContent = `Step ${state.stepIndex + 1} -- ${CURRENT_STEP.title.replace(/\.$/, '')}`;
  document.getElementById('step-total').textContent = `of ${STEPS.length}`;
  document.getElementById('progress-fill').style.width = `${((state.stepIndex + 1) / STEPS.length) * 100}%`;
  document.getElementById('back-btn').disabled = state.stepIndex === 0;
  const onReview = !!CURRENT_STEP.isReview;
  document.getElementById('next-btn').hidden = onReview;
  document.getElementById('submit-btn').hidden = !onReview;
}

function commitCurrentStep() {
  if (CURRENT_STEP.read) CURRENT_STEP.read();
}

async function bootstrap() {
  try {
    const res = await fetch('/api/profile');
    const body = await res.json();
    state.profile = body.profile ?? {};
  } catch (error) {
    console.warn('Unable to load current profile, starting blank.', error);
    state.profile = {};
  }
  renderStep();
  document.getElementById('back-btn').addEventListener('click', () => {
    commitCurrentStep();
    if (state.stepIndex > 0) {
      state.stepIndex -= 1;
      renderStep();
    }
  });
  document.getElementById('next-btn').addEventListener('click', () => {
    commitCurrentStep();
    if (state.stepIndex < STEPS.length - 1) {
      state.stepIndex += 1;
      renderStep();
    }
  });
  document.getElementById('submit-btn').addEventListener('click', submit);
}

async function submit() {
  commitCurrentStep();
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';
  const payload = { answers: state.answers, summary: buildSummary() };
  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    document.querySelector('.tile').hidden = true;
    document.querySelector('.nav').hidden = true;
    document.getElementById('done').hidden = false;
  } catch (error) {
    btn.disabled = false;
    btn.textContent = 'Submit profile';
    alert(`Submission failed: ${error.message}`);
  }
}

bootstrap();
