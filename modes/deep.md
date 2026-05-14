# Mode: deep -- Listing or Area Deep Dive

Use this mode when the user wants deeper research on a property, subdivision, neighborhood, town, or school cluster.

Read before researching:
- `buyer-profile.md`
- `config/profile.yml`
- `modes/_shared.md`
- `modes/_profile.md`
- `data/listings.md`
- `data/shortlist.md` if it exists
- relevant existing reports in `reports/`

## Goal

Produce a detailed brief that goes beyond the normal evaluation report.

This mode is for questions like:
- "Go deeper on this neighborhood"
- "Research everything around this house"
- "How risky is this area long term?"
- "Compare the school environment around these two subdivisions"

It also handles a shortlist batch branch:
- "Go deep on the top 10"
- "Run deep on the compare shortlist"
- "Batch deep dive the current shortlist"

## Architecture: Three Axis Agents

This mode uses **three axis agents plus the main agent for every run** — single-home and batch alike. Their definitions live at:

- `.claude/agents/sentiment-axis.md` (Claude Code) and `.github/agents/sentiment-axis.agent.md` (OpenCode)
- `.claude/agents/risk-builder-axis.md` and `.github/agents/risk-builder-axis.agent.md`
- `.claude/agents/schools-axis.md` and `.github/agents/schools-axis.agent.md`

When dispatching, use `subagent_type: sentiment-axis | risk-builder-axis | schools-axis`.

The deterministic capture scripts (Phase 0/2 single, Phase A batch) own all live browsing. The axis agents read pre-captured JSON sidecars **first**. When a sidecar is missing or empty, an axis agent MAY re-run the relevant capture script (e.g. `sentiment-public-extract.mjs`, `school-metadata-fetch.mjs`, `construction-check.mjs`) with `--profile chrome-host`, which connects to the user's already-running hosted browser session via CDP. This is the only permitted fallback — it must NOT use `WebFetch`, `WebSearch`, or any MCP server, and must NOT launch a new browser (a fresh session has no auth and will 403/404 against portals). Each agent records `source: "sidecar" | "fallback-capture"` provenance per datapoint.

Total agent count per run = 4 (3 axis + 1 main).

## Script Execution Order (Authoritative)

The contract system at `.home-ops/command-contract.json` (defined in `scripts/hooks/contract-shared.mjs`) actively gates this mode. The PreToolUse hook (`scripts/hooks/on-pretool.mjs`) **denies** any Bash call whose contract gate has unsatisfied prereqs. The PostToolUse hook (`scripts/hooks/on-bash.mjs`) records satisfaction or **blocks** on non-zero exit.

Single-home flow (`deep-single` contract):

```
deep-single-runner.mjs        →  extract-listing-details + school-assignments-fetch
        ↓ (gate: extract-listing-details)
[main agent] eval report      →  reports/{N}-{slug}-{date}.md, tracker row
        ↓
deep-single-final-runner.mjs  →  research-source-plan, community-lookup, sentiment-browser-extract,
                                  sentiment-public-extract, construction-check, county-permits-check,
                                  school-metadata-fetch, builder-check, hoa-docs-check,
                                  deep-research-packet
        ↓ (gate: deep-research-packet-single)
[3 axis agents in parallel]   →  Sentiment, Risk & Builder, Schools
        ↓
[main agent] update report    →  enrich the same reports/{N}-{slug}-{date}.md with deep findings
        ↓
review-tabs.mjs urls --replace
        ↓ (gate: review-tabs-single)
briefing-pdf.mjs --report ... →  output/briefings/{slug}-deep-{date}.pdf
        ↓ (gate: briefing-pdf-deep-single)
[final tab state: 2 tabs]
```

Multi-URL flow uses the same gates, repeated per-URL during capture, with one combined `briefing-pdf.mjs --reports …` call at the end. The combined call satisfies the same `briefing-pdf-deep-single` gate — exactly **one** PDF is produced per deep run regardless of single-URL vs. multi-URL input.

