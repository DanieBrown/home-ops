# Portal Extractor Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix homes.com (broken @graph JSON-LD + missing DOM fields) and complete realtor.com (listingAgent, mls, precise baths, daysOnMarket) so both portals fully populate the canonical `buildEmptyListing()` schema.

**Architecture:** All changes are isolated to `scripts/research/extract-listing-details.mjs`. The shared `pickJsonLdResidence()` gets a 5-line @graph unwrap; `fromJsonLdResidence()` gains agent + listing-date reads; `extractHomes()` is rewritten with JSON-LD primary + DOM section parser secondary; `extractRealtor()` gains four additive field reads. Pure helper functions are exported for unit testing; Playwright-dependent extractors are covered by integration smoke tests.

**Tech Stack:** Node.js ESM, node:assert/strict (unit tests), Playwright via existing `attachHostedBrowser` (integration tests), no external test framework.

---

## File Map

| File | Action | What changes |
|---|---|---|
| `scripts/research/extract-listing-details.mjs` | Modify | `pickJsonLdResidence`, `fromJsonLdResidence`, `extractHomes`, `extractRealtor` + add named exports |
| `scripts/tests/test-extract-parsers.mjs` | Create | Unit tests for pure helper functions |

---

### Task 1: Add named exports for pure helpers

The unit test file imports `pickJsonLdResidence` and `fromJsonLdResidence` by name. Neither is currently exported. This task adds the exports before implementing any logic changes.

**Files:**
- Modify: `scripts/research/extract-listing-details.mjs`

- [ ] **Step 1: Open the file and find the bottom of the module (after `buildSlug`)**

The file ends around line 680 with an `async function main()` block and an `if (import.meta.url ...)` guard. The existing export is `export async function extractListing(...)` at line 562.

- [ ] **Step 2: Add named exports for the two pure helpers**

Add these two lines immediately after the closing brace of `fromJsonLdResidence` (currently around line 319), changing the existing function declarations to exported functions:

Change:
```js
function pickJsonLdResidence(jsonLdItems = []) {
```
to:
```js
export function pickJsonLdResidence(jsonLdItems = []) {
```

Change:
```js
function fromJsonLdResidence(item) {
```
to:
```js
export function fromJsonLdResidence(item) {
```

- [ ] **Step 3: Verify the exports don't break the existing CLI**

```bash
node scripts/research/extract-listing-details.mjs --help
```

Expected output: the HELP_TEXT block (usage instructions). No import errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/research/extract-listing-details.mjs
git commit -m "refactor: export pickJsonLdResidence and fromJsonLdResidence for unit testing"
```

---

### Task 2: Create unit test harness and write failing @graph tests

**Files:**
- Create: `scripts/tests/test-extract-parsers.mjs`

- [ ] **Step 1: Create the test file**

```js
#!/usr/bin/env node
/**
 * Unit tests for extract-listing-details.mjs pure helper functions.
 * Run: node scripts/tests/test-extract-parsers.mjs
 */
import assert from 'node:assert/strict';
import { pickJsonLdResidence, fromJsonLdResidence } from '../research/extract-listing-details.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}: ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// pickJsonLdResidence — @graph handling
// ---------------------------------------------------------------------------

test('@graph: finds SingleFamilyResidence inside @graph wrapper', () => {
  const items = [{
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', name: 'Listing page' },
      {
        '@type': 'SingleFamilyResidence',
        numberOfBedrooms: 5,
        floorSize: { value: 3716, unitText: 'SQFT' },
        address: { streetAddress: '4404 Clarkdale Ct', addressLocality: 'Fuquay Varina', addressRegion: 'NC', postalCode: '27526' },
      },
    ],
  }];
  const result = pickJsonLdResidence(items);
  assert.ok(result, 'should find a residence item');
  assert.equal(result['@type'], 'SingleFamilyResidence');
  assert.equal(result.numberOfBedrooms, 5);
});

test('@graph: returns null when @graph has no residence type', () => {
  const items = [{
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage' },
      { '@type': 'Organization', name: 'Realty Co' },
    ],
  }];
  const result = pickJsonLdResidence(items);
  assert.equal(result, null);
});

