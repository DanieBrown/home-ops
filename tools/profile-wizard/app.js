/* Home-Ops Profile Wizard client
 *
 * Renders a progress-based questionnaire that mirrors the filter fields used
 * by Zillow, Redfin, Realtor.com, and Homes.com, plus sentiment and school
 * weight sliders. On submit, POSTs the full answer payload to /api/submit.
 *
 * Step 1 is a State -> County -> Cities drill-down that pulls lists from
 * Wikipedia (proxied through the local server with an on-disk cache). The
 * wizard also saves answers to the server after each step so re-opening the
 * flow preserves prior selections.
 */

const state = {
  profile: {},
  savedAnswers: null,
  answers: {},
  stepIndex: 0,
  geo: {
    states: null,
    countiesByState: {},
    countyErrorByState: {},
    townsByKey: {},
    loadingStates: false,
    loadingCounties: false,
    loadingTowns: false,
    error: '',
  },
  visitedSteps: new Set([0]),
};

const STEPS = [
  {
    id: 'areas',
    title: 'Where do you want to move?',
    hint: 'Pick the state, the counties you want to search inside, and then the specific cities. Lists are pulled from Wikipedia and cached locally.',
    render: renderAreasStep,
    read: () => ({ areas_selection: state.answers.areas_selection ?? {} }),
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
          current: state.profile?.search?.hard_requirements?.beds_min,
          inputOnly: true,
          inputType: 'number',
          inputStep: 1,
          inputMin: 0,
          placeholder: 'e.g. 3',
        },
        {
          field: 'baths_min',
          label: 'Bathrooms minimum',
          current: state.profile?.search?.hard_requirements?.baths_min,
          inputOnly: true,
          inputType: 'number',
          inputStep: 0.5,
          inputMin: 0,
          placeholder: 'e.g. 2.5',
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
          current: state.profile?.search?.hard_requirements?.sqft_min,
          inputOnly: true,
          inputType: 'number',
          inputStep: 50,
          inputMin: 0,
          placeholder: 'e.g. 2200',
          unit: 'sq ft',
        },
        {
          field: 'garage_min',
          label: 'Garage spaces minimum',
          current: state.profile?.search?.hard_requirements?.garage_min,
          inputOnly: true,
          inputType: 'number',
          inputStep: 1,
          inputMin: 0,
          placeholder: 'e.g. 2',
        },
        {
          field: 'lot_min',
          label: 'Lot size minimum (acres)',
          current: state.profile?.search?.hard_requirements?.lot_min_acres,
          inputOnly: true,
          inputType: 'number',
          inputStep: 0.05,
          inputMin: 0,
          placeholder: 'e.g. 0.25 (leave blank for no minimum)',
          unit: 'acres',
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
          options: ['Resale only', 'New construction ok', 'New construction preferred', 'No preference'],
          current: state.profile?.search?.hard_requirements?.home_type_preference,
          includeCustom: false,
        },
        {
          field: 'year_built_min',
          label: 'Year built minimum',
          current: state.profile?.search?.soft_preferences?.year_built_min,
          inputOnly: true,
          inputType: 'number',
          inputStep: 1,
          inputMin: 1800,
          inputMax: 2100,
          placeholder: 'e.g. 2000 (leave blank for no preference)',
        },
        {
          field: 'stories_preferred',
          label: 'Stories preferred',
          current: state.profile?.search?.soft_preferences?.stories_preferred,
          inputOnly: true,
          inputType: 'number',
          inputStep: 1,
          inputMin: 1,
          inputMax: 5,
          placeholder: 'e.g. 2 (leave blank for no preference)',
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
    title: 'HOA maximum',
    hint: 'HOA cap on monthly dues. Feeds the hard-requirement gate on every listing.',
    render: () => renderMultipleSingleChoice({
      questions: [
        {
          field: 'hoa_max',
          label: 'HOA max monthly',
          current: state.profile?.search?.soft_preferences?.hoa_max_monthly,
          inputOnly: true,
          inputType: 'number',
          inputStep: 25,
          inputMin: 0,
          placeholder: 'e.g. 200 (leave blank for no cap)',
          unit: '$/mo',
        },
      ],
    }),
    read: () => ({ hoa_max: state.answers.hoa_max }),
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
          current: state.profile?.search?.hard_requirements?.schools_min_rating,
          inputOnly: true,
          inputType: 'number',
          inputStep: 1,
          inputMin: 0,
          inputMax: 10,
          placeholder: 'e.g. 7',
        },
        {
          field: 'max_listing_age',
          label: 'Maximum days on market',
          current: state.profile?.search?.hard_requirements?.max_listing_age_days,
          inputOnly: true,
          inputType: 'number',
          inputStep: 1,
          inputMin: 1,
          placeholder: 'e.g. 14',
          unit: 'days',
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
    hint: 'For each destination, pick the state and county. An address is optional -- if you leave it blank the drive-time link will point at the county; add a street or neighborhood for a more precise comparison.',
    render: renderCommuteStep,
    read: () => ({ commute: state.answers.commute ?? [] }),
  },
  {
    id: 'research-sources',
    title: 'Which sources should power your research?',
    hint: 'Pick the listing portals and background-research sites Home-Ops should use. Nothing is pre-checked -- select only what you want. If you leave a group empty, that stage of the pipeline is skipped (except listing portals, where empty means "use them all").',
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
        { key: 'livability', label: 'Parks, groceries, everyday livability' },
      ],
      currentValues: normalizedToScale(state.profile?.sentiment?.weights),
    }),
    read: () => ({ sentiment_weights: state.answers.sentiment_weights ?? {} }),
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

/* ---------- Step 1: Areas (state / counties / cities) ---------- */

function ensureAreasSelection() {
  if (!state.answers.areas_selection) {
    // Start with an empty state input -- legacy two-letter abbreviations in
    // config/profile.yml are not valid Wikipedia page keys, so forcing the
    // user to pick from the autocomplete avoids bogus 429s and a stuck UI.
    state.answers.areas_selection = {
      state: '',
      counties: [],
      cities: [],
    };
  }
  return state.answers.areas_selection;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) reason = body.error;
    } catch { /* ignore */ }
    throw new Error(reason);
  }
  return response.json();
}

