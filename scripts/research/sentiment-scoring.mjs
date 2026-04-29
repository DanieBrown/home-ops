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

/**
 * Build proximity hint groups for a given home. Returned object provides:
 *   - strong: list of phrases (subdivision name, road names, school names)
 *     whose presence in a snippet means the post is about the home's
 *     immediate area.
 *   - weak: list of phrases (city name) whose presence indicates a
 *     city-wide post that should contribute fractional weight.
 */
export function buildProximityHints({ subdivisionHints = [], roadHints = [], schoolNames = [], city = '', communityName = null } = {}) {
  const strong = [];
  if (communityName) strong.push(communityName);
  for (const hint of subdivisionHints) if (hint) strong.push(hint);
  for (const hint of roadHints) if (hint) strong.push(hint);
  for (const name of schoolNames) if (name) strong.push(name);
  const weak = city ? [city] : [];
  return { strong: dedupe(strong), weak: dedupe(weak) };
}

function dedupe(values) {
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
}

/**
 * Classify how close a snippet is to the home. Returns:
 *   - "strong": at least one strong hint matched (full weight, multiplier 1.0)
 *   - "weak":   only city/general matched (fractional weight, multiplier 0.4)
 *   - "none":   no hint matched (multiplier 0; caller should drop)
 */
export function classifyProximity(text, hints) {
  if (!text) return { level: 'none', multiplier: 0, matchedHints: [] };
  const haystack = String(text).toLowerCase();
  const strongMatched = hints.strong.filter((hint) => haystack.includes(String(hint).toLowerCase()));
  if (strongMatched.length > 0) return { level: 'strong', multiplier: 1.0, matchedHints: strongMatched };
  const weakMatched = hints.weak.filter((hint) => haystack.includes(String(hint).toLowerCase()));
  if (weakMatched.length > 0) return { level: 'weak', multiplier: 0.4, matchedHints: weakMatched };
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
