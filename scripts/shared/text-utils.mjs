/**
 * Shared text helpers used across home-ops scripts.
 *
 * - slugify: lowercase, hyphenate non-alphanumerics, trim hyphens.
 * - normalizeStreetSuffixes: expand common street abbreviations.
 * - normalizeAddress: lowercase + suffix expansion + strip punctuation.
 * - normalizeCity: lowercase + strip punctuation.
 *
 * Address normalization is the canonical key used to dedup listings across
 * portals, so any change here must keep existing tracker rows colliding the
 * same way they did before.
 */

export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeStreetSuffixes(value) {
  return value
    .replace(/\bst\b/g, 'street')
    .replace(/\brd\b/g, 'road')
    .replace(/\bave\b/g, 'avenue')
    .replace(/\bblvd\b/g, 'boulevard')
    .replace(/\bdr\b/g, 'drive')
    .replace(/\bln\b/g, 'lane')
    .replace(/\bct\b/g, 'court')
    .replace(/\bcir\b/g, 'circle')
    .replace(/\bpkwy\b/g, 'parkway')
    .replace(/\bpl\b/g, 'place')
    .replace(/\bhwy\b/g, 'highway');
}

export function normalizeAddress(value) {
  return normalizeStreetSuffixes(String(value ?? '').toLowerCase())
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCity(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