async function ensureStatesLoaded() {
  if (state.geo.states) return;
  state.geo.loadingStates = true;
  try {
    const body = await fetchJson('/api/geo/states');
    state.geo.states = body.states ?? [];
  } catch (error) {
    state.geo.error = `Could not load states list: ${error.message}`;
  } finally {
    state.geo.loadingStates = false;
  }
}

async function ensureCountiesLoaded(stateName) {
  if (!stateName) return;
  if (state.geo.countiesByState[stateName]) return;
  if (state.geo.countyErrorByState[stateName]) return; // avoid retry loop on 429/404
  if (state.geo.loadingCounties) return;
  state.geo.loadingCounties = true;
  renderStep(); // show loading
  try {
    const body = await fetchJson(`/api/geo/counties?state=${encodeURIComponent(stateName)}`);
    state.geo.countiesByState[stateName] = body.counties ?? [];
    state.geo.error = '';
  } catch (error) {
    state.geo.countyErrorByState[stateName] = error.message;
    // The dedicated county block renders its own error hint + manual entry,
    // so we don't also bubble this up to the global banner.
  } finally {
    state.geo.loadingCounties = false;
    renderStep();
  }
}

function townKey(stateName, countyName) {
  return `${stateName}::${countyName}`;
}

async function ensureTownsLoaded(stateName, countyNames) {
  const pending = (countyNames ?? []).filter((county) => !state.geo.townsByKey[townKey(stateName, county)]);
  if (pending.length === 0) return;
  state.geo.loadingTowns = true;
  renderStep();
  for (const county of pending) {
    try {
      const body = await fetchJson(`/api/geo/towns?state=${encodeURIComponent(stateName)}&county=${encodeURIComponent(county)}`);
      state.geo.townsByKey[townKey(stateName, county)] = { abbr: body.abbr, towns: body.towns ?? [] };
    } catch (error) {
      state.geo.townsByKey[townKey(stateName, county)] = { abbr: '', towns: [], error: error.message };
    }
  }
  state.geo.loadingTowns = false;
  renderStep();
}

