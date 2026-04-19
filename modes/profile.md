# Mode: profile -- Interactive Buyer Profile Setup And Refresh

Use this mode when the user wants to create or revise the buyer profile through a guided question flow instead of editing the files manually.

## Read First

- `modes/_preflight.md`
- `buyer-profile.md` if it exists
- `config/profile.yml` if it exists
- `modes/_profile.md` if it exists
- `config/profile.example.yml`
- `modes/_profile.template.md`
- `DATA_CONTRACT.md`
- `docs/CUSTOMIZATION.md`

## Prerequisites

Run the environment preflight in `modes/_preflight.md` before anything else. This mode runs `node generate-portals.mjs` and `node profile-sync-check.mjs` at the end, and the optional web-wizard flow in `tools/profile-wizard/` also starts a local Node server. If any preflight step fails, halt and surface the install guidance to the user before attempting to collect or write profile data.

## Goal

Collect the buyer's search criteria, lifestyle context, and weighting preferences, then map that information back into the buyer-layer files:

- `buyer-profile.md`
- `config/profile.yml`
- `modes/_profile.md`

If any of those files are missing, create them from the checked-in example or template first and then fill them in.

## Flow Options -- Offer the Web Wizard First

Before starting the in-chat Q&A, offer the buyer two ways to go through the profile interview:

1. **Web wizard (preferred on fresh sessions or full rewrites).** A local static page at `tools/profile-wizard/` that mirrors the filter fields on Zillow, Redfin, Realtor.com, and Homes.com, plus slider tiles for sentiment and school weights. The user completes it in a browser and clicks Submit; the answers are written to `.home-ops/profile-wizard-submission.json`.
2. **In-chat Q&A (good for quick touch-ups).** The existing `vscode_askQuestions` flow below.

Ask which the user prefers. If they pick the web wizard:

1. Start the server: `npm run profile:wizard:once` (in the background if your harness supports it; otherwise run it, print the URL, and tell the user where to find it).
2. The server prints the URL (default `http://127.0.0.1:4178/`). Open it in the hosted Chrome session via Chrome MCP if available, otherwise ask the user to open it manually.
3. Wait for the submission file to appear at `.home-ops/profile-wizard-submission.json`. Poll periodically or ask the user to confirm they clicked Submit.
4. Once the submission file exists, read it and map the answers back into `config/profile.yml`, `buyer-profile.md`, and `modes/_profile.md` using the same file-update rules below. Then delete or rename the submission file so the next run starts clean.
5. Run the validation steps and output summary as usual.

If the user prefers the in-chat flow (or says "just ask me"), skip the wizard and proceed straight to the question batches.

## Interaction Rules

- Use `vscode_askQuestions` in short batches instead of dumping one long questionnaire into chat.
- Default to fixed-choice and multi-select questions. Free-text should be the exception, reserved for nuanced narrative answers that cannot be reduced to a pick-list.
- **Seed every question with the current profile value.** When a meaningful current value exists, it must be the pre-selected default on single-choice questions and the pre-checked set on multi-select questions. The user should be able to accept the whole profile without typing anything.
- Every single-choice question must include a `Keep current` option when a current value exists, and a `Custom` option for anything the defaults miss.
- Every multi-select question must list the user's existing selections at the top already checked, then add curated defaults beneath them as unchecked suggestions, then expose an `Add custom` free-text entry at the bottom for one-off additions.
- For grouped criteria such as areas, features, deal-breakers, or commute destinations, the default interaction is a multi-select pick-list. Only fall back to bulleted or comma-delimited free text if the user explicitly asks to type it out.
- Preserve any current value the user explicitly says to keep.
- Do not write buyer-specific criteria into `modes/_shared.md`.

## Question Style Rules

Every question must be rendered with the current profile value pre-selected. The option sets below are only the fallback when no current value exists or the current value has no natural bucket.

### Single-Choice Defaults

For numeric or enum-style answers, present roughly four buckets plus `Keep current` (when applicable) and `Custom`:

