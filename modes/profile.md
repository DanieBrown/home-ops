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
- Prefer a mix of fixed-choice and free-input questions.
- For grouped criteria such as areas, features, deal-breakers, or commute destinations, ask the user for a bulleted list and map the bullets back to the correct fields.
- Preserve any current value the user explicitly says to keep.
- Do not write buyer-specific criteria into `modes/_shared.md`.

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
- target areas as a bulleted list
- price minimum and maximum
- minimum beds
- minimum garage spaces
- minimum square footage
- yard requirement summary
- minimum school rating
- maximum listing age in days
- home type preference

For search areas, ask for a bulleted list in a format such as:

- `Holly Springs | NC | Wake | 1`
- `Apex | NC | Wake | 2`

Interpret the columns as:
- area name
- state
- county
- rank

If county or rank is omitted, ask a short follow-up instead of inventing it.

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

For feature-heavy answers, ask the user for a bulleted list and map each item back into either a structured `config/profile.yml` field or a narrative note in `buyer-profile.md` and `modes/_profile.md`.

### 4. Deal-Breakers And Lifestyle Context

Collect:
- deal-breakers as a bulleted list
- family context
- resale versus new-construction tolerance
- street-noise sensitivity
- lot and yard priorities
- commute tolerance
- how aggressive the buyer wants to be in a tight market

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

### `modes/_profile.md`

Update the buyer-specific operating heuristics with:
- buyer priorities
- area notes when the user provides town-specific nuance
- decision heuristics
- tour triggers
- pass triggers
- financial posture

Preserve any existing nuanced notes that the user did not override.

## Validation

After updating the files, run:

- `node profile-sync-check.mjs`

If the buyer changed areas, price bands, or other search coverage materially, tell the user that `portals.yml` may need a separate refresh to keep scan mode aligned.

## Output Summary

Return a concise summary with:
- which buyer-layer files were updated
- the biggest profile changes captured
- whether the weight scores were re-normalized
- whether `profile-sync-check.mjs` passed
- whether `portals.yml` now looks out of sync with the new profile