function renderAreasStep() {
  const selection = ensureAreasSelection();
  const target = document.getElementById('tile');

  if (!state.geo.states && !state.geo.loadingStates) {
    // kick off states load without blocking
    ensureStatesLoaded().then(() => renderStep()).catch(() => renderStep());
  }

  const states = state.geo.states ?? [];
  const counties = state.geo.countiesByState[selection.state] ?? [];
  const townsForSelected = (selection.counties ?? []).map((county) => ({
    county,
    entry: state.geo.townsByKey[townKey(selection.state, county)],
  }));

  // City list: de-dup across all selected counties.
  const cityOptions = [];
  const seen = new Set();
  for (const { county, entry } of townsForSelected) {
    if (!entry || entry.error) continue;
    for (const town of entry.towns ?? []) {
      const key = `${town.name}|${county}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cityOptions.push({ name: town.name, county, state: selection.state, abbr: entry.abbr });
    }
  }

  // Sort by name for the searchable list.
  cityOptions.sort((a, b) => a.name.localeCompare(b.name));

  const citySearchTerm = (state.answers.areas_selection._citySearch ?? '').trim().toLowerCase();
  const filtered = citySearchTerm
    ? cityOptions.filter((entry) => entry.name.toLowerCase().includes(citySearchTerm))
    : cityOptions;

  const selectedCityKeys = new Set(
    (selection.cities ?? []).map((c) => `${c.name}|${c.county}`),
  );

  const stateBlock = `
    <div class="sub-question">
      <h3 class="tile-subtitle">State</h3>
      <div class="autocomplete" data-auto="state">
        <input type="text" class="text-input" id="state-input"
          placeholder="${state.geo.loadingStates ? 'Loading states...' : 'Start typing a state name...'}"
          value="${escapeAttr(selection.state ?? '')}"
          ${state.geo.loadingStates ? 'disabled' : ''} autocomplete="off" />
        <div class="auto-menu" id="state-menu" hidden></div>
      </div>
    </div>
  `;

  const countyError = state.geo.countyErrorByState[selection.state];
  const countyPlaceholder = countyError
    ? 'Type a county name and press Enter (Wikipedia unavailable)'
    : 'Start typing a county name...';
  const countyBlock = selection.state ? `
    <div class="sub-question">
      <h3 class="tile-subtitle">Counties in ${escapeHtml(selection.state)}</h3>
      ${state.geo.loadingCounties && counties.length === 0
        ? '<p class="tile-hint">Loading counties from Wikipedia...</p>'
        : `
          ${countyError ? `<p class="tile-hint" style="color: var(--warning, #e0b458);">Wikipedia didn't respond (${escapeHtml(countyError)}). You can still type county names manually and press Enter to add them.</p>` : ''}
          <div class="chips-selected" id="county-chips">
            ${[...(selection.counties ?? [])].sort((a, b) => a.localeCompare(b)).map((c) => `
              <span class="selected-chip" data-county="${escapeAttr(c)}">${escapeHtml(c)} <button type="button" aria-label="Remove">&times;</button></span>
            `).join('')}
          </div>
          <div class="autocomplete" data-auto="county">
            <input type="text" class="text-input" id="county-input"
              placeholder="${escapeAttr(countyPlaceholder)}" autocomplete="off" />
            <div class="auto-menu" id="county-menu" hidden></div>
          </div>
          ${countyError ? `<button type="button" class="primary" id="county-retry" style="margin-top: 8px;">Retry Wikipedia lookup</button>` : ''}
        `}
    </div>
  ` : '';

  const citySearchActive = (selection.counties ?? []).length > 0;
  const cityBlock = citySearchActive ? `
    <div class="sub-question">
      <h3 class="tile-subtitle">Cities to search${state.geo.loadingTowns ? ' <span class="loading-tag">Loading...</span>' : ''}</h3>
      <p class="tile-hint">Pulled from Wikipedia for the counties you picked. Check every place you want the scan to cover.</p>
      <input type="search" class="text-input" id="city-search"
        placeholder="Search cities and towns..."
        value="${escapeAttr(state.answers.areas_selection._citySearch ?? '')}" autocomplete="off" />
      <div class="city-list">
        ${filtered.length === 0 && !state.geo.loadingTowns
          ? `<p class="tile-hint">No matches. ${cityOptions.length === 0 ? 'Wikipedia returned no towns for these counties. Add a custom entry below.' : 'Try a different search term.'}</p>`
          : filtered.slice(0, 200).map((entry) => {
              const key = `${entry.name}|${entry.county}`;
              const isChecked = selectedCityKeys.has(key);
              return `
                <label class="option ${isChecked ? 'checked' : ''}" data-city-key="${escapeAttr(key)}"
                  data-city-name="${escapeAttr(entry.name)}" data-city-county="${escapeAttr(entry.county)}"
                  data-city-abbr="${escapeAttr(entry.abbr ?? '')}">
                  <input type="checkbox" ${isChecked ? 'checked' : ''} />
                  <span class="label">${escapeHtml(entry.name)}
                    <span class="sublabel">${escapeHtml(entry.county)} County</span>
                  </span>
                </label>
              `;
            }).join('')}
      </div>
      ${filtered.length > 200 ? `<p class="tile-hint">Showing the first 200 of ${filtered.length} matches. Narrow the search to see more.</p>` : ''}

      <div class="custom-row">
        <input type="text" id="custom-city-input" placeholder="Add a custom city..." />
        <button type="button" class="primary" id="custom-city-add">Add</button>
      </div>

      <div class="chips-selected" id="selected-cities">
        <h4 class="tile-subtitle">Selected cities</h4>
        ${(selection.cities ?? []).length === 0
          ? '<p class="tile-hint">None yet. Check a city above or add a custom one.</p>'
          : (selection.cities ?? []).map((c) => `
              <span class="selected-chip" data-city-selected="${escapeAttr(`${c.name}|${c.county}`)}">
                ${escapeHtml(c.name)}<span class="sublabel">${escapeHtml(c.county || 'custom')}</span>
                <button type="button" aria-label="Remove">&times;</button>
              </span>
            `).join('')}
      </div>
    </div>
  ` : '';

  target.innerHTML = `
    <h2>${escapeHtml(CURRENT_STEP.title)}</h2>
    <p class="tile-hint">${escapeHtml(CURRENT_STEP.hint)}</p>
    ${state.geo.error ? `<p class="validation">${escapeHtml(state.geo.error)}</p>` : ''}
    ${stateBlock}
    ${countyBlock}
    ${cityBlock}
  `;

  wireAreasInputs(states, counties, cityOptions);
}

function wireAreasInputs(states, counties, cityOptions) {
  const selection = state.answers.areas_selection;

  // ---- State autocomplete ----
  const stateInput = document.getElementById('state-input');
  const stateMenu = document.getElementById('state-menu');
  const renderStateMenu = () => {
    const query = (stateInput.value ?? '').trim().toLowerCase();
    if (!query) { stateMenu.hidden = true; return; }
    const matches = states.filter((s) => s.name.toLowerCase().includes(query)).slice(0, 12);
    if (matches.length === 0) { stateMenu.hidden = true; return; }
    stateMenu.hidden = false;
    stateMenu.innerHTML = matches.map((s) => `
      <button type="button" class="auto-option" data-state="${escapeAttr(s.name)}">${escapeHtml(s.name)}${s.abbr ? ` <span class="sublabel">${escapeHtml(s.abbr)}</span>` : ''}</button>
    `).join('');
    stateMenu.querySelectorAll('.auto-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pickedState = btn.dataset.state;
        const changed = pickedState !== selection.state;
        selection.state = pickedState;
        if (changed) {
          // Reset dependent data when the state changes.
          selection.counties = [];
          selection.cities = (selection.cities ?? []).filter((c) => c.state === pickedState);
        }
        stateMenu.hidden = true;
        saveAnswersDebounced();
        ensureCountiesLoaded(pickedState);
      });
    });
  };
  if (stateInput) {
    stateInput.addEventListener('input', renderStateMenu);
    stateInput.addEventListener('focus', renderStateMenu);
    stateInput.addEventListener('blur', () => setTimeout(() => { if (stateMenu) stateMenu.hidden = true; }, 120));
  }

  // ---- County autocomplete + chips ----
  const countyInput = document.getElementById('county-input');
  const countyMenu = document.getElementById('county-menu');
  const renderCountyMenu = () => {
    const query = (countyInput.value ?? '').trim().toLowerCase();
    if (!query) { countyMenu.hidden = true; return; }
    const taken = new Set(selection.counties ?? []);
    const matches = counties
      .filter((c) => !taken.has(c.name) && c.name.toLowerCase().includes(query))
      .slice(0, 12);
    if (matches.length === 0) { countyMenu.hidden = true; return; }
    countyMenu.hidden = false;
    countyMenu.innerHTML = matches.map((c) => `
      <button type="button" class="auto-option" data-county="${escapeAttr(c.name)}">${escapeHtml(c.name)}</button>
    `).join('');
    countyMenu.querySelectorAll('.auto-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pickedCounty = btn.dataset.county;
        if (!selection.counties.includes(pickedCounty)) {
          selection.counties.push(pickedCounty);
        }
        countyInput.value = '';
        countyMenu.hidden = true;
        saveAnswersDebounced();
        ensureTownsLoaded(selection.state, [pickedCounty]).then(() => renderStep());
        renderStep();
      });
    });
  };
  if (countyInput) {
    countyInput.addEventListener('input', renderCountyMenu);
    countyInput.addEventListener('focus', renderCountyMenu);
    countyInput.addEventListener('blur', () => setTimeout(() => { if (countyMenu) countyMenu.hidden = true; }, 120));
    countyInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const typed = (countyInput.value ?? '').trim();
      if (!typed) return;
      // Prefer an autocomplete match when available; otherwise accept what the
      // user typed so they are not blocked by a Wikipedia outage.
      const match = counties.find((c) => c.name.toLowerCase() === typed.toLowerCase())
        ?? counties.find((c) => c.name.toLowerCase().startsWith(typed.toLowerCase()));
      const pickedCounty = match?.name ?? typed;
      if (!selection.counties.includes(pickedCounty)) selection.counties.push(pickedCounty);
      countyInput.value = '';
      countyMenu.hidden = true;
      saveAnswersDebounced();
      ensureTownsLoaded(selection.state, [pickedCounty]).then(() => renderStep());
      renderStep();
    });
  }

  const countyRetry = document.getElementById('county-retry');
  if (countyRetry) {
    countyRetry.addEventListener('click', () => {
      delete state.geo.countyErrorByState[selection.state];
      state.geo.error = '';
      ensureCountiesLoaded(selection.state);
    });
  }

  document.querySelectorAll('.selected-chip[data-county]').forEach((chip) => {
    chip.querySelector('button')?.addEventListener('click', () => {
      const target = chip.dataset.county;
      selection.counties = selection.counties.filter((c) => c !== target);
      selection.cities = selection.cities.filter((c) => c.county !== target);
      saveAnswersDebounced();
      renderStep();
    });
  });

  // Counties only load in response to an explicit state pick from the
  // autocomplete -- not from the render path. That keeps a stale state value
  // from triggering repeated Wikipedia requests (and stealing input focus).

  // ---- City list ----
  const citySearch = document.getElementById('city-search');
  if (citySearch) {
    citySearch.addEventListener('input', () => {
      selection._citySearch = citySearch.value;
      renderStep();
      // Restore focus
      const refreshed = document.getElementById('city-search');
      if (refreshed) {
        refreshed.focus();
        refreshed.setSelectionRange(refreshed.value.length, refreshed.value.length);
      }
    });
  }

  document.querySelectorAll('.option[data-city-key]').forEach((node) => {
    node.addEventListener('click', (event) => {
      const checkbox = node.querySelector('input[type="checkbox"]');
      if (event.target !== checkbox) checkbox.checked = !checkbox.checked;
      node.classList.toggle('checked', checkbox.checked);
      const payload = {
        name: node.dataset.cityName,
        county: node.dataset.cityCounty,
        state: selection.state,
        abbr: node.dataset.cityAbbr || undefined,
      };
      const key = node.dataset.cityKey;
      const existingIndex = (selection.cities ?? []).findIndex((c) => `${c.name}|${c.county}` === key);
      if (checkbox.checked) {
        if (existingIndex === -1) selection.cities.push(payload);
      } else if (existingIndex !== -1) {
        selection.cities.splice(existingIndex, 1);
      }
      saveAnswersDebounced();
      updateSelectedCityChips();
    });
  });

  // Kick off town loads for any county that hasn't been fetched.
  const countiesNeedingTowns = (selection.counties ?? []).filter((c) => !state.geo.townsByKey[townKey(selection.state, c)]);
  if (countiesNeedingTowns.length > 0 && !state.geo.loadingTowns) {
    ensureTownsLoaded(selection.state, countiesNeedingTowns);
  }

  const customCityInput = document.getElementById('custom-city-input');
  const customCityBtn = document.getElementById('custom-city-add');
  if (customCityInput && customCityBtn) {
    const add = () => {
      const name = (customCityInput.value ?? '').trim();
      if (!name) return;
      // Custom cities are not tied to a specific county -- they're flagged as
      // `custom: true` and inherit the state. Counties are an unordered set,
      // so there is no "primary" one to attach them to.
      const alreadyIndex = selection.cities.findIndex((c) => c.name.toLowerCase() === name.toLowerCase() && c.custom);
      if (alreadyIndex === -1) {
        selection.cities.push({ name, county: '', state: selection.state, custom: true });
      }
      customCityInput.value = '';
      saveAnswersDebounced();
      renderStep();
    };
    customCityBtn.addEventListener('click', add);
    customCityInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
  }

  document.querySelectorAll('.selected-chip[data-city-selected]').forEach((chip) => {
    chip.querySelector('button')?.addEventListener('click', () => {
      const key = chip.dataset.citySelected;
      selection.cities = selection.cities.filter((c) => `${c.name}|${c.county}` !== key);
      saveAnswersDebounced();
      renderStep();
    });
  });
}