- Price range: `200k-400k`, `400k-600k`, `600k-800k`, `800k-1.0M+`, `Keep current`, `Custom`
- Minimum beds: `3+`, `4+`, `5+`, `6+`, `Keep current`, `Custom`
- Minimum garage spaces: `1+`, `2+`, `3+`, `4+`, `Keep current`, `Custom`
- Minimum square footage: `1800+`, `2200+`, `2700+`, `3200+`, `Keep current`, `Custom`
- Minimum school rating: `5+`, `6+`, `7+`, `8+`, `Keep current`, `Custom`
- Maximum listing age: `7 days`, `14 days`, `30 days`, `60 days`, `Keep current`, `Custom`
- Home type posture: `Resale strongly preferred`, `Resale preferred but new is OK`, `Resale only`, `No strong preference`, `Keep current`
- Story preference: `No preference`, `1 story`, `2 stories`, `3+ stories`, `Keep current`, `Custom`
- HOA maximum: `No cap`, `$100/mo`, `$200/mo`, `$300/mo`, `Keep current`, `Custom`

When the current profile value falls inside one of the listed buckets, mark that bucket as the pre-selected option so the user can press enter to accept it. When the current value is outside the buckets, include it verbatim as a `Keep current (<exact value>)` option. Ask the `Custom` follow-up only when the user explicitly picks `Custom`.

### Multi-Select Defaults

Every multi-select must be rendered as: the user's existing selections at the top already checked, curated defaults underneath as unchecked suggestions, and an `Add custom` row at the bottom for freeform entries. Do not drop a current selection just because it is not in the curated list -- keep it, checked, so the user sees their existing profile and can uncheck to remove.

Curated defaults (the unchecked suggestions, de-duplicated against whatever the current profile already has):

- Property features: `Large backyard`, `Fenced yard`, `Open-concept plan`, `Updated kitchen`, `Hardwood or LVP floors`, `Bonus room or office`, `First-floor primary suite`, `Two-story layout`, `Mature neighborhood`, `Community pool`
- Street and lot feel: `Cul-de-sac`, `Low-traffic interior street`, `Tree cover`, `Flat yard`, `Large lot`, `Play-friendly backyard`
- Deal-breakers: `Busy road`, `Flood risk`, `Townhome or condo`, `Small or cramped yard`, `Major repair needed`, `Weak schools`, `Long commute`, `Backing to commercial property`, `New construction`
- Family and lifestyle priorities: `School quality`, `Quiet street`, `Neighborhood community feel`, `Commute convenience`, `Outdoor space`, `Move-in-ready condition`, `Resale stability`, `Lower monthly payment`

When a selected item maps cleanly into `config/profile.yml`, store it there. If it is more nuanced, also reflect it in `buyer-profile.md` and `modes/_profile.md`.

## Question Flow

Ask the profile questions in these batches.

### 1. Buyer Identity

Collect:
- full name
- email
- phone
- location
- timezone

When the current profile already has any of these values, pre-fill them as the default answer on each question. Offer `Keep current` as the first option so the user can accept an unchanged identity field without retyping anything. Identity fields are free-text by nature, so the only goal here is to minimize retyping for the refresh flow.

### 2. Search Areas And Hard Requirements

Collect:
- target areas
- price minimum and maximum
- minimum beds
- minimum garage spaces
- minimum square footage
- yard requirement summary
- minimum school rating
- maximum listing age in days
- home type preference

#### Search areas (multi-select)

Render a single multi-select question built from:

1. Every area currently in `search.areas` (pre-checked, with the county and rank shown next to the name so the user can see what is on file).
2. A short list of unchecked regional suggestions the current profile does not already include. Default suggestions for the Triangle market: `Holly Springs`, `Apex`, `Cary`, `Willow Springs`, `Fuquay-Varina`, `Morrisville`, `Wake Forest`, `Durham`, `Raleigh`.
3. An `Add custom area` row at the bottom for one-off additions.

Rules:

- The user accepts the current areas simply by leaving the pre-checked boxes alone.
- Unchecking a pre-checked row removes that area from `search.areas`.
- For every area the user adds (either from the suggestion list or via `Add custom area`) that is missing a county or rank, ask one consolidated follow-up covering all missing values at once instead of asking per area. Format the follow-up as a short table:
  - `Apex | county? | rank?`
  - `Morrisville | county? | rank?`
- If the user picks Willow Springs, a multi-county value such as `Wake, Harnett` is acceptable.
- Only drop back to free text (bulleted or comma-delimited) if the user explicitly asks for it.

#### Hard requirements (single-choice, current value pre-selected)

Ask each hard requirement as a single-choice question using the buckets in "Single-Choice Defaults" above. For each question:

- Pre-select the bucket that contains the current profile value.
- When the current value does not fit any bucket cleanly, surface it as `Keep current (<exact value>)` and pre-select that.
- Include `Custom` on every question for explicit overrides.

