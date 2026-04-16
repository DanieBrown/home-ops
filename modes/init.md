# Mode: init -- Browser Session Setup

Launch or confirm the repo-local hosted browser session that Home-Ops will reuse for portal scans and listing verification.

## Read First

- `modes/_shared.md`
- `modes/_profile.md`
- `config/profile.yml`
- `portals.yml`
- `output/browser-sessions/chrome-host/session-state.json` if it exists
- `batch/logs/browser-sessions.tsv` if it exists

## Goal

Prepare a reusable hosted Chrome session for Zillow, Redfin, and Realtor.com so the user can sign in once and then run `/home-ops scan` separately.

## Platform Flags

If the command arguments include any of these flags, treat them as a platform filter for session initialization:

- `--zillow`
- `--redfin`
- `--relator`

Treat `--realtor` as a backward-compatible alias, but prefer `--relator` in commands and documentation.

When no platform flags are present:
- Initialize all login-required platforms from `portals.yml`.

## Behavior

1. Check the existing hosted session first with `npm run browser:status`.
2. If the hosted session is already open and the CDP endpoint is reachable, report that the session is ready instead of relaunching it unless the user explicitly asks to refresh it.
3. If a new setup is needed and no platform flags are present, run `npm.cmd run browser:setup` on Windows PowerShell.
4. If a new setup is needed and platform flags are present, run `npm.cmd run browser:session -- --hosted --caller init --channel chrome {matching flags}` on Windows PowerShell.
5. Never enter credentials for the user. The user must complete sign-in manually in the hosted Chrome window.
6. Tell the user to keep the hosted browser running after login so Home-Ops can attach to it later over CDP.

## Output Summary

Return a concise summary with:
- whether an existing hosted session was reused or a new one was launched
- platforms covered by the session
- browser profile path
- CDP endpoint if available
- state/log files updated
- the next step: run `/home-ops scan`