function updateSelectedCityChips() {
  const container = document.getElementById('selected-cities');
  if (!container) return;
  const selection = state.answers.areas_selection;
  const chips = (selection.cities ?? []).map((c) => `
    <span class="selected-chip" data-city-selected="${escapeAttr(`${c.name}|${c.county}`)}">
      ${escapeHtml(c.name)}<span class="sublabel">${escapeHtml(c.county || 'custom')}</span>
      <button type="button" aria-label="Remove">&times;</button>
    </span>
  `).join('');
  container.innerHTML = `
    <h4 class="tile-subtitle">Selected cities</h4>
    ${chips || '<p class="tile-hint">None yet. Check a city above or add a custom one.</p>'}
  `;
  container.querySelectorAll('.selected-chip[data-city-selected]').forEach((chip) => {
    chip.querySelector('button')?.addEventListener('click', () => {
      const key = chip.dataset.citySelected;
      selection.cities = selection.cities.filter((c) => `${c.name}|${c.county}` !== key);
      saveAnswersDebounced();
      renderStep();
    });
  });
}

/* ---------- Commute step: state + county drill-down, optional address ---------- */

function ensureCommuteDestinations() {
  if (!Array.isArray(state.answers.commute) || state.answers.commute.length === 0) {
    state.answers.commute = [{ label: '', state: '', county: '', address: '' }];
  }
  // Normalize legacy shapes (string-only, or the previous {city} variant).
  state.answers.commute = state.answers.commute.map((entry) => {
    if (typeof entry === 'string') return { label: entry, state: '', county: '', address: '' };
    return {
      label: entry.label ?? entry.name ?? '',
      state: entry.state ?? '',
      county: entry.county ?? '',
      address: entry.address ?? entry.city ?? '',
    };
  });
  return state.answers.commute;
}

