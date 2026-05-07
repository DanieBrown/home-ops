# Python sidecar — crawl4ai-backed extractors

This directory holds Python scripts that the Node-based home-ops pipeline shells
out to when stealth Playwright + schema extraction beats raw `fetch()`.

Currently scoped to these sidecar scripts:

- `school_metadata_crawl.py` — fetches Niche.com school pages and extracts grades,
  enrollment, ratio, proficiency, salary, ethnicity, and gender. Called per school
  by [`scripts/research/school-metadata-fetch.mjs`](../school-metadata-fetch.mjs).
- `crawl4ai_portal_extract.py` — attaches to the existing hosted Chrome CDP
  session and extracts portal search cards or detail-page listing facts for the
  scan, evaluate, and single-listing extraction flows.

If Python or crawl4ai are not available the Node script automatically falls back
to its legacy `fetch()` path. The pipeline degrades; it does not break.

## One-time setup

**Python 3.10+ is required.** crawl4ai 0.6+ does not publish wheels for older
Python; the install will fail with "no matching distribution" if you try to use
3.8 or 3.9.

### Windows

The `py` launcher selects an installed 3.10+ interpreter. Run from the repo
root:

```powershell
py -3 -m pip install -r scripts/research/python/requirements.txt
py -3 -m playwright install chromium
py -3 -m crawl4ai.install
```

If `py -3` resolves to a version older than 3.10, install Python 3.12 from
https://www.python.org/downloads/ and rerun. Verify with `py -3 --version`.

### macOS / Linux

```bash
python3 -m pip install -r scripts/research/python/requirements.txt
python3 -m playwright install chromium
python3 -m crawl4ai.install
```

### Verify

```bash
node scripts/system/doctor.mjs
```

You should see `crawl4ai: ok (school metadata sidecar enabled)`.

The `crawl4ai.install` step provisions the stealth Chromium build (~250MB).
If that step is unavailable in your version, the project also supports
`crawl4ai-setup` as a console script — but on Windows that script lands in
`Scripts\` which may not be on PATH; the `py -3 -m crawl4ai.install` form is
PATH-independent.

## Single-school sanity check

```bash
python scripts/research/python/school_metadata_crawl.py \
  --school "Buckhorn Creek Elementary" \
  --city "Holly Springs" \
  --state "NC" \
  --json
```

Expected: a JSON record on stdout with non-null `nicheGrade.letter`, `enrollment`,
and `studentTeacherRatio`.

## Portal extraction sanity check

The portal sidecar is normally called through Node because the Node bridge reads
the hosted browser CDP URL from `output/browser-sessions/chrome-host/session-state.json`.
For fixture-only parser checks that do not hit a live portal:

```powershell
py -3 scripts/research/python/crawl4ai_portal_extract.py `
  --mode detail `
  --platform realtor `
  --url "https://www.realtor.com/example" `
  --html-file scripts/tests/fixtures/crawl4ai-realtor-detail.html `
  --json
```

Live portal extraction must reuse the hosted browser session created by
`/home-ops init` or `npm.cmd run browser:setup`; blocked or rate-limited portal
responses are reported as `captureStatus: "blocked"` rather than treated as
active listings.

## Output schema

The script prints exactly one JSON object to stdout. On success:

```json
{
  "name": "...",
  "gradeLevel": "elementary|middle|high|null",
  "url": "<final niche url>",
  "source": "niche.com",
  "nicheGrade": { "letter": "A+", "classKey": "aplus" },
  "subGrades": { "academics": "A", "teachers": "B+" },
  "enrollment": 850,
  "studentTeacherRatio": "16:1",
  "freeReducedLunchPct": 23.4,
  "percentProficient": { "math": 71.2, "reading": 68.5 },
  "averageTeacherSalary": 54000,
  "ethnicityDistribution": { "white": "42%" },
  "genderDistribution": { "male": "51%", "female": "49%" },
  "captureStatus": "captured",
  "attemptedUrls": ["https://www.niche.com/k12/..."],
  "finalUrl": "https://www.niche.com/k12/...",
  "provider": "crawl4ai"
}
```

On soft failure (no candidate URL worked or page rendered without expected markup):

```json
{ "error": "all-candidates-failed" | "parse-failed", "attempted": [...] }
```

Soft failures still exit 0 so the orchestrator can keep iterating other schools.

Hard environment failures (crawl4ai not installed, Playwright browsers missing)
exit 2 with a one-line diagnostic on stderr.
