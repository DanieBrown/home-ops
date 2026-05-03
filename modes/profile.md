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

Run the environment preflight in `modes/_preflight.md` before anything else. This mode runs `node scripts/config/generate-portals.mjs` and `node scripts/config/profile-sync-check.mjs` at the end, and the optional web-wizard flow in `tools/profile-wizard/` also starts a local Node server. If any preflight step fails, halt and surface the install guidance to the user before attempting to collect or write profile data.

## Goal

Collect the buyer's search criteria, lifestyle context, and weighting preferences, then map that information back into the buyer-layer files:

- `buyer-profile.md`
- `config/profile.yml`
- `modes/_profile.md`

If any of those files are missing, create them from the checked-in example or template first and then fill them in.

## Flow -- Always Use The Web Wizard

The web wizard at `tools/profile-wizard/` is the only supported interview path. It mirrors the filter fields on Zillow, Redfin, Realtor.com, and Homes.com and includes slider tiles for sentiment and school weights. The user completes it in a browser and clicks Submit; the answers are written to `.home-ops/profile-wizard-submission.json`.

Do not offer an in-chat Q&A alternative, and do not fall back to `vscode_askQuestions` for the question flow. If the user asks to "just ask me" or to skip the wizard, tell them the wizard is now the only supported path and explain that partial edits can still be made by editing `config/profile.yml` or `buyer-profile.md` by hand afterward.

Follow this flow exactly. The mechanism is a background server plus an explicit user confirmation -- do **not** use a long Bash timeout to "wait" for the user. The foreground wait timer was removed because it was buggy (bash cap races, early returns, truncated stdout that looked like a submission).

1. **Announce the URL first.** Before launching the server, tell the user in one short line: "Wizard will open at http://127.0.0.1:4178/ -- fill it out and click Submit, then tell me when you're done." If Chrome MCP is available, also open the URL in the hosted Chrome session now so the tab is ready before the server starts accepting submissions.
2. **Launch the server in the background.** Call the Bash tool with:
   - `command`: `node tools/profile-wizard/serve.mjs --once --port 4178`
   - `run_in_background`: `true`
   - No custom timeout -- the process stays alive until the user submits, at which point it exits on its own ~250ms after writing the submission file.
2b. **Open the wizard in a browser automatically.** After launching the server, open a Playwright browser tab so the user doesn't have to copy-paste the URL. Call the Bash tool with:
   - `command`: `node scripts/profile-wizard/open-browser.mjs --url http://127.0.0.1:4178/`
   - `run_in_background`: `false` (this exits as soon as the tab opens, typically under 10 s)
   If the script exits with code 1 (server not reachable within 10 s), tell the user to open http://127.0.0.1:4178/ manually.
3. **Ask the user to confirm when they are done.** After the server is running, send a single short message asking the user to reply when they have clicked Submit (wording suggestion: "Wizard is live at http://127.0.0.1:4178/. Reply 'done' once you've submitted and I'll ingest the answers."). Stop and wait for the user's reply -- do not poll, do not re-prompt, do not proceed on assumption.
4. **Ingest after the user confirms.** Once the user says they have submitted, read `.home-ops/profile-wizard-submission.json`. If the file does not exist, tell the user the wizard did not finish writing and ask them to re-submit in the same browser tab (answers are preserved in `.home-ops/profile-wizard-answers.json` so refreshes keep their work). Once the file exists, map the answers into `config/profile.yml`, `buyer-profile.md`, and `modes/_profile.md` using the file-update rules below, then delete or rename the submission file so the next run starts clean.
5. Run the validation steps and output summary as usual.

### Wizard Submission Shape (Updated)

The wizard no longer asks for features or deal-breakers as separate pick-lists, and the financial tile no longer asks for down payment or closing costs. Its submission payload (under `payload.answers`) is now shaped as:

- `areas_selection`: `{ state, counties: [...], cities: [{ name, county, state, abbr? }] }`. Map every city into `config/profile.yml` `search.areas` as `{ name, state, county, rank }` (rank = order of selection). When a city entry has `custom: true` and no `county`, leave the county blank and add it to `modes/_profile.md` for manual follow-up. After ingestion, if any city is not represented in `config/city-registry.yml`, add a stub row with `redfin_city_id: null` and `primary_zip: <lookup>` before running `generate-portals.mjs`.
- `price`, `beds_min`, `baths_min`, `sqft_min`, `garage_min`, `lot_min`, `home_type_preference`, `year_built_min`, `stories_preferred`, `property_types`, `hoa_max`, `schools_min_rating`, `max_listing_age`: map into the matching `config/profile.yml` fields exactly as before. Persist `baths_min` into `search.hard_requirements.baths_min` and `lot_min` into `search.hard_requirements.lot_min_acres` (parse `No minimum` as `null`, `0.15+` as `0.15`, etc.) so later wizard sessions can pre-seed these values.
- `hoa_max` still writes to `search.soft_preferences.hoa_max_monthly`.
- `down_payment_pct` / `closing_pct` are no longer collected. Do not overwrite the existing `financial` block in `config/profile.yml`; leave it as-is.
- `research_sources` keys are flat `group.source` pairs. When a whole group has every source set to `false`, that group is intentionally opted out -- set every key in the corresponding `research_sources.<group>` object to `false` in `config/profile.yml`, and update `modes/_profile.md` to note which pipeline stages are now skipped. The one exception is the listing-portals group: an all-off portals group means "use every portal" -- `generate-portals.mjs` already handles this fallback, so still mirror the buyer's picks verbatim into `config/profile.yml`.
- The schools group now exposes only `greatschools`. Write the buyer's pick into `research_sources.schools.greatschools` and set the legacy keys `niche`, `state_report_cards`, and `schooldigger` to `false` on ingestion.
- The development group exposes `state_dot` and `county_planning`. Write the buyer's picks verbatim into the corresponding `research_sources.development` keys and set the remaining legacy keys (`local_construction`, `municipal_planning`, `mpo`) to `false` on ingestion.
- `commute` is a list of destination names. Preserve each destination's existing `address` and `priority` in `config/profile.yml` if present; otherwise default `priority` to `occasional` and leave `address` equal to `<name>, <state>`.

