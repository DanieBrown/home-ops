#!/usr/bin/env node

import assert from 'assert/strict';
import { buildPortalsDocument, readResearchDefaults } from '../config/generate-portals.mjs';
import { compileConfiguredPatterns, readResearchDefaults as readFullResearchDefaults } from '../shared/research-defaults.mjs';

const profile = {
  search: {
    areas: [
      { name: 'Apex', state: 'NC', county: 'Wake', rank: 1 },
    ],
    hard_requirements: {
      price_min: 450000,
      price_max: 700000,
      beds_min: 4,
      baths_min: 2.5,
      sqft_min: 2400,
      garage_min: 2,
    },
  },
  research_sources: {
    portals: { redfin: true, realtor: false, zillow: false, homes: false },
    development: { state_dot: true, county_planning: true, municipal_planning: true, mpo: false },
    sentiment: { google_maps: true, facebook: false, nextdoor: false, twitter: false },
    schools: { greatschools: true, niche: false, state_report_cards: true, schooldigger: false },
    utilities: { electric: false, water_sewer: false, natural_gas: false, internet: false },
  },
};

const registry = {
  cities: [
    {
      name: 'Apex',
      state: 'NC',
      redfin_city_id: 2090,
      redfin_state_path: 'NC',
      redfin_slug: 'Apex',
      realtor_slug: 'Apex_NC',
      homes_slug: 'apex-nc',
    },
  ],
};

const researchDefaults = readResearchDefaults();
assert.ok(researchDefaults.NC.transportation.some((source) => /NCDOT/i.test(source.name)));
const fullDefaults = readFullResearchDefaults();
assert.ok(fullDefaults.builder.known_builders.includes('Taylor Morrison'));
assert.ok(fullDefaults.construction.ncdot_stip_layers.some((layer) => /MapServer\/0$/.test(layer.url)));
assert.ok(fullDefaults.county_sources.counties.wake.services.some((service) => service.key === 'wake-development'));
assert.ok(fullDefaults.hoa.known_seeds.some((seed) => seed.key.includes('avocet')));
assert.ok(compileConfiguredPatterns(fullDefaults.community.invalid_patterns).some((pattern) => pattern.test('not found')));

const { document, warnings, generatedInventories } = buildPortalsDocument(profile, registry, researchDefaults);
assert.equal(warnings.length, 0);
assert.ok(document.platforms.redfin.search_urls[0].url.includes('/city/2090/NC/Apex'));
assert.equal(document.development_sources.county[0].name, 'Wake County Planning, Development & Inspections');
assert.equal(document.development_sources.municipality[0].name, 'Apex Interactive Development Map');
assert.equal(document.school_sources.state_report_cards.url, 'https://ncreports.ondemand.sas.com/dashboard');
assert.ok(generatedInventories.stateSources.states.NC.transportation.some((source) => source.sourceLevel === 'state'));
assert.ok(generatedInventories.developmentSources.propertyPermitSources.some((source) => source.appliesTo === 'Wake'));

console.log('generate-portals tests passed.');
