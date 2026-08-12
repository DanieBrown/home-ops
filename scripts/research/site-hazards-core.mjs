// scripts/research/site-hazards-core.mjs
//
// Pure parsers for the site-hazard sources. Every function takes an already
// fetched response and returns a dimension plus its sourceCoverage entry, so
// the whole capture path is testable offline against recorded fixtures.
//
// The one rule that governs all of it: a source that failed is `blocked`, and
// `blocked` is not "no hazard found".

import { haversineMeters, metersToMiles, pointInRings, round, toWebMercator } from '../shared/geo.mjs';
import { coverageEntry, dimension } from './source-coverage.mjs';

export const SOURCES = Object.freeze({
  fema: {
    key: 'fema_nfhl',
    name: 'FEMA National Flood Hazard Layer',
    url: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer',
    zonesLayer: 28,
    firmPanelLayer: 3,
  },
  wetlands: {
    key: 'usfws_nwi',
    name: 'USFWS National Wetlands Inventory',
    url: 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer',
    layer: 0,
  },
  radon: {
    key: 'epa_radon_zones',
    name: 'EPA Map of Radon Zones — North Carolina',
    url: 'https://www.epa.gov/sites/default/files/2014-08/documents/north_carolina.pdf',
    stateProgramUrl: 'https://ncdhhs.gov/divisions/health-service-regulation/north-carolina-radon-program/nc-radon-data',
  },
  epaSites: {
    key: 'epa_frs',
    name: 'EPA Facility Registry Service',
    url: 'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/FRS_INTERESTS/FeatureServer',
    layer: 0,
  },
  soil: {
    key: 'nrcs_sda',
    name: 'USDA NRCS Soil Data Access (SSURGO)',
    url: 'https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest',
  },
  airport: {
    key: 'rdu_noise_contours',
    name: 'RDU Composite Noise Contours',
    url: 'https://experience.arcgis.com/experience/9b371abfb6bd4084be571b546789ff4a',
    dataUrl: 'https://www.arcgis.com/sharing/rest/content/items/7a0bb4bbfe324c4693a7b68b8da0fade/data?f=json',
  },
});

/** EPA program acronyms that identify a genuinely contaminated site. */
const PROGRAM_LABELS = {
  SEMS: 'Superfund (SEMS)',
  'SEMS-ARCHIVE': 'Superfund, archived (SEMS)',
  ACRES: 'Brownfield (ACRES)',
  RCRAINFO: 'Hazardous waste handler (RCRAInfo)',
  NPDES: 'Wastewater discharge (NPDES)',
  AIRS_AFS: 'Air emissions (AFS)',
  TRIS: 'Toxics release (TRI)',
};
const SERIOUS_PROGRAMS = new Set(['SEMS', 'SEMS-ARCHIVE', 'ACRES']);

// ── Flood ────────────────────────────────────────────────────────────

/**
 * FEMA NFHL layer 28. SFHA_TF is the authoritative Special Flood Hazard Area
 * flag; FLD_ZONE alone is not (zone X is minimal hazard, zone X shaded is
 * 0.2% annual chance, and both read as "X").
 */
export function parseFloodZone(response, panelResponse = null) {
  const source = SOURCES.fema;
  const layerUrl = `${source.url}/${source.zonesLayer}`;

  if (!response || response.ok === false) {
    return {
      dimension: dimension({
        label: 'FEMA flood zone',
        provenance: 'blocked',
        sourceUrl: layerUrl,
        note: `FEMA NFHL query failed (${response?.error ?? 'no response'}). Flood status is unknown, not clear.`,
      }),
      coverage: coverageEntry({
        key: source.key, name: source.name, url: layerUrl, status: 'blocked',
        error: response?.error ?? 'no response',
        note: 'Flood exposure could not be checked. Treat as an open question, not an all-clear.',
      }),
      isSFHA: null,
    };
  }

  const feature = (response.features ?? [])[0];
  if (!feature) {
    return {
      dimension: dimension({
        label: 'FEMA flood zone',
        provenance: 'unconfirmed',
        sourceUrl: layerUrl,
        note: 'No NFHL polygon covers this point. The area may be unmapped rather than low risk.',
      }),
      coverage: coverageEntry({
        key: source.key, name: source.name, url: layerUrl, status: 'captured',
        note: 'NFHL returned no polygon at this coordinate — unmapped area.',
      }),
      isSFHA: null,
    };
  }

  const a = feature.attributes ?? {};
  const zone = String(a.FLD_ZONE ?? '').trim() || null;
  const subtype = String(a.ZONE_SUBTY ?? '').trim() || null;
  const isSFHA = String(a.SFHA_TF ?? '').trim().toUpperCase() === 'T';
  const bfe = Number(a.STATIC_BFE);
  const firmPanel = (panelResponse?.features ?? [])[0]?.attributes ?? null;

  return {
    dimension: dimension({
      label: 'FEMA flood zone',
      provenance: 'captured',
      value: zone,
      detail: [
        isSFHA ? 'Special Flood Hazard Area (1% annual chance)' : 'Outside the Special Flood Hazard Area',
        subtype,
        Number.isFinite(bfe) && bfe > -9999 ? `base flood elevation ${bfe} ft` : null,
        firmPanel ? `FIRM panel ${firmPanel.FIRM_PAN ?? firmPanel.PANEL ?? a.DFIRM_ID}` : (a.DFIRM_ID ? `FIRM ${a.DFIRM_ID}` : null),
      ].filter(Boolean).join('; '),
      sourceUrl: layerUrl,
    }),
    coverage: coverageEntry({ key: source.key, name: source.name, url: layerUrl, status: 'captured' }),
    isSFHA,
    zone,
  };
}

