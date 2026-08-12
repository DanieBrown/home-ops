// scripts/research/access-core.mjs
//
// Pure parsers for road adjacency, traffic volume, drive times, and the
// guided-link dimensions. Testable offline against recorded NCDOT responses.
//
// The point of the AADT work is to replace a keyword match with a measurement.
// modes/_shared.md caps a home at 2.2 for "major road adjacency"; deciding that
// from whether a listing blurb happened to say "busy road" is not a finding.
// A named route, a traffic count, and a distance is.

import { haversineMeters, round } from '../shared/geo.mjs';
import { coverageEntry, dimension } from './source-coverage.mjs';

export const SOURCES = Object.freeze({
  aadtStations: {
    key: 'ncdot_aadt_stations',
    name: 'NCDOT Annual Average Daily Traffic stations',
    url: 'https://services.arcgis.com/NuWFvHYDMVmmxMeM/ArcGIS/rest/services/NCDOT_AADT_Stations/FeatureServer/0',
  },
  aadtSegments: {
    key: 'ncdot_aadt_segments',
    name: 'NCDOT AADT traffic segments',
    url: 'https://services.arcgis.com/NuWFvHYDMVmmxMeM/arcgis/rest/services/NCDOT_AADT_Traffic_Segmentation/FeatureServer/2',
  },
  driveTimes: {
    key: 'google_maps_directions',
    name: 'Google Maps directions (hosted browser session)',
    url: 'https://www.google.com/maps',
  },
  sexOffender: {
    key: 'ncsbi_sex_offender_registry',
    name: 'NC SBI Sex Offender Registry',
    url: 'https://sexoffender.ncsbi.gov',
    nationalUrl: 'https://www.nsopw.gov/search-public-sex-offender-registries',
  },
  schoolRedistricting: {
    key: 'school_assignment_changes',
    name: 'District student assignment changes',
    url: 'https://www.wcpss.net/domain/12171',
  },
});

export const DEFAULT_THRESHOLDS = Object.freeze({
  busyRoadAadt: 15000,
  busyRoadDistanceMeters: 250,
  aadtSearchRadiusMeters: 2000,
});

export function resolveThresholds(profile = {}) {
  const access = profile?.access ?? {};
  const pick = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    busyRoadAadt: pick(access.busy_road_aadt, DEFAULT_THRESHOLDS.busyRoadAadt),
    busyRoadDistanceMeters: pick(access.busy_road_distance_meters, DEFAULT_THRESHOLDS.busyRoadDistanceMeters),
    aadtSearchRadiusMeters: pick(access.aadt_search_radius_meters, DEFAULT_THRESHOLDS.aadtSearchRadiusMeters),
  };
}

/**
 * NCDOT publishes one column per survey year (AADT_2002 … AADT_2022) and
 * leaves the years a station was not counted blank, so the "current" volume is
 * the most recent column that actually carries a number.
 */
export function latestAadt(attributes = {}) {
  let best = null;
  for (const [key, raw] of Object.entries(attributes)) {
    const match = /^AADT_(\d{4})$/.exec(key);
    if (!match) continue;
    const value = Number(String(raw ?? '').trim());
    if (!Number.isFinite(value) || value <= 0) continue;
    const year = Number(match[1]);
    if (!best || year > best.year) best = { year, aadt: value };
  }
  return best;
}

/**
 * Nearest counted road plus its volume. Stations carry the route name and the
 * count; segments carry a count but no name, so they only ever supplement.
 */
