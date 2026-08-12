// scripts/shared/geo.mjs
//
// Small geometry helpers shared by the spatial capture scripts. No network,
// no dependencies -- everything here is pure math so it can be unit tested
// against recorded fixtures.

const EARTH_RADIUS_M = 6371008.8;      // mean Earth radius (IUGG)
const WEB_MERCATOR_R = 6378137;        // EPSG:3857 sphere radius
const METERS_PER_MILE = 1609.344;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Great-circle distance in meters between two WGS84 points. */
export function haversineMeters(aLat, aLng, bLat, bLng) {
  if (![aLat, aLng, bLat, bLng].every((value) => Number.isFinite(value))) return null;
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function metersToMiles(meters) {
  if (!Number.isFinite(meters)) return null;
  return meters / METERS_PER_MILE;
}

export function metersToFeet(meters) {
  if (!Number.isFinite(meters)) return null;
  return meters * 3.28084;
}

/**
 * WGS84 lon/lat → EPSG:3857 (Web Mercator) meters.
 *
 * Some published ArcGIS layers ship their geometry as an embedded Web Mercator
 * feature collection rather than a queryable service. Projecting the point
 * into the layer's own space keeps point-in-polygon exact -- Mercator's area
 * distortion cancels out because both sides use the same projection.
 */
export function toWebMercator(lng, lat) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return {
    x: WEB_MERCATOR_R * toRadians(lng),
    y: WEB_MERCATOR_R * Math.log(Math.tan(Math.PI / 4 + toRadians(clampedLat) / 2)),
  };
}

/**
 * Ray-casting point-in-polygon over an Esri ring array. Esri polygons use
 * clockwise outer rings and counter-clockwise holes; the even-odd rule handles
 * both without needing to classify them.
 */
export function pointInRings(point, rings) {
  if (!point || !Array.isArray(rings)) return false;
  const { x, y } = point;
  let inside = false;

  for (const ring of rings) {
    if (!Array.isArray(ring)) continue;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i] ?? [];
      const [xj, yj] = ring[j] ?? [];
      if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) continue;
      const straddles = (yi > y) !== (yj > y);
      if (straddles && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }

  return inside;
}

/**
 * Area-weighted centroid of an Esri polygon's rings, in the ring's own units.
 *
 * Used to re-anchor a spatial query onto a matched parcel: an interpolated
 * street-centerline geocode can sit in the right-of-way or on the neighbour's
 * lot, while the parcel centroid is unambiguously inside this home's lot.
 * Falls back to the vertex mean for degenerate (zero-area) rings.
 */
export function ringsCentroid(rings) {
  if (!Array.isArray(rings) || rings.length === 0) return null;
  const outer = rings[0];
  if (!Array.isArray(outer) || outer.length < 3) return null;

  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i, i += 1) {
    const [xi, yi] = outer[i] ?? [];
    const [xj, yj] = outer[j] ?? [];
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
    const cross = xj * yi - xi * yj;
    twiceArea += cross;
    cx += (xj + xi) * cross;
    cy += (yj + yi) * cross;
  }

  if (Math.abs(twiceArea) < 1e-12) {
    const points = outer.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (points.length === 0) return null;
    return {
      x: points.reduce((sum, p) => sum + p[0], 0) / points.length,
      y: points.reduce((sum, p) => sum + p[1], 0) / points.length,
    };
  }

  return { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) };
}

/** Rounds to a fixed number of decimals, preserving null for missing input. */
export function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
