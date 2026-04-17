# Mode: profile -- Interactive Buyer Profile Setup And Refresh

Use this mode when the user wants to create or revise the buyer profile through a guided question flow instead of editing the files manually.

## Read First

- `buyer-profile.md` if it exists
- `config/profile.yml` if it exists
- `modes/_profile.md` if it exists
- `config/profile.example.yml`
- `modes/_profile.template.md`
- `DATA_CONTRACT.md`
- `docs/CUSTOMIZATION.md`

## Goal

Collect the buyer's search criteria, lifestyle context, and weighting preferences, then map that information back into the buyer-layer files:

- `buyer-profile.md`
- `config/profile.yml`
- `modes/_profile.md`

If any of those files are missing, create them from the checked-in example or template first and then fill them in.

## Interaction Rules

- Use `vscode_askQuestions` in short batches instead of dumping one long questionnaire into chat.
- Prefer fixed-choice questions first, then short custom follow-ups only when needed.
- For single-value fields that map cleanly into YAML, present roughly 4 generic default options plus a `Custom` option.
- For refresh flows, include a `Keep current` option when a meaningful current value already exists.
- For multi-value sections such as features, deal-breakers, and lifestyle preferences, prefer curated multi-select lists with optional freeform additions.
- For grouped criteria such as areas, features, deal-breakers, or commute destinations, ask the user for a bulleted list and map the entries back to the correct fields.
- For search areas specifically, also accept one comma-delimited free-text reply containing multiple area names, then convert that one answer into the structured `search.areas` list.
- Preserve any current value the user explicitly says to keep.
- Do not write buyer-specific criteria into `modes/_shared.md`.

## Question Style Rules

Use these defaults unless the current market or prior profile makes a different set more sensible.

### Single-Choice Defaults

For numeric or enum-style answers, prefer option sets like these:

- Price range: `200k-400k`, `400k-600k`, `600k-800k`, `800k-1.0M+`, `Custom`
- Minimum beds: `3+`, `4+`, `5+`, `6+`, `Custom`
- Minimum garage spaces: `1+`, `2+`, `3+`, `4+`, `Custom`
- Minimum square footage: `1800+`, `2200+`, `2700+`, `3200+`, `Custom`
- Minimum school rating: `5+`, `6+`, `7+`, `8+`, `Custom`
- Maximum listing age: `7 days`, `14 days`, `30 days`, `60 days`, `Custom`
- Home type posture: `Resale strongly preferred`, `Resale preferred but new is OK`, `Resale only`, `No strong preference`
- Story preference: `No preference`, `1 story`, `2 stories`, `3+ stories`, `Custom`
- HOA maximum: `No cap`, `$100/mo`, `$200/mo`, `$300/mo`, `Custom`

If the user picks `Custom`, ask a short follow-up for the exact value.

### Multi-Select Defaults

For preference-heavy sections, offer curated pick-lists like these before asking for freeform additions:

- Property features: `Large backyard`, `Fenced yard`, `Open-concept plan`, `Updated kitchen`, `Hardwood or LVP floors`, `Bonus room or office`, `First-floor primary suite`, `Two-story layout`, `Mature neighborhood`, `Community pool`
- Street and lot feel: `Cul-de-sac`, `Low-traffic interior street`, `Tree cover`, `Flat yard`, `Large lot`, `Play-friendly backyard`
- Deal-breakers: `Busy road`, `Flood risk`, `High HOA`, `Townhome or condo`, `Small or cramped yard`, `Major repair needed`, `Weak schools`, `Long commute`, `Backing to commercial property`, `New construction`
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

### 2. Search Areas And Hard Requirements

Collect:
- target areas as a bulleted list or comma-delimited list
- price minimum and maximum
- minimum beds
- minimum garage spaces
- minimum square footage
- yard requirement summary
- minimum school rating
- maximum listing age in days
- home type preference

Ask the hard requirements using structured defaults first. Example:

- price band from a short default list plus `Custom`
- minimum beds from a short default list plus `Custom`
- garage minimum from a short default list plus `Custom`
- square-foot minimum from a short default list plus `Custom`
- school minimum from a short default list plus `Custom`
- listing-age maximum from a short default list plus `Custom`
- home-type preference from a short default list

For search areas, accept either a structured bulleted list or a single comma-delimited reply.

Structured example:

- `Holly Springs | NC | Wake | 1`
- `Apex | NC | Wake | 2`

Comma-delimited shorthand example:

- `Holly Springs, Cary, Apex, Willow Springs`