function renderCommuteStep() {
  const destinations = ensureCommuteDestinations();
  const target = document.getElementById('tile');

  if (!state.geo.states && !state.geo.loadingStates) {
    ensureStatesLoaded().then(() => renderStep()).catch(() => renderStep());
  }

  // Kick off county loads for any destination that already has a state, so
  // the county autocomplete pool is warm when the user focuses the field.
  const statesNeedingCounties = new Set();
  for (const dest of destinations) {
    if (dest.state) statesNeedingCounties.add(dest.state);
  }
  for (const stateName of statesNeedingCounties) {
    if (!state.geo.countiesByState[stateName] && !state.geo.countyErrorByState[stateName]) {
      ensureCountiesLoaded(stateName);
    }
  }

  const rows = destinations.map((dest, index) => renderCommuteRow(dest, index)).join('');

  target.innerHTML = `
    <h2>${escapeHtml(CURRENT_STEP.title)}</h2>
    <p class="tile-hint">${escapeHtml(CURRENT_STEP.hint)}</p>
    <div class="commute-editor">${rows}</div>
    <button type="button" class="ghost" id="commute-add" style="margin-top: 12px;">+ Add another destination</button>
  `;

  wireCommuteInputs();
}

function renderCommuteRow(dest, index) {
  const counties = state.geo.countiesByState[dest.state] ?? [];
  const countyError = state.geo.countyErrorByState[dest.state];

  const countyHint = countyError
    ? `<p class="tile-hint" style="color: var(--warning, #e0b458);">
         Wikipedia unavailable (${escapeHtml(countyError)}). Type a county name and press Enter, or
         <button type="button" class="link-btn" data-action="retry-county">retry the lookup</button>.
       </p>`
    : '';

  return `
    <div class="commute-row-editor" data-commute-index="${index}">
      <div class="commute-row-head">
        <input type="text" class="text-input" data-field="label"
          placeholder="Label (e.g. Work, Daycare)" value="${escapeAttr(dest.label ?? '')}" />
        <button type="button" class="ghost" data-action="remove" aria-label="Remove destination">Remove</button>
      </div>
      <div class="commute-row-grid">
        <label class="commute-field">
          <span>State</span>
          <div class="autocomplete" data-auto="commute-state">
            <input type="text" class="text-input" data-field="state"
              placeholder="${state.geo.loadingStates ? 'Loading states...' : 'Start typing a state...'}"
              value="${escapeAttr(dest.state ?? '')}"
              ${state.geo.loadingStates ? 'disabled' : ''} autocomplete="off" />
            <div class="auto-menu" data-menu="state" hidden></div>
          </div>
        </label>
        <label class="commute-field">
          <span>County${state.geo.loadingCounties && dest.state && counties.length === 0 ? ' <span class="loading-tag">Loading...</span>' : ''}</span>
          <div class="autocomplete" data-auto="commute-county">
            <input type="text" class="text-input" data-field="county"
              placeholder="${dest.state ? (countyError ? 'Type county + Enter' : 'Start typing a county...') : 'Pick a state first'}"
              value="${escapeAttr(dest.county ?? '')}"
              ${dest.state ? '' : 'disabled'} autocomplete="off" />
            <div class="auto-menu" data-menu="county" hidden></div>
          </div>
          ${countyHint}
        </label>
      </div>
      <label class="commute-field">
        <span>Address <span class="sublabel" style="text-transform: none; font-weight: 400;">(optional -- street, city, or landmark for a more precise drive-time link)</span></span>
        <input type="text" class="text-input" data-field="address"
          placeholder="${dest.state ? 'e.g. 123 Main St, Cary or just Downtown Raleigh' : 'Pick a state first'}"
          value="${escapeAttr(dest.address ?? '')}"
          ${dest.state ? '' : 'disabled'} />
      </label>
    </div>
  `;
}