// ── Wetlands ─────────────────────────────────────────────────────────

/** NWI joins its code table in, so attribute keys arrive dotted-prefixed. */
const nwiField = (attributes, name) => attributes?.[`Wetlands.${name}`] ?? attributes?.[name] ?? null;

export function parseWetlands(pointResponse, nearbyResponse, { nearbyRadiusMeters = 500 } = {}) {
  const source = SOURCES.wetlands;
  const layerUrl = `${source.url}/${source.layer}`;
  const failed = (r) => !r || r.ok === false;

  if (failed(pointResponse) && failed(nearbyResponse)) {
    return {
      dimension: dimension({
        label: 'Wetlands',
        provenance: 'blocked',
        sourceUrl: layerUrl,
        note: `NWI query failed (${pointResponse?.error ?? nearbyResponse?.error ?? 'no response'}).`,
      }),
      coverage: coverageEntry({
        key: source.key, name: source.name, url: layerUrl, status: 'blocked',
        error: pointResponse?.error ?? nearbyResponse?.error ?? 'no response',
      }),
    };
  }

  const onSite = (pointResponse?.features ?? [])[0];
  if (onSite) {
    const a = onSite.attributes ?? {};
    return {
      dimension: dimension({
        label: 'Wetlands',
        provenance: 'captured',
        value: 'on parcel',
        detail: [
          nwiField(a, 'WETLAND_TYPE'),
          nwiField(a, 'ATTRIBUTE') ? `code ${nwiField(a, 'ATTRIBUTE')}` : null,
          Number.isFinite(Number(nwiField(a, 'ACRES'))) ? `${round(Number(nwiField(a, 'ACRES')), 2)} acres` : null,
        ].filter(Boolean).join('; '),
        sourceUrl: layerUrl,
      }),
      coverage: coverageEntry({ key: source.key, name: source.name, url: layerUrl, status: 'captured' }),
    };
  }

  const nearby = (nearbyResponse?.features ?? []).map((f) => ({
    type: nwiField(f.attributes, 'WETLAND_TYPE'),
    code: nwiField(f.attributes, 'ATTRIBUTE'),
    acres: round(Number(nwiField(f.attributes, 'ACRES')), 2),
  }));

  return {
    dimension: dimension({
      label: 'Wetlands',
      provenance: 'captured',
      value: nearby.length > 0 ? `none on parcel; ${nearby.length} within ${nearbyRadiusMeters} m` : 'none mapped on or near parcel',
      detail: nearby.slice(0, 3).map((w) => `${w.type ?? w.code}${w.acres ? ` (${w.acres} ac)` : ''}`).join(', ') || null,
      sourceUrl: layerUrl,
    }),
    coverage: coverageEntry({ key: source.key, name: source.name, url: layerUrl, status: 'captured' }),
    nearby,
  };
}

// ── Radon ────────────────────────────────────────────────────────────

/**
 * County-level EPA zone, from the shipped table. Zone is a screening predictor
 * for the county, never a measurement of this house -- the note says so.
 */
export function lookupRadonZone(county, radonTable = {}) {
  const source = SOURCES.radon;
  const key = String(county ?? '').trim().toLowerCase().replace(/\s+county$/, '');
  const zone = key ? radonTable[key] : null;

  if (!zone) {
    return {
      dimension: dimension({
        label: 'Radon zone',
        provenance: county ? 'unsupported' : 'unconfirmed',
        sourceUrl: source.url,
        note: county
          ? `No radon zone on file for "${county}". config/radon-zones.yml covers North Carolina counties only.`
          : 'County unknown for this home, so the county radon zone could not be looked up.',
      }),
      coverage: coverageEntry({
        key: source.key, name: source.name, url: source.url,
        status: county ? 'unsupported' : 'missing',
        note: county ? `County "${county}" is not in config/radon-zones.yml.` : 'No county resolved for this home.',
      }),
    };
  }

  const descriptions = {
    1: 'Zone 1 — predicted indoor average at or above 4 pCi/L',
    2: 'Zone 2 — predicted indoor average 2 to 4 pCi/L',
    3: 'Zone 3 — predicted indoor average below 2 pCi/L',
  };

  return {
    dimension: dimension({
      label: 'Radon zone',
      provenance: 'captured',
      value: `Zone ${zone}`,
      detail: descriptions[zone] ?? null,
      sourceUrl: source.url,
      note: 'County-level screening predictor. Only a test of this specific house measures its actual level.',
    }),
    coverage: coverageEntry({ key: source.key, name: source.name, url: source.url, status: 'captured' }),
    zone,
  };
}