export function parseRoadAccess(stationsResponse, segmentsResponse, home, thresholds = DEFAULT_THRESHOLDS) {
  const station = SOURCES.aadtStations;
  const segment = SOURCES.aadtSegments;
  const coverage = [];

  if (!stationsResponse || stationsResponse.ok === false) {
    coverage.push(coverageEntry({
      key: station.key, name: station.name, url: station.url, status: 'blocked',
      error: stationsResponse?.error ?? 'no response',
    }));
    return {
      coverage,
      nearestRoad: null,
      busyRoadExposure: null,
      dimension: dimension({
        label: 'Nearest counted road',
        provenance: 'blocked',
        sourceUrl: station.url,
        note: `NCDOT AADT query failed (${stationsResponse?.error ?? 'no response'}). Road exposure is unknown, not low.`,
      }),
    };
  }
  coverage.push(coverageEntry({ key: station.key, name: station.name, url: station.url, status: 'captured' }));

  const stations = [];
  for (const feature of stationsResponse.features ?? []) {
    const a = feature.attributes ?? {};
    const geometry = feature.geometry ?? {};
    const meters = haversineMeters(home.lat, home.lng, Number(geometry.y), Number(geometry.x));
    const latest = latestAadt(a);
    if (!latest || meters == null) continue;
    stations.push({
      route: String(a.ROUTE ?? '').trim() || null,
      location: String(a.LOCATION ?? '').trim() || null,
      locationId: a.LocationID ?? null,
      routeClass: Number(a.RTE_CLS) || null,
      aadt: latest.aadt,
      aadtYear: latest.year,
      distanceMeters: Math.round(meters),
    });
  }
  stations.sort((left, right) => left.distanceMeters - right.distanceMeters);

  // Segments have volume but no route name, so they only ever corroborate.
  let peakSegmentAadt = null;
  if (segmentsResponse && segmentsResponse.ok !== false) {
    coverage.push(coverageEntry({ key: segment.key, name: segment.name, url: segment.url, status: 'captured' }));
    for (const feature of segmentsResponse.features ?? []) {
      const value = Number(feature.attributes?.AADT);
      if (Number.isFinite(value) && (peakSegmentAadt == null || value > peakSegmentAadt)) peakSegmentAadt = value;
    }
  } else if (segmentsResponse) {
    coverage.push(coverageEntry({
      key: segment.key, name: segment.name, url: segment.url, status: 'blocked',
      error: segmentsResponse.error ?? 'no response',
    }));
  }

  if (stations.length === 0) {
    return {
      coverage,
      nearestRoad: null,
      busyRoadExposure: null,
      dimension: dimension({
        label: 'Nearest counted road',
        provenance: 'unconfirmed',
        sourceUrl: station.url,
        note: `No NCDOT count station within ${thresholds.aadtSearchRadiusMeters} m. Local streets are not counted, so this is not evidence of low traffic.`,
      }),
    };
  }

  // "Busy road exposure" = a high-volume road that is also close.
  const qualifying = stations.filter(
    (s) => s.aadt >= thresholds.busyRoadAadt && s.distanceMeters <= thresholds.busyRoadDistanceMeters,
  );
  const nearest = stations[0];
  const loudest = [...stations].sort((a, b) => b.aadt - a.aadt)[0];
  const exposed = qualifying.length > 0;

  return {
    coverage,
    stations: stations.slice(0, 8),
    nearestRoad: nearest,
    peakSegmentAadt,
    busyRoadExposure: {
      exposed,
      threshold: thresholds,
      matchedRoad: exposed ? qualifying[0] : null,
      loudestNearbyRoad: loudest,
    },
    dimension: dimension({
      label: 'Nearest counted road',
      provenance: 'captured',
      value: `${nearest.route ?? 'unnamed route'} — ${nearest.aadt.toLocaleString('en-US')} AADT at ${nearest.distanceMeters} m`,
      detail: [
        nearest.location ? `station ${nearest.location}` : null,
        `${nearest.aadtYear} count`,
        exposed
          ? `exceeds the buyer's busy-road threshold (${thresholds.busyRoadAadt.toLocaleString('en-US')} AADT within ${thresholds.busyRoadDistanceMeters} m)`
          : `below the buyer's busy-road threshold (${thresholds.busyRoadAadt.toLocaleString('en-US')} AADT within ${thresholds.busyRoadDistanceMeters} m)`,
      ].filter(Boolean).join('; '),
      sourceUrl: station.url,
      note: 'NCDOT counts state-maintained routes. Subdivision streets are not counted, so an uncounted street is unmeasured, not quiet.',
    }),
  };
}

