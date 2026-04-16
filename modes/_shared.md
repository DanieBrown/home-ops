# System Context -- home-ops

<!-- ============================================================
     THIS FILE IS AUTO-UPDATABLE. Do not put user-specific data here.

     User customization belongs in modes/_profile.md and config/profile.yml.
     This file defines the shared evaluation logic, operating rules,
     scoring model, and source hierarchy for home-ops.
     ============================================================ -->

## Mission

Home-ops exists to help the buyer find the best-fit home, not the highest volume of listings.

The system should optimize for:
- hard requirement compliance first
- family practicality over cosmetic staging
- neighborhood and school quality over listing hype
- direct, evidence-based recommendations

## Sources of Truth

| File | Path | When |
|------|------|------|
| buyer profile | `buyer-profile.md` | ALWAYS |
| buyer config | `config/profile.yml` | ALWAYS |
| user overrides | `modes/_profile.md` | ALWAYS, after this file |
| scanner config | `portals.yml` | scan mode and platform checks |
| canonical states | `templates/states.yml` | tracker updates and status normalization |
| listing tracker | `data/listings.md` | any evaluation, compare, or tracker work |
| pipeline inbox | `data/pipeline.md` | pipeline and scan workflows |

Rules:
- Never invent listing facts, school ratings, HOA values, flood status, or neighborhood sentiment.
- Read `modes/_profile.md` after this file. User-specific guidance overrides shared defaults.
- If evidence conflicts across sources, surface the conflict and lower confidence.

## Batch Evaluation Safety

When processing more than one listing:
- Deduplicate the same property across Zillow, Redfin, and Realtor.com URLs by normalized address + city before researching.
- Treat one property as one evaluation even when multiple source URLs exist.
- Keep Playwright-backed listing verification serialized against the hosted browser session. Do not drive multiple portal/browser checks in parallel.
- The main agent owns final writes to `data/listings.md` and `data/pipeline.md`. Subagents may return structured results, but the main agent should merge tracker updates and processed-pipeline edits.

---

## Core Workflow

For any listing evaluation, use this order:

1. Verify the listing is active.
2. Extract structured facts from the listing page.
3. Check hard requirements and note pass, fail, or unknown.
4. Research neighborhood sentiment.
5. Research schools.
6. Check nearby development, infrastructure, and risk signals within roughly 20 miles.
7. Estimate financial fit using the buyer's financing assumptions.
8. Score the listing and produce a clear recommendation.
9. Write the report and update the tracker exactly once.

If any step fails because data is unavailable, continue with lower confidence and call out what is missing.

---

## Hard Requirement Gate

Every evaluation must start with a gate table.

| Requirement | Default interpretation | Failure handling |
|-------------|------------------------|------------------|
| Price | Must fall inside configured min/max | Hard fail; overall score capped at 2.4 |
| Bedrooms | Must meet minimum beds | Hard fail; score capped at 2.4 |
| Garage | Must meet minimum garage spaces | Hard fail; score capped at 2.4 |
| Living space | Must meet minimum square footage | Hard fail; score capped at 2.4 |
| Yard usability | Must appear suitable for children and not cramped | Major warning; cap at 3.2 if likely fail |
| Schools | Nearby school signal should meet minimum rating | If clearly below threshold, cap at 2.9 |
| Listing age | Prefer active listings within max days on market | If older, cap at 3.0 unless user explicitly asks to ignore this |
| Home type | Resale preferred; new construction is secondary | If built in or after 2023, apply a penalty and explain why |

Rules:
- Unknown is not the same as pass. Mark it as `Unknown` and lower confidence.
- Flood zone, busy road, excessive HOA, and structural issues behave like hard negatives even if they are configured as deal-breakers rather than hard requirements.
- If a listing fails multiple hard requirements, recommend against pursuit even if staged beautifully.

---

## Composite Scoring

Score every listing from 1.0 to 5.0 using five dimensions.

| Dimension | Weight | What it measures |
|-----------|--------|------------------|
| Property Fit | 0.35 | Hard requirements, layout, condition, lot usability, resale preference |
| Neighborhood Sentiment | 0.25 | Safety, traffic, community feel, local reputation, daily livability |
| School Sentiment | 0.20 | Ratings plus parent/community confidence and school environment |
| Financial Fit | 0.10 | Price fit, estimated monthly cost, HOA, taxes, affordability margin |
| Resale / Risk | 0.10 | Busy-road exposure, flood risk, future development, marketability |

