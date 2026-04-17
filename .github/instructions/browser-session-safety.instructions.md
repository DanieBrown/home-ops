---
description: "Use when editing browser-session.mjs, scan-listings.mjs, check-liveness.mjs, review-tabs.mjs, sentiment-browser-extract.mjs, or init/scan/evaluate/hunt mode files. Covers hosted browser session reuse, Playwright serialization, blocked-listing handling, and Windows PowerShell caveats."
name: "Browser Session Safety"
applyTo: "browser-session.mjs,scan-listings.mjs,check-liveness.mjs,review-tabs.mjs,sentiment-browser-extract.mjs,modes/init.md,modes/scan.md,modes/evaluate.md,modes/hunt.md,modes/_shared.md"
---
# Browser Session Safety

- Treat the hosted browser session as a shared repo resource created by `/home-ops init` or `npm.cmd run browser:setup`. Do not bootstrap a new browser session from scan, evaluate, or hunt flows.
- Reuse the persisted hosted session through its saved CDP connection details instead of launching a fresh Playwright browser when an existing hosted session is required.
- Keep Playwright-backed listing verification and normalized fact extraction serialized against the hosted session. Do not run multiple browser checks in parallel against the same session.
- Keep browser attachment, session-state reads, verification, and normalized fact extraction in the main agent or orchestrator. Subagents should work from structured evidence, not the live hosted browser.
- If a flow depends on the hosted browser session, fail clearly when the session is closed, unreachable, or blocked instead of silently falling back to a fresh hidden browser.
- Treat anti-bot or request-processing pages as blocked or unconfirmed, not as proof that a listing is active or inactive.
- If Zillow hits sign-in, press-and-hold, captcha, or human-verification blockers during scan mode, skip Zillow for the rest of that scan and tell the user to rerun after clearing the blocker.
- If Realtor.com shows request-processing or similar access blocks, report the listing or scan as blocked and retry later instead of marking the listing sold, inactive, or missing.
- Preserve the existing browser-channel preference and fallback order. Prefer Chrome, then Edge, then Chromium, and report when fallback occurs.
- On Windows PowerShell, prefer `npm.cmd` over `npm` when invoking browser-session or related repo scripts if execution policy blocks `npm.ps1`.
- Keep hunt ordering strict: reset -> scan -> evaluate. Browser setup belongs to init, not to later phases.
- In batch evaluate flows, deduplicate homes by normalized address + city before dispatching report workers, and keep the live browser pass single-threaded even when report drafting happens in waves.