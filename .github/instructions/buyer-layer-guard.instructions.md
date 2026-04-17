---
description: "Use when editing buyer-profile.md, config/profile.yml, modes/_profile.md, or portals.yml. Covers buyer-owned customization files, minimal edits, and where buyer-specific criteria belong."
name: "Buyer Layer Guard"
applyTo: "buyer-profile.md,config/profile.yml,modes/_profile.md,portals.yml"
---
# Buyer Layer Guard

- Treat `buyer-profile.md`, `config/profile.yml`, `modes/_profile.md`, and `portals.yml` as buyer-owned files. Do not overwrite, reset, or regenerate them wholesale.
- Make the smallest change that satisfies the request. Preserve the buyer's wording, structure, URLs, notes, and existing thresholds unless the user asked to change them.
- Keep buyer-specific criteria in these files, not in `modes/_shared.md`, templates, or other shared system files.
- Put narrative preferences, commute context, and nuanced tradeoffs in `buyer-profile.md`.
- Put structured thresholds, weights, finance assumptions, and workflow flags in `config/profile.yml` using the existing schema.
- Put buyer-specific prompt behavior and heuristics in `modes/_profile.md`.
- Put live search URLs, source coverage, login-related source settings, and evidence inventories in `portals.yml`.
- Do not duplicate numeric search thresholds into `portals.yml` when they already belong in `config/profile.yml`; scan syncs those values at runtime.
- If a requested change would move buyer-specific logic into a shared file, keep the logic in the buyer layer and update the shared file only if the rule is truly system-wide.
- If scope is unclear, ask whether the user wants a buyer-specific change or a reusable system change before editing shared prompts or scripts.