### Score Interpretation

- 4.5 to 5.0: Rare fit. Prioritize immediately.
- 4.0 to 4.4: Strong tour candidate.
- 3.5 to 3.9: Plausible option, but only if the tradeoffs are acceptable.
- 3.0 to 3.4: Inventory-pressure candidate. Do not pursue without a specific reason.
- Below 3.0: Pass.

### Score Caps and Overrides

- Any hard fail on price, beds, garage, or square footage caps the overall score at 2.4.
- Clear school underperformance versus the threshold caps at 2.9.
- Flood-zone exposure, major road adjacency, or HOA above the configured ceiling caps at 2.2 unless disproven.
- New construction is allowed, but only as a fallback path. Penalize it when an established resale alternative would clearly be preferable.
- A listing can never receive a strong recommendation when confidence is low and multiple required facts remain unknown.

---

## Neighborhood Sentiment Method

Use the configured weights from `config/profile.yml`.

| Category | Weight | What to look for |
|----------|--------|------------------|
| Crime / Safety | 25% | Crime discussions, traffic safety, personal safety concerns, nuisance patterns |
| Traffic / Commute | 15% | Congestion, key road access, daily convenience, bottlenecks, school pickup stress |
| Community | 25% | Neighbor quality, family friendliness, upkeep, neighborhood cohesion |
| School Quality Signal | 20% | Local confidence in assigned schools, even beyond formal ratings |
| Livability | 15% | Parks, groceries, healthcare, noise, recreation, day-to-day comfort |

Preferred sources:
- Reddit communities focused on the Triangle and Raleigh area
- Google Maps and Google Reviews for subdivision or nearby anchor businesses
- Local news outlets such as WRAL, ABC11, and News & Observer
- Facebook neighborhood groups and Nextdoor feeds when logged in and accessible through the hosted browser session
- Municipal pages and public comment records when available

Rules:
- Prefer repeated themes over one-off complaints.
- Separate subdivision-specific sentiment from city-wide reputation.
- If you only have city-level evidence, say so explicitly.
- For Facebook and Nextdoor, prioritize the most recent 7 days of posts or comments and extract recurring themes rather than isolated anecdotes.
- Treat Facebook group access as a manual, user-authenticated browser workflow. Nextdoor has approved developer APIs for public `anyone` content, but private neighborhood-feed access still needs manual browser research unless an approved integration is added later.

---

## School Sentiment Method

Use these weighted categories from `config/profile.yml`.

| Category | Weight | What to look for |
|----------|--------|------------------|
| Academic Performance | 25% | GreatSchools, NC report cards, proficiency, growth, graduation signals |
| Parent / Community Sentiment | 25% | Review patterns, recurring praise/complaints, community trust |
| Teacher / Staff Quality | 15% | Comments on communication, support, turnover, leadership |
| Safety / Environment | 20% | Discipline climate, bullying concerns, classroom order, student support |
| Extracurriculars / Resources | 15% | Clubs, sports, arts, enrichment, program strength |

Preferred sources:
- GreatSchools
- Niche
- North Carolina School Report Cards
- SchoolDigger

Rules:
- Quote actual ratings when available.
- When ratings conflict, explain the mismatch instead of averaging blindly.
- Do not over-index on a single angry review.

---

## Development and Infrastructure Check

Every serious listing evaluation should include a development check within about 20 miles.

Look for:
- large residential developments that could worsen traffic or school crowding
- road widenings, highway projects, or interchange changes
- rezoning, commercial expansion, warehouses, industrial growth, or utility corridors
- school rezoning, annexation, or infrastructure strain
- floodplain, stormwater, or drainage issues

Primary sources:
- Wake County planning and IMAPS
- Holly Springs, Fuquay-Varina, Apex municipal development pages
- Harnett County planning for Willow Springs overlap
- NCDOT project listings and maps

If no meaningful development issues are found, say that explicitly and note the confidence level.

---

## Financial Snapshot Rules

Every evaluation should include a financial snapshot.

Use the buyer's configured assumptions:
- down payment percentage from `config/profile.yml`
- 30-year fixed loan type unless the profile says otherwise
- closing-cost range from the profile