The full set is:
- price band
- minimum beds
- garage minimum
- square-foot minimum
- school minimum
- listing-age maximum
- home-type preference

### 3. Soft Preferences And Features

This batch replaces the old set of individual yes/no questions about fenced yards, updated kitchens, pools, floor-plan style, and street type. Those preferences are captured inside the multi-select below, so do not also ask them as separate soft-preference questions.

Ask one multi-select for desired features (current profile selections pre-checked, curated suggestions below, `Add custom` at the bottom). Curated defaults:

- `Large backyard`
- `Fenced yard`
- `Open-concept plan`
- `Updated kitchen`
- `Hardwood or LVP floors`
- `Bonus room or office`
- `First-floor primary suite`
- `Two-story layout`
- `Cul-de-sac or low-traffic street`
- `Community pool`
- `Mature neighborhood`

Then ask three short single-choice questions that genuinely do not fit the multi-select:

- preferred story count (uses the Single-Choice Defaults above)
- HOA maximum monthly budget (uses the Single-Choice Defaults above)
- year-built range: `2010+`, `2000+`, `1990+`, `No preference`, `Keep current`, `Custom`

Pre-select the current value on each of the three single-choice questions. Every multi-select selection should land in a structured `config/profile.yml` field where one exists; anything nuanced should also be reflected in `buyer-profile.md` and `modes/_profile.md`.

### 4. Deal-Breakers And Lifestyle Context

Several dimensions that used to live here (street noise, lot and yard priorities, resale-vs-new-construction tolerance) are already captured by the deal-breaker multi-select or by Section 2's home-type preference. Do not re-ask them.

Ask one multi-select for deal-breakers (current profile selections pre-checked, curated suggestions below, `Add custom` at the bottom). Curated defaults:

- `Busy road or cut-through traffic`
- `Floodplain or drainage concern`
- `Small or unusable backyard`
- `Weak assigned schools`
- `Townhome or condo`
- `Backs to commercial or highway`
- `Major immediate repairs`
- `Too far from preferred commute`
- `Builder-heavy new construction`

Notes:
- `HOA above budget` was intentionally dropped -- Section 3 already captures the HOA monthly cap, which is how this constraint gets enforced.
- If the user unchecks `Busy road or cut-through traffic`, that implicitly answers street-noise tolerance; no separate question needed.
- If the user's home-type preference in Section 2 is `Resale strongly preferred` or `Resale only`, pre-check `Builder-heavy new construction` here so the two signals stay consistent.

Then collect the narrative-only lifestyle fields that do not map to any pick-list:

- family context (short free text: household size, kids or pets, stage of life)
- buyer aggressiveness in a tight market (single-choice: `Wait for the perfect fit`, `Move on strong fits`, `Compete hard`, `Keep current`, `Custom`)

Pre-fill the current value on each question where the profile already has one.

### 5. Commute And Financial Assumptions

Collect:
- commute destinations and priority (daily / occasional / rare)
- down-payment percentage
- loan type
- closing-cost minimum and maximum percentages

#### Commute destinations (multi-select)

Render a multi-select seeded from:

1. The user's current `financial.commute_destinations` (pre-checked, with priority shown next to each).
2. Unchecked regional suggestions the profile does not already include. Defaults: `Downtown Raleigh`, `Research Triangle Park`, `Cary office parks`, `Durham`, `Chapel Hill`, `Apex`.
3. An `Add custom destination` row.

After the user confirms the set, ask one follow-up assigning `daily`, `occasional`, or `rare` to any destination where priority is missing. Pre-fill the existing priority for pre-checked rows.

#### Financial assumptions (single-choice, current value pre-selected)

- down payment: `10%`, `15%`, `20%`, `25%+`, `Keep current`, `Custom`
- closing costs: `1-2%`, `2-3%`, `3-4%`, `4%+`, `Keep current`, `Custom`
- loan type: `30-year fixed`, `15-year fixed`, `ARM`, `Keep current`, `Custom`

Pre-select the bucket that matches the current profile value on every question.

### 6. Neighborhood Weight Scores

Do not start with raw 0-100 text input. Ask each factor as a single-choice question with five importance bands plus the current normalized weight shown as `Keep current`:

- `Not important` = 10
- `Somewhat` = 25
- `Important` = 50
- `Very important` = 75
- `Critical` = 90
- `Keep current (<current normalized value>)`
- `Custom 0-100`

