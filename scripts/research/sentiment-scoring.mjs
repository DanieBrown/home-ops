/**
 * sentiment-scoring.mjs -- Shared helpers for sentiment-browser-extract and
 * sentiment-public-extract. Centralizes:
 *
 * 1. Profile-derived red-flag patterns. Pulls keywords from
 *    config/profile.yml deal_breakers (e.g. "flood zone", "highway adjacent")
 *    and commute destinations so the scorer treats buyer-specific concerns
 *    as negative signals instead of leaning only on the generic lexicon.
 *
 * 2. Proximity scoring. A snippet that mentions the home's subdivision,
 *    road, or school name is "near" evidence and counts at full weight.
 *    A snippet that only mentions the city name is "general area" and
 *    contributes a fractional weight, which prevents city-wide chatter
 *    from dominating per-home scores.
 */

const SOFT_WORDS = new Set(['the', 'and', 'of', 'to', 'in', 'on', 'a', 'an', 'or', 'with', 'for', 'is', 'are', 'be', 'near']);

function tokenize(value) {
  return String(value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !SOFT_WORDS.has(token));
}

function escapeForRegex(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract red-flag regex patterns from the buyer profile. Each deal-breaker
 * phrase becomes a tolerant regex (alphanumeric tokens joined by \s+).
 * Examples:
 *   "Backs to commercial or highway" ->
 *     - /backs\s+to\s+commercial/i
 *     - /backs\s+to\s+highway/i
 *   "Flood zone" -> /flood\s+zone/i
 */
export function buildProfileRedFlagPatterns(profile) {
  const dealBreakers = Array.isArray(profile?.search?.deal_breakers) ? profile.search.deal_breakers : [];
  const patterns = [];
  for (const phrase of dealBreakers) {
    const cleaned = String(phrase ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;

    // Split on " or " and " and " so "commercial or highway" yields two patterns.
    const subPhrases = cleaned.split(/\s+(?:or|and)\s+/);
    const baseTokens = subPhrases[0].split(' ').filter((t) => t && !SOFT_WORDS.has(t));

    for (const sub of subPhrases) {
      const subTokens = sub.split(' ').filter((t) => t && !SOFT_WORDS.has(t));
      // For "commercial or highway" the second sub is just "highway" -- carry the
      // leading verb tokens from the first sub-phrase so we still match
      // "backs to highway".
      const tokens = subTokens.length === 1 && baseTokens.length > 1
        ? [...baseTokens.slice(0, baseTokens.length - 1), subTokens[0]]
        : subTokens;
      if (tokens.length === 0) continue;
      // Allow up to ~30 chars of intervening words/spaces between tokens so
      // phrases like "backs to commercial" still match after we drop the
      // soft-word "to". This is a tolerant proximity match within a snippet.
      const between = '[\\s\\w]{0,30}?';
      patterns.push(new RegExp(`\\b${tokens.map(escapeForRegex).join(between)}\\b`, 'i'));
    }
  }
  return patterns;
}

// The specificity ladder (Phase 3 of the sentiment-capture goal prompt):
// a snippet degrades in *tier*, never to silence. `municipal` is always
// available (the city name is always known), so every run can classify
// something instead of dropping evidence outright. Buyer-tunable at
// config/profile.yml sentiment.proximity_tiers -- these are the fallback
// defaults when a buyer hasn't overridden them.
export const PROXIMITY_TIER_ORDER = ['subdivision', 'street', 'school-zone', 'municipal'];
export const DEFAULT_PROXIMITY_TIER_MULTIPLIERS = {
  subdivision: 1.0,
  street: 0.8,
  'school-zone': 0.6,
  municipal: 0.3,
};

export function resolveProximityTierMultipliers(profile) {
  const configured = profile?.sentiment?.proximity_tiers ?? {};
  return {
    subdivision: Number.isFinite(configured.subdivision) ? configured.subdivision : DEFAULT_PROXIMITY_TIER_MULTIPLIERS.subdivision,
    street: Number.isFinite(configured.street) ? configured.street : DEFAULT_PROXIMITY_TIER_MULTIPLIERS.street,
    'school-zone': Number.isFinite(configured.school_zone) ? configured.school_zone : DEFAULT_PROXIMITY_TIER_MULTIPLIERS['school-zone'],
    municipal: Number.isFinite(configured.municipal) ? configured.municipal : DEFAULT_PROXIMITY_TIER_MULTIPLIERS.municipal,
  };
}

/**
 * Build proximity hint groups for a given home, one array per tier:
 *   - subdivision: the resolved neighborhood name and any subdivision hints
 *   - street: road/street names
 *   - schoolZone: assigned school names -- a genuine local-geography proxy
 *   - municipal: the city name -- always available, the floor of the ladder
 */
export function buildProximityHints({ subdivisionHints = [], roadHints = [], schoolNames = [], city = '', communityName = null } = {}) {
  const subdivision = [];
  if (communityName) subdivision.push(communityName);
  for (const hint of subdivisionHints) if (hint) subdivision.push(hint);
  const street = dedupe(roadHints);
  const schoolZone = dedupe(schoolNames);
  const municipal = city ? [city] : [];
  return { subdivision: dedupe(subdivision), street, schoolZone, municipal };
}

function dedupe(values) {
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
}

/**
 * Classify how close a snippet is to the home by walking the specificity
 * ladder from most to least specific and returning the first tier that
 * matched. "none" means no hint at all matched (including the city name),
 * which the caller should drop -- everything else is a genuine, labelled
 * finding at some tier.
 */
export function classifyProximity(text, hints, tierMultipliers = DEFAULT_PROXIMITY_TIER_MULTIPLIERS) {
  if (!text) return { level: 'none', multiplier: 0, matchedHints: [] };
  const haystack = String(text).toLowerCase();
  const tiersToCheck = [
    ['subdivision', hints.subdivision ?? []],
    ['street', hints.street ?? []],
    ['school-zone', hints.schoolZone ?? []],
    ['municipal', hints.municipal ?? []],
  ];
  for (const [level, phrases] of tiersToCheck) {
    const matched = phrases.filter((hint) => haystack.includes(String(hint).toLowerCase()));
    if (matched.length > 0) {
      return { level, multiplier: tierMultipliers[level] ?? DEFAULT_PROXIMITY_TIER_MULTIPLIERS[level] ?? 0, matchedHints: matched };
    }
  }
  return { level: 'none', multiplier: 0, matchedHints: [] };
}

/**
 * Score profile red-flag pattern hits in a snippet. Returns the count of
 * distinct buyer-specific concerns that the snippet touches, plus the
 * matched phrases for surfacing alongside the score.
 */
export function scoreProfileRedFlags(text, redFlagPatterns) {
  if (!text || !Array.isArray(redFlagPatterns)) return { hits: 0, matched: [] };
  const matched = [];
  for (const pattern of redFlagPatterns) {
    if (pattern.test(text)) matched.push(pattern.source);
  }
  return { hits: matched.length, matched };
}