// Regression: flat @type items must still work
test('flat @type: finds SingleFamilyResidence without @graph wrapper', () => {
  const items = [
    { '@type': 'WebPage', name: 'Listing page' },
    { '@type': 'SingleFamilyResidence', numberOfBedrooms: 3, address: { streetAddress: '1 Main St' } },
  ];
  const result = pickJsonLdResidence(items);
  assert.ok(result);
  assert.equal(result.numberOfBedrooms, 3);
});

test('flat @type: returns null when nothing matches', () => {
  const result = pickJsonLdResidence([{ '@type': 'WebPage' }]);
  assert.equal(result, null);
});

test('empty array: returns null', () => {
  assert.equal(pickJsonLdResidence([]), null);
});

// ---------------------------------------------------------------------------
// fromJsonLdResidence — listingAgent + daysOnMarket
// ---------------------------------------------------------------------------

test('fromJsonLdResidence: extracts listingAgent from offers.offeredBy array', () => {
  const item = {
    '@type': 'SingleFamilyResidence',
    address: { streetAddress: '123 Main St', addressLocality: 'Raleigh', addressRegion: 'NC', postalCode: '27601' },
    offers: [{ price: 500000, availability: 'InStock', offeredBy: [{ name: 'Jane Smith' }] }],
  };
  const result = fromJsonLdResidence(item);
  assert.equal(result.listingAgent, 'Jane Smith');
});

test('fromJsonLdResidence: extracts listingAgent from offers.offeredBy object (non-array)', () => {
  const item = {
    '@type': 'SingleFamilyResidence',
    address: { streetAddress: '123 Main St', addressLocality: 'Raleigh', addressRegion: 'NC' },
    offers: { price: 400000, offeredBy: { name: 'Bob Jones' } },
  };
  const result = fromJsonLdResidence(item);
  assert.equal(result.listingAgent, 'Bob Jones');
});

test('fromJsonLdResidence: no crash when offeredBy is absent', () => {
  const item = {
    '@type': 'SingleFamilyResidence',
    address: { streetAddress: '123 Main', addressLocality: 'Raleigh', addressRegion: 'NC' },
    offers: { price: 300000 },
  };
  const result = fromJsonLdResidence(item);
  assert.equal(result.listingAgent, null);
});

test('fromJsonLdResidence: computes daysOnMarket from datePosted', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const item = {
    '@type': 'SingleFamilyResidence',
    datePosted: twoDaysAgo,
    address: { streetAddress: '123 Main', addressLocality: 'Raleigh', addressRegion: 'NC' },
  };
  const result = fromJsonLdResidence(item);
  assert.ok(
    result.daysOnMarket >= 1 && result.daysOnMarket <= 3,
    `expected ~2 days, got ${result.daysOnMarket}`
  );
});

