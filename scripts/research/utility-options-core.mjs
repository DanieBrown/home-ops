import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ROOT } from '../shared/paths.mjs';
import { slugify } from '../shared/text-utils.mjs';

export const UTILITY_ASSUMPTIONS = {
  electricKwh: { low: 750, typical: 1000, high: 1500 },
  waterGallons: { low: 3000, typical: 5000, high: 8000 },
  gasTherms: { low: 15, typical: 30, high: 70 },
  internetPreference: 'lowest verified plan at or above 500 Mbps, preferring fiber',
};

const CHECKED_STATUSES = new Set(['confirmed', 'reported', 'likely']);
const COUNTED_STATUSES = new Set(['confirmed', 'reported', 'likely']);

export const DEFAULT_UTILITY_SOURCES = {
  electric: [
    {
      key: 'nc_public_staff_electric',
      name: 'NC Public Staff Electric Section',
      url: 'https://publicstaff.nc.gov/public-staff-divisions/energy-division/electric-section',
      note: 'Representative regulated-utility residential bill tables and rate-schedule links.',
    },
    {
      key: 'duke_provider_check',
      name: 'Duke Energy provider check',
      url: 'https://www.duke-energy.com/home/start-stop-move/is-duke-my-provider',
      note: 'Address-level service territory confirmation.',
    },
  ],
  waterSewer: [
    {
      key: 'apex_water_sewer',
      name: 'Apex water and sewer service',
      url: 'https://www.apexnc.org/1510/Connect-to-Town-Water-and-Sewer',
      note: 'Apex service availability and current rate-schedule link.',
    },
    {
      key: 'holly_springs_rates',
      name: 'Holly Springs utility rates',
      url: 'https://www.hollyspringsnc.gov/184/Rates',
      note: 'Water, sewer, stormwater, and sanitation rates.',
    },
    {
      key: 'fuquay_varina_utilities',
      name: 'Fuquay-Varina public utilities',
      url: 'https://www.fuquay-varina.org/283/Public-Utilities',
      note: 'Town water and sewer utility overview.',
    },
    {
      key: 'cary_utilities',
      name: 'Cary utility billing',
      url: 'https://www.carync.gov/services-publications/water-sewer-stormwater/utility-billing',
      note: 'Town of Cary utility billing and rate references.',
    },
  ],
  naturalGas: [
    {
      key: 'nc_public_staff_gas',
      name: 'NC Public Staff Natural Gas Section',
      url: 'https://publicstaff.nc.gov/public-staff-divisions/energy-division/natural-gas-section',
      note: 'NC gas utility list, current rate links, and typical bill references.',
    },
    {
      key: 'enbridge_nc',
      name: 'Enbridge Gas North Carolina',
      url: 'https://www.enbridgegas.com/north-carolina',
      note: 'Former Dominion Energy North Carolina / PSNC gas service.',
    },
    {
      key: 'piedmont_ng',
      name: 'Piedmont Natural Gas',
      url: 'https://www.piedmontng.com/',
      note: 'NC natural gas provider and rate/service information.',
    },
  ],
  internet: [
    {
      key: 'fcc_bdc',
      name: 'FCC Broadband Data Collection overview',
      url: 'https://help.bdc.fcc.gov/hc/en-us/articles/5290946484763-Fixed-Broadband-Availability-Data-Overview',
      note: 'Fixed broadband providers report standard-install availability to the FCC.',
    },
    {
      key: 'spectrum_plans',
      name: 'Spectrum internet plans',
      url: 'https://www.spectrum.com/internet/plans',
      note: 'Published residential internet plans; address availability still must be checked.',
    },
    {
      key: 'gfiber_triangle',
      name: 'GFiber Triangle plans',
      url: 'https://fiber.google.com/cities/triangle/',
      note: 'Published Triangle-market GFiber plans and address availability form.',
    },
    {
      key: 'att_availability',
      name: 'AT&T internet availability',
      url: 'https://www.att.com/internet/availability/',
      note: 'Address-level fiber and home internet availability check.',
    },
    {
      key: 'brightspeed_availability',
      name: 'Brightspeed availability',
      url: 'https://www.brightspeed.com/',
      note: 'Address-level internet availability check.',
    },
  ],
};

