# Mode: reset -- Clear Generated Search State

Use this mode when the user wants a clean working slate without touching buyer-specific setup.

## Goal

Delete generated scan and evaluation clutter while preserving the buyer profile, portal configuration, and browser session data.

## Preserve

Do not modify:
- `buyer-profile.md`
- `config/profile.yml`
- `modes/_profile.md`
- `portals.yml`
- `output/browser-sessions/`
- `batch/logs/`

## Reset Scope

Clear or reset these generated artifacts:
- generated markdown reports in `reports/`
- staged tracker TSVs in `batch/tracker-additions/` and `batch/tracker-additions/merged/`
- `data/scan-history.tsv`
- unchecked and processed items in `data/pipeline.md`
- `data/listings.md`
- `data/shortlist.md` only when `config/profile.yml` does not set `workflow.shortlist.preserve_on_reset: true`

Resetting `data/listings.md` is required when reports are deleted, otherwise the tracker would keep broken report links.
If shortlist preservation is enabled in the profile, keep `data/shortlist.md` untouched during reset and say so in the summary.

## Execution

Prefer the checked-in package script:
- Windows PowerShell: `npm.cmd run reset:data`
- Other shells: `npm run reset:data`

If the user wants a preview first, use:
- Windows PowerShell: `npm.cmd run reset:data -- --dry-run`
- Other shells: `npm run reset:data -- --dry-run`

After the reset, run `node scripts/pipeline/verify-pipeline.mjs`.

## Output Summary

Return a concise summary with:
- reports removed
- tracker additions removed
- files reset
- confirmation that profiles and browser sessions were preserved