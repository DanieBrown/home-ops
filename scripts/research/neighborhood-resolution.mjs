/**
 * neighborhood-resolution.mjs -- resolveNeighborhood() chain (Phase 2 of the
 * sentiment-capture goal prompt).
 *
 * mapdevelopers.com was a single point of failure for 0.35 of the composite
 * score (neighborhood sentiment). This chain tries cheap, already-captured
 * sidecars first, escalates to public network sources only on a miss, and
 * keeps mapdevelopers as a last resort. Every candidate that was actually
 * tried is kept (`candidates`), not just the winner, so a disagreement
 * between sources lowers confidence instead of being silently discarded.
 *
 * Priority order (first confident match wins): parcel legal description,
 * county parcel-layer subdivision attribute (only when the county registry
 * maps one -- Wake's does not, verified against the live layer field list),
 * listing communityName, HOA sidecar communityName/associationName,
 * street-name heuristic, OpenStreetMap Overpass named places, mapdevelopers.
 * The first four are free (already on disk) and are always attempted so
 * they can cross-check each other; the rest cost a network call or a
 * browser scrape and are only attempted when nothing free resolved.
 */

const FIELD_LABEL_TOKENS = new Set(['address', 'city', 'state', 'zipcode', 'zip', 'code', 'county']);

export const RESOLVER_PRIORITY = [
  'parcel-legal-description',
  'county-parcel-layer',
  'listing',
  'hoa',
  'street-heuristic',
  'osm-overpass',
  'mapdevelopers',
];

// Two confirmed Wake County PROPDESC shapes: "LO14 WHEELER WOODS BM2016
// -00958" and "LO440 BRIGHTON FOREST PH4-A BM2008 -00642". Only these two
// are backed by real fixtures; unverified section/unit variants are
// deliberately not special-cased here.
const LEGAL_DESCRIPTION_PATTERN = /^LOT?\s*[\d-]+\s+(.+?)(?:\s+PH[\w.-]*)?\s+BM\s*\d+/i;

export function parseSubdivisionFromLegalDescription(legalDescription) {
  const match = String(legalDescription ?? '').match(LEGAL_DESCRIPTION_PATTERN);
  return match ? match[1].trim() : null;
}

const STREET_SUFFIXES = /\b(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln|court|ct|place|pl|terrace|ter|boulevard|blvd|way|parkway|pkwy|circle|cir|trail|trl|loop|run|ridge|rdg|point|pt)\b\.?$/i;

// "8121 Wheeler Woods Dr" -> "Wheeler Woods". Deliberately last among local
// sources: it is a strong hint in NC subdivision naming but produces false
// positives on through-roads that aren't subdivision names at all.
export function extractStreetHeuristicName(address) {
  const trimmed = String(address ?? '').trim();
  if (!trimmed) return null;
  const withoutNumber = trimmed.replace(/^\d+[a-z]?\s+/i, '');
  const withoutSuffix = withoutNumber.replace(STREET_SUFFIXES, '').trim();
  return withoutSuffix || null;
}