function wireCommuteInputs() {
  const destinations = state.answers.commute;

  document.querySelectorAll('.commute-row-editor').forEach((row) => {
    const index = Number.parseInt(row.dataset.commuteIndex, 10);
    const dest = destinations[index];
    if (!dest) return;

    const labelInput = row.querySelector('input[data-field="label"]');
    if (labelInput) {
      labelInput.addEventListener('input', () => {
        dest.label = labelInput.value;
        saveAnswersDebounced();
      });
    }

    const stateInput = row.querySelector('input[data-field="state"]');
    const stateMenu = row.querySelector('[data-menu="state"]');
    const renderStateMenu = () => {
      const query = (stateInput.value ?? '').trim().toLowerCase();
      if (!query) { stateMenu.hidden = true; return; }
      const matches = (state.geo.states ?? [])
        .filter((s) => s.name.toLowerCase().includes(query))
        .slice(0, 12);
      if (matches.length === 0) { stateMenu.hidden = true; return; }
      stateMenu.hidden = false;
      stateMenu.innerHTML = matches.map((s) => `
        <button type="button" class="auto-option" data-state="${escapeAttr(s.name)}">${escapeHtml(s.name)}${s.abbr ? ` <span class="sublabel">${escapeHtml(s.abbr)}</span>` : ''}</button>
      `).join('');
      stateMenu.querySelectorAll('.auto-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          const picked = btn.dataset.state;
          if (picked !== dest.state) {
            dest.state = picked;
            dest.county = '';
          }
          stateMenu.hidden = true;
          saveAnswersDebounced();
          ensureCountiesLoaded(picked);
          renderStep();
        });
      });
    };
    if (stateInput) {
      stateInput.addEventListener('input', renderStateMenu);
      stateInput.addEventListener('focus', renderStateMenu);
      stateInput.addEventListener('blur', () => setTimeout(() => { stateMenu.hidden = true; }, 120));
    }

    const countyInput = row.querySelector('input[data-field="county"]');
    const countyMenu = row.querySelector('[data-menu="county"]');
    const renderCountyMenu = () => {
      if (!dest.state) { countyMenu.hidden = true; return; }
      const query = (countyInput.value ?? '').trim().toLowerCase();
      if (!query) { countyMenu.hidden = true; return; }
      const pool = state.geo.countiesByState[dest.state] ?? [];
      const matches = pool
        .filter((c) => c.name.toLowerCase().includes(query))
        .slice(0, 12);
      if (matches.length === 0) { countyMenu.hidden = true; return; }
      countyMenu.hidden = false;
      countyMenu.innerHTML = matches.map((c) => `
        <button type="button" class="auto-option" data-county="${escapeAttr(c.name)}">${escapeHtml(c.name)}</button>
      `).join('');
      countyMenu.querySelectorAll('.auto-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          dest.county = btn.dataset.county;
          countyInput.value = dest.county;
          countyMenu.hidden = true;
          saveAnswersDebounced();
        });
      });
    };
    if (countyInput) {
      countyInput.addEventListener('input', () => {
        dest.county = countyInput.value;
        renderCountyMenu();
      });
      countyInput.addEventListener('focus', renderCountyMenu);
      countyInput.addEventListener('blur', () => setTimeout(() => { countyMenu.hidden = true; saveAnswersDebounced(); }, 120));
      countyInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        dest.county = (countyInput.value ?? '').trim();
        countyMenu.hidden = true;
        saveAnswersDebounced();
      });
    }

    const addressInput = row.querySelector('input[data-field="address"]');
    if (addressInput) {
      addressInput.addEventListener('input', () => {
        dest.address = addressInput.value;
        saveAnswersDebounced();
      });
    }

    row.querySelector('[data-action="remove"]')?.addEventListener('click', () => {
      destinations.splice(index, 1);
      if (destinations.length === 0) destinations.push({ label: '', state: '', county: '', address: '' });
      saveAnswersDebounced();
      renderStep();
    });

    row.querySelector('[data-action="retry-county"]')?.addEventListener('click', () => {
      delete state.geo.countyErrorByState[dest.state];
      ensureCountiesLoaded(dest.state);
    });
  });

  document.getElementById('commute-add')?.addEventListener('click', () => {
    destinations.push({ label: '', state: '', county: '', address: '' });
    saveAnswersDebounced();
    renderStep();
  });
}

/* ---------- Shared single-choice / multi-select / range ---------- */

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
      saveAnswersDebounced();
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
      saveAnswersDebounced();
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
    saveAnswersDebounced();
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

