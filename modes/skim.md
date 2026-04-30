# Mode: skim -- Browser Search Preview

Open one filtered search tab per configured portal area in the hosted browser, with buyer profile filters already baked into each URL. Use this when you want to visually browse all configured markets across every portal before committing to a full scan.

## Read First

- `modes/_preflight.md`
- `modes/_shared.md`
- `modes/_profile.md`
- `config/profile.yml`
- `portals.yml`
- `output/browser-sessions/chrome-host/session-state.json` if it exists

## Goal

For every platform × area combination configured in `portals.yml`, open a browser tab whose URL already encodes the buyer's hard requirements (price range, beds, baths, sqft, garage, listing age, HOA, year built). This lets the user visually review current search results without running the full extract-and-pipeline flow.

If no hosted browser session is active, skim launches one automatically before opening tabs. The user does not need to run `/home-ops init` first.

## Platform Filter Flags

If the command arguments include any of these flags, open tabs only for the matching portals:

- `--zillow`
- `--redfin`
- `--relator` (or `--realtor`)
- `--homes`
- `--no-zillow` / `--no-redfin` / `--no-relator` / `--no-homes`

When no flags are present, open tabs for all platforms configured in `portals.yml`.

## Behavior

1. Run the environment preflight in `modes/_preflight.md`. Node.js and npm must be on PATH with `node_modules/` present.
2. Run `npm run skim` (with any platform flags forwarded as additional arguments).
   - The script reads `portals.yml` and `config/profile.yml`.
   - It syncs buyer filters into each search URL (price, beds, baths, sqft, garage, listing age, HOA, year built, school rating where applicable).
   - It checks for an active hosted session via the CDP endpoint saved in `output/browser-sessions/chrome-host/session-state.json`.
   - **If no session is active**, the script launches a new hosted Chrome window automatically (falling back to Edge or Chromium if Chrome is not installed) and saves the session state before opening tabs.
   - It connects to the hosted session via CDP and opens one tab per platform × area.
3. After the script exits, the hosted browser remains open for the user to browse.

## Session Auto-Launch

Unlike `/home-ops init`, skim does not wait for the user to sign in before proceeding. It opens the search tabs immediately. If a portal requires a sign-in and the session cookies are not saved yet:
- The portal page will show a sign-in prompt inside the tab.
- The user can sign in manually in that tab and then refresh it.
- For a full authenticated session across all portals, run `/home-ops init` first.

## Output Summary

Return a concise summary with:
- whether an existing session was reused or a new one was launched
- total tabs opened, grouped by platform
- any tabs that failed to navigate (the tab is still open but may need a manual refresh)
- the next suggested action: browse the tabs, then run `/home-ops scan` to extract and pipeline the listings
