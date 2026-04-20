# Contributing to Home-Ops

Thanks for contributing.

Home-Ops is a local decision-support tool for evaluating home listings. Good contributions make the buyer workflow clearer, safer, and easier to maintain.

## Before Opening a PR

Open an issue first when the change is more than a small bug fix. That avoids parallel solutions and helps keep the repo focused.

## Good Contributions

- Better listing-evaluation prompts or score explanations
- Safer tracker, merge, dedup, or verification scripts
- Dashboard improvements for listing workflows
- Documentation improvements
- Better example scanner templates
- Bug reports with a clear reproduction path

## Guidelines

- Keep buyer-specific data out of system-layer files.
- Use `buyer-profile.md`, `config/profile.yml`, `modes/_profile.md`, and `portals.yml` for personalization.
- Scripts should handle missing files gracefully.
- Dashboard changes should still build with `go build ./...`.
- Prefer small, focused PRs.

## Not Accepted

- PRs that auto-contact agents, auto-schedule tours, or auto-submit offers
- PRs that encourage violating platform terms of service
- PRs that add paid API requirements without prior discussion
- PRs that commit real personal data, real addresses, or private reports

## Development

```bash
npm install
npx playwright install chromium
npm run doctor
npm run verify
npm run sync-check
node scripts/system/test-all.mjs --quick

# optional dashboard build
cd dashboard && go build ./...
```

## Data Safety

Do not commit these user-layer files:
- `buyer-profile.md`
- `config/profile.yml`
- `modes/_profile.md`
- `portals.yml`
- `data/listings.md`
- `data/pipeline.md`
- `data/scan-history.tsv`
- `reports/*`

Use fictional data in `examples/` and documentation.
