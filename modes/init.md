# Mode: init -- Browser Session Setup

Launch or confirm the repo-local hosted browser session that Home-Ops will reuse for portal scans, listing verification, and gated neighborhood research.

## Read First

- `modes/_preflight.md`
- `modes/_shared.md`
- `modes/_profile.md`
- `config/profile.yml`
- `portals.yml`
- `output/browser-sessions/chrome-host/session-state.json` if it exists
- `batch/logs/browser-sessions.tsv` if it exists

## Prerequisites

Run the environment preflight in `modes/_preflight.md` before anything else. This mode calls `npm run browser:status`, `npm run browser:setup`, and `npm run browser:session`, so Node.js and npm must both be on PATH with `node_modules/` present. If any preflight step fails, halt and surface the install guidance to the user instead of attempting to launch the browser session.

## Goal

Prepare a reusable hosted browser session for the login-required browser targets in `portals.yml` so the user can sign in once and then run `/home-ops hunt`, `/home-ops scan`, `/home-ops evaluate`, or `/home-ops deep` without repeating portal login.

## Platform Flags

If the command arguments include any of these flags, treat them as a platform filter for session initialization:

- `--zillow`
- `--redfin`
- `--relator`
- `--homes`
- `--facebook`
- `--nextdoor`
- `--greatschools`

Treat `--realtor` as a backward-compatible alias, but prefer `--relator` in commands and documentation.
Treat `--homes.com` as a backward-compatible alias for `--homes`.
Treat `--greatschools` as a direct school-research target rather than a login-required portal.

When no platform flags are present:
- Initialize all login-required browser targets from `portals.yml`, including Homes.com when it is configured as a login-required listing portal and Facebook/Nextdoor when they are configured as login-required sentiment sources.
- Confirm that the hosted Chrome window opens one tab per `login_required: true` platform in `portals.yml`. If Homes.com is present in `portals.yml` but no Homes.com tab appears, stop and report it instead of silently continuing.

## Behavior

1. Check the existing hosted session first with `npm run browser:status`.
2. If the hosted session is already open and the CDP endpoint is reachable, report that the session is ready instead of relaunching it unless the user explicitly asks to refresh it.
3. If a new setup is needed and no platform flags are present, run `npm.cmd run browser:setup` on Windows PowerShell.
4. If a new setup is needed and platform flags are present, run `npm.cmd run browser:session -- --hosted --caller init --channel chrome {matching flags}` on Windows PowerShell.
5. Use `--greatschools` when the user wants the hosted browser session to preload direct school pages instead of relying on search-engine fallback.
6. Never enter credentials for the user. The user must complete sign-in manually in the hosted Chrome window.
7. Tell the user to keep the hosted browser running after login so Home-Ops can attach to it later over CDP.

Notes:
- The hosted session launcher prefers local Chrome, but now falls back to Edge or Chromium automatically when Chrome is not installed.
- Report the actual browser channel used when a fallback occurred.

## Output Summary

Return a concise summary with:
- whether an existing hosted session was reused or a new one was launched
- browser targets covered by the session
- browser profile path
- CDP endpoint if available
- state/log files updated
- the next step: run `/home-ops hunt`, `/home-ops scan`, `/home-ops evaluate`, or `/home-ops deep`