Batch flow (`deep-shortlist` contract): see Phase A/B/C below; gates are `research-audit`, `deep-research-packet`, `promote-finalists`, `finalist-gate`, `review-tabs-top3`, `briefing-pdf`.

## Run-to-Completion Contract

Once the deep command starts, run every numbered step below to completion in one turn. Do not pause for user approval between steps.

The only legitimate stop points are:

1. **Missing prerequisite the user must supply.** Example: `data/shortlist.md` has no populated top-10 rows and no compare or evaluate run has established a cohort. Ask once, then proceed.
2. **Destructive override.** Example: the finalist gate fails and the user must explicitly authorize a bypass before the refined top-3 is promoted. Surface the gate result, ask once, continue based on the answer.
3. **Hard external failure that blocks all downstream steps.** Example: the hosted browser session is closed and cannot be reopened.

Every other condition (partial results, one missing sentiment file, NCDOT timing out, builder not detected) must be recorded in the brief and the run must continue.

When each numbered step starts, announce it in one short sentence so the user sees progress.

---

## Single-Home Deep Run (`/home-ops deep <url>`)

This is the primary single-URL path. It is fully scripted from URL to PDF — the AI does not fall back to WebSearch or WebFetch to fill primary listing facts. The listing extractor may use crawl4ai only as a supplemental fallback for missing fields or suspicious status conflicts; hosted-browser listing facts remain the primary source.

### Phase 0 — Pre-Eval: Listing Extraction

Run the pre-eval runner. This blocks until both scripts finish:

```
node scripts/pipeline/deep-single-runner.mjs --url <url> --profile chrome-host
```

This runner sequentially:
1. Scrapes listing facts from the live page via Playwright → `output/listings/{slug}.json`
2. Resolves assigned schools from district/listing sources first, with GreatSchools as fallback verification → `output/school-metadata/{slug}.json`

If the runner exits non-zero (listing extraction failed), stop and surface the error. Schools failure is soft — continue with a gap note.

### Phase 1 — Main Agent Writes Eval Report

Read `output/listings/{slug}.json` and `output/school-metadata/{slug}.json`. Write the canonical evaluation report:

- Path: `reports/{N}-{slug}-{YYYY-MM-DD}.md`
- Append a tracker row to `data/listings.md`

Use the structured listing JSON as the source of truth for address, price, beds, baths, sqft, year built, HOA, builder, and schools. Do not WebSearch these fields while writing the eval report. Builder discovery can run later through `builder-check`, which first uses listing/report fields, then permit-sidecar applicant/contractor/developer/builder fields when available, then an address + "builder" crawl4ai search fallback. It records its source URL in `output/builder/{slug}.json`.

### Phase 2 — Post-Eval: Data Capture

Run the post-eval runner. Pass the report path from Phase 1. This blocks until all scripts finish:

```
node scripts/pipeline/deep-single-final-runner.mjs --report reports/{N}-{slug}-{YYYY-MM-DD}.md --profile chrome-host
```

This runner sequentially runs: research-source-plan, community-lookup, sentiment-browser-extract, sentiment-public-extract, construction-check, county-permits-check, school-metadata-fetch, builder-check, hoa-docs-check, and deep-research-packet. All steps produce JSON sidecars under `output/`. The runner exits 0 when the deep-research-packet succeeds (all other failures are soft).

### Phase 3 — Three Axis Agents

Launch the three axis agents in **a single message with three Agent tool calls** so the runtime fans them out in parallel. Use the named subagents:

- `subagent_type: sentiment-axis`
- `subagent_type: risk-builder-axis`
- `subagent_type: schools-axis`

Each agent reads its pre-written JSON sidecars first. When a sidecar is missing or empty, the agent may re-run the relevant capture script with `--profile chrome-host` to use the user's existing hosted session. WebFetch, WebSearch, and launching a new browser are forbidden — a fresh session has no portal auth and will 403/404.

Pass each agent the relevant sidecar paths and the `slug`. The full output schema for each agent is documented in its definition file under `.claude/agents/`.

