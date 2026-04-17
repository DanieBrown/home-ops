# Customization Guide

## Buyer Layer

These files are the intended place for buyer-specific configuration:

- `buyer-profile.md`: plain-language brief for towns, deal-breakers, family context, and priorities
- `config/profile.yml`: structured requirements, weights, and finance assumptions
- `modes/_profile.md`: buyer-specific prompt behavior and decision heuristics
- `portals.yml`: live search URLs and source preferences

If you want guided setup instead of manual editing, use `/home-ops profile` to interview the buyer and write the answers back into the buyer-layer files.

If priorities change, update one of these files instead of hard-coding new criteria into `modes/_shared.md`.

## config/profile.yml

Key sections to tune:

- `search.areas`: towns, neighborhoods, and metro focus
- `search.hard_requirements`: price, bedrooms, garage, square footage, listing age, and similar gates
- `soft_preferences`: lot, resale, layout, and livability preferences
- `deal_breakers`: flood risk, busy roads, HOA, or similar hard negatives
- `sentiment.weights`: neighborhood weighting model
- `school_sentiment.weights`: school weighting model
- `financial`: down payment, closing cost, and payment assumptions
- `workflow.shortlist.preserve_on_reset`: keep `data/shortlist.md` stable during recurring reset and hunt runs

These weight blocks currently steer evaluator judgment and research emphasis. They are not yet a standalone deterministic scoring engine that automatically consumes structured sentiment, school, and development records.

## buyer-profile.md

Use this file for the context that is hard to express in YAML, such as:

- neighborhood personality preferences
- commute tolerances
- resale versus new-construction preference
- street-noise sensitivity
- what makes a listing worth touring despite tradeoffs

## portals.yml

`portals.yml` controls how discovery works.

Customize:

- portal search area paths and base URLs
- login prompts for each platform
- search areas and source coverage
- sentiment, school, and development sources
- fallback `search_queries` used when direct browsing is blocked

Scan syncs the numeric portal filters from `config/profile.yml` at runtime, so `portals.yml` does not need to mirror every price, bed, garage, and square-foot threshold by hand.

The source inventories in `portals.yml` are both configuration and audit surface. Home-Ops uses them to define what the evaluator should look for, and `research-coverage-audit.mjs` uses report content to tell you whether those evidence classes were actually covered.

## Prompt Overrides

`modes/_profile.md` is the right place to bias the evaluator toward your buyer's actual tradeoffs. Good examples:

- prefer established resale neighborhoods over brand-new subdivisions
- penalize busy-road exposure harder than average
- treat school confidence as more important than cosmetic finishes

Avoid putting those preferences into `modes/_shared.md`, which should remain reusable.

## Canonical States

If you change tracker states, update all three of these together:

1. `templates/states.yml`
2. `normalize-statuses.mjs`
3. any prompt text that references status names

## Dashboard Theme

The Go dashboard theme lives under `dashboard/internal/theme/`. Change that layer only if you want to alter the visual presentation of the terminal UI without affecting evaluation logic.
