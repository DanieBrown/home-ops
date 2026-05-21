# Mode: afford -- Conservative Affordability Wizard

Use this mode when the user wants to estimate a realistic home-affordability range and optionally update the buyer profile's price and financial assumptions.

## Read First

- `modes/_preflight.md`
- `modes/_shared.md`
- `buyer-profile.md` if it exists
- `config/profile.yml` if it exists
- `modes/_profile.md` if it exists
- `DATA_CONTRACT.md`
- `docs/CUSTOMIZATION.md`

## Prerequisites

Run the environment preflight in `modes/_preflight.md` before anything else. This mode starts a local Node wizard server, runs the deterministic affordability calculator, and may run the profile sync check after an accepted update. If preflight fails, halt and surface the install guidance before collecting financial inputs.

## Goal

Collect exactly ten primary financial inputs needed for a conservative estimate, calculate the selected fixed-rate loan term first, show the alternate fixed term as comparison context, then ask before updating:

- `config/profile.yml`
- `buyer-profile.md`
- `modes/_profile.md`

This is educational decision support, not lender preapproval, financial advice, or a substitute for Loan Estimates from lenders.

## Flow -- Always Use The Web Wizard

The affordability wizard at `tools/afford-wizard/` is the supported interview path. The user completes it in a browser and clicks Submit; the answers are written to `.home-ops/afford-wizard-submission.json`.

Follow this flow:

1. Tell the user: "Affordability wizard will open at http://127.0.0.1:4179/ -- fill it out and click Submit, then tell me when you're done."
2. Launch the server in the background:
   - `node tools/afford-wizard/serve.mjs --once --port 4179`
3. Open the wizard in a new tab of the hosted Playwright/CDP browser session:
   - `npm.cmd run afford:open`
   - If that fails because the hosted session is missing or unreachable, run `npm.cmd run browser:setup`, leave Chrome open, then rerun the opener.
4. Stop and wait for the user to confirm they clicked Submit.
5. After confirmation, run:
   - `npm.cmd run afford:calculate -- --input .home-ops/afford-wizard-submission.json --output output/affordability/latest.json`
6. Summarize:
   - selected loan term
   - recommended purchase-price range
   - binding constraint: monthly payment cap or cash available
   - estimated monthly payment at the max
   - rate source
   - alternate-term comparison if available
   - profile patch preview
7. Ask whether to update the profile with the calculated range. Do not update buyer-layer files unless the user explicitly accepts.
8. If accepted, run:
   - `npm.cmd run afford:apply -- --input output/affordability/latest.json`
   - `npm.cmd run sync-check`

## Wizard Inputs

Primary inputs:

1. Target state/area, prefilled from `config/profile.yml` when possible.
2. Preferred fixed loan term: `30-year fixed` or `15-year fixed`.
3. Actual monthly household take-home pay.
4. Monthly non-mortgage debt payments.
5. Cash the buyer can comfortably use for the home purchase.
6. Target down-payment percentage.
7. Rough credit-score band, not exact score.
8. Housing-payment cap as a percent of take-home.
9. HOA monthly budget or estimate.
10. Minimum search floor preference: keep current profile min, auto 85% of max, custom amount, or no floor.

If no rate override is provided, `scripts/affordability/calculate-affordability.mjs` attempts to fetch Freddie Mac PMMS rates for the selected term. If PMMS lookup fails and no override exists, tell the user to reopen the wizard and provide a rate override.

## Calculation Rules

- Primary cap: monthly housing payment should stay at or below the selected percentage of monthly take-home pay after subtracting monthly non-mortgage debt. Default to 25%.
- Payment includes principal, interest, estimated property tax, homeowners insurance, HOA, and mortgage insurance when applicable.
- Down payment comes from the wizard answer, falling back to the profile and then 20%.
- Closing-cost planning range is 2% to 5%.
- Cash constraint must fit down payment plus high-end closing costs plus applicable credit/LTV pricing pressure.
- For 30-year conventional scenarios, apply Fannie Mae purchase-money LLPA by credit tier and LTV as an upfront pricing-pressure estimate.
- For 15-year fixed scenarios, do not apply the greater-than-15-year LLPA table, but keep the credit-score warning.
- If credit score is unknown, use the `700-719` tier for pricing-pressure estimates and lower confidence.
- Show the selected term first; the other term is comparison context only.

## File Update Rules

If the user accepts the update:

- Update `search.hard_requirements.price_min` and `search.hard_requirements.price_max` from the calculated recommended range.
- Update `financial.down_payment_pct`, `closing_cost_pct_min`, `closing_cost_pct_max`, `loan_term_years`, `housing_payment_pct`, `rate_assumption_pct`, and `rate_source`.
- Add or replace the affordability snapshot in `buyer-profile.md`.
- Add or replace the affordability heuristic in `modes/_profile.md`.

Never persist raw income, monthly debt, cash available, or exact credit-score inputs into buyer-layer files.

## Validation

After an accepted update, run:

- `npm.cmd run sync-check`

If validation fails, report the failure and leave the files as written so the user can inspect the profile changes.

## Output Summary

Return a concise summary with:

- affordability result path
- whether the profile was updated
- selected-term recommended range
- alternate-term comparison when available
- warnings and confidence notes
- validation result after an accepted update