### Phase 4 — Brief, PDF, and Tabs

Once the axis agents return:

1. Review the axis outputs with the deep packet and eval report. Update the same canonical report `reports/{N}-{slug}-{YYYY-MM-DD}.md` with the deep findings instead of creating a second markdown report. A single URL should leave exactly one report for that physical home. Organize the added deep content around the seven research axes below.
   If `output/hoa/{slug}.json` exists, add a brief `HOA Rules and Restrictions` subsection before `Risks and Open Questions`. Use only captured HOA docs or listing-derived HOA clues; when docs are missing or blocked, mark HOA rules as unconfirmed and request the resale/disclosure packet.

2. Replace browser tabs with the listing URL first:
   ```
   node scripts/browser/review-tabs.mjs urls <listing-url> --replace
   ```

3. Render **exactly one** briefing PDF and open it in the hosted session:
   ```
   node scripts/reports/briefing-pdf.mjs --report reports/{N}-{slug}-{YYYY-MM-DD}.md
   ```
   `briefing-pdf.mjs` renders the PDF **and** opens it as a new CDP tab automatically. Running it after `--replace` means the PDF tab opens into the already-clean session, producing exactly 2 tabs.

   **Do NOT also run a `--reports` call for a single home.** The single-mode call covers the home in one PDF. Running both `--report` and `--reports` produces duplicate output; the contract has a single `briefing-pdf-deep-single` gate that either form satisfies.

   **Do NOT use a raw Playwright script or `node -e` snippet to open the PDF tab.** Always use `briefing-pdf.mjs` for this step — it uses the same CDP `/json/new` path as `review-tabs.mjs` and respects the hosted session state.

   **Final tab state: exactly 2 tabs** — the listing URL + the briefing PDF.

Post a final summary: canonical report path, briefing PDF path, and the 2-tab final state.

---

## Multi-URL Deep Run (`/home-ops deep <url1>\n<url2>\n...`)

When the user provides two or more URLs (separated by newlines or spaces), process each home through the full single-home pipeline, then fan out the axis agents across all homes together so interpretation is done in one pass.

### Parsing URLs

Extract all `https://...` tokens from the prompt. Deduplicate, preserve order.

### Phase 0–2 per URL (sequential)

For each URL **in order**, run the full three-phase capture before moving to the next. This serializes browser access so Playwright sessions don't overlap.

**Repeat for each URL:**
1. `node scripts/pipeline/deep-single-runner.mjs --url <url> --profile chrome-host`
2. Read `output/listings/{slug}.json` + `output/school-metadata/{slug}.json`. Write the eval report (`reports/{N}-{slug}-{YYYY-MM-DD}.md`) and append a tracker row to `data/listings.md`.
3. `node scripts/pipeline/deep-single-final-runner.mjs --report reports/{N}-{slug}-{YYYY-MM-DD}.md --profile chrome-host`

Collect the eval report path and listing URL for each home as you go.

### Axis Agents (batched across all homes)

After all URLs have completed Phases 0–2, launch the three axis agents in **a single message** covering all homes at once, using `subagent_type: sentiment-axis | risk-builder-axis | schools-axis`. Pass every relevant sidecar path — `output/sentiment/{slug}.json`, `output/construction/{slug}.json`, etc. — for the full set of homes. The hybrid contract still applies: sidecar-first, Playwright MCP fallback only when a sidecar is missing.

### Briefs, PDFs, and Tabs

For each home (using the axis agent outputs):

1. Write the deep brief: `reports/{slug}-deep-{YYYY-MM-DD}.md`

After all briefs are written, replace the browser tabs with all listing URLs first:
```
node scripts/browser/review-tabs.mjs urls <url1> <url2> ... --replace
```

