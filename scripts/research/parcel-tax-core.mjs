// scripts/research/parcel-tax-core.mjs
//
// Pure parsers for the county parcel record: assessment, tax estimate, and
// zoning. Testable offline against recorded county ArcGIS responses.
//
// The governing rule here is address-match-before-consume. County geocodes are
// interpolated along street centerlines and can land hundreds of meters from
// the actual parcel, so a nearby parcel is not this home's parcel. When no
// row matches the report address, the record stays `unconfirmed` and carries
// no numbers at all.

import { ringsCentroid, round } from '../shared/geo.mjs';
import { coverageEntry, dimension } from './source-coverage.mjs';

/** Street-type abbreviations vary between the tracker and county records. */
const STREET_ALIASES = {
  street: 'st', avenue: 'ave', drive: 'dr', road: 'rd', lane: 'ln', court: 'ct',
  place: 'pl', boulevard: 'blvd', circle: 'cir', terrace: 'ter', parkway: 'pkwy',
  trail: 'trl', way: 'way', loop: 'loop', run: 'run', ridge: 'rdg', point: 'pt',
  north: 'n', south: 's', east: 'e', west: 'w',
};

export function normalizeStreetAddress(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => STREET_ALIASES[token] ?? token)
    .join(' ')
    .trim();
}

/**
 * Finds the parcel row whose site address is this home's. Returns null rather
 * than a best guess -- consuming the wrong parcel would attach another
 * household's assessment and sale history to the report.
 */
export function matchParcel(features, target, { addressField = 'SITE_ADDRESS' } = {}) {
  const wanted = normalizeStreetAddress(target?.address);
  if (!wanted) return null;
  for (const feature of features ?? []) {
    const candidate = normalizeStreetAddress(feature?.attributes?.[addressField]);
    if (candidate && candidate === wanted) return feature;
  }
  return null;
}