const ELECTRIC_RATE_FIXTURES = {
  duke_energy_progress_nc: {
    name: 'Duke Energy Progress',
    sourceUrl: 'https://publicstaff.nc.gov/public-staff-divisions/energy-division/electric-section',
    serviceStatus: 'likely',
    notes: [
      'Representative NC Public Staff residential RES bill examples, excluding sales tax.',
      'Actual electric service territory must be confirmed by address.',
    ],
    sampleBills: [
      { kwh: 300, summer: 61.15, winter: 61.15 },
      { kwh: 500, summer: 91.38, winter: 91.38 },
      { kwh: 1000, summer: 166.94, winter: 164.94 },
      { kwh: 1500, summer: 242.51, winter: 235.51 },
      { kwh: 2000, summer: 318.07, winter: 306.07 },
    ],
  },
  apex_electric: {
    name: 'Town of Apex Electric',
    sourceUrl: 'https://www.apexnc.org/documentcenter/view/407',
    serviceStatus: 'unconfirmed',
    notes: [
      'Apex FY26 fee schedule lists residential base and energy charges.',
      'Use only for addresses confirmed inside the Town of Apex electric service area.',
    ],
    customerCharge: 28,
    energyRate: 0.1178,
  },
};

const WATER_RATE_FIXTURES = {
  'holly springs': {
    name: 'Town of Holly Springs Water/Sewer',
    sourceUrl: 'https://www.hollyspringsnc.gov/184/Rates',
    serviceStatus: 'likely',
    note: 'In-town rates effective Aug. 1, 2025. Out-of-town rates may be doubled.',
    waterAccess: 18.46,
    sewerAccess: 19.25,
    waterTiers: [
      { upToGallons: 2000, ratePerThousand: 6.12 },
      { upToGallons: 5000, ratePerThousand: 7.97 },
      { upToGallons: 9000, ratePerThousand: 9.81 },
      { upToGallons: 14000, ratePerThousand: 11.65 },
      { upToGallons: Infinity, ratePerThousand: 13.49 },
    ],
    sewerRatePerThousand: 8.38,
  },
  'fuquay-varina': {
    name: 'Town of Fuquay-Varina Water/Sewer',
    sourceUrl: 'https://www.fuquay-varina.org/DocumentCenter/View/2646/Water-and-Sewer-Rates-and-Fee-Schedule-PDF?bidId=',
    serviceStatus: 'likely',
    note: 'FY2025-2026 in-town residential rates. Out-of-town rates may be doubled.',
    waterAccess: 17.84,
    sewerAccess: 24.77,
    waterRatePerThousand: 9.02,
    sewerRatePerThousand: 10.60,
  },
  apex: {
    name: 'Town of Apex Water/Sewer',
    sourceUrl: 'https://www.apexnc.org/documentcenter/view/407',
    serviceStatus: 'unconfirmed',
    note: 'Apex service and in-town/out-of-town status must be confirmed by parcel/address.',
    waterAccess: null,
    sewerAccess: null,
  },
  cary: {
    name: 'Town of Cary Water/Sewer',
    sourceUrl: 'https://www.carync.gov/services-publications/water-sewer-stormwater/utility-billing',
    serviceStatus: 'unconfirmed',
    note: 'Cary water/sewer service and current usage rates need address/rate-page confirmation.',
    waterAccess: null,
    sewerAccess: null,
  },
};

const INTERNET_PLAN_CATALOG = {
  spectrum: [
    { name: 'Internet Premier', technology: 'Cable / HFC', downloadMbps: 500, uploadMbps: null, monthlyPrice: 50, sourceUrl: 'https://www.spectrum.com/internet/plans', note: 'Published promotional plan; availability and final taxes/fees vary by address.' },
    { name: 'Internet Gig', technology: 'Cable / HFC', downloadMbps: 1000, uploadMbps: null, monthlyPrice: 70, sourceUrl: 'https://www.spectrum.com/internet/plans', note: 'Published plan estimate; verify address availability.' },
  ],
  gfiber: [
    { name: 'Core 1 Gig', technology: 'Fiber', downloadMbps: 1000, uploadMbps: 1000, monthlyPrice: 70, sourceUrl: 'https://fiber.google.com/cities/triangle/' },
    { name: 'Home 3 Gig', technology: 'Fiber', downloadMbps: 3000, uploadMbps: 3000, monthlyPrice: 100, sourceUrl: 'https://fiber.google.com/cities/triangle/' },
    { name: 'Edge 8 Gig', technology: 'Fiber', downloadMbps: 8000, uploadMbps: 8000, monthlyPrice: 150, sourceUrl: 'https://fiber.google.com/cities/triangle/' },
  ],
};