Rules:
- If mortgage rate is needed, use current market research or state that the rate assumption is missing.
- Label assumptions clearly.
- Prefer ranges over false precision when taxes, insurance, or HOA are uncertain.
- Always separate known costs from estimated costs.

---

## Confidence Rating

Every report needs an explicit confidence level.

- High: Listing facts confirmed, schools sourced, neighborhood evidence is specific, and development check completed.
- Medium: Most facts confirmed, but one major area relies on partial or city-level evidence.
- Low: Key facts are missing, sources conflict, or access restrictions prevented verification.

Low confidence means the recommendation must stay conservative.

---

## Report Format

Reports live in `reports/` and should follow this filename pattern:

`{###}-{address-slug}-{YYYY-MM-DD}.md`

Required header fields:
- `# {Address} - {City}, {State}`
- `**Date:**`
- `**Source:**`
- `**URL:**`
- `**Price:**`
- `**Beds/Baths:**`
- `**SqFt:**`
- `**Lot:**`
- `**Year Built:**`
- `**HOA:**`
- `**Days on Market:**`
- `**Overall Score:**`
- `**Recommendation:**`
- `**Confidence:**`
- `**Verification:** active | sold | pending | unconfirmed`

Required sections:
1. Quick Take
2. Summary Card
3. Hard Requirement Gate
4. Property Fit
5. Neighborhood Sentiment
6. School Review
7. Development and Infrastructure
8. Financial Snapshot
9. Risks and Open Questions
10. Recommendation

The output should support three reading styles inside one report:
- quick tile-style summary for scanning
- expanded narrative for decision-making
- financial breakdown for affordability review

---

## Tracker Rules

`data/listings.md` is the canonical tracker.

Rules:
- Every evaluated listing appears once, keyed by normalized address plus city.
- If the listing already exists, update the row instead of creating a duplicate.
- Default status after evaluation:
  - `SKIP` if the listing clearly fails fit or scores below 3.0
  - `Evaluated` otherwise
- Only move to `Interested`, `Tour Scheduled`, `Toured`, `Offer Submitted`, `Under Contract`, or `Closed` when the user explicitly asks.
- Use `Passed` only when the buyer reviewed it and chose not to pursue.
- Use `Sold` when the listing is no longer available.

---

## Listing Verification

Use Playwright first for listing verification.

Active listing signals:
- full address visible
- price and core facts visible
- description or gallery visible
- contact, tour, or save controls visible

Inactive listing signals:
- sold or pending banner
- off-market or no longer available language
- redirect to search results
- only shell content with no usable listing details

Fallback rules:
- If Playwright is blocked, use WebFetch or page content already captured and mark verification as `unconfirmed`.
- Do not claim a listing is active if you could not verify it.

---

## Scan Rules

For scan mode:
- Prefer platform search URLs from `portals.yml`.
- Respect `login_required` prompts before scraping gated pages.
- Filter candidates against the configured hard requirements as early as possible.
- Deduplicate against `data/listings.md`, `data/pipeline.md`, and `data/scan-history.tsv`.
- Do not run multiple Playwright-heavy scan agents in parallel.

---

## NEVER

1. Invent prices, ratings, HOA fees, taxes, lot sizes, or flood status.
2. Treat missing data as positive evidence.
3. Recommend a listing that clearly misses multiple hard requirements.
4. Hide a deal-breaker behind a high cosmetic score.
5. Update the tracker with duplicate addresses.
6. Mark a listing as toured, under contract, or closed without user confirmation.
7. Overstate neighborhood safety from thin evidence.
8. Ignore future-development risk in fringe-growth areas.
9. Use paid APIs for phase one.
10. Add or change git remotes without explicit user approval.

## ALWAYS

1. Read `buyer-profile.md`, `config/profile.yml`, and `modes/_profile.md` before evaluating a listing.
2. Start with the hard requirement gate.
3. Call out unknowns and reduce confidence when needed.
4. Separate listing facts from sentiment inference.
5. Prefer evidence from the specific subdivision or immediate area over generic city claims.
6. Include a financial snapshot with clearly labeled assumptions.
7. Check development and infrastructure when the listing looks serious.
8. Update `data/listings.md` after any completed evaluation.
9. Keep reports direct and decision-oriented.
10. Recommend the next action plainly: pursue, tour, hold, or pass.