function isFieldLabelCluster(value) {
  const tokens = String(value ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.length >= 3 && tokens.every((token) => FIELD_LABEL_TOKENS.has(token));
}

export function sanitizeCandidateName(value, invalidPatterns = []) {
  const community = String(value ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b(?:subdivision|community|hoa|neighborhood)\b\s*$/i, '')
    .replace(/[.,;:]+$/, '')
    .trim();
  if (!community) return null;
  if (community.length > 80 || community.length < 2) return null;
  if (isFieldLabelCluster(community)) return null;
  if (FIELD_LABEL_TOKENS.has(community.toLowerCase())) return null;
  if (/https?:\/\//i.test(community)) return null;
  if (invalidPatterns.some((pattern) => pattern.test(community))) return null;
  return community;
}

function normalizeForCompare(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Public, no-key, no-ToS-friction OSM data. Rate-limited public instances --
 * one query per resolution, and only reached when nothing free resolved.
 * Returns { ok, value } on a real answer (including a legitimate "no named
 * place nearby") and { ok: false, error } only when the endpoint itself
 * could not be reached, so a dead Overpass instance is recorded as blocked
 * rather than "no neighborhood."
 */
export async function queryOverpassNeighborhood(lat, lng, { fetchImpl = fetch, radiusMeters = 400, endpoint = 'https://overpass-api.de/api/interpreter', timeoutMs = 20000 } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: true, value: null };
  }
  const query = `[out:json][timeout:20];(
    node["place"~"^(neighbourhood|suburb)$"]["name"](around:${radiusMeters},${lat},${lng});
    way["place"~"^(neighbourhood|suburb)$"]["name"](around:${radiusMeters},${lat},${lng});
    way["landuse"="residential"]["name"](around:${Math.min(radiusMeters, 250)},${lat},${lng});
  );out center tags;`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const body = await response.json();
    const named = (body.elements ?? []).find((element) => element.tags?.name);
    return { ok: true, value: named?.tags?.name ?? null };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Only activates for a county whose registry entry maps a subdivision-like
 * field on the parcel layer. Wake County's layer was enumerated live and
 * carries no such field (MAP_NAME is a map-grid reference, not a
 * subdivision name) -- for Wake this resolver is a no-op with zero network
 * cost, ready to activate the moment a county registry entry adds one.
 */
export async function queryCountyParcelSubdivisionField(parcelSidecar, { registry, arcgisQueryImpl } = {}) {
  const countyKey = String(parcelSidecar?.county ?? '').toLowerCase().split(/\s+/)[0];
  const layerConfig = registry?.counties?.[countyKey]?.parcelLayer;
  const subdivisionField = layerConfig?.fields?.subdivision;
  const parcelId = parcelSidecar?.parcel?.parcelId;
  const idField = layerConfig?.fields?.parcelId;
  if (!layerConfig?.url || !subdivisionField || !parcelId || !idField || typeof arcgisQueryImpl !== 'function') {
    return { ok: true, value: null, skipped: true };
  }
  const result = await arcgisQueryImpl(layerConfig.url, {
    where: `${idField}='${parcelId}'`,
    outFields: subdivisionField,
  });
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'ArcGIS query failed' };
  }
  return { ok: true, value: result.features?.[0]?.attributes?.[subdivisionField] ?? null };
}

function recordCandidate(candidates, { source, confidence, cost, invalidPatterns }, outcome) {
  if (!outcome || outcome.skipped) {
    candidates.push({
      source, confidence, cost, status: 'skipped', community: null, rawValue: null, error: null,
    });
    return;
  }
  if (outcome.ok === false) {
    candidates.push({
      source, confidence, cost, status: 'blocked', community: null, rawValue: null, error: outcome.error ?? 'unreachable',
    });
    return;
  }
  const rawValue = 'value' in outcome ? outcome.value : outcome;
  const community = sanitizeCandidateName(rawValue, invalidPatterns);
  candidates.push({
    source, confidence, cost, status: community ? 'matched' : 'no-match', community, rawValue: rawValue ?? null, error: null,
  });
}

function pickWinner(candidates) {
  const matched = candidates.filter((entry) => entry.status === 'matched');
  matched.sort((a, b) => RESOLVER_PRIORITY.indexOf(a.source) - RESOLVER_PRIORITY.indexOf(b.source));
  return matched[0] ?? null;
}

/**
 * @param {object} target - { address, city, state }
 * @param {object} options
 * @param {object} [options.parcelSidecar] - output/parcel/{slug}.json contents
 * @param {object} [options.listingSidecar] - output/listings/{slug}.json contents
 * @param {object} [options.hoaSidecar] - output/hoa/{slug}.json contents
 * @param {RegExp[]} [options.invalidPatterns] - from research-defaults.yml community.invalid_patterns
 * @param {object} [options.arcgisRegistry] - parsed config/county-arcgis-registry.yml
 * @param {Function} [options.arcgisQueryImpl] - injected for the county-parcel-layer resolver
 * @param {Function} [options.overpassQueryImpl] - injected for the osm-overpass resolver
 * @param {Function} [options.mapdevelopersQueryImpl] - injected browser-driven resolver, async (target) => { ok, value } | { ok: false, error }
 */
export async function resolveNeighborhood(target, options = {}) {
  const {
    parcelSidecar = null,
    listingSidecar = null,
    hoaSidecar = null,
    invalidPatterns = [],
    arcgisRegistry = null,
    arcgisQueryImpl = null,
    overpassQueryImpl = queryOverpassNeighborhood,
    mapdevelopersQueryImpl = null,
  } = options;

  const candidates = [];
  const ctx = { invalidPatterns };

  recordCandidate(candidates, { source: 'parcel-legal-description', confidence: 'high', cost: 'free', ...ctx },
    parcelSidecar?.parcel?.legalDescription
      ? { ok: true, value: parseSubdivisionFromLegalDescription(parcelSidecar.parcel.legalDescription) }
      : { skipped: true });

  recordCandidate(candidates, { source: 'listing', confidence: 'medium', cost: 'free', ...ctx },
    listingSidecar ? { ok: true, value: listingSidecar.communityName } : { skipped: true });

  recordCandidate(candidates, { source: 'hoa', confidence: 'medium', cost: 'free', ...ctx },
    hoaSidecar ? { ok: true, value: hoaSidecar.hoa?.communityName || hoaSidecar.hoa?.associationName || null } : { skipped: true });

  recordCandidate(candidates, { source: 'street-heuristic', confidence: 'low', cost: 'free', ...ctx },
    { ok: true, value: extractStreetHeuristicName(target?.address) });

  let winner = pickWinner(candidates);

  if (!winner) {
    const outcome = await queryCountyParcelSubdivisionField(parcelSidecar, { registry: arcgisRegistry, arcgisQueryImpl });
    recordCandidate(candidates, { source: 'county-parcel-layer', confidence: 'high', cost: 'gis-call', ...ctx }, outcome);
    winner = pickWinner(candidates);
  }

  if (!winner && typeof overpassQueryImpl === 'function') {
    const geocode = parcelSidecar?.geocode;
    const outcome = await overpassQueryImpl(geocode?.lat, geocode?.lng);
    recordCandidate(candidates, { source: 'osm-overpass', confidence: 'medium', cost: 'network-call', ...ctx }, outcome);
    winner = pickWinner(candidates);
  }

  if (!winner && typeof mapdevelopersQueryImpl === 'function') {
    const outcome = await mapdevelopersQueryImpl(target);
    recordCandidate(candidates, { source: 'mapdevelopers', confidence: 'low', cost: 'browser-scrape', ...ctx }, outcome);
    winner = pickWinner(candidates);
  }

  const matched = candidates.filter((entry) => entry.status === 'matched');
  const disagreement = matched.length > 1
    && new Set(matched.map((entry) => normalizeForCompare(entry.community))).size > 1;

  return {
    community: winner?.community ?? null,
    resolvedVia: winner?.source ?? null,
    confidence: disagreement ? 'low' : winner?.confidence ?? null,
    disagreement,
    candidates,
  };
}