Interpret the columns as:
- area name
- state
- county
- rank

If the user provides multiple areas in one answer, keep them in one batch.
If county or rank is omitted, ask one consolidated follow-up that covers all missing values instead of asking one area at a time.
If Willow Springs is selected, a multi-county value such as `Wake, Harnett` is acceptable.

### 3. Soft Preferences And Features

Collect:
- preferred home style
- fenced-yard preference
- preferred floor-plan style
- updated kitchen preference
- preferred flooring types
- preferred street type
- preferred story count
- HOA maximum monthly budget
- pool preference
- year-built range

For feature-heavy answers, use a multi-select pick-list first, then ask for custom additions only if the user has something missing from the list. Map each selection back into either a structured `config/profile.yml` field or a narrative note in `buyer-profile.md` and `modes/_profile.md`.

Use defaults such as:

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

### 4. Deal-Breakers And Lifestyle Context

Collect:
- deal-breakers as a bulleted list
- family context
- resale versus new-construction tolerance
- street-noise sensitivity
- lot and yard priorities
- commute tolerance
- how aggressive the buyer wants to be in a tight market

Use a multi-select deal-breaker list first, then collect missing nuance in freeform. Good defaults:

- `Busy road or cut-through traffic`
- `Floodplain or drainage concern`
- `HOA above budget`
- `Small or unusable backyard`
- `Weak assigned schools`
- `Townhome or condo`
- `Backs to commercial or highway`
- `Major immediate repairs`
- `Too far from preferred commute`
- `Builder-heavy new construction`

### 5. Commute And Financial Assumptions

Collect:
- commute destinations as a bulleted list
- destination priority for each commute target
- down-payment percentage
- loan type
- closing-cost minimum and maximum percentages

For commute destinations, ask for bullets in a format such as:

- `Downtown Raleigh | Downtown Raleigh, NC | occasional`
- `Research Triangle Park | RTP, NC | daily`

For down payment and closing-cost assumptions, prefer short default options first. Example:

- down payment: `10%`, `15%`, `20%`, `25%+`, `Custom`
- closing costs: `1-2%`, `2-3%`, `3-4%`, `4%+`, `Custom`
- loan type: `30-year fixed`, `15-year fixed`, `ARM`, `Custom`

### 6. Neighborhood Weight Scores

Ask one 0-100 question for each neighborhood weighting factor. Use wording like this:

- How important is low crime in your neighborhood? Enter `0-100`.
- How important is manageable traffic and commute friction near the home? Enter `0-100`.
- How important is a strong sense of community and neighbor quality? Enter `0-100`.
- How important is strong local school reputation as part of the neighborhood score? Enter `0-100`.
- How important is everyday livability such as parks, groceries, healthcare access, and lower noise? Enter `0-100`.

Map those answers to:
- `sentiment.weights.crime_safety`
- `sentiment.weights.traffic_commute`
- `sentiment.weights.community`
- `sentiment.weights.school_quality`
- `sentiment.weights.livability`

### 7. School Weight Scores

Ask one 0-100 question for each school weighting factor. Use wording like this:

- How important is academic performance? Enter `0-100`.
- How important is parent and community trust in the school? Enter `0-100`.
- How important is teacher and staff quality? Enter `0-100`.
- How important is school safety and student environment? Enter `0-100`.
- How important are extracurriculars and available resources? Enter `0-100`.

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

The profile flow should feel like a guided form, not a blank interview.

Rules:

- Do not ask every field as pure free text when a short default list would make the answer easier.
- Do not anchor the option sets around the current buyer's exact values; use generic defaults that work for many buyers, with `Custom` available.
- Keep each batch small enough that the user can answer quickly.
- If the user chooses multiple features or deal-breakers, reflect the whole set back into the written profile instead of collapsing it down to one headline preference.
- When the user supplies multiple search areas in one reply, preserve that batch and ask at most one grouped follow-up for any missing county or rank fields.

## Validation

After updating the files, run:

- `node profile-sync-check.mjs`

If the buyer changed areas or other search coverage materially, tell the user that `portals.yml` may still need area-path updates even though scan now syncs numeric filter ranges from `config/profile.yml` at runtime.

## Output Summary

Return a concise summary with:
- which buyer-layer files were updated
- the biggest profile changes captured
- whether the weight scores were re-normalized
- whether `profile-sync-check.mjs` passed
- whether `portals.yml` now looks out of sync with the new profile
- and an explicit next-step line telling the user to run `/home-ops init` next