// ── EPA regulated / contaminated sites ───────────────────────────────

export function parseEpaSites(response, home, { radiusMeters = 3000 } = {}) {
  const source = SOURCES.epaSites;
  const layerUrl = `${source.url}/${source.layer}`;

  if (!response || response.ok === false) {
    return {
      dimension: dimension({
        label: 'Environmental sites',
        provenance: 'blocked',
        sourceUrl: layerUrl,
        note: `EPA FRS query failed (${response?.error ?? 'no response'}).`,
      }),
      coverage: coverageEntry({
        key: source.key, name: source.name, url: layerUrl, status: 'blocked',
        error: response?.error ?? 'no response',
      }),
    };
  }

  const sites = [];
  for (const feature of response.features ?? []) {
    const a = feature.attributes ?? {};
    const program = String(a.PGM_SYS_ACRNM ?? '').trim().toUpperCase();
    const meters = haversineMeters(home.lat, home.lng, Number(a.LATITUDE83), Number(a.LONGITUDE83));
    sites.push({
      name: a.PRIMARY_NAME ?? null,
      address: [a.LOCATION_ADDRESS, a.CITY_NAME].filter(Boolean).join(', ') || null,
      program,
      programLabel: PROGRAM_LABELS[program] ?? (program ? `${program} program record` : 'Unclassified FRS record'),
      serious: SERIOUS_PROGRAMS.has(program),
      activeStatus: a.ACTIVE_STATUS ?? null,
      distanceMiles: round(metersToMiles(meters), 2),
      url: a.FAC_URL ?? null,
    });
  }
  sites.sort((left, right) => (left.distanceMiles ?? 99) - (right.distanceMiles ?? 99));

  const serious = sites.filter((site) => site.serious);
  const radiusMiles = round(metersToMiles(radiusMeters), 1);

  return {
    dimension: dimension({
      label: 'Environmental sites',
      provenance: 'captured',
      value: serious.length > 0
        ? `${serious.length} superfund/brownfield within ${radiusMiles} mi`
        : `no superfund or brownfield within ${radiusMiles} mi`,
      detail: (serious.length > 0 ? serious : sites).slice(0, 3)
        .map((site) => `${site.name} — ${site.programLabel}${site.distanceMiles != null ? `, ${site.distanceMiles} mi` : ''}`)
        .join('; ') || null,
      sourceUrl: layerUrl,
      note: sites.length > serious.length
        ? `${sites.length - serious.length} other regulated facility record(s) nearby; routine permits, not contamination findings.`
        : null,
    }),
    coverage: coverageEntry({ key: source.key, name: source.name, url: layerUrl, status: 'captured' }),
    sites: sites.slice(0, 15),
  };
}

// ── Soil / septic suitability ────────────────────────────────────────

/**
 * Only meaningful off public sewer. `sewerStatus` comes from the utilities
 * sidecar; when public sewer is confirmed this is skipped rather than
 * answered, because septic suitability does not bear on the decision.
 */
export function parseSepticSuitability(sdaBody, { sewerStatus = 'unconfirmed' } = {}) {
  const source = SOURCES.soil;

  if (sewerStatus === 'public') {
    return {
      dimension: dimension({
        label: 'Septic suitability',
        provenance: 'not-applicable',
        sourceUrl: source.url,
        note: 'Home is on confirmed public sewer, so soil septic suitability does not apply.',
      }),
      coverage: coverageEntry({
        key: source.key, name: source.name, url: source.url, status: 'skipped-by-profile',
        note: 'Public sewer confirmed in the utilities sidecar.',
      }),
    };
  }

  const rows = sdaBody?.Table;
  if (!Array.isArray(rows) || rows.length < 2) {
    return {
      dimension: dimension({
        label: 'Septic suitability',
        provenance: 'blocked',
        sourceUrl: source.url,
        note: 'NRCS Soil Data Access returned no usable rows.',
      }),
      coverage: coverageEntry({
        key: source.key, name: source.name, url: source.url, status: 'blocked',
        error: sdaBody?.error ?? 'no rows returned',
      }),
    };
  }

  const [header, ...records] = rows;
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  const components = records
    .map((row) => ({
      component: row[index.compname] ?? null,
      percent: Number(row[index.comppct_r]) || 0,
      rating: row[index.interphrc] ?? null,
    }))
    .sort((left, right) => right.percent - left.percent);

  const dominant = components[0];
  if (!dominant?.rating) {
    return {
      dimension: dimension({
        label: 'Septic suitability',
        provenance: 'unconfirmed',
        sourceUrl: source.url,
        note: 'SSURGO returned map units with no septic interpretation for this point.',
      }),
      coverage: coverageEntry({ key: source.key, name: source.name, url: source.url, status: 'captured' }),
    };
  }

  return {
    dimension: dimension({
      label: 'Septic suitability',
      provenance: 'captured',
      value: dominant.rating,
      detail: `${dominant.component} soil, ${dominant.percent}% of the map unit`,
      sourceUrl: source.url,
      note: 'SSURGO map-unit rating. A county-permitted soil evaluation governs an actual septic permit.',
    }),
    coverage: coverageEntry({ key: source.key, name: source.name, url: source.url, status: 'captured' }),
    components: components.slice(0, 4),
  };
}