Then render **one combined briefing PDF** covering all homes and open it in the hosted session:
```
node scripts/reports/briefing-pdf.mjs --reports reports/{slug1}-deep-{YYYY-MM-DD}.md,reports/{slug2}-deep-{YYYY-MM-DD}.md,...
```
`briefing-pdf.mjs` renders the combined PDF to `output/briefings/url-deep-{YYYY-MM-DD}.pdf` and opens it as a new CDP tab automatically. Running it after `--replace` means the PDF tab is added into the already-clean session.

**Do NOT use raw Playwright scripts to open PDF tabs.** Always use `briefing-pdf.mjs`.

**Final tab state: exactly N+1 tabs** — N listing URLs + 1 combined briefing PDF.

Post a final summary: all eval report paths, all brief paths, the combined briefing PDF path, and the N+1-tab final state.

---

## Batch Deep Run (`/home-ops deep` — shortlist or top-N cohort)

### Target Resolution

1. Read `data/shortlist.md` and use the populated top-10 rows as the target set. Accept cohorts from either `evaluate` or `compare`. If empty, ask the user what set to use.
2. Load existing evaluation reports for those homes. If any are missing, run `evaluate` first.
3. Run `scripts/research/research-coverage-audit.mjs` against the shortlisted reports so deep knows which homes have weak evidence.

### Phase A — Deterministic Capture (no agents)

**Steps 4a–4h run concurrently.** Use `run_in_background` Bash calls or `Start-Job` on Windows PowerShell. Wait for all to finish before Phase B.

All steps use `--shortlist`.

- **4a:** `node scripts/research/research-source-plan.mjs --shortlist --type all`
- **4b:** `node scripts/research/community-lookup.mjs --shortlist --profile chrome-host`
- **4c:** `node scripts/research/sentiment-browser-extract.mjs --shortlist --profile chrome-host --concurrency 4` (add `--quick` when shortlist has 5+ homes)
- **4d:** `node scripts/research/sentiment-public-extract.mjs --shortlist`
- **4e:** `node scripts/research/construction-check.mjs --shortlist` (add `--quick` when requested)
- **4f:** `node scripts/research/county-permits-check.mjs --shortlist`
- **4g:** `node scripts/research/school-metadata-fetch.mjs --shortlist --profile chrome-host`
- **4h:** `node scripts/research/builder-check.mjs --shortlist`

5. Wait for all Phase A jobs to finish. Surface any failures in the brief rather than silently proceeding.

6. Run `node scripts/research/deep-research-packet.mjs --shortlist` — one packet per home under `output/deep-packets/{slug}.json`.

### Phase B — Three Axis Agents

Launch the three axis agents in **a single message with three Agent tool calls** so the runtime fans them out in parallel, using the named subagents:

- `subagent_type: sentiment-axis`
- `subagent_type: risk-builder-axis`
- `subagent_type: schools-axis`

The agents read pre-written JSON sidecars first. They MAY use Playwright MCP only as a targeted fallback when a specific sidecar is missing or empty. They MUST NOT use WebFetch, WebSearch, or any other MCP server.

**7. Sentiment Agent.** Inputs: every `output/sentiment/{slug}.json`, buyer profile weights, deal_breakers, commute destinations. Output per home:
- `sentimentScores` keyed by dimension (`crime_safety`, `traffic_commute`, `community`, `livability`) with each entry containing `score` (signed, weight-applied), `signalDirection`, `evidenceCount`, `proximityMix`, and 2–3 raw `quotes`.
- `redFlagsTriggered`: deal-breaker phrases that matched any snippet.
- `sourceCoverage` per source using `captured`, `blocked`, `no-community-match`, `skipped-by-profile`, or `missing`.
- `confidence` — `high` / `medium` / `low`.

**8. Risk & Builder Quality Agent.** Inputs: every `output/construction/{slug}.json`, `output/permits/{slug}.json`, `output/builder/{slug}.json`. Output per home:
- `riskLevel` — `low` / `moderate` / `high`.
- `nearbyProjects`: most relevant matches from construction + permits, each with description, source, status, distance.
- `pressureBreakdown`: NCDOT + county-permit contribution.
- `resaleRiskNote`: one paragraph.
- When builder found: `builderName`, `builderOverallScore`, `builderQualityNote`, `builderRiskContribution`.
- When no builder: omit builder fields; record gap in `sourceCoverage`.