// ── Drive times ──────────────────────────────────────────────────────

/** "1 hr 5 min", "25 min", "1 h 5 min" → minutes. */
export function parseDurationMinutes(text) {
  if (!text) return null;
  const cleaned = String(text).toLowerCase();
  const hours = /(\d+)\s*(?:hr|hour|h)\b/.exec(cleaned);
  const minutes = /(\d+)\s*(?:min|minute|m)\b/.exec(cleaned);
  if (!hours && !minutes) return null;
  return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
}

const formatMinutes = (value) => {
  if (!Number.isFinite(value)) return null;
  if (value < 60) return `${Math.round(value)} min`;
  const h = Math.floor(value / 60);
  const m = Math.round(value % 60);
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
};

export function mapsDirectionsUrl(origin, destination) {
  const params = new URLSearchParams({
    api: '1',
    origin: String(origin ?? ''),
    destination: String(destination ?? ''),
    travelmode: 'driving',
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * `captures` is one entry per configured destination, each already read from
 * the hosted browser session. A destination whose duration could not be read
 * keeps its map link but reports blocked -- the PDF previously showed only
 * links, so degrading to a link is never worse than the old behavior.
 */
export function buildDriveTimes(destinations, captures = [], { origin = null } = {}) {
  const source = SOURCES.driveTimes;

  if (!Array.isArray(destinations) || destinations.length === 0) {
    return {
      coverage: coverageEntry({
        key: source.key, name: source.name, url: source.url, status: 'skipped-by-profile',
        note: 'config/profile.yml has no commute.destinations, so no drive time was measured.',
      }),
      routes: [],
      dimension: dimension({
        label: 'Drive times',
        provenance: 'not-applicable',
        sourceUrl: source.url,
        note: 'No commute destinations are configured in config/profile.yml (commute.destinations). Add one to measure drive times.',
      }),
    };
  }

  const byName = new Map(captures.map((capture) => [capture.name, capture]));
  const routes = destinations.map((destination) => {
    const capture = byName.get(destination.name) ?? {};
    const url = mapsDirectionsUrl(origin ?? '', destination.address ?? destination.name);
    return {
      name: destination.name,
      address: destination.address ?? null,
      freeFlowMinutes: Number.isFinite(capture.freeFlowMinutes) ? capture.freeFlowMinutes : null,
      peakMinutes: Number.isFinite(capture.peakMinutes) ? capture.peakMinutes : null,
      typicalRange: capture.typicalRange ?? null,
      status: capture.error ? 'blocked' : (Number.isFinite(capture.freeFlowMinutes) ? 'captured' : 'blocked'),
      error: capture.error ?? (Number.isFinite(capture.freeFlowMinutes) ? null : 'no duration could be read from the directions panel'),
      mapUrl: url,
    };
  });

  const captured = routes.filter((route) => route.status === 'captured');
  const allBlocked = captured.length === 0;

  return {
    coverage: coverageEntry({
      key: source.key, name: source.name, url: source.url,
      status: allBlocked ? 'blocked' : 'captured',
      error: allBlocked ? routes[0]?.error ?? 'no durations captured' : null,
      note: allBlocked ? 'Map links are still provided; no duration was measured.' : null,
    }),
    routes,
    dimension: dimension({
      label: 'Drive times',
      provenance: allBlocked ? 'blocked' : 'captured',
      value: allBlocked ? null : captured
        .map((route) => `${route.name} ${formatMinutes(route.freeFlowMinutes)}${route.peakMinutes ? ` (peak ${formatMinutes(route.peakMinutes)})` : ''}`)
        .join('; '),
      detail: allBlocked ? null : (captured.some((r) => r.peakMinutes == null) ? 'Peak-hour duration unavailable for some destinations.' : null),
      sourceUrl: source.url,
      note: allBlocked ? 'Directions could not be read from the hosted session. Map links are provided instead of a measured time.' : null,
    }),
  };
}

// ── Guided links (no scraping) ───────────────────────────────────────

/**
 * The sex-offender registry is a law-enforcement system with an acceptable-use
 * policy and no public API. We emit the official radius-search link and how to
 * run it, and never scrape it or a third-party reseller.
 */
export function buildSexOffenderGuide(target) {
  const source = SOURCES.sexOffender;
  const oneLine = [target.address, target.city, target.state].filter(Boolean).join(', ');
  return {
    coverage: coverageEntry({
      key: source.key, name: source.name, url: source.url, status: 'captured',
      note: 'Guided link emitted. The registry has no public API and is not scraped.',
    }),
    guide: {
      name: 'NC SBI Sex Offender Registry — radius search',
      url: source.url,
      alternateUrl: source.nationalUrl,
      instructions: `Open the registry, choose the address radius search, enter "${oneLine}", and pick a 1-mile radius. The national NSOPW portal is a reasonable cross-check.`,
    },
    dimension: dimension({
      label: 'Sex-offender proximity',
      provenance: 'unconfirmed',
      sourceUrl: source.url,
      note: 'Buyer-run check. The NC SBI registry publishes no API and its acceptable-use policy rules out automated retrieval, so no result is claimed here.',
    }),
  };
}

/**
 * Assignment changes are published as board proposals with no stable API, so
 * this adds the change-risk narrative only -- current assignment already comes
 * from school-assignments-fetch.mjs.
 */
export function buildRedistrictingGuide(target, { districtUrl = null } = {}) {
  const source = SOURCES.schoolRedistricting;
  const url = districtUrl ?? source.url;
  return {
    coverage: coverageEntry({
      key: source.key, name: source.name, url, status: 'captured',
      note: 'Guided link emitted; assignment-change risk is not machine-readable.',
    }),
    guide: {
      name: 'Student assignment change proposals',
      url,
      instructions: `Check the district's assignment-change page for proposals covering ${target.city ?? 'this area'}. Growth-corridor addresses in new subdivisions are reassigned more often than established ones.`,
    },
    dimension: dimension({
      label: 'School redistricting risk',
      provenance: 'unconfirmed',
      sourceUrl: url,
      note: 'Districts publish assignment changes as board proposals without a stable API. Current assignment is captured separately in output/school-metadata/.',
    }),
  };
}

// ── Record assembly ──────────────────────────────────────────────────

export function buildAccessRecord({ target, geocode, road, driveTimes, sexOffender, redistricting, generatedAt = new Date().toISOString() }) {
  const dimensions = {
    nearestRoad: road.dimension,
    driveTimes: driveTimes.dimension,
    sexOffenderProximity: sexOffender.dimension,
    schoolRedistricting: redistricting.dimension,
  };

  const warnings = [];
  for (const dim of Object.values(dimensions)) {
    if (dim.provenance === 'blocked') {
      warnings.push(`${dim.label}: source unreachable — recorded as blocked, not as a low-risk finding.`);
    }
  }

  const sourceCoverage = [
    ...(road.coverage ?? []),
    driveTimes.coverage,
    sexOffender.coverage,
    redistricting.coverage,
  ].filter(Boolean);

  return {
    generatedAt,
    address: target.address,
    city: target.city,
    state: target.state,
    reportPath: target.relativePath,
    geocode: geocode ? { lat: geocode.lat, lng: geocode.lng, source: geocode.source } : null,
    status: 'reviewed',
    nearestRoad: road.nearestRoad ?? null,
    busyRoadExposure: road.busyRoadExposure ?? null,
    aadtStations: road.stations ?? [],
    driveTimes: driveTimes.routes ?? [],
    guidedChecks: [sexOffender.guide, redistricting.guide].filter(Boolean),
    dimensions,
    sourceCoverage,
    warnings,
  };
}

export { formatMinutes, round };
