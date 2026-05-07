#!/usr/bin/env node

/**
 * generate-portals.mjs -- Build portals.yml from config/profile.yml.
 *
 * Resolves each profile search area into platform-specific search URLs using
 * config/city-registry.yml. Unknown cities fall back to zipcode-based URLs
 * (Redfin) or derived slugs (Zillow, Realtor.com) and a warning is printed.
 *
 * portals.yml is gitignored and treated as generated. Rerun this script any
 * time config/profile.yml changes. The profile mode invokes it automatically.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';

import { slugify as slugifyLower } from '../shared/text-utils.mjs';
import { ROOT, OUTPUT_DIR, PROFILE_PATH, PORTALS_PATH } from '../shared/paths.mjs';

const REGISTRY_PATH = join(ROOT, 'config', 'city-registry.yml');
const DEVELOPMENT_SOURCES_OUTPUT = join(OUTPUT_DIR, 'development-sources.json');
const STATE_SOURCES_OUTPUT = join(OUTPUT_DIR, 'state-sources.json');

const STATE_RESEARCH_DEFAULTS = {
  NC: {
    reddit_subreddits: ['r/raleigh', 'r/bullcity', 'r/NorthCarolina', 'r/triangle'],
    state_report_card: {
      url: 'https://ncreports.ondemand.sas.com/dashboard',
      note: 'NC School Report Cards -- operated by NCDPI.',
    },
    transportation: [
      {
        name: 'NCDOT STIP Projects',
        url: 'https://www.ncdot.gov/projects/state-transportation-improvement-program/Pages/default.aspx',
        layers: [
          {
            name: 'NCDOT STIP points',
            url: 'https://gis11.services.ncdot.gov/arcgis/rest/services/NCDOT_STIP/MapServer/0',
            geometryType: 'point',
          },
          {
            name: 'NCDOT STIP lines',
            url: 'https://gis11.services.ncdot.gov/arcgis/rest/services/NCDOT_STIP/MapServer/1',
            geometryType: 'line',
          },
        ],
      },
      {
        name: 'CAMPO (Capital Area MPO)',
        url: 'https://www.campo-nc.us/',
      },
    ],
    counties: {
      Wake: {
        name: 'Wake County Planning, Development & Inspections',
        url: 'https://www.wake.gov/departments-government/planning-development-inspections',
      },
      Harnett: {
        name: 'Harnett County Planning Services',
        url: 'https://www.harnett.org/planning/',
      },
      Durham: {
        name: 'Durham County Planning',
        url: 'https://www.dconc.gov/county-departments/departments-f-z/planning',
      },
      Johnston: {
        name: 'Johnston County Planning',
        url: 'https://www.johnstonnc.com/mainsite2/content.cfm?pd=12',
      },
      Chatham: {
        name: 'Chatham County Planning',
        url: 'https://www.chathamcountync.gov/government/departments-programs/planning',
      },
      Orange: {
        name: 'Orange County Planning',
        url: 'https://www.orangecountync.gov/139/Planning-Inspections',
      },
    },
    municipalities: {
      'holly springs': {
        name: 'Holly Springs Interactive Development Activity Map',
        url: 'https://hollyspringsnc.gov/321/Maps',
        note: 'Use the Development Activity Map / Interactive Development Activity Map for proposed, approved, and under-construction projects.',
        lookupMethods: ['address', 'parcel', 'project-name', 'nearby-road'],
      },
      'fuquay-varina': {
        name: 'Fuquay-Varina Interactive Development Map',
        url: 'https://fuquay-varina.org/304/Whats-Coming-to-Fuquay-Varina',
        note: 'Use the interactive development map and project tabs for proposed, approved, under-construction, and completed projects.',
        lookupMethods: ['address', 'parcel', 'project-name', 'nearby-road'],
      },
      apex: {
        name: 'Apex Interactive Development Map',
        url: 'https://www.apexnc.org/659/View',
        note: 'Use the development map for proposed, approved, and under-construction projects.',
        lookupMethods: ['address', 'parcel', 'project-name', 'nearby-road'],
      },
      cary: {
        name: 'Cary Planning & Development Services',
        url: 'https://www.carync.gov/services-publications/planning-development',
      },
      raleigh: {
        name: 'Raleigh Planning & Development',
        url: 'https://raleighnc.gov/planning',
      },
      durham: {
        name: 'Durham City-County Planning',
        url: 'https://www.durhamnc.gov/228/City-County-Planning',
      },
      morrisville: {
        name: 'Morrisville Planning',
        url: 'https://www.townofmorrisville.org/government/departments/planning',
      },
      'wake forest': {
        name: 'Wake Forest Planning',
        url: 'https://www.wakeforestnc.gov/departments/planning',
      },
    },
    property_permits: {
      Wake: [
        {
          name: 'Wake County Permit Search (pre-2018)',
          url: 'https://permitsearch.wake.gov/',
          jurisdiction: 'Wake County',
          lookupMethods: ['address', 'pin', 'owner', 'permit-number'],
          note: 'Historical Wake County permit search. Page states post-7/1/2018 records should be checked in the Wake County Permit Portal.',
        },
        {
          name: 'Wake County Permit Portal (EnerGov SelfService)',
          url: 'https://wakecountync-energovpub.tylerhost.net/apps/SelfService#/search',
          jurisdiction: 'Wake County',
          lookupMethods: ['address', 'pin', 'permit-number'],
          note: 'Use for current county-issued permit records. Populate the search bar with the target service address before extracting permit, inspection, applicant, contractor, builder, or owner details; municipal addresses may also need the city portal.',
        },
      ],
    },
    municipal_property_permits: {
      'holly springs': {
        name: 'Holly Springs CityView Portal',
        url: 'https://cityview.hollyspringsnc.us/portal',
        jurisdiction: 'Town of Holly Springs',
        lookupMethods: ['service-address', 'permit-number', 'application-search', 'property-search'],
        note: 'Public portal exposes Building & UDO permit application search and property search.',
      },
      'fuquay-varina': {
        name: 'Fuquay-Varina ePermits',
        url: 'https://esuite.fuquay-varina.org/esuite.permits/',
        jurisdiction: 'Town of Fuquay-Varina',
        lookupMethods: ['service-address', 'permit-number'],
        note: 'Public Information Search supports service-address and permit-number lookups.',
      },
      apex: {
        name: 'Apex ePermits Public Information Search',
        url: 'https://apexnc.org/183/Building-Inspections-Permits',
        jurisdiction: 'Town of Apex',
        lookupMethods: ['address', 'permit-number'],
        note: 'Town guidance says public users can search by permit number or address for issued permits and inspection results.',
      },
      cary: {
        name: 'Cary Click2Gov Permit Portal',
        url: 'https://www.carync.gov/services-publications/click2gov-landing-page',
        jurisdiction: 'Town of Cary',
        lookupMethods: ['address', 'permit-number', 'inspection-results'],
        note: 'Cary Click2Gov provides permit search, inspection scheduling, and inspection results.',
      },
      durham: {
        name: 'Durham LDO Application/Permit Search',
        url: 'https://ldo4.durhamnc.gov/DurhamWeb/Search/ApplicationSearchResults',
        jurisdiction: 'City of Durham',
        lookupMethods: ['application-permit', 'related-permit-summary', 'parcel-address-pin-owner', 'inspection'],
        note: 'Search does not require login. Use Application/Permit for direct permit records, Parcel by Parcel ID/PIN/Address/Owner Name when address search is thin, and Inspection for inspection history.',
      },
    },
  },
};

function readYaml(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing required file: ${path}`);
  }
  return YAML.parse(readFileSync(path, 'utf8')) ?? {};
}

function optionalYaml(path) {
  if (!existsSync(path)) {
    return {};
  }
  return YAML.parse(readFileSync(path, 'utf8')) ?? {};
}

function normalizeKey(name, state) {
  return `${String(name ?? '').trim().toLowerCase()}|${String(state ?? '').trim().toLowerCase()}`;
}

function slugifyTitleDashed(value) {
  return String(value ?? '')
    .trim()
    .split(/[\s_]+/)
    .map((part) => part.replace(/[^A-Za-z0-9-]/g, ''))
    .filter(Boolean)
    .map((part) => {
      const segments = part.split('-').filter(Boolean);
      return segments
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
        .join('-');
    })
    .join('-');
}

function buildRegistryIndex(registry) {
  const index = new Map();
  for (const entry of registry.cities ?? []) {
    if (!entry?.name || !entry?.state) {
      continue;
    }
    const keys = new Set([normalizeKey(entry.name, entry.state)]);
    for (const alias of entry.aliases ?? []) {
      keys.add(normalizeKey(alias, entry.state));
    }
    for (const key of keys) {
      index.set(key, entry);
    }
  }
  return index;
}

function resolvePlatformSlugs(area, registryEntry) {
  const name = area.name;
  const state = (area.state ?? 'NC').toUpperCase();

  const zillowSlug = registryEntry?.zillow_slug
    ?? `${slugifyLower(name)}-${state.toLowerCase()}`;
  const realtorSlug = registryEntry?.realtor_slug
    ?? `${slugifyTitleDashed(name)}_${state}`;
  const redfinCityId = registryEntry?.redfin_city_id ?? null;
  const redfinSlug = registryEntry?.redfin_slug ?? slugifyTitleDashed(name);
  const primaryZip = registryEntry?.primary_zip ?? null;

  return { state, zillowSlug, realtorSlug, redfinCityId, redfinSlug, primaryZip };
}

function zillowUrl(slugs) {
  return `https://www.zillow.com/${slugs.zillowSlug}/houses/`;
}

function realtorUrl(slugs) {
  return `https://www.realtor.com/realestateandhomes-search/${slugs.realtorSlug}`;
}

function redfinUrl(slugs, warnings, areaName) {
  if (slugs.redfinCityId) {
    return `https://www.redfin.com/city/${slugs.redfinCityId}/${slugs.state}/${slugs.redfinSlug}`;
  }
  if (slugs.primaryZip) {
    return `https://www.redfin.com/zipcode/${slugs.primaryZip}`;
  }
  warnings.push(
    `No Redfin city_id or primary_zip for "${areaName}". Add an entry to config/city-registry.yml so scan has a working Redfin search URL.`,
  );
  return `https://www.redfin.com/city/search?q=${encodeURIComponent(`${areaName}, ${slugs.state}`)}`;
}

function homesUrl(slugs) {
  // Use the bare /{slug}/ path, not /houses-for-sale/. The /houses-for-sale/
  // segment is a SFH filter that also drops Coming Soon listings; the syncer
  // adds /resale/ and /N-to-M-bedroom/ path segments on its own.
  return `https://www.homes.com/${slugs.zillowSlug}/`;
}

const PORTAL_DEFINITIONS = {
  zillow: {
    name: 'Zillow',
    base_url: 'https://www.zillow.com',
    login_prompt:
      'I need the saved Zillow browser session. Run /home-ops init --zillow if needed, sign in manually in the hosted Chrome window, then confirm.',
    buildUrl: (slugs) => zillowUrl(slugs),
  },
  redfin: {
    name: 'Redfin',
    base_url: 'https://www.redfin.com',
    login_prompt:
      'I need the saved Redfin browser session. Run /home-ops init --redfin if needed, sign in manually in the hosted Chrome window, then confirm.',
    buildUrl: (slugs, warnings, areaName) => redfinUrl(slugs, warnings, areaName),
  },
  realtor: {
    name: 'Realtor.com',
    base_url: 'https://www.realtor.com',
    login_prompt:
      'I need the saved Realtor.com browser session. Run /home-ops init --relator if needed, sign in manually in the hosted Chrome window, then confirm.',
    buildUrl: (slugs) => realtorUrl(slugs),
  },
  homes: {
    name: 'Homes.com',
    base_url: 'https://www.homes.com',
    login_prompt:
      'I need the saved Homes.com browser session. Run /home-ops init --homes if needed, sign in manually in the hosted Chrome window, then confirm.',
    buildUrl: (slugs) => homesUrl(slugs),
  },
};

const DEFAULT_PORTAL_SELECTION = { zillow: true, redfin: true, realtor: true, homes: false };
const ALL_PORTALS_ON = { zillow: true, redfin: true, realtor: true, homes: true };

function resolvePortalSelection(profile) {
  const configured = profile?.research_sources?.portals;
  if (!configured || typeof configured !== 'object') {
    return { ...DEFAULT_PORTAL_SELECTION };
  }
  const resolved = { ...DEFAULT_PORTAL_SELECTION };
  for (const key of Object.keys(PORTAL_DEFINITIONS)) {
    if (key in configured) {
      resolved[key] = Boolean(configured[key]);
    }
  }
  // If the buyer opted everything off, fall back to every supported portal
  // instead of emitting an empty portals.yml that would leave /home-ops scan
  // with nothing to query.
  if (Object.values(resolved).every((value) => value === false)) {
    return { ...ALL_PORTALS_ON };
  }
  return resolved;
}

function buildPlatforms(areas, registryIndex, warnings, selection) {
  const platforms = {};
  for (const [key, definition] of Object.entries(PORTAL_DEFINITIONS)) {
    if (!selection[key]) continue;
    const searches = areas.map((area) => {
      const registryEntry = registryIndex.get(normalizeKey(area.name, area.state ?? 'NC'));
      if (!registryEntry && key === 'zillow') {
        warnings.push(
          `"${area.name}, ${area.state ?? '??'}" is not in config/city-registry.yml. Falling back to derived slugs -- verify the generated URLs.`,
        );
      }
      const slugs = resolvePlatformSlugs(area, registryEntry);
      return { area: area.name, url: definition.buildUrl(slugs, warnings, area.name) };
    });
    platforms[key] = {
      name: definition.name,
      base_url: definition.base_url,
      login_required: true,
      login_prompt: definition.login_prompt,
      search_urls: searches,
    };
  }
  return platforms;
}

const DEFAULT_SENTIMENT_SELECTION = { nextdoor: true, facebook: true, google_maps: true, twitter: false };
const DEFAULT_SCHOOL_SELECTION = { greatschools: true, niche: true, state_report_cards: true, schooldigger: false };
const DEFAULT_DEVELOPMENT_SELECTION = { state_dot: true, county_planning: true, municipal_planning: true, mpo: false };

function resolveGroupSelection(profile, group, defaults) {
  const configured = profile?.research_sources?.[group];
  if (!configured || typeof configured !== 'object') {
    return { ...defaults };
  }
  const resolved = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (key in configured) {
      resolved[key] = Boolean(configured[key]);
    }
  }
  return resolved;
}

function buildResearchSources(areas, profile) {
  const states = new Set(areas.map((area) => (area.state ?? 'NC').toUpperCase()));
  const primaryState = areas[0]?.state?.toUpperCase() ?? 'NC';
  const defaults = STATE_RESEARCH_DEFAULTS[primaryState];

  const sentimentSelection = resolveGroupSelection(profile, 'sentiment', DEFAULT_SENTIMENT_SELECTION);
  const schoolSelection = resolveGroupSelection(profile, 'schools', DEFAULT_SCHOOL_SELECTION);
  const developmentSelection = resolveGroupSelection(profile, 'development', DEFAULT_DEVELOPMENT_SELECTION);

  const countyNames = new Set();
  for (const area of areas) {
    for (const segment of String(area.county ?? '').split(',')) {
      const trimmed = segment.trim();
      if (trimmed) {
        countyNames.add(trimmed);
      }
    }
  }

  const municipalities = [];
  if (defaults?.municipalities) {
    const seen = new Set();
    for (const area of areas) {
      const key = area.name.toLowerCase();
      const match = defaults.municipalities[key];
      if (match && !seen.has(match.url)) {
        municipalities.push(match);
        seen.add(match.url);
      }
    }
  }

  const counties = [];
  if (defaults?.counties) {
    for (const county of countyNames) {
      const match = defaults.counties[county];
      if (match) {
        counties.push(match);
      }
    }
  }

  const sentimentSources = {};
  if (sentimentSelection.google_maps) {
    sentimentSources.google_maps = {
      login_required: false,
      note: `Use local review patterns for subdivisions, schools, parks, and anchor businesses around ${areas.map((area) => area.name).join(', ') || 'the configured areas'}.`,
    };
  }
  if (sentimentSelection.facebook) {
    sentimentSources.facebook = {
      base_url: 'https://www.facebook.com/',
      login_required: true,
      lookback_days: 7,
      login_prompt:
        'I need Facebook login to search for local neighborhood groups. Please log in and confirm.',
      note: 'Search the subdivision name, nearby schools, and major roads. Prefer the last 7 days of posts and comments.',
    };
  }
  if (sentimentSelection.nextdoor) {
    sentimentSources.nextdoor = {
      base_url: 'https://nextdoor.com/',
      login_required: true,
      lookback_days: 7,
      login_prompt:
        'I need Nextdoor login to view neighborhood discussion. Please log in and confirm.',
      note: 'Use recent neighborhood posts for traffic, construction, safety, noise, and community-maintenance signals.',
    };
  }
  if (sentimentSelection.twitter) {
    sentimentSources.twitter = {
      base_url: 'https://x.com/',
      login_required: true,
      lookback_days: 7,
      login_prompt:
        'I need Twitter/X login to search for local neighborhood discussion. Please log in and confirm.',
      note: 'Search neighborhood name + city for recent local observations, safety reports, and community events.',
    };
  }

  const schoolSources = {};
  if (schoolSelection.greatschools) {
    schoolSources.greatschools = { url: 'https://www.greatschools.org', login_required: false };
  }
  if (schoolSelection.niche) {
    schoolSources.niche = { url: 'https://www.niche.com', login_required: false };
  }
  if (schoolSelection.state_report_cards) {
    schoolSources.state_report_cards = {
      url: defaults?.state_report_card?.url ?? 'https://nces.ed.gov/ccd/schoolsearch/',
      login_required: false,
    };
    if (defaults?.state_report_card?.note) {
      schoolSources.state_report_cards.note = defaults.state_report_card.note;
    }
  }
  if (schoolSelection.schooldigger) {
    schoolSources.schooldigger = { url: 'https://www.schooldigger.com', login_required: false };
  }
  if (schoolSelection.greatschools && primaryState === 'NC' && [...states].every((s) => s === 'NC')) {
    schoolSources.wcpss = {
      url: 'https://www.wcpss.net/domain/12171',
      login_required: false,
      note: 'Wake County Public School System -- base assignment, magnet, and calendar options.',
    };
  }

  const developmentSources = {};
  if (developmentSelection.county_planning) {
    developmentSources.county = counties.length > 0 ? counties : [
      { name: 'Local County Planning (add entry in config/city-registry.yml context)', url: '' },
    ];
  }
  if (developmentSelection.municipal_planning) {
    developmentSources.municipality = municipalities.length > 0 ? municipalities : [
      { name: 'Municipal Planning (add entry)', url: '' },
    ];
  }
  if (developmentSelection.state_dot) {
    developmentSources.transportation = defaults?.transportation ?? [
      { name: 'State DOT Projects', url: '' },
    ];
  }
  if (developmentSelection.mpo) {
    const mpoEntry = (defaults?.transportation ?? []).find((entry) => /mpo/i.test(entry.name));
    developmentSources.mpo = mpoEntry
      ? [mpoEntry]
      : [{ name: 'Regional MPO (add entry)', url: '' }];
  }

  return { sentimentSources, schoolSources, developmentSources };
}

function buildGeneratedResearchInventories(areas, profile, research) {
  const states = [...new Set(areas.map((area) => area.state || 'NC'))];
  const generatedAt = new Date().toISOString();

  const stateSources = {
    generatedAt,
    states: {},
  };

  for (const state of states) {
    const defaults = STATE_RESEARCH_DEFAULTS[state] ?? {};
    stateSources.states[state] = {
      transportation: (defaults.transportation ?? []).map((source) => ({
        ...source,
        sourceLevel: 'state',
        recommendedUse: /ncdot|stip/i.test(`${source.name ?? ''} ${source.url ?? ''}`)
          ? 'Spatially query official STIP layers near the home, then cite TIP/SPOT ID, route, description, right-of-way year, construction year, and comment.'
          : 'Use as a regional transportation planning context source after direct spatial matches are checked.',
      })),
    };
  }

  const municipalityDefaults = {};
  const countyDefaults = {};
  const propertyPermitDefaults = {};
  const municipalPropertyPermitDefaults = {};
  for (const state of states) {
    const defaults = STATE_RESEARCH_DEFAULTS[state] ?? {};
    Object.assign(municipalityDefaults, defaults.municipalities ?? {});
    Object.assign(countyDefaults, defaults.counties ?? {});
    Object.assign(propertyPermitDefaults, defaults.property_permits ?? {});
    Object.assign(municipalPropertyPermitDefaults, defaults.municipal_property_permits ?? {});
  }

  const profileResearch = profile?.research_sources?.development ?? {};
  const developmentSources = {
    generatedAt,
    enabled: {
      stateDot: profileResearch.state_dot === true,
      countyPlanning: profileResearch.county_planning === true,
      municipalPlanning: profileResearch.municipal_planning === true,
    },
    profileAreas: areas.map((area) => ({
      name: area.name,
      state: area.state,
      county: area.county,
      rank: area.rank ?? null,
    })),
    counties: [],
    municipalities: [],
    propertyPermitSources: [],
    sourceNotes: [
      'Development maps are for nearby project pressure; property permit sources are for work permitted on the specific home/address.',
      'When searching home permit history, use service address, permit number, PIN/parcel, and owner names where supported. Older and newer permits may live in different systems.',
    ],
  };

  const countySeen = new Set();
  const municipalitySeen = new Set();
  const propertyPermitSeen = new Set();

  for (const area of areas) {
    const countyKey = String(area.county ?? '').trim();
    const countyDefault = countyDefaults[countyKey];
    if (countyDefault && !countySeen.has(countyKey)) {
      countySeen.add(countyKey);
      developmentSources.counties.push({
        key: countyKey.toLowerCase(),
        state: area.state,
        ...countyDefault,
        sourceLevel: 'county',
        lookupMethods: ['address', 'parcel', 'pin', 'case-id', 'subdivision', 'nearby-road'],
      });
    }

    const countyPermitSources = propertyPermitDefaults[countyKey] ?? [];
    for (const source of countyPermitSources) {
      const key = `${source.name}|${source.url}`;
      if (!propertyPermitSeen.has(key)) {
        propertyPermitSeen.add(key);
        developmentSources.propertyPermitSources.push({
          ...source,
          sourceLevel: 'county',
          appliesTo: countyKey,
        });
      }
    }

    const municipalityKey = String(area.name ?? '').trim().toLowerCase();
    const municipalityDefault = municipalityDefaults[municipalityKey];
    if (municipalityDefault && !municipalitySeen.has(municipalityKey)) {
      municipalitySeen.add(municipalityKey);
      developmentSources.municipalities.push({
        key: municipalityKey,
        city: area.name,
        state: area.state,
        ...municipalityDefault,
        sourceLevel: 'municipal',
      });
    }

    const municipalPermitDefault = municipalPropertyPermitDefaults[municipalityKey];
    if (municipalPermitDefault) {
      const key = `${municipalPermitDefault.name}|${municipalPermitDefault.url}`;
      if (!propertyPermitSeen.has(key)) {
        propertyPermitSeen.add(key);
        developmentSources.propertyPermitSources.push({
          ...municipalPermitDefault,
          sourceLevel: 'municipal',
          appliesTo: area.name,
        });
      }
    }
  }

  // Keep the exact generated portals development sources here too so consumers
  // can cite the profile-selected inventory without reparsing YAML.
  developmentSources.portalInventory = research.developmentSources;

  return { developmentSources, stateSources };
}

function buildSearchQueries(areas, hardRequirements, selection, scanKeywords = [], scanNegativeKeywords = []) {
  const priceMin = Number.parseInt(hardRequirements?.price_min ?? 0, 10);
  const priceMax = Number.parseInt(hardRequirements?.price_max ?? 0, 10);
  const bedsMin = Number.parseFloat(hardRequirements?.beds_min ?? 0);
  const bathsMin = Number.parseFloat(hardRequirements?.baths_min ?? 0);
  const sqftMin = Number.parseInt(hardRequirements?.sqft_min ?? 0, 10);
  const garageMin = Number.parseInt(hardRequirements?.garage_min ?? 0, 10);
  const formatPrice = (value) => `$${Number(value).toLocaleString('en-US')}`;
  const priceFragment = priceMin && priceMax
    ? `${formatPrice(priceMin)} ${formatPrice(priceMax)}`
    : '';
  const bedsFragment = bedsMin ? `${bedsMin} bed` : '';
  const bathsFragment = bathsMin ? `${bathsMin} bath` : '';
  const sqftFragment = sqftMin ? `${sqftMin}+ sqft` : '';
  const garageFragment = garageMin ? `${garageMin}-car garage` : '';

  const topKeywords = Array.isArray(scanKeywords) ? scanKeywords.slice(0, 4) : [];
  const topNegatives = Array.isArray(scanNegativeKeywords) ? scanNegativeKeywords.slice(0, 3) : [];
  const keywordFragment = topKeywords.map((term) => `"${term}"`).join(' ');
  const negativeFragment = topNegatives.map((term) => `-"${term}"`).join(' ');

  const allPlatforms = [
    { key: 'zillow', label: 'Zillow', host: 'zillow.com' },
    { key: 'redfin', label: 'Redfin', host: 'redfin.com' },
    { key: 'realtor', label: 'Realtor.com', host: 'realtor.com' },
    { key: 'homes', label: 'Homes.com', host: 'homes.com' },
  ];
  const platforms = allPlatforms.filter((platform) => selection[platform.key]);

  const queries = [];
  for (const platform of platforms) {
    for (const area of areas) {
      const state = area.state ?? 'NC';
      const pieces = [
        `site:${platform.host}`,
        `"${area.name}, ${state}"`,
        'house',
        bedsFragment,
        bathsFragment,
        sqftFragment,
        garageFragment,
        priceFragment,
        keywordFragment,
        negativeFragment,
      ].filter(Boolean);
      queries.push({
        name: `${platform.label} -- ${area.name}`,
        query: pieces.join(' '),
        enabled: true,
      });
    }
  }
  return queries;
}

function buildPortalsDocument(profile, registry) {
  const areas = (profile.search?.areas ?? [])
    .map((entry) => ({
      name: String(entry?.name ?? '').trim(),
      state: String(entry?.state ?? 'NC').trim(),
      county: String(entry?.county ?? '').trim(),
      rank: entry?.rank ?? null,
    }))
    .filter((entry) => entry.name);

  if (areas.length === 0) {
    throw new Error(
      'config/profile.yml has no search.areas entries. Add at least one area before regenerating portals.yml.',
    );
  }

  const warnings = [];
  const registryIndex = buildRegistryIndex(registry);
  const portalSelection = resolvePortalSelection(profile);
  const platforms = buildPlatforms(areas, registryIndex, warnings, portalSelection);
  if (Object.keys(platforms).length === 0) {
    warnings.push(
      'No listing portals are enabled in research_sources.portals. Scan will have nothing to fetch.',
    );
  }
  const research = buildResearchSources(areas, profile);
  const generatedInventories = buildGeneratedResearchInventories(areas, profile, research);
  const scanKeywords = Array.isArray(profile.search?.scan_keywords) ? profile.search.scan_keywords : [];
  const scanNegativeKeywords = Array.isArray(profile.search?.scan_negative_keywords) ? profile.search.scan_negative_keywords : [];
  const queries = buildSearchQueries(
    areas,
    profile.search?.hard_requirements,
    portalSelection,
    scanKeywords,
    scanNegativeKeywords,
  );

  const document = {
    platforms,
    sentiment_sources: research.sentimentSources,
    school_sources: research.schoolSources,
    development_sources: research.developmentSources,
    search_queries: queries,
  };

  return { document, warnings, generatedInventories };
}

function serialize(document) {
  const header = [
    '# Home-Ops portals.yml',
    '#',
    '# Auto-generated by generate-portals.mjs from config/profile.yml and',
    '# config/city-registry.yml. Do not edit by hand -- run:',
    '#   node generate-portals.mjs',
    '# or',
    '#   npm run portals:generate',
    '#',
    '# Scan syncs numeric filters (price, beds, sqft, garage, listing age, HOA)',
    '# from config/profile.yml at runtime, so this file only needs the correct',
    '# base URLs and source inventories.',
    '',
  ].join('\n');

  return `${header}\n${YAML.stringify(document, { lineWidth: 0 })}`;
}

function main() {
  const profile = readYaml(PROFILE_PATH);
  const registry = optionalYaml(REGISTRY_PATH);
  const { document, warnings, generatedInventories } = buildPortalsDocument(profile, registry);
  const yamlText = serialize(document);
  writeFileSync(PORTALS_PATH, yamlText, 'utf8');
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(DEVELOPMENT_SOURCES_OUTPUT, `${JSON.stringify(generatedInventories.developmentSources, null, 2)}\n`, 'utf8');
  writeFileSync(STATE_SOURCES_OUTPUT, `${JSON.stringify(generatedInventories.stateSources, null, 2)}\n`, 'utf8');

  const platformKeys = Object.keys(document.platforms);
  const areaCount = platformKeys.length > 0 ? document.platforms[platformKeys[0]].search_urls.length : 0;
  const platformSummary = platformKeys.length > 0 ? platformKeys.join(', ') : '(none enabled)';
  console.log(`Wrote portals.yml with ${areaCount} area(s) across platforms: ${platformSummary}.`);
  console.log('Wrote output/development-sources.json and output/state-sources.json.');
  if (warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of warnings) {
      console.log(`  - ${warning}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`generate-portals.mjs failed: ${error.message}`);
  process.exit(1);
}