function renderSingleChoiceBlock({ field, label, options, current, currentPrefix = '', currentSuffix = '', includeCustom = true, inputOnly = false, inputType = 'text', inputStep, inputMin, inputMax, placeholder = '', unit = '' }) {
  if (inputOnly) {
    const saved = state.answers[field];
    const initial = saved ?? (current === undefined || current === null ? '' : current);
    const stepAttr = inputStep !== undefined ? ` step="${escapeAttr(inputStep)}"` : '';
    const minAttr = inputMin !== undefined ? ` min="${escapeAttr(inputMin)}"` : '';
    const maxAttr = inputMax !== undefined ? ` max="${escapeAttr(inputMax)}"` : '';
    const placeholderAttr = placeholder ? ` placeholder="${escapeAttr(placeholder)}"` : '';
    const unitHtml = unit ? `<span class="unit">${escapeHtml(unit)}</span>` : '';
    return `
      <div class="sub-question" data-sc-field="${escapeAttr(field)}" data-sc-input-only="true">
        <h3 class="tile-subtitle">${escapeHtml(label)}</h3>
        <div class="free-input-row">
          <input type="${escapeAttr(inputType)}"${stepAttr}${minAttr}${maxAttr}${placeholderAttr} value="${escapeAttr(initial)}" />
          ${unitHtml}
        </div>
      </div>
    `;
  }
  // No "Keep current (X)" fallback -- if the saved profile value matches one
  // of the canonical options, pre-select it; otherwise leave unselected.
  const matched = findAnswerFromCurrent(options, current, currentPrefix, currentSuffix);
  const selected = state.answers[field] ?? matched ?? null;
  const optionList = [...options];
  if (includeCustom) optionList.push('Custom');
  const isCustomSelected = typeof selected === 'string' && selected.toLowerCase().startsWith('custom:');
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
      ${includeCustom ? `
        <div class="custom-row" data-sc-custom="${escapeAttr(field)}" ${isCustomSelected ? '' : 'hidden'}>
          <input type="text" placeholder="Custom value..." value="${escapeAttr(isCustomSelected ? selected.slice(7).trim() : '')}" />
        </div>
      ` : ''}
    </div>
  `;
}

function wireSingleChoiceBlock({ field, includeCustom = true, inputOnly = false }) {
  const scope = document.querySelector(`[data-sc-field="${CSS.escape(field)}"]`);
  if (!scope) return;
  if (inputOnly) {
    const input = scope.querySelector('input');
    if (!input) return;
    input.addEventListener('input', () => {
      const value = input.value.trim();
      if (value === '') {
        delete state.answers[field];
      } else {
        state.answers[field] = value;
      }
      saveAnswersDebounced();
    });
    return;
  }
  scope.querySelectorAll('.option').forEach((node) => {
    node.addEventListener('click', () => {
      scope.querySelectorAll('.option').forEach((opt) => opt.classList.remove('checked'));
      node.classList.add('checked');
      node.querySelector('input').checked = true;
      const value = node.dataset.value;
      const customRow = includeCustom ? scope.querySelector(`[data-sc-custom="${CSS.escape(field)}"]`) : null;
      if (value === 'Custom' && customRow) {
        customRow.hidden = false;
        const input = customRow.querySelector('input');
        setTimeout(() => input.focus(), 40);
        input.addEventListener('input', () => {
          state.answers[field] = input.value.trim() ? `Custom: ${input.value.trim()}` : 'Custom';
          saveAnswersDebounced();
        });
      } else {
        if (customRow) customRow.hidden = true;
        state.answers[field] = value;
        saveAnswersDebounced();
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
    saveAnswersDebounced();
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
      saveAnswersDebounced();
    });
  });
}

const RESEARCH_SOURCE_GROUPS = [
  {
    key: 'portals',
    title: 'Listing portals',
    note: 'Drives /home-ops scan. If you leave this group empty, Home-Ops uses every supported portal.',
    sources: [
      { key: 'zillow', label: 'Zillow' },
      { key: 'redfin', label: 'Redfin' },
      { key: 'realtor', label: 'Realtor.com' },
      { key: 'homes', label: 'Homes.com' },
    ],
  },
  {
    key: 'sentiment',
    title: 'Neighborhood sentiment',
    note: 'Drives /home-ops deep and the sentiment extract. Leave empty to skip neighborhood sentiment entirely.',
    sources: [
      { key: 'reddit', label: 'Reddit (local subreddits)' },
      { key: 'nextdoor', label: 'Nextdoor' },
      { key: 'facebook', label: 'Facebook neighborhood groups' },
      { key: 'google_maps', label: 'Google Maps reviews' },
    ],
  },
  {
    key: 'schools',
    title: 'Schools',
    note: 'Drives school-metadata capture (rating, enrollment, demographics) for the final PDF and the school hard-requirement gate. Leave empty to skip school lookups.',
    sources: [
      { key: 'greatschools', label: 'GreatSchools' },
    ],
  },
  {
    key: 'development',
    title: 'Development and infrastructure',
    note: 'Drives construction-pressure checks for road projects, rezonings, and subdivisions near a listing.',
    sources: [
      { key: 'state_dot', label: 'State DOT project list' },
    ],
  },
];

function collectCurrentResearchSources() {
  // Everything starts OFF -- the buyer picks sources from scratch.
  const result = {};
  for (const group of RESEARCH_SOURCE_GROUPS) {
    for (const source of group.sources) {
      result[`${group.key}.${source.key}`] = false;
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
      saveAnswersDebounced();
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
        saveAnswersDebounced();
      });
    });
  });

  ['n-wants', 'n-avoids', 'n-family', 'n-notes', 'n-aggr'].forEach((id) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.addEventListener('input', () => { readNarrative(); saveAnswersDebounced(); });
    node.addEventListener('change', () => { readNarrative(); saveAnswersDebounced(); });
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
  const areas = state.answers.areas_selection;
  if (areas) {
    if (areas.state) push('State', areas.state);
    if (areas.counties?.length) push('Counties', areas.counties);
    if (areas.cities?.length) {
      push('Cities', areas.cities.map((c) => `${c.name}${c.county ? ` (${c.county})` : ''}`));
    }
  }
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
  push('School min', state.answers.schools_min_rating);
  push('Max DOM', state.answers.max_listing_age);
  if (Array.isArray(state.answers.commute)) {
    const rendered = state.answers.commute
      .map((d) => {
        if (typeof d === 'string') return d;
        const head = d.label ? `${d.label}: ` : '';
        const tail = [d.address, d.county ? `${d.county} County` : '', d.state].filter(Boolean).join(', ');
        return `${head}${tail}`.trim();
      })
      .filter(Boolean);
    if (rendered.length) push('Commute destinations', rendered);
  }
  if (state.answers.research_sources && Object.keys(state.answers.research_sources).length) {
    const on = Object.entries(state.answers.research_sources).filter(([, value]) => value).map(([key]) => key);
    if (on.length) lines.push(`Research sources: ${on.join(', ')}`);
    else lines.push('Research sources: (none selected -- defaults handled per group)');
  }
  if (state.answers.sentiment_weights) lines.push(`Neighborhood weights: ${JSON.stringify(state.answers.sentiment_weights)}`);
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
  state.visitedSteps.add(state.stepIndex);
  // Capture focus state so loads that complete mid-typing don't eject the
  // user's cursor. We look for a stable data-field + row index (commute) or
  // an id, then restore focus + selection after the re-render.
  const focusSnapshot = captureFocusSnapshot();
  CURRENT_STEP.render();
  document.getElementById('step-label').textContent = `Step ${state.stepIndex + 1} -- ${CURRENT_STEP.title.replace(/\.$/, '')}`;
  document.getElementById('step-total').textContent = `of ${STEPS.length}`;
  document.getElementById('progress-fill').style.width = `${((state.stepIndex + 1) / STEPS.length) * 100}%`;
  renderBreadcrumbs();
  const onReview = !!CURRENT_STEP.isReview;
  document.getElementById('submit-btn').hidden = !onReview;
  const backBtn = document.getElementById('back-btn');
  const nextBtn = document.getElementById('next-btn');
  if (backBtn) backBtn.disabled = state.stepIndex === 0;
  if (nextBtn) nextBtn.hidden = onReview || state.stepIndex >= STEPS.length - 1;
  restoreFocusSnapshot(focusSnapshot);

  // If the user was mid-typing in a commute county field when a data load
  // completed, re-dispatch an input event so the autocomplete menu reopens
  // against the fresh pool without requiring another keystroke.
  const refocused = document.activeElement;
  if (refocused?.matches?.('.commute-row-editor input[data-field="county"]')) {
    if ((refocused.value ?? '').trim().length > 0) {
      refocused.dispatchEvent(new Event('input'));
    }
  }
}

function captureFocusSnapshot() {
  const active = document.activeElement;
  if (!active || active === document.body) return null;
  const snapshot = { selectionStart: active.selectionStart ?? null, selectionEnd: active.selectionEnd ?? null };
  if (active.id) {
    snapshot.kind = 'id';
    snapshot.id = active.id;
  } else if (active.matches?.('.commute-row-editor input[data-field]')) {
    const row = active.closest('.commute-row-editor');
    snapshot.kind = 'commute';
    snapshot.rowIndex = row?.dataset.commuteIndex;
    snapshot.field = active.dataset.field;
  } else {
    return null;
  }
  return snapshot;
}

function restoreFocusSnapshot(snapshot) {
  if (!snapshot) return;
  let node = null;
  if (snapshot.kind === 'id') {
    node = document.getElementById(snapshot.id);
  } else if (snapshot.kind === 'commute') {
    const row = document.querySelector(`.commute-row-editor[data-commute-index="${snapshot.rowIndex}"]`);
    node = row?.querySelector(`input[data-field="${snapshot.field}"]`);
  }
  if (!node) return;
  node.focus();
  if (typeof snapshot.selectionStart === 'number' && typeof snapshot.selectionEnd === 'number') {
    try { node.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd); } catch { /* non-text input */ }
  }
}

function renderBreadcrumbs() {
  const nav = document.getElementById('breadcrumbs');
  if (!nav) return;
  // A crumb is reachable when its index is at or before the step immediately
  // after the furthest visited step -- that lets the user advance forward one
  // step at a time (replacing the old Next button) without skipping ahead.
  const maxVisited = Math.max(...state.visitedSteps);
  const reachableThrough = Math.min(maxVisited + 1, STEPS.length - 1);
  const items = STEPS.map((step, index) => {
    const isCurrent = index === state.stepIndex;
    const isReachable = index <= reachableThrough;
    const classes = ['crumb'];
    if (isCurrent) classes.push('current');
    if (isReachable) classes.push('reachable'); else classes.push('locked');
    const disabled = !isReachable || isCurrent ? 'disabled' : '';
    const shortTitle = step.title.replace(/[?.].*/, '').trim();
    return `
      <button type="button" class="${classes.join(' ')}" data-step="${index}" ${disabled}
        aria-current="${isCurrent ? 'step' : 'false'}"
        title="${escapeAttr(step.title)}">
        <span class="crumb-num">${index + 1}</span>
        <span class="crumb-label">${escapeHtml(shortTitle)}</span>
      </button>
    `;
  }).join('');
  nav.innerHTML = items;
  nav.querySelectorAll('.crumb:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = Number.parseInt(btn.dataset.step, 10);
      if (!Number.isFinite(target) || target === state.stepIndex) return;
      commitCurrentStep();
      saveAnswersDebounced();
      state.stepIndex = target;
      renderStep();
    });
  });
}

function commitCurrentStep() {
  if (CURRENT_STEP.read) CURRENT_STEP.read();
}

let saveTimer = null;
function saveAnswersDebounced() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fetch('/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: state.answers }),
    }).catch(() => { /* best-effort */ });
  }, 400);
}

async function bootstrap() {
  try {
    const res = await fetch('/api/profile');
    const body = await res.json();
    state.profile = body.profile ?? {};
    // savedAnswers take precedence for fields that are not yet ingested into
    // config/profile.yml -- this is what keeps re-opening the wizard from
    // wiping selections between sessions.
    if (body.savedAnswers?.answers) {
      state.answers = { ...body.savedAnswers.answers };
      // Guard against legacy state values (e.g. "NC") that were saved before
      // the full-name requirement -- Wikipedia needs the full state name.
      const areas = state.answers.areas_selection;
      if (areas && typeof areas.state === 'string' && /^[A-Z]{2}$/.test(areas.state.trim())) {
        areas.state = '';
        areas.counties = [];
        areas.cities = [];
      }
    }
  } catch (error) {
    console.warn('Unable to load current profile, starting blank.', error);
    state.profile = {};
  }
  // Seed visitedSteps from any previously-saved answers so re-opening the
  // wizard lets you jump straight to a later step via breadcrumbs. We consider
  // a step "visited" if its primary answer key already has a value.
  const stepAnswerKeys = {
    areas: 'areas_selection', price: 'price',
    'beds-baths': 'beds_min', size: 'sqft_min',
    'home-type': 'home_type_preference', financial: 'hoa_max',
    schools: 'schools_min_rating', commute: 'commute',
    'research-sources': 'research_sources',
    'sentiment-weights': 'sentiment_weights',
    narrative: 'narrative',
  };
  STEPS.forEach((step, index) => {
    const key = stepAnswerKeys[step.id];
    if (key && state.answers[key] !== undefined && state.answers[key] !== null) {
      state.visitedSteps.add(index);
    }
  });

  renderStep();
  document.getElementById('submit-btn').addEventListener('click', submit);
  document.getElementById('back-btn').addEventListener('click', () => {
    if (state.stepIndex === 0) return;
    commitCurrentStep();
    saveAnswersDebounced();
    state.stepIndex -= 1;
    renderStep();
  });
  document.getElementById('next-btn').addEventListener('click', () => {
    if (state.stepIndex >= STEPS.length - 1) return;
    commitCurrentStep();
    saveAnswersDebounced();
    state.stepIndex += 1;
    renderStep();
  });

  // Let users press ArrowLeft / ArrowRight while focused on nothing in
  // particular to step through the wizard. Forward is gated to the same
  // "reachable" rule used by the breadcrumbs (current maxVisited + 1).
  document.addEventListener('keydown', (event) => {
    if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    if (event.key === 'ArrowLeft' && state.stepIndex > 0) {
      commitCurrentStep();
      saveAnswersDebounced();
      state.stepIndex -= 1;
      renderStep();
    } else if (event.key === 'ArrowRight' && state.stepIndex < STEPS.length - 1) {
      const maxVisited = Math.max(...state.visitedSteps);
      const target = state.stepIndex + 1;
      if (target <= maxVisited + 1) {
        commitCurrentStep();
        saveAnswersDebounced();
        state.stepIndex = target;
        renderStep();
      }
    }
  });
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
