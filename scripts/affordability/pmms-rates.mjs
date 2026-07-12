// Freddie Mac PMMS rate lookup with a persistent last-known-good cache.
// The cache lives under .home-ops/ (transient state) so a PMMS outage or
// parse break does not dead-end the affordability wizard.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { PMMS_URL, toNumber } from './affordability-core.mjs';
import { HOME_OPS_DIR } from '../shared/paths.mjs';

export const PMMS_CACHE_PATH = join(HOME_OPS_DIR, 'pmms-rates-cache.json');

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchPmmsRates({ timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(PMMS_URL, {
      headers: { 'user-agent': 'home-ops-affordability/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Freddie Mac PMMS returned HTTP ${response.status}`);
    const text = stripTags(await response.text());
    const asOf = text.match(/as of ([A-Za-z]+ \d{1,2}, \d{4})/)?.[1] ?? null;
    const rate30Pct = toNumber(text.match(/30-year fixed-rate mortgage\s+averaged\s+([\d.]+)%/i)?.[1]);
    const rate15Pct = toNumber(text.match(/15-year fixed-rate mortgage\s+averaged\s+([\d.]+)%/i)?.[1]);
    if (!Number.isFinite(rate30Pct) && !Number.isFinite(rate15Pct)) {
      throw new Error('Could not parse 30-year or 15-year PMMS rates.');
    }
    return {
      source: PMMS_URL,
      asOf,
      rate30Pct,
      rate15Pct,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function readCachedPmmsRates(cachePath = PMMS_CACHE_PATH) {
  if (!existsSync(cachePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    const rates = parsed?.rates;
    if (!Number.isFinite(toNumber(rates?.rate30Pct)) && !Number.isFinite(toNumber(rates?.rate15Pct))) return null;
    return { ...rates, cachedAt: parsed.cachedAt ?? null };
  } catch {
    return null;
  }
}

export function writeCachedPmmsRates(rates, cachePath = PMMS_CACHE_PATH) {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify({ cachedAt: new Date().toISOString(), rates }, null, 2)}\n`, 'utf8');
}

// Fetch fresh PMMS rates and refresh the cache; on failure fall back to the
// last cached rates (flagged with fromCache/fetchError) or rethrow when no
// cache exists.
export async function getPmmsRates({ cachePath = PMMS_CACHE_PATH, fetcher = fetchPmmsRates, timeoutMs = 8000 } = {}) {
  try {
    const rates = await fetcher({ timeoutMs });
    try {
      writeCachedPmmsRates(rates, cachePath);
    } catch {
      // A cache write failure should never block a successful lookup.
    }
    return rates;
  } catch (error) {
    const cached = readCachedPmmsRates(cachePath);
    if (cached) {
      return { ...cached, fromCache: true, fetchError: error.message };
    }
    throw error;
  }
}