test('fromJsonLdResidence: daysOnMarket is null when datePosted absent', () => {
  const item = {
    '@type': 'SingleFamilyResidence',
    address: { streetAddress: '123 Main', addressLocality: 'Raleigh', addressRegion: 'NC' },
  };
  const result = fromJsonLdResidence(item);
  assert.equal(result.daysOnMarket, null);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run the tests — expect failures on @graph and listingAgent/daysOnMarket tests**

```bash
node scripts/tests/test-extract-parsers.mjs
```

Expected: the two `@graph` tests fail (`should find a residence item`, `null` mismatch); the `listingAgent` and `daysOnMarket` tests fail. The `flat @type` regression tests pass.

- [ ] **Step 3: Commit the failing tests**

```bash
git add scripts/tests/test-extract-parsers.mjs
git commit -m "test: add failing unit tests for @graph unwrap and fromJsonLdResidence extensions"
```

---

### Task 3: Implement @graph unwrap in `pickJsonLdResidence`

**Files:**
- Modify: `scripts/research/extract-listing-details.mjs` lines 268–285

- [ ] **Step 1: Replace the function body**

Current (lines 268–285):
```js
export function pickJsonLdResidence(jsonLdItems = []) {
  const list = Array.isArray(jsonLdItems) ? jsonLdItems : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const type = item['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => /Residence|RealEstateListing|SingleFamilyResidence|House/i.test(String(t || '')))) {
      return item;
    }
  }
  for (const item of list) {
    // Many sites embed a Product/Place that wraps the listing; descend if needed
    if (item && typeof item === 'object' && item.address && (item.numberOfRooms || item.floorSize)) {
      return item;
    }
  }
  return null;
}
```

Replace with:
```js
export function pickJsonLdResidence(jsonLdItems = []) {
  const raw = Array.isArray(jsonLdItems) ? jsonLdItems : [];
  // Unwrap @graph containers (homes.com wraps residence in a top-level @graph array)
  const list = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && Array.isArray(item['@graph']) && !item['@type']) {
      for (const inner of item['@graph']) list.push(inner);
    } else {
      list.push(item);
    }
  }
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const type = item['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => /Residence|RealEstateListing|SingleFamilyResidence|House/i.test(String(t || '')))) {
      return item;
    }
  }
  for (const item of list) {
    // Many sites embed a Product/Place that wraps the listing; descend if needed
    if (item && typeof item === 'object' && item.address && (item.numberOfRooms || item.floorSize)) {
      return item;
    }
  }
  return null;
}
```

- [ ] **Step 2: Run unit tests — @graph tests should now pass**

```bash
node scripts/tests/test-extract-parsers.mjs
```

Expected: all `@graph` and regression `flat @type` tests pass. `listingAgent` and `daysOnMarket` tests still fail.

- [ ] **Step 3: Commit**

```bash
git add scripts/research/extract-listing-details.mjs
git commit -m "fix: unwrap @graph JSON-LD containers in pickJsonLdResidence"
```

---

### Task 4: Extend `fromJsonLdResidence` with agent + daysOnMarket

**Files:**
- Modify: `scripts/research/extract-listing-details.mjs` lines 287–319

- [ ] **Step 1: Add three lines to `fromJsonLdResidence`**

Find this block inside `fromJsonLdResidence` (around line 295):
```js
  const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
  if (offers && typeof offers === 'object') {
    result.price = toNumber(offers.price ?? offers.priceSpecification?.price);
    result.listingStatus = normalizeListingStatus(offers.availability || offers.itemCondition);
  } else {
    result.price = toNumber(item.price);
  }
```

Replace with:
```js
  const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
  if (offers && typeof offers === 'object') {
    result.price = toNumber(offers.price ?? offers.priceSpecification?.price);
    result.listingStatus = normalizeListingStatus(offers.availability || offers.itemCondition);
    const offeredBy = Array.isArray(offers.offeredBy) ? offers.offeredBy[0] : offers.offeredBy;
    result.listingAgent = offeredBy?.name ? String(offeredBy.name).trim() : null;
  } else {
    result.price = toNumber(item.price);
    result.listingAgent = null;
  }
```

Then find the end of the function (before `return result;`) and add:
```js
  if (item.datePosted) {
    const posted = new Date(item.datePosted);
    if (!Number.isNaN(posted.getTime())) {
      result.daysOnMarket = Math.floor((Date.now() - posted.getTime()) / (1000 * 60 * 60 * 24));
    }
  }
  if (result.daysOnMarket === undefined) result.daysOnMarket = null;
```

- [ ] **Step 2: Run unit tests — all should pass**

```bash
node scripts/tests/test-extract-parsers.mjs
```

Expected: `N passed, 0 failed`

- [ ] **Step 3: Commit**

```bash
git add scripts/research/extract-listing-details.mjs
git commit -m "feat: extract listingAgent and daysOnMarket from JSON-LD offers in fromJsonLdResidence"
```

---

### Task 5: Rewrite `extractHomes` with JSON-LD + DOM section parser

**Files:**
- Modify: `scripts/research/extract-listing-details.mjs` lines 507–520

- [ ] **Step 1: Replace the stub `extractHomes` function**

Current (lines 507–520):
```js
async function extractHomes(page) {
  // Homes.com layout shares a lot with Realtor.com (same parent). Try
  // JSON-LD first; selectors are TODO.
  const findings = {};
  const notes = [];
  const jsonLd = await readJsonLd(page);
  const residence = pickJsonLdResidence(jsonLd);
  const fromLd = fromJsonLdResidence(residence);
  Object.assign(findings, fromLd);
  if (!findings.address && !findings.price) {
    notes.push('homes: only JSON-LD parser implemented; selectors not implemented yet');
  }
  return { findings, notes };
}
```

Replace with:
```js
async function extractHomes(page) {
  const findings = {};
  const notes = [];

  // Primary: JSON-LD (@graph unwrap handled by pickJsonLdResidence)
  const jsonLd = await readJsonLd(page);
  const residence = pickJsonLdResidence(jsonLd);
  const fromLd = fromJsonLdResidence(residence);
  Object.assign(findings, fromLd);

  // Secondary: DOM section parser for fields JSON-LD doesn't carry
  const domFindings = await page.evaluate(() => {
    const result = {};

    function sectionText(headerPattern) {
      const headers = Array.from(document.querySelectorAll('h3, h4, [class*="section-title"], [class*="label"]'));
      for (const h of headers) {
        if (headerPattern.test(h.textContent.trim())) {
          const sibling = h.nextElementSibling ?? h.parentElement?.nextElementSibling;
          if (sibling) return sibling.textContent.trim();
        }
      }
      return '';
    }

    // HOA Fees → hoaMonthly
    const hoaText = sectionText(/HOA\s*Fee/i);
    if (hoaText) {
      const m = hoaText.match(/\$?([\d,]+)/);
      if (m) result.hoaMonthly = Number(m[1].replace(/,/g, ''));
    }

    // Parking → garage count
    const parkingText = sectionText(/Parking/i);
    if (parkingText) {
      const m = parkingText.match(/^(\d+)/);
      if (m) result.garage = Number(m[1]);
    }

    // Lot Details → lotSqft
    const lotText = sectionText(/Lot\s*Details?/i);
    if (lotText) {
      const m = lotText.match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft)/i);
      if (m) result.lotSqft = Number(m[1].replace(/,/g, ''));
    }

    // Community Details → communityName
    const communityText = sectionText(/Community\s*Details?/i);
    if (communityText) result.communityName = communityText.split('\n')[0].trim() || null;

    // Builder → builderName
    const builderText = sectionText(/^Builder$/i);
    if (builderText) result.builderName = builderText.split('\n')[0].trim() || null;

    // MLS → mls
    const mlsText = sectionText(/^MLS/i);
    if (mlsText) {
      const m = mlsText.match(/([A-Z0-9]{6,})/i);
      if (m) result.mls = m[1];
    }

    // Schools section → assignedSchools
    const schoolHeaders = Array.from(document.querySelectorAll('h3, h4')).filter(
      (h) => /schools?/i.test(h.textContent.trim())
    );
    if (schoolHeaders.length) {
      const schoolSection = schoolHeaders[0].nextElementSibling
        ?? schoolHeaders[0].parentElement?.nextElementSibling;
      if (schoolSection) {
        const items = Array.from(schoolSection.querySelectorAll('li'));
        result.assignedSchools = items.map((el) => {
          const text = el.textContent.trim();
          let level = null;
          if (/elementary|primary/i.test(text)) level = 'elementary';
          else if (/middle|junior/i.test(text)) level = 'middle';
          else if (/high|senior/i.test(text)) level = 'high';
          return { name: text.split('\n')[0].trim(), level, source: 'homes' };
        }).filter((s) => s.name.length > 0);
      }
    }

    // Precise baths from summary detail block
    const allText = document.body?.innerText ?? '';
    const bathMatch = allText.match(/(\d+(?:\.\d+)?)\s*Ba(?:th)?s?\b/);
    if (bathMatch) result.baths = Number(bathMatch[1]);

    return result;
  }).catch(() => ({}));

  // Merge: DOM baths win over JSON-LD integer baths; JSON-LD wins for everything else
  for (const [key, value] of Object.entries(domFindings)) {
    if (value === null || value === undefined) continue;
    if (key === 'baths') {
      findings.baths = value;
    } else if (findings[key] === null || findings[key] === undefined) {
      findings[key] = value;
    }
  }

  if (!findings.address && !findings.price) {
    notes.push('homes: JSON-LD and DOM section parser found no structured data');
  }
  return { findings, notes };
}
```

- [ ] **Step 2: Verify syntax is valid**

```bash
node --check scripts/research/extract-listing-details.mjs
```

Expected: no output and exit code 0 (syntax valid). An error means a parse mistake in the replacement — fix it before continuing.

- [ ] **Step 3: Run unit tests — should still all pass**

```bash
node scripts/tests/test-extract-parsers.mjs
```

Expected: all pass (no regressions from the rewrite).

- [ ] **Step 4: Commit**

```bash
git add scripts/research/extract-listing-details.mjs
git commit -m "feat: rewrite extractHomes with JSON-LD primary and DOM section parser secondary"
```

---

### Task 6: Extend `extractRealtor` with four new field reads

**Files:**
- Modify: `scripts/research/extract-listing-details.mjs` lines 435–505

- [ ] **Step 1: Add four field reads inside the `if (listing)` block**

Find this block inside `extractRealtor` (around line 483):
```js
        findings.builderName = pickFirst(listing.builder?.name);
        findings.communityName = pickFirst(listing.community?.name, listing.subdivision?.name);
```

Add the following immediately after those two lines:
```js
        // listingAgent from advertisers array
        const advertisers = Array.isArray(listing.advertisers) ? listing.advertisers : [];
        if (advertisers[0]?.name) {
          findings.listingAgent = String(advertisers[0].name).trim();
        }

        // MLS from advertisers mls_set
        const mlsSet = advertisers[0]?.mls_set;
        if (Array.isArray(mlsSet) && mlsSet[0]) {
          const mlsId = mlsSet[0].id ?? mlsSet[0].listing_id;
          if (mlsId) findings.mls = String(mlsId).trim();
        }

        // Precise baths: use baths_full + halves when available
        if (typeof desc.baths_full === 'number') {
          findings.baths = desc.baths_full
            + 0.5 * (desc.baths_half ?? 0)
            + 0.5 * (desc.baths_3qtr ?? 0);
        }

        // daysOnMarket from list_date when days_on_market is absent
        if ((findings.daysOnMarket === null || findings.daysOnMarket === undefined) && listing.list_date) {
          const listed = new Date(listing.list_date);
          if (!Number.isNaN(listed.getTime())) {
            findings.daysOnMarket = Math.floor((Date.now() - listed.getTime()) / (1000 * 60 * 60 * 24));
          }
        }
```

- [ ] **Step 2: Verify no syntax errors**

```bash
node --check scripts/research/extract-listing-details.mjs
```

Expected: no output and exit code 0.

- [ ] **Step 3: Run unit tests — all should still pass**

```bash
node scripts/tests/test-extract-parsers.mjs
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/research/extract-listing-details.mjs
git commit -m "feat: add listingAgent, mls, precise baths, and daysOnMarket to extractRealtor"
```

---

### Task 7: Integration smoke test — homes.com

Requires the hosted browser to be running (`npm run browser:status` should show active).

**Files:**
- Read: `output/listings/nc.json` (existing failed extraction to compare against)

- [ ] **Step 1: Check the hosted browser is active**

```bash
node scripts/browser/browser-session.mjs --status --profile chrome-host
```

Expected: a line showing the session is active and a CDP endpoint is reachable. If not active, run `npm run browser:setup` and log into homes.com before continuing.

- [ ] **Step 2: Run the extractor against the known homes.com listing**

```bash
node scripts/research/extract-listing-details.mjs --url "https://www.homes.com/property/4404-clarkdale-ct-fuquay-varina-nc/bm457fnk52lm0/" --json
```

Expected JSON output must have all of these non-null:
- `address`: `"4404 Clarkdale Ct"`
- `city`: `"Fuquay Varina"`
- `price`: `750000`
- `beds`: `5`
- `baths`: a decimal like `4.5` (not integer `4`)
- `sqftFinished`: `3716`
- `yearBuilt`: `2023`
- `confidence`: `"high"` or `"medium"` (not `"low"`)

And these should be populated where visible on the page:
- `hoaMonthly`, `garage`, `lotSqft`, `builderName`, `communityName`, `mls`, `assignedSchools`

- [ ] **Step 3: If any required field is null, inspect the page structure**

Write a temporary inspection script `_inspect-homes.mjs` in the repo root:

```js
// _inspect-homes.mjs — delete after use
import { attachHostedBrowser, navigateAndSettle, safeClose } from './scripts/browser/browser-extract-utils.mjs';
import { ROOT } from './scripts/shared/paths.mjs';
const attached = await attachHostedBrowser(ROOT, 'chrome-host');
const { context, browser } = attached;
const { page } = await navigateAndSettle(context, 'https://www.homes.com/property/4404-clarkdale-ct-fuquay-varina-nc/bm457fnk52lm0/', { settleMs: 3000 });
const h3s = await page.evaluate(() =>
  Array.from(document.querySelectorAll('h3')).map(h => h.textContent.trim()).slice(0, 25)
);
console.log('H3 headers:', JSON.stringify(h3s, null, 2));
await safeClose({ browser });
```

Run it:
```bash
node _inspect-homes.mjs
```

Use the actual h3 text values to tune the `sectionText` regex patterns in `extractHomes` if needed. Delete `_inspect-homes.mjs` after use. Adjust and re-run until all expected fields populate.

- [ ] **Step 4: Commit any selector adjustments**

```bash
git add scripts/research/extract-listing-details.mjs
git commit -m "fix: tune homes.com DOM section selectors based on live page inspection"
```

(Skip this commit if no adjustments were needed.)

---

### Task 8: Integration smoke test — realtor.com

- [ ] **Step 1: Run the extractor against the known realtor.com listing**

```bash
node scripts/research/extract-listing-details.mjs --url "https://www.realtor.com/realestateandhomes-detail/101-Jewell-Farm-Ln_Holly-Springs_NC_27540_M57922-30867" --json
```

Expected JSON must have all of these non-null:
- `address`, `city`, `price`, `beds`
- `baths`: should be `3.5` (3 full + 1 half = 3 + 0.5), not integer `3`
- `listingAgent`: `"Erica Anderson"` (or current agent name)
- `mls`: a non-empty string like `"NC10058399"`
- `daysOnMarket`: a positive integer

- [ ] **Step 2: If listingAgent or mls are null, inspect __NEXT_DATA__ path**

Write a temporary inspection script `_inspect-realtor.mjs` in the repo root:

```js
// _inspect-realtor.mjs — delete after use
import { attachHostedBrowser, navigateAndSettle, safeClose } from './scripts/browser/browser-extract-utils.mjs';
import { ROOT } from './scripts/shared/paths.mjs';
const attached = await attachHostedBrowser(ROOT, 'chrome-host');
const { context, browser } = attached;
const { page } = await navigateAndSettle(context, 'https://www.realtor.com/realestateandhomes-detail/101-Jewell-Farm-Ln_Holly-Springs_NC_27540_M57922-30867', { settleMs: 3000 });
const advertisers = await page.evaluate(() => {
  const raw = document.querySelector('script#__NEXT_DATA__')?.textContent;
  if (!raw) return null;
  const data = JSON.parse(raw);
  const props = data?.props?.pageProps;
  const listing = props?.property ?? props?.initialState?.propertyDetails ?? null;
  return listing?.advertisers ?? null;
});
console.log('advertisers:', JSON.stringify(advertisers, null, 2));
await safeClose({ browser });
```

Run it:
```bash
node _inspect-realtor.mjs
```

Adjust the `advertisers` access path in `extractRealtor` if the actual structure differs. Delete `_inspect-realtor.mjs` after use.

- [ ] **Step 3: Commit any path adjustments**

```bash
git add scripts/research/extract-listing-details.mjs
git commit -m "fix: tune realtor.com advertisers path for listingAgent and mls extraction"
```

(Skip if no adjustments needed.)

---

### Task 9: Register unit tests in test-all.mjs

**Files:**
- Modify: `scripts/system/test-all.mjs`

- [ ] **Step 1: Find the section where external scripts are run (look for `run(` calls)**

The file uses a `run(command)` helper that calls `execSync`. Find where script checks are performed.

- [ ] **Step 2: Add a check that runs the unit test file**

Find an appropriate place (after existing script checks) and add:
```js
{
  const result = run('node scripts/tests/test-extract-parsers.mjs');
  if (result.ok) {
    pass('extract-listing-details parser unit tests');
  } else {
    fail(`extract-listing-details parser unit tests\n${result.output}`);
  }
}
```

- [ ] **Step 3: Run the full test suite**

```bash
npm test
```

Expected: all existing checks pass plus `PASS extract-listing-details parser unit tests`.

- [ ] **Step 4: Final commit**

```bash
git add scripts/system/test-all.mjs
git commit -m "test: register extract-listing-details unit tests in test-all.mjs"
```