const numberOrNull = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);
const isoDateOrNull = (value) => {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

/** Maps a county's own column names onto the fields the snapshot needs. */
export function extractParcelFields(feature, layerConfig = {}) {
  const a = feature?.attributes ?? {};
  const map = layerConfig.fields ?? {};
  const raw = (key) => (map[key] ? a[map[key]] : undefined);
  return {
    parcelId: raw('parcelId') ?? null,
    realEstateId: raw('realEstateId') ?? null,
    owner: raw('owner') ?? null,
    siteAddress: a[layerConfig.addressField ?? 'SITE_ADDRESS'] ?? null,
    acres: round(numberOrNull(raw('acres')), 3),
    landValue: numberOrNull(raw('landValue')),
    improvementValue: numberOrNull(raw('improvementValue')),
    assessedValue: numberOrNull(raw('assessedValue')),
    lastSalePrice: numberOrNull(raw('lastSalePrice')),
    lastSaleDate: isoDateOrNull(raw('lastSaleDate')),
    yearBuilt: numberOrNull(raw('yearBuilt')),
    heatedArea: numberOrNull(raw('heatedArea')),
    legalDescription: raw('legalDescription') ?? null,
    jurisdiction: raw('jurisdiction') ?? null,
  };
}

// ── Parcel + assessment ──────────────────────────────────────────────

export function parseParcel(response, target, { county = null, layerConfig = null } = {}) {
  const source = { key: 'county_parcel', name: county ? `${county} parcel layer` : 'County parcel layer' };
  const url = layerConfig?.url ?? null;

  if (!layerConfig) {
    return {
      parcel: null,
      dimension: dimension({
        label: 'Parcel record',
        provenance: 'unsupported',
        note: county
          ? `No parcelLayer registered for ${county} in config/county-arcgis-registry.yml. Run county-services-discover.mjs to find one.`
          : 'No county resolved for this home, so no parcel layer could be selected.',
      }),
      coverage: coverageEntry({
        key: source.key, name: source.name, url, status: county ? 'unsupported' : 'missing',
      }),
    };
  }

  if (!response || response.ok === false) {
    return {
      parcel: null,
      dimension: dimension({
        label: 'Parcel record',
        provenance: 'blocked',
        sourceUrl: url,
        note: `County parcel query failed (${response?.error ?? 'no response'}).`,
      }),
      coverage: coverageEntry({ key: source.key, name: source.name, url, status: 'blocked', error: response?.error ?? 'no response' }),
    };
  }

  const feature = matchParcel(response.features, target, { addressField: layerConfig.addressField });
  if (!feature) {
    const seen = (response.features ?? []).length;
    return {
      parcel: null,
      dimension: dimension({
        label: 'Parcel record',
        provenance: 'unconfirmed',
        sourceUrl: url,
        note: seen > 0
          ? `${seen} nearby parcel(s) returned, none matching "${target.address}". Not consumed — a neighbouring parcel's assessment is not this home's.`
          : `No parcel matched "${target.address}" in the county layer.`,
      }),
      coverage: coverageEntry({
        key: source.key, name: source.name, url, status: 'captured',
        note: 'Queried successfully but no parcel matched the report address.',
      }),
    };
  }

  const parcel = extractParcelFields(feature, layerConfig);
  // The parcel's own centroid anchors follow-up queries (zoning) far more
  // reliably than the interpolated address geocode.
  const centroid = ringsCentroid(feature.geometry?.rings);
  return {
    parcel,
    matchedCentroid: centroid ? { lat: centroid.y, lng: centroid.x } : null,
    dimension: dimension({
      label: 'Parcel record',
      provenance: 'captured',
      value: parcel.parcelId ? `PIN ${parcel.parcelId}` : parcel.siteAddress,
      detail: [
        parcel.acres != null ? `${parcel.acres} deeded acres` : null,
        parcel.yearBuilt ? `built ${parcel.yearBuilt}` : null,
        parcel.heatedArea ? `${parcel.heatedArea.toLocaleString('en-US')} heated sq ft` : null,
        parcel.legalDescription,
      ].filter(Boolean).join('; '),
      sourceUrl: url,
    }),
    coverage: coverageEntry({ key: source.key, name: source.name, url, status: 'captured' }),
  };
}

export function buildAssessmentDimension(parcel, { url = null } = {}) {
  if (!parcel || parcel.assessedValue == null) {
    return dimension({
      label: 'Assessed value',
      provenance: parcel ? 'unconfirmed' : 'unconfirmed',
      sourceUrl: url,
      note: parcel
        ? 'The matched parcel record carried no total assessed value.'
        : 'No parcel matched this home, so no assessment was read.',
    });
  }
  const money = (value) => (value == null ? null : `$${Math.round(value).toLocaleString('en-US')}`);
  return dimension({
    label: 'Assessed value',
    provenance: 'captured',
    value: money(parcel.assessedValue),
    detail: [
      parcel.landValue != null ? `land ${money(parcel.landValue)}` : null,
      parcel.improvementValue != null ? `improvements ${money(parcel.improvementValue)}` : null,
    ].filter(Boolean).join('; ') || null,
    sourceUrl: url,
    note: 'County assessed value, which is a revaluation figure and not a market appraisal.',
  });
}

export function buildSaleHistoryDimension(parcel, { url = null } = {}) {
  if (!parcel || parcel.lastSalePrice == null) {
    return dimension({
      label: 'Last recorded sale',
      provenance: 'unconfirmed',
      sourceUrl: url,
      note: parcel ? 'The matched parcel carried no recorded sale price.' : 'No parcel matched this home.',
    });
  }
  return dimension({
    label: 'Last recorded sale',
    provenance: 'captured',
    value: `$${Math.round(parcel.lastSalePrice).toLocaleString('en-US')}`,
    detail: parcel.lastSaleDate ? `recorded ${parcel.lastSaleDate}` : null,
    sourceUrl: url,
  });
}

// ── Tax estimate ─────────────────────────────────────────────────────

/**
 * County rate + municipal rate applied to the assessed value. Always an
 * estimate: special district levies (fire, waste, stormwater, MSDs) are not
 * included, and the county's own bill lookup is emitted alongside it.
 */
export function buildTaxEstimate(parcel, { county, city, rateConfig = {} }) {
  const source = { key: 'property_tax_rates', name: 'Property tax rate table (config/property-tax-rates.yml)' };
  const countyKey = String(county ?? '').toLowerCase().replace(/\s+county$/, '').trim();
  const cityKey = String(city ?? '').toLowerCase().trim();
  const countyRate = rateConfig.counties?.[countyKey] ?? null;
  const municipalRate = rateConfig.municipalities?.[cityKey] ?? null;
  const lookup = rateConfig.billLookups?.[countyKey] ?? null;

  if (!parcel || parcel.assessedValue == null) {
    return {
      dimension: dimension({
        label: 'Estimated annual tax',
        provenance: 'unconfirmed',
        sourceUrl: lookup?.url ?? null,
        note: 'No assessed value was captured, so no estimate could be computed. Use the county bill lookup for the actual figure.',
      }),
      coverage: coverageEntry({ key: source.key, name: source.name, status: 'missing', note: 'No assessed value available.' }),
      billLookup: lookup,
    };
  }

  if (!countyRate) {
    return {
      dimension: dimension({
        label: 'Estimated annual tax',
        provenance: 'unsupported',
        sourceUrl: lookup?.url ?? null,
        note: `No tax rate on file for "${county ?? 'unknown county'}" in config/property-tax-rates.yml. Add one rather than infer a bill.`,
      }),
      coverage: coverageEntry({ key: source.key, name: source.name, status: 'unsupported' }),
      billLookup: lookup,
    };
  }

  const combinedRate = countyRate.rate + (municipalRate?.rate ?? 0);
  const annual = (parcel.assessedValue / 100) * combinedRate;
  const parts = [
    `${countyRate.label ?? countyKey} ${countyRate.rate}`,
    municipalRate ? `${municipalRate.label ?? cityKey} ${municipalRate.rate}` : null,
  ].filter(Boolean).join(' + ');

  return {
    dimension: dimension({
      label: 'Estimated annual tax',
      provenance: 'captured',
      value: `~$${Math.round(annual).toLocaleString('en-US')}/yr`,
      detail: `${parts} per $100 of $${Math.round(parcel.assessedValue).toLocaleString('en-US')} assessed${rateConfig.fiscalYear ? `, FY ${rateConfig.fiscalYear}` : ''}`,
      sourceUrl: lookup?.url ?? countyRate.source ?? null,
      note: municipalRate
        ? 'Estimate only — excludes fire, solid waste, stormwater and any municipal service district levies. Not a tax quote.'
        : `Estimate uses the county rate only; no municipal rate is on file for "${city ?? 'this jurisdiction'}". Excludes special district levies. Not a tax quote.`,
    }),
    coverage: coverageEntry({ key: source.key, name: source.name, url: countyRate.source ?? null, status: 'captured' }),
    annualEstimate: round(annual, 2),
    combinedRate: round(combinedRate, 4),
    municipalRateFound: Boolean(municipalRate),
    billLookup: lookup,
  };
}

// ── Zoning ───────────────────────────────────────────────────────────

export function parseZoning(response, { url = null, classField = 'CLASS', jurisdictionLabel = null } = {}) {
  const source = { key: 'county_zoning', name: 'County/municipal zoning layer' };

  if (!url) {
    return {
      dimension: dimension({
        label: 'Zoning',
        provenance: 'unsupported',
        note: 'No zoning layer registered for this jurisdiction in config/county-arcgis-registry.yml.',
      }),
      coverage: coverageEntry({ key: source.key, name: source.name, status: 'unsupported' }),
    };
  }
  if (!response || response.ok === false) {
    return {
      dimension: dimension({
        label: 'Zoning',
        provenance: 'blocked',
        sourceUrl: url,
        note: `Zoning query failed (${response?.error ?? 'no response'}).`,
      }),
      coverage: coverageEntry({ key: source.key, name: source.name, url, status: 'blocked', error: response?.error ?? 'no response' }),
    };
  }

  const feature = (response.features ?? [])[0];
  const zoneClass = feature?.attributes?.[classField] ?? null;
  if (!zoneClass) {
    return {
      dimension: dimension({
        label: 'Zoning',
        provenance: 'unconfirmed',
        sourceUrl: url,
        note: 'The zoning layer returned no district at this point.',
      }),
      coverage: coverageEntry({ key: source.key, name: source.name, url, status: 'captured' }),
    };
  }

  return {
    dimension: dimension({
      label: 'Zoning',
      provenance: 'captured',
      value: String(zoneClass),
      detail: jurisdictionLabel ? `${jurisdictionLabel} zoning district` : null,
      sourceUrl: url,
      note: 'District code only. Consult the jurisdiction\'s ordinance for the permitted uses and setbacks behind the code.',
    }),
    coverage: coverageEntry({ key: source.key, name: source.name, url, status: 'captured' }),
    zoneClass: String(zoneClass),
  };
}

/**
 * Future land use rarely has a queryable layer, so it follows the guided-link
 * pattern: an official link plus how to check this home, never a claimed result.
 */
export function buildFutureLandUseGuide(developmentSources, { city = null } = {}) {
  const source = { key: 'future_land_use', name: 'Municipal future land use / development map' };
  const cityKey = String(city ?? '').toLowerCase().trim();
  const municipalities = developmentSources?.municipalities ?? [];
  const match = municipalities.find((entry) => String(entry.key ?? entry.city ?? '').toLowerCase() === cityKey);

  if (!match?.url) {
    return {
      dimension: dimension({
        label: 'Future land use',
        provenance: 'unsupported',
        note: `No municipal development map is registered for "${city ?? 'this area'}" in output/development-sources.json. Add one via templates/research-defaults.yml.`,
      }),
      coverage: coverageEntry({ key: source.key, name: source.name, status: 'unsupported' }),
      guide: null,
    };
  }

  return {
    dimension: dimension({
      label: 'Future land use',
      provenance: 'unconfirmed',
      sourceUrl: match.url,
      note: `Not machine-queryable. Check ${match.name ?? match.url} for the future land use designation covering this parcel.`,
    }),
    coverage: coverageEntry({
      key: source.key, name: source.name, url: match.url, status: 'captured',
      note: 'Guided link emitted; no designation was claimed.',
    }),
    guide: {
      name: match.name ?? 'Municipal development map',
      url: match.url,
      instructions: 'Open the map, search this street address or PIN, and read the future land use / small area plan designation for the parcel and its immediate neighbours.',
    },
  };
}

// ── Record assembly ──────────────────────────────────────────────────

export function buildParcelRecord({ target, geocode, parcel, dimensions, sourceCoverage, extras = {}, generatedAt = new Date().toISOString() }) {
  const warnings = [];
  for (const dim of Object.values(dimensions)) {
    if (dim.provenance === 'blocked') {
      warnings.push(`${dim.label}: source unreachable — recorded as blocked, not as absence of a finding.`);
    }
  }
  if (!parcel) {
    warnings.push('No county parcel matched this address, so assessment, tax, and sale history are unconfirmed.');
  }

  return {
    generatedAt,
    address: target.address,
    city: target.city,
    state: target.state,
    reportPath: target.relativePath,
    geocode: geocode ? { lat: geocode.lat, lng: geocode.lng, source: geocode.source } : null,
    status: 'reviewed',
    parcel,
    dimensions,
    ...extras,
    sourceCoverage,
    warnings,
  };
}