function normalizeCity(value) {
  return String(value ?? '').trim().toLowerCase();
}

function roundMoney(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : null;
}

function formatCheckedAt() {
  return new Date().toISOString();
}

function medianNumber(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

export function estimateTieredUsage(gallons, tiers) {
  let remaining = Number(gallons);
  if (!Number.isFinite(remaining) || remaining <= 0 || !Array.isArray(tiers)) return 0;
  let priorLimit = 0;
  let total = 0;
  for (const tier of tiers) {
    const limit = tier.upToGallons === Infinity ? Infinity : Number(tier.upToGallons);
    const span = Math.min(remaining, limit - priorLimit);
    if (span > 0) {
      total += (span / 1000) * Number(tier.ratePerThousand ?? 0);
      remaining -= span;
    }
    if (remaining <= 0) break;
    priorLimit = limit;
  }
  return roundMoney(total) ?? 0;
}

export function estimateWaterSewer(rate, gallons) {
  if (!rate || rate.waterAccess == null || rate.sewerAccess == null) return null;
  const waterUsage = Array.isArray(rate.waterTiers)
    ? estimateTieredUsage(gallons, rate.waterTiers)
    : (Number(gallons) / 1000) * Number(rate.waterRatePerThousand ?? 0);
  const sewerUsage = (Number(gallons) / 1000) * Number(rate.sewerRatePerThousand ?? 0);
  return roundMoney(Number(rate.waterAccess) + Number(rate.sewerAccess) + waterUsage + sewerUsage);
}

function interpolateSampleBill(samples, kwh) {
  const target = Number(kwh);
  if (!Number.isFinite(target)) return null;
  const points = samples
    .map((sample) => ({
      kwh: Number(sample.kwh),
      bill: medianNumber([Number(sample.summer), Number(sample.winter)]),
    }))
    .filter((sample) => Number.isFinite(sample.kwh) && Number.isFinite(sample.bill))
    .sort((a, b) => a.kwh - b.kwh);
  if (points.length === 0) return null;
  const exact = points.find((point) => point.kwh === target);
  if (exact) return roundMoney(exact.bill);
  const lower = [...points].reverse().find((point) => point.kwh < target);
  const upper = points.find((point) => point.kwh > target);
  if (lower && upper) {
    const ratio = (target - lower.kwh) / (upper.kwh - lower.kwh);
    return roundMoney(lower.bill + ((upper.bill - lower.bill) * ratio));
  }
  const nearest = lower ?? upper;
  if (!nearest) return null;
  const perKwh = nearest.bill / nearest.kwh;
  return roundMoney(perKwh * target);
}

export function estimateElectric(rate, kwh) {
  if (!rate) return null;
  if (Array.isArray(rate.sampleBills)) return interpolateSampleBill(rate.sampleBills, kwh);
  if (rate.customerCharge != null && rate.energyRate != null) {
    return roundMoney(Number(rate.customerCharge) + (Number(kwh) * Number(rate.energyRate)));
  }
  return null;
}

export function estimateGasMonthly(therms, { baseCharge = 12, ratePerTherm = 1.45 } = {}) {
  return roundMoney(Number(baseCharge) + (Number(therms) * Number(ratePerTherm)));
}

function buildRange(estimateFn, assumptions) {
  return {
    low: estimateFn(assumptions.low),
    typical: estimateFn(assumptions.typical),
    high: estimateFn(assumptions.high),
  };
}

function addRange(left, right) {
  return {
    low: roundMoney(Number(left?.low ?? 0) + Number(right?.low ?? 0)),
    typical: roundMoney(Number(left?.typical ?? 0) + Number(right?.typical ?? 0)),
    high: roundMoney(Number(left?.high ?? 0) + Number(right?.high ?? 0)),
  };
}

function firstRange(values) {
  return values.find((value) => value && value.low != null && value.typical != null && value.high != null) ?? null;
}

function firstCountableProviderRange(providers) {
  return firstRange(
    providers
      .filter((provider) => COUNTED_STATUSES.has(provider.serviceStatus))
      .map((provider) => provider.estimateMonthly),
  );
}

function makeProvider(kind, input) {
  return {
    name: input.name,
    serviceStatus: input.serviceStatus ?? 'unconfirmed',
    sourceUrl: input.sourceUrl ?? '',
    checkedAt: input.checkedAt ?? formatCheckedAt(),
    estimateMonthly: input.estimateMonthly ?? null,
    plans: input.plans ?? [],
    notes: input.notes ?? [],
    kind,
  };
}

function reportText(target, listing) {
  return [
    target?.content,
    target?.sections?.FinancialSnapshot,
    target?.sections?.['Financial Snapshot'],
    target?.sections?.['Property Fit'],
    target?.sections?.['Quick Take'],
    listing?.description,
  ].filter(Boolean).join('\n');
}

function hasGasSignal(target, listing) {
  return /\b(gas\s+(?:fireplace|cooktop|range|stove|heat|furnace|water heater)|natural gas|tankless gas)\b/i.test(reportText(target, listing));
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function loadListingForTarget(target, projectRoot = ROOT) {
  const slug = slugify(`${target.address}-${target.city}-${target.state || 'NC'}`);
  if (!slug) return null;
  return readJsonIfExists(join(projectRoot, 'output', 'listings', `${slug}.json`));
}

function resolveSourceInventory(researchContext) {
  const configured = researchContext?.portals?.utility_sources;
  const generated = researchContext?.generatedUtilitySources?.utilitySources;
  const source = configured && typeof configured === 'object'
    ? configured
    : generated && typeof generated === 'object'
      ? generated
      : DEFAULT_UTILITY_SOURCES;
  return {
    electric: Array.isArray(source.electric) ? source.electric : DEFAULT_UTILITY_SOURCES.electric,
    waterSewer: Array.isArray(source.waterSewer) ? source.waterSewer : Array.isArray(source.water_sewer) ? source.water_sewer : DEFAULT_UTILITY_SOURCES.waterSewer,
    naturalGas: Array.isArray(source.naturalGas) ? source.naturalGas : Array.isArray(source.natural_gas) ? source.natural_gas : DEFAULT_UTILITY_SOURCES.naturalGas,
    internet: Array.isArray(source.internet) ? source.internet : DEFAULT_UTILITY_SOURCES.internet,
  };
}

function sourceCoverageFromInventory(inventory, checkedAt) {
  return Object.entries(inventory).flatMap(([kind, entries]) => entries.map((entry) => ({
    kind,
    key: entry.key ?? slugify(entry.name) ?? kind,
    name: entry.name ?? entry.key ?? kind,
    url: entry.url ?? '',
    status: 'planned',
    checkedAt,
    note: entry.note ?? '',
  })));
}

function sourceUrlByKey(coverage, key, fallback = '') {
  return coverage.find((entry) => entry.key === key)?.url || fallback;
}

function buildElectricProviders(target, coverage) {
  const checkedAt = formatCheckedAt();
  const city = normalizeCity(target.city);
  const providers = [];

  if (city === 'apex') {
    const apex = ELECTRIC_RATE_FIXTURES.apex_electric;
    providers.push(makeProvider('electric', {
      name: apex.name,
      serviceStatus: apex.serviceStatus,
      sourceUrl: apex.sourceUrl,
      checkedAt,
      estimateMonthly: buildRange((kwh) => estimateElectric(apex, kwh), UTILITY_ASSUMPTIONS.electricKwh),
      notes: apex.notes,
    }));
  }

  const duke = ELECTRIC_RATE_FIXTURES.duke_energy_progress_nc;
  providers.push(makeProvider('electric', {
    name: duke.name,
    serviceStatus: city === 'apex' ? 'unconfirmed' : 'likely',
    sourceUrl: sourceUrlByKey(coverage, 'nc_public_staff_electric', duke.sourceUrl),
    checkedAt,
    estimateMonthly: buildRange((kwh) => estimateElectric(duke, kwh), UTILITY_ASSUMPTIONS.electricKwh),
    notes: duke.notes,
  }));

  return providers;
}

function buildWaterProviders(target, coverage) {
  const checkedAt = formatCheckedAt();
  const city = normalizeCity(target.city);
  const rate = WATER_RATE_FIXTURES[city];
  if (!rate) {
    return [makeProvider('waterSewer', {
      name: 'Water/Sewer provider not resolved',
      serviceStatus: 'unconfirmed',
      sourceUrl: sourceUrlByKey(coverage, `${city.replace(/[-\s]+/g, '_')}_utilities`, ''),
      checkedAt,
      notes: ['No municipal water/sewer fixture matched this city. Confirm public utility, well/septic, or private provider before offer.'],
    })];
  }

  const estimate = buildRange((gallons) => estimateWaterSewer(rate, gallons), UTILITY_ASSUMPTIONS.waterGallons);
  return [makeProvider('waterSewer', {
    name: rate.name,
    serviceStatus: rate.serviceStatus,
    sourceUrl: rate.sourceUrl,
    checkedAt,
    estimateMonthly: estimate.low == null || estimate.typical == null || estimate.high == null ? null : estimate,
    notes: [rate.note],
  })];
}

function buildGasProviders(target, listing, coverage) {
  const checkedAt = formatCheckedAt();
  const gasLikely = hasGasSignal(target, listing);
  return [makeProvider('naturalGas', {
    name: 'Enbridge Gas North Carolina',
    serviceStatus: gasLikely ? 'likely' : 'unconfirmed',
    sourceUrl: sourceUrlByKey(coverage, 'enbridge_nc', 'https://www.enbridgegas.com/north-carolina'),
    checkedAt,
    estimateMonthly: buildRange((therms) => estimateGasMonthly(therms), UTILITY_ASSUMPTIONS.gasTherms),
    notes: [
      gasLikely
        ? 'Listing text includes gas-appliance signals; confirm active gas meter/provider before offer.'
        : 'No listing gas-appliance signal found; treat natural gas as optional until address availability is confirmed.',
      'Estimate uses a generic NC planning assumption because provider bills vary by rate case and gas cost riders.',
    ],
  })];
}

function normalizeProviderName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/charter|communications|llc|inc\.?|corporation|company|broadband|fiber/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function catalogKeyForProvider(name) {
  const normalized = normalizeProviderName(name);
  if (/\bspectrum\b/.test(normalized)) return 'spectrum';
  if (/\bgoogle\b|\bgfiber\b/.test(normalized)) return 'gfiber';
  return '';
}

function officialSeedKeyForProvider(name) {
  const raw = String(name ?? '').toLowerCase();
  const normalized = normalizeProviderName(name).replace(/\bat\s*t\b/g, 'att');
  if (/\bat\s*&\s*t\b/.test(raw) || /\batt\b/.test(normalized)) return 'att_availability';
  if (/\bbrightspeed\b/.test(normalized)) return 'brightspeed_availability';
  return '';
}

function parseBroadbandApiProviders(payload) {
  const candidates = Array.isArray(payload?.providers)
    ? payload.providers
    : Array.isArray(payload?.data?.providers)
      ? payload.data.providers
      : Array.isArray(payload?.internet)
        ? payload.internet
        : Array.isArray(payload?.results)
          ? payload.results
          : [];

  return candidates.map((entry) => {
    const name = entry.providerName ?? entry.provider ?? entry.name ?? entry.brandName ?? entry.holdingCompanyName ?? '';
    const downloadMbps = Number(entry.maxDownloadMbps ?? entry.max_download_mbps ?? entry.downloadMbps ?? entry.download_mbps ?? entry.max_down ?? entry.maxDownload ?? entry.download_speed ?? NaN);
    const uploadMbps = Number(entry.maxUploadMbps ?? entry.max_upload_mbps ?? entry.uploadMbps ?? entry.upload_mbps ?? entry.max_up ?? entry.maxUpload ?? entry.upload_speed ?? NaN);
    const technology = entry.technology ?? entry.tech ?? entry.connectionType ?? entry.type ?? '';
    return {
      name: String(name).trim(),
      technology: String(technology || '').trim(),
      downloadMbps: Number.isFinite(downloadMbps) ? downloadMbps : null,
      uploadMbps: Number.isFinite(uploadMbps) ? uploadMbps : null,
    };
  }).filter((entry) => entry.name);
}

function reportedPlanForProvider(reported, lookupUrl) {
  if (!reported?.downloadMbps) return null;
  return {
    name: `${reported.downloadMbps}${reported.uploadMbps ? `/${reported.uploadMbps}` : ''} Mbps reported service`,
    technology: reported.technology || 'Reported broadband',
    downloadMbps: reported.downloadMbps,
    uploadMbps: reported.uploadMbps,
    monthlyPrice: null,
    sourceUrl: lookupUrl || '',
  };
}

async function fetchBroadbandProviders(target, geocodeRecord, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  if (!fetchImpl || !geocodeRecord?.lat || !geocodeRecord?.lng) {
    return { status: 'unconfirmed', providers: [], error: 'No geocode available for FCC-derived internet lookup.' };
  }
  const params = new URLSearchParams({
    lat: String(geocodeRecord.lat),
    lng: String(geocodeRecord.lng),
    service_type: 'residential',
  });
  const url = `https://broadbandmap.com/api/v1/location/internet?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'home-ops/utility-options (+https://github.com/)' },
    });
    if (!response.ok) {
      return { status: 'blocked', providers: [], url, error: `HTTP ${response.status}` };
    }
    const payload = await response.json();
    return { status: 'captured', providers: parseBroadbandApiProviders(payload), url };
  } catch (error) {
    return { status: 'blocked', providers: [], url, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

function makeInternetProviderFromCatalog(key, status = 'unconfirmed', extra = {}) {
  const catalog = INTERNET_PLAN_CATALOG[key] ?? [];
  const names = { spectrum: 'Spectrum', gfiber: 'GFiber' };
  const reportedNote = extra.reported
    ? `FCC-derived lookup reports ${extra.reported.technology || 'fixed broadband'} service up to ${extra.reported.downloadMbps || '?'}${extra.reported.uploadMbps ? `/${extra.reported.uploadMbps}` : ''} Mbps.`
    : '';
  return makeProvider('internet', {
    name: names[key] ?? key,
    serviceStatus: status,
    sourceUrl: catalog[0]?.sourceUrl ?? '',
    plans: catalog,
    notes: [
      reportedNote,
      status === 'reported'
        ? 'Provider was reported by the FCC-derived lookup; final orderability still needs provider address confirmation.'
        : 'Published plan options only; address availability is unconfirmed.',
      ...(extra.notes ?? []),
    ].filter(Boolean),
  });
}

function chooseInternetStatus(city, key, reportedKeys) {
  if (reportedKeys.has(key)) return 'reported';
  if (key === 'gfiber' && ['cary', 'raleigh'].includes(city)) return 'likely';
  if (key === 'spectrum') return 'unconfirmed';
  return 'unconfirmed';
}

async function buildInternetProviders(target, coverage, geocodeRecord, options) {
  const checkedAt = formatCheckedAt();
  const city = normalizeCity(target.city);
  const lookup = options?.skipNetwork
    ? { status: 'skipped', providers: [], error: 'Network lookup skipped.' }
    : await fetchBroadbandProviders(target, geocodeRecord, options);
  const reportedKeys = new Set();
  const reportedCatalog = new Map();
  const reportedSeeds = new Map();
  const providers = [];

  for (const reported of lookup.providers ?? []) {
    const key = catalogKeyForProvider(reported.name);
    if (key) {
      reportedKeys.add(key);
      reportedCatalog.set(key, reported);
      continue;
    }
    const seedKey = officialSeedKeyForProvider(reported.name);
    if (seedKey) {
      reportedSeeds.set(seedKey, reported);
      continue;
    }
    const reportedPlan = reportedPlanForProvider(reported, lookup.url);
    providers.push(makeProvider('internet', {
      name: reported.name,
      serviceStatus: 'reported',
      sourceUrl: lookup.url || sourceUrlByKey(coverage, 'fcc_bdc'),
      checkedAt,
      plans: reportedPlan ? [reportedPlan] : [],
      notes: ['Reported by FCC-derived broadband lookup; provider orderability and pricing still need confirmation.'],
    }));
  }

  for (const key of ['spectrum', 'gfiber']) {
    providers.unshift(makeInternetProviderFromCatalog(key, chooseInternetStatus(city, key, reportedKeys), {
      reported: reportedCatalog.get(key),
    }));
  }

  for (const seed of [
    { name: 'AT&T Fiber / Internet Air', key: 'att_availability' },
    { name: 'Brightspeed', key: 'brightspeed_availability' },
  ]) {
    const reported = reportedSeeds.get(seed.key);
    const reportedPlan = reportedPlanForProvider(reported, lookup.url);
    providers.push(makeProvider('internet', {
      name: seed.name,
      serviceStatus: reported ? 'reported' : 'unconfirmed',
      sourceUrl: sourceUrlByKey(coverage, seed.key),
      checkedAt,
      plans: reportedPlan ? [reportedPlan] : [],
      notes: [
        reported
          ? `FCC-derived lookup reports ${reported.technology || 'fixed broadband'} service up to ${reported.downloadMbps || '?'}${reported.uploadMbps ? `/${reported.uploadMbps}` : ''} Mbps.`
          : 'Address-level provider check required; published pricing is not included without an address-confirmed plan.',
        'Final orderability still needs provider address confirmation.',
      ],
    }));
  }

  return {
    providers,
    lookupCoverage: {
      kind: 'internet',
      key: 'fcc_derived_location_lookup',
      name: 'FCC-derived internet provider lookup',
      url: lookup.url ?? '',
      status: lookup.status,
      checkedAt,
      note: lookup.error ?? 'Residential fixed broadband providers by geocoded location.',
    },
  };
}

function selectLowestInternetPlan(providers) {
  const candidates = [];
  for (const provider of providers) {
    if (!COUNTED_STATUSES.has(provider.serviceStatus)) continue;
    for (const plan of provider.plans ?? []) {
      const speed = Number(plan.downloadMbps);
      const price = plan.monthlyPrice == null ? NaN : Number(plan.monthlyPrice);
      if (Number.isFinite(speed) && speed >= 500 && Number.isFinite(price)) {
        candidates.push({ provider: provider.name, status: provider.serviceStatus, ...plan });
      }
    }
  }
  candidates.sort((left, right) => left.monthlyPrice - right.monthlyPrice || right.downloadMbps - left.downloadMbps);
  return candidates[0] ?? null;
}

function confidenceForRecord(record) {
  const coverage = record.sourceCoverage ?? [];
  const providers = Object.values(record.providers ?? {}).flat();
  const hasEstimatedAny = record.monthlyEstimate?.low != null
    && record.monthlyEstimate?.typical != null
    && record.monthlyEstimate?.high != null;
  const includedServices = record.monthlyEstimate?.includedServices ?? [];
  const hasElectric = includedServices.some((service) => /^electric\b/i.test(service));
  const hasWater = includedServices.some((service) => /^water\/sewer\b/i.test(service));
  const hasInternet = includedServices.some((service) => /^internet\b/i.test(service));
  const hasReportedInternet = providers.some((provider) => provider.kind === 'internet' && CHECKED_STATUSES.has(provider.serviceStatus));
  const blocked = coverage.some((entry) => ['blocked', 'error'].includes(entry.status));
  if (hasElectric && hasWater && hasInternet && hasReportedInternet && !blocked) return 'high';
  if (hasEstimatedAny && hasReportedInternet && (hasElectric || hasWater)) return 'medium';
  if (hasEstimatedAny) return 'low';
  return 'low';
}

export async function buildUtilityOptionsRecord(target, researchContext = {}, options = {}) {
  const checkedAt = formatCheckedAt();
  const sourceInventory = resolveSourceInventory(researchContext);
  const sourceCoverage = sourceCoverageFromInventory(sourceInventory, checkedAt);
  const listing = options.listing ?? loadListingForTarget(target, options.projectRoot ?? ROOT);
  const geocodeRecord = options.geocodeRecord ?? null;

  const electricProviders = buildElectricProviders(target, sourceCoverage);
  const waterProviders = buildWaterProviders(target, sourceCoverage);
  const gasProviders = buildGasProviders(target, listing, sourceCoverage);
  const internet = await buildInternetProviders(target, sourceCoverage, geocodeRecord, options);

  const electricEstimate = firstCountableProviderRange(electricProviders);
  const waterEstimate = firstCountableProviderRange(waterProviders);
  const selectedInternetPlan = selectLowestInternetPlan(internet.providers);
  const internetEstimate = selectedInternetPlan
    ? { low: selectedInternetPlan.monthlyPrice, typical: selectedInternetPlan.monthlyPrice, high: selectedInternetPlan.monthlyPrice }
    : null;
  const gasEstimate = gasProviders[0]?.estimateMonthly ?? null;

  let totalEstimate = { low: 0, typical: 0, high: 0 };
  const includedServices = [];
  const optionalServices = [];
  if (electricEstimate) {
    totalEstimate = addRange(totalEstimate, electricEstimate);
    includedServices.push('electric');
  }
  if (waterEstimate) {
    totalEstimate = addRange(totalEstimate, waterEstimate);
    includedServices.push('water/sewer');
  }
  if (internetEstimate) {
    totalEstimate = addRange(totalEstimate, internetEstimate);
    includedServices.push(`internet (${selectedInternetPlan.provider} ${selectedInternetPlan.name})`);
  }
  if (gasEstimate) {
    optionalServices.push('natural gas');
  }
  const monthlyEstimate = includedServices.length > 0
    ? { ...totalEstimate, includedServices, optionalServices, confidence: 'low' }
    : { low: null, typical: null, high: null, includedServices, optionalServices, confidence: 'low' };

  const warnings = [];
  if (!internetEstimate) {
    warnings.push('No address-confirmed or provider-reported internet plan price was captured; verify provider availability before relying on totals.');
  } else if (selectedInternetPlan?.status !== 'confirmed' && selectedInternetPlan?.status !== 'reported') {
    warnings.push('Internet pricing is included from a likely provider signal, not a completed provider orderability check.');
  }
  if (!waterEstimate) warnings.push('Water/sewer rates were not structured for this city; confirm utility provider, well/septic, and inside/outside town status.');
  if (!electricEstimate) warnings.push('Electric provider/rate table was not confirmed strongly enough to include in the main utility total.');
  if (gasProviders[0]?.serviceStatus !== 'likely') warnings.push('Natural gas is not included in the main total unless availability or gas appliances are confirmed.');
  if (electricProviders.every((provider) => provider.serviceStatus !== 'confirmed')) warnings.push('Electric provider remains a service-territory assumption until checked by address.');

  const record = {
    generatedAt: checkedAt,
    address: target.address,
    city: target.city,
    state: target.state || 'NC',
    reportPath: target.relativePath ?? target.reportPath ?? null,
    assumptions: UTILITY_ASSUMPTIONS,
    providers: {
      electric: electricProviders,
      waterSewer: waterProviders,
      naturalGas: gasProviders,
      internet: internet.providers,
    },
    monthlyEstimate,
    selectedInternetPlan: selectedInternetPlan ? {
      provider: selectedInternetPlan.provider,
      name: selectedInternetPlan.name,
      downloadMbps: selectedInternetPlan.downloadMbps,
      uploadMbps: selectedInternetPlan.uploadMbps,
      monthlyPrice: selectedInternetPlan.monthlyPrice,
      serviceStatus: selectedInternetPlan.status,
      sourceUrl: selectedInternetPlan.sourceUrl,
    } : null,
    optionalEstimates: {
      naturalGas: gasEstimate,
    },
    sourceCoverage: [...sourceCoverage, internet.lookupCoverage],
    warnings,
  };

  record.monthlyEstimate.confidence = confidenceForRecord(record);
  return record;
}