**9. Schools Agent.** Inputs: every `output/school-metadata/{slug}.json`. Output per home:
- `schools`: array per assigned school with name, gradeLevel, rating, enrollment, studentTeacherRatio, ethnicityDistribution, and a mismatch note.
- `weightedSchoolScore`: normalized 0–1 × `profile.sentiment.weights.schools`.
- `flags`: enrollment trending up sharply, ratio above district mean, rating below buyer minimum.

**Hybrid input contract:** axis agents read pre-written JSON sidecars first. If a sidecar is missing or empty, an agent MAY re-run the relevant capture script (e.g. `sentiment-public-extract.mjs`, `construction-check.mjs`, `school-metadata-fetch.mjs`) with `--profile chrome-host` to reach the user's established hosted session. WebFetch, WebSearch, MCP servers, and launching a new browser are all forbidden — only the capture scripts with `--profile chrome-host` are a valid fallback. Each datapoint is tagged with `source: "sidecar" | "fallback-capture"`. If the sidecar AND the fallback capture both fail, record `status: "missing-input"` and continue.

### Phase C — Main Agent Synthesis

10. Stream axis agent results back as they land. Do not wait for the slowest agent before starting the brief skeleton.

11. Review all three axis outputs with the deep packets and evaluation reports. Resolve conflicts.

12. Write the combined brief to `reports/deep-shortlist-{YYYY-MM-DD}.md`.

13. Update `data/shortlist.md` with deep batch status, the report path, and the refined top 3.

14. Rerank the top-10 cohort using axis agent outputs, deep packets, and audit gaps. `riskLevel: "high"` depresses rank unless matches are clearly benign. Schools score × schools weight contributes to rerank. Builder quality feeds through `builderRiskContribution`.

15. Run `node scripts/research/shortlist-finalist-gate.mjs`. If the gate passes, continue. If it fails, surface the blockers, ask once about bypass, continue based on the answer.

16. Render the briefing PDF:
    ```
    node scripts/reports/briefing-pdf.mjs
    ```
    PDF lands at `output/briefings/top3-briefing-{YYYY-MM-DD}.pdf`.

17. Replace browser tabs with the top-3 finalists, then open the PDF last:
    ```
    node scripts/browser/review-tabs.mjs shortlist-top3 --replace
    ```
    Then open the briefing PDF tab in the hosted session (PDF must be opened **after** `--replace`).

    **Final tab state: exactly 4 tabs** — three finalist listings + briefing PDF.

Post a final summary: brief path, finalist gate result, briefing PDF path, and the 4-tab final state.

---

## Research Axes (for the brief content)

Organize the brief around these seven sections — single-home and batch alike:

1. Immediate Area and Neighborhood Identity
2. School Ecosystem
3. Development Pipeline and Future Change
4. Commute and Daily Convenience
5. Risk Review (including Builder Quality when applicable)
6. Resale Outlook
7. Buyer-Specific Verdict

**Quick mode (when `--quick` was passed in Phase A):** focus on axes 1, 3, 5, and 7. Axes 2, 4, and 6 can be filled in a second targeted pass.

## What to Research per Axis

### 1. Immediate Area and Neighborhood Identity
Sentiment Agent's `sentimentScores.community`, `sentimentScores.livability`, and `redFlagsTriggered` drive this section. Quote 2–3 raw snippets per home. Note Twitter signal separately when it contributed.

### 2. School Ecosystem
Schools Agent output. Include the metadata table and any flags about ratings drift, enrollment, or deal-breaker mismatches.

### 3. Development Pipeline and Future Change
Risk & Builder Quality Agent output. Combine NCDOT + county permits. Always cite specific case IDs and project descriptions when present in `output/permits/`.

Use this evidence ladder for construction and permit research:

1. **Spatial official data first.** Start with `output/construction/{slug}.json` and `output/permits/{slug}.json`, because those are address-geocoded radius checks. Prefer official GIS feature matches over keyword web results.
2. **Transportation projects.** Treat NCDOT STIP point/line matches as the transportation backbone. Record TIP/SPOT ID, route, description, right-of-way year, construction year, phase/comment, and whether the project is immediate-road, same-town, or broader-corridor pressure.
3. **County planning and permits.** Treat county GIS matches as nearby land-use pressure. Record case/permit ID, project or subdivision name, status, lots/acres when present, date, and approximate radius. If `county-permits-check` returns `unsupported-county`, run `npm.cmd run permits:discover -- --county <county> --base-url <arcgis-rest-base>` after finding the official county ArcGIS REST catalog.
4. **Municipal development maps.** Read `output/development-sources.json` for profile-selected municipal development maps or project lists. For Apex, Holly Springs, Fuquay-Varina, Cary, and similar towns, use those official maps to validate whether a nearby project is proposed, approved, under construction, or complete. This is especially important when county GIS is thin or when the address sits inside municipal planning jurisdiction.
5. **Property permit history for the specific home.** Use `output/development-sources.json` `propertyPermitSources` and the per-home `sourcePlans.development.propertyPermitGuides` in `output/deep-packets/{slug}.json` to surface official permit-history lookup links and buyer-facing instructions. This is distinct from nearby development pressure. Search by service address first, then permit number, PIN/parcel, and owner if the portal supports it. If the portal exposes builder, contractor, applicant, developer, or owner fields, use those as potential builder-detection evidence and cite the permit portal/case. If the portal is too brittle to automate, include the official link and a short "how to search this home" blurb instead of claiming a result.
6. **Parcel/project detail lookup.** When a map match is material, search by address, parcel/PIN, subdivision name, case ID, and nearby road/intersection. Avoid relying on address-only search because large developments often use parent parcels, project names, or intersections instead of the listing address.
7. **Fallback narrative sources.** Use news, agendas, public-hearing packets, MPO/CIP pages, and neighborhood posts only to explain context after the official project match is identified. If no official spatial match exists, classify narrative-only evidence as lower confidence.

Report permit/construction findings as one of:
- `none found`: official spatial sources checked and returned no material nearby matches.
- `low`: small, completed, pedestrian, signal, or routine projects unlikely to change daily life.
- `moderate`: active or approved projects that may affect traffic, school capacity, resale, or neighborhood character.
- `high`: road widening, interchange, large subdivision, industrial/commercial expansion, or multiple active projects close enough to affect the home.

Never describe the area as clear of construction risk when NCDOT, county GIS, or municipal project sources were unreachable. Mark it as `unconfirmed`.

### 4. Commute and Daily Convenience
Sentiment Agent's `traffic_commute` dimension (Google Maps / construction signals). Cross-reference with buyer commute destinations from `config/profile.yml`.

### 5. Risk Review (including Builder Quality)
Combine: Risk & Builder Quality Agent's high-pressure projects, builder quality note, Sentiment Agent's red flags, and audit blockers from the deep packet. When builder data is present, lead with the builder verdict before development risk.

### 6. Resale Outlook
Use the rerank logic. Explain how each axis pushed the home up or down vs. the original evaluation order.

### 7. Buyer-Specific Verdict
Per-home: does this fit the buyer's stated priorities, and what would need in-person validation before moving forward.

## Output Style

- Prefer a direct research brief over a generic prompt.
- Distinguish clearly between evidence, inference, and unresolved questions.
- Include a per-home source-coverage ledger at the top of each home's section showing what was captured, blocked, or missing.
- If sentiment, construction, permits, school metadata, or builder files are missing for a home, say that directly and lower confidence — do not paper over the gap.
- Persist the refined top 3 back into `data/shortlist.md` after writing the batch brief.
- **Single-home final state: exactly 2 tabs** (listing URL + briefing PDF). Open the PDF last.
- **Batch final state: exactly 4 tabs** (three finalists + briefing PDF). Open the PDF last.