Pre-select the band closest to the current normalized weight for each factor. Only route through `Custom 0-100` when the user explicitly picks it.

Ask one such question per factor:

- How important is low crime in your neighborhood?
- How important is manageable traffic and commute friction near the home?
- How important is a strong sense of community and neighbor quality?
- How important is strong local school reputation as part of the neighborhood score?
- How important is everyday livability such as parks, groceries, healthcare access, and lower noise?

Map those answers to:
- `sentiment.weights.crime_safety`
- `sentiment.weights.traffic_commute`
- `sentiment.weights.community`
- `sentiment.weights.school_quality`
- `sentiment.weights.livability`

### 7. School Weight Scores

Use the same five-band importance question format as Section 6, with the current school-sentiment weight shown as `Keep current` and pre-selected band matching the closest existing value.

Ask one question per factor:

- How important is academic performance?
- How important is parent and community trust in the school?
- How important is teacher and staff quality?
- How important is school safety and student environment?
- How important are extracurriculars and available resources?

Map those answers to:
- `school_sentiment.weights.academic_performance`
- `school_sentiment.weights.parent_community_sentiment`
- `school_sentiment.weights.teacher_staff_quality`
- `school_sentiment.weights.safety_environment`
- `school_sentiment.weights.extracurriculars_resources`

## Weight Normalization Rules

For both weight groups:

1. Parse each response as a number from `0` to `100`.
2. If a value is invalid or missing, ask a follow-up instead of guessing.
3. Normalize the raw scores so each group sums to `1.0`.
4. If the user gives all zeros for a group, keep the current weights. If no current weights exist, fall back to the example defaults.
5. Round to a practical YAML precision and ensure the final stored values still sum to `1.0`.

## File Update Rules

### `config/profile.yml`

Update the structured fields for:
- buyer identity
- search areas
- hard requirements
- soft preferences
- deal-breakers
- commute destinations
- financial assumptions
- normalized neighborhood weights
- normalized school weights

### `buyer-profile.md`

Update the narrative brief with:
- search areas
- hard requirements
- soft preferences
- deal-breakers
- family and lifestyle context
- commute destinations

When the user selected from structured defaults, rewrite those picks into natural-language buyer criteria rather than echoing the raw option labels.

### `modes/_profile.md`

Update the buyer-specific operating heuristics with:
- buyer priorities
- area notes when the user provides town-specific nuance
- decision heuristics
- tour triggers
- pass triggers
- financial posture

Preserve any existing nuanced notes that the user did not override.

## Interview Quality Bar

The profile flow should feel like a guided form, not a blank interview. A user who only wants to confirm the current profile should be able to walk through every batch by accepting the pre-selected defaults without typing anything.

Rules:

- Do not ask any field as pure free text when a short default list or multi-select would make the answer easier.
- Always seed the question with the current profile value: pre-select it on single-choice questions, pre-check it on multi-select questions, and include a `Keep current` option when the current value falls outside the curated buckets.
- Keep the curated option sets generic enough to work for many buyers, but never drop a current selection just because it is not in the curated list -- preserve it as a checked row so the user can see and keep it.
- Expose `Add custom` or `Custom` on every question as an escape hatch for anything the defaults miss.
- Keep each batch small enough that the user can answer quickly.
- If the user chooses multiple features or deal-breakers, reflect the whole set back into the written profile instead of collapsing it down to one headline preference.
- When the user adds new search areas, preserve the batch and ask at most one grouped follow-up for any missing county or rank fields.

## Validation

After updating the files, run:

- `node generate-portals.mjs` -- regenerates `portals.yml` from the updated `config/profile.yml` and `config/city-registry.yml`. Always run this when search areas change so Zillow, Redfin, and Realtor.com base URLs stay in sync with the profile.
- `node profile-sync-check.mjs`

If `generate-portals.mjs` emits a warning for an unmatched city, add the missing `redfin_city_id` and `primary_zip` to `config/city-registry.yml` and rerun the generator before continuing.

## Output Summary

Return a concise summary with:
- which buyer-layer files were updated
- the biggest profile changes captured
- whether the weight scores were re-normalized
- whether `generate-portals.mjs` ran cleanly, plus any unmatched-city warnings it surfaced
- whether `profile-sync-check.mjs` passed
- and an explicit next-step line telling the user to run `/home-ops init` next