// ── Airport noise ────────────────────────────────────────────────────

/**
 * RDU publishes its composite contours as an embedded Web Mercator feature
 * collection rather than a queryable service, so the point is projected into
 * the same space and tested against the rings directly.
 *
 * Outside every modelled contour is reported `not-applicable` -- the model
 * simply does not cover the home. It is never reported as "quiet".
 */
export function resolveAirportNoise(home, contours) {
  const source = SOURCES.airport;

  if (!contours || contours.ok === false || !Array.isArray(contours.features)) {
    return {
      dimension: dimension({
        label: 'Airport noise',
        provenance: 'blocked',
        sourceUrl: source.url,
        note: `RDU noise contours unavailable (${contours?.error ?? 'no response'}).`,
      }),
      coverage: coverageEntry({
        key: source.key, name: source.name, url: source.url, status: 'blocked',
        error: contours?.error ?? 'no response',
      }),
    };
  }

  const point = toWebMercator(home.lng, home.lat);
  if (!point) {
    return {
      dimension: dimension({
        label: 'Airport noise',
        provenance: 'blocked',
        sourceUrl: source.url,
        note: 'No usable coordinate for this home, so the contour test could not run.',
      }),
      coverage: coverageEntry({ key: source.key, name: source.name, url: source.url, status: 'missing' }),
    };
  }

  let band = null;
  for (const feature of contours.features) {
    const level = Number(feature.attributes?.Noise_Leve);
    if (!Number.isFinite(level)) continue;
    if (pointInRings(point, feature.geometry?.rings)) {
      band = band == null ? level : Math.max(band, level);
    }
  }

  if (band == null) {
    return {
      dimension: dimension({
        label: 'Airport noise',
        provenance: 'not-applicable',
        sourceUrl: source.url,
        note: 'Outside every modelled RDU contour (the model extends down to 55 dB DNL). Not a quietness finding — RDU noise is simply not modelled here.',
      }),
      coverage: coverageEntry({ key: source.key, name: source.name, url: source.url, status: 'captured' }),
      band: null,
    };
  }

  return {
    dimension: dimension({
      label: 'Airport noise',
      provenance: 'captured',
      value: `${band} dB DNL contour`,
      detail: band >= 65
        ? 'At or above the FAA 65 dB DNL threshold for residential incompatibility.'
        : 'Below the FAA 65 dB DNL residential threshold, but inside the modelled contours.',
      sourceUrl: source.url,
    }),
    coverage: coverageEntry({ key: source.key, name: source.name, url: source.url, status: 'captured' }),
    band,
  };
}

// ── Record assembly ──────────────────────────────────────────────────

export function buildHazardsRecord({ target, geocode, results, generatedAt = new Date().toISOString() }) {
  const dimensions = {};
  const sourceCoverage = [];
  const warnings = [];

  for (const [key, result] of Object.entries(results)) {
    if (!result) continue;
    dimensions[key] = result.dimension;
    if (result.coverage) sourceCoverage.push(result.coverage);
    if (result.dimension.provenance === 'blocked') {
      warnings.push(`${result.dimension.label}: source unreachable — recorded as blocked, not as "no hazard found".`);
    }
  }

  const flood = results.flood ?? {};
  return {
    generatedAt,
    address: target.address,
    city: target.city,
    state: target.state,
    reportPath: target.relativePath,
    geocode: geocode ? { lat: geocode.lat, lng: geocode.lng, source: geocode.source } : null,
    status: 'reviewed',
    floodIsSFHA: flood.isSFHA ?? null,
    floodZone: flood.zone ?? null,
    dimensions,
    epaSites: results.epaSites?.sites ?? [],
    sourceCoverage,
    warnings,
  };
}