### Wizard Narrative Mapping

On submit, `tools/profile-wizard/serve.mjs` runs the prose through `tools/profile-wizard/parse-narrative.mjs` and writes the structured result into the submission file as a top-level `narrative_extract` block shaped like:

```
narrative_extract:
  features: ["Fenced yard", "Updated kitchen", ...]          # -> search.soft_preferences.features
  deal_breakers: ["Busy road...", "Townhome or condo", ...]  # -> search.deal_breakers
  scan_keywords: ["fenced yard", "updated kitchen", ...]     # -> search.scan_keywords
  scan_negative_keywords: ["busy road", ...]                 # -> search.scan_negative_keywords
  profile_fields:                                            # -> merged into search.soft_preferences
    fenced_yard: true
    floor_plan: open
    street_type: cul-de-sac
    lot_min_acres_floor: 0.25      # bumps search.hard_requirements.lot_min_acres up to at least this value
    exclude_property_types: [...]   # -> search.soft_preferences.exclude_property_types
```

When ingesting a wizard submission, prefer `narrative_extract` for features/deal-breakers/scan keywords over trying to re-parse the narrative text yourself. Still preserve the raw narrative text (`payload.answers.narrative.wants` / `.avoids` / `.notes`) into `buyer-profile.md` so the buyer voice is not lost.

## Interaction Rules

- The wizard owns question presentation. This mode file no longer scripts per-question text, buckets, or default option sets -- see `tools/profile-wizard/app.js` for the actual form.
- Do not re-ask any question through `vscode_askQuestions`. The only in-chat follow-ups allowed are:
  - asking whether to rerun the wizard server after three failed auto-pickup rounds, and
  - asking whether to bypass a wizard submission field that parsed as invalid (e.g. an out-of-range numeric field that the wizard somehow let through).
- Do not write buyer-specific criteria into `modes/_shared.md`.

## Weight Normalization Rules

For the neighborhood weight group:

1. Parse each response as a number from `0` to `100`.
2. If a value is invalid or missing, ask a follow-up instead of guessing.
3. Normalize the raw scores so they sum to `1.0`.
4. If the user gives all zeros, keep the current weights. If no current weights exist, fall back to the example defaults.
5. Round to a practical YAML precision and ensure the final stored values still sum to `1.0`.

## File Update Rules

### `config/profile.yml`

Update the structured fields for:
- search areas
- hard requirements
- soft preferences (including `features` and any `profile_fields` from `narrative_extract` like `fenced_yard`, `floor_plan`, `street_type`, `updated_kitchen`, `flooring_include`, `exclude_property_types`)
- deal-breakers
- `search.scan_keywords` and `search.scan_negative_keywords` (from the wizard's `narrative_extract` -- these flow into the Google search queries that `generate-portals.mjs` emits)
- commute destinations
- financial assumptions (down payment and closing-cost range only)
- research sources (portals, sentiment, schools, development)
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

## Validation

After updating the files, run:

- `node scripts/config/generate-portals.mjs` -- regenerates `portals.yml` from the updated `config/profile.yml` and `config/city-registry.yml`. Always run this when search areas change so Zillow, Redfin, and Realtor.com base URLs stay in sync with the profile.
- `node scripts/config/profile-sync-check.mjs`
- **County GIS discovery** (if `research_sources.development.county_planning` is `true`): run `node scripts/research/county-services-discover.mjs --all`. This queries the ArcGIS REST catalog for each county in the buyer's search areas that has an entry in `config/county-arcgis-registry.yml`, discovers planning/permits/zoning feature layers by field scoring, and writes `config/county-sources.json`. The permits check (`county-permits-check.mjs`) loads this file automatically on every run. If a county is not in the registry, note it in the output summary and tell the user to add its ArcGIS base URL to `config/county-arcgis-registry.yml`.

If `scripts/config/generate-portals.mjs` emits a warning for an unmatched city, add the missing `redfin_city_id` and `primary_zip` to `config/city-registry.yml` and rerun the generator before continuing.

## Output Summary

Return a concise summary with:
- which buyer-layer files were updated
- the biggest profile changes captured
- whether the weight scores were re-normalized
- whether `scripts/config/generate-portals.mjs` ran cleanly, plus any unmatched-city warnings it surfaced
- whether `scripts/config/profile-sync-check.mjs` passed
- if county_planning is enabled: how many counties were discovered, which had services registered, and which were skipped (not in registry)
- and an explicit next-step line telling the user to run `/home-ops init` next