# Evaluate Worker Contract

Use this contract when the main Home-Ops evaluate flow hands one canonical property to the evaluate worker.

The contract has two parts:
- the evidence packet sent to the worker
- the structured result returned by the worker

The unit of work is always one physical home.

## Evidence Packet Schema

Provide one packet per canonical property.

### Required Fields

| Field | Type | Notes |
|---|---|---|
| `assignment_id` | string | Stable ID for this worker invocation |
| `property_key` | string | Normalized address + city key for the physical home |
| `address` | object | Canonical address fields for the home |
| `listing` | object | Normalized listing facts |
| `verification` | object | Active, sold, pending, unavailable, or unconfirmed result |
| `buyer_context` | object | The buyer rules needed for gating and scoring |
| `evidence` | object | Neighborhood, school, development, and financial evidence gathered so far |

### Optional Fields

| Field | Type | Notes |
|---|---|---|
| `primary_url` | string | Main listing URL used for the first pass |
| `fallback_urls` | string[] | Alternate URLs for the same home only |
| `source_plan` | object | Concrete targets produced by `research-source-plan.mjs` |
| `existing_context` | object | Prior report, tracker row, or shortlist context |
| `notes_for_worker` | string | Parent-agent instructions specific to this home |

### Address Object

```json
{
  "street": "200 Meadowcrest Pl",
  "city": "Holly Springs",
  "state": "NC",
  "postal_code": "27540",
  "county": "Wake"
}
```

### Listing Object

Use normalized values where possible.

```json
{
  "source": "Zillow",
  "price": 615000,
  "beds": 4,
  "baths": 3.5,
  "sqft": 3120,
  "lot_size": "0.24 acres",
  "garage_spaces": 2,
  "hoa": 85,
  "year_built": 2018,
  "days_on_market": 6,
  "property_type": "Single Family"
}
```

### Verification Object

`status` must be one of:
- `active`
- `sold`
- `pending`
- `unavailable`
- `unconfirmed`
- `blocked`

```json
{
  "status": "active",
  "confidence": "High",
  "summary": "Address, price, gallery, and tour controls visible on the listing page.",
  "checked_from": "Zillow"
}
```

### Buyer Context Object

Include only the worker-relevant subset, not the full raw files.

```json
{
  "hard_requirements": {
    "price_max": 650000,
    "beds_min": 4,
    "garage_min": 2,
    "sqft_min": 2800,
    "days_on_market_max": 45
  },
  "deal_breakers": ["busy road", "flood risk"],
  "weights": {
    "property_fit": 0.35,
    "neighborhood_sentiment": 0.25,
    "school_sentiment": 0.20,
    "financial_fit": 0.10,
    "resale_risk": 0.10
  },
  "financial_assumptions": {
    "down_payment_pct": 20,
    "loan_type": "30-year fixed"
  }
}
```

### Evidence Object

Keep this split by evidence class so gaps remain visible.

```json
{
  "property": ["Two-story resale with fenced backyard and first-floor guest suite."],
  "neighborhood": ["Mostly positive subdivision-level comments about walkability and family feel."],
  "schools": ["Assigned schools meet threshold on GreatSchools and NC report card growth data."],
  "development": ["No major rezoning found nearby; one NCDOT widening project 6 miles away."],
  "financial": ["Estimated monthly cost fits budget range assuming 20% down."],
  "gaps": ["No fresh Facebook group evidence available this run."]
}
```

## Structured Result Schema

The worker returns one markdown result bundle with two sections:
- `## Report Draft`
- `## Structured Result`

### Required Fields

| Field | Type | Notes |
|---|---|---|
| `property_key` | string | Must match the incoming packet |
| `score` | string | Format `n.n/5` |
| `recommendation` | string | One approved Home-Ops phrase |
| `confidence` | string | `High`, `Medium`, or `Low` |
| `suggested_status` | string | `Sold`, `SKIP`, or `Evaluated` unless caller asked for a different workflow |
| `tracker_note` | string | One concise sentence |
| `evidence_gaps` | string[] | Explicit missing or weak evidence |
| `sources_used` | string[] | Sources actually used in the draft |
| `report_draft` | markdown | Full Home-Ops report draft |

### Optional Fields

| Field | Type | Notes |
|---|---|---|
| `shortlist_rationale` | string | Present only when the home is viable |
| `open_questions` | string[] | Useful unresolved checks for the main agent |
| `primary_risks` | string[] | Top risks that should surface in the batch summary |

### Recommendation Values

Use exactly one:
- `Pursue now`
- `Worth touring`
- `Hold pending validation`
- `Pass`

### Suggested Status Rules

- Use `Sold` when verification shows the listing is no longer available.
- Use `SKIP` when the home is clearly a poor fit or the recommendation is `Pass`.
- Use `Evaluated` for completed review drafts that remain viable or need user review.

### Result Example

```markdown
## Report Draft
# 200 Meadowcrest Pl - Holly Springs, NC

...full report...

## Structured Result
- Property Key: 200 meadowcrest pl|holly springs
- Score: 4.2/5
- Recommendation: Worth touring
- Confidence: Medium
- Suggested Status: Evaluated
- Tracker Note: Strong resale-fit home with solid schools and only modest development risk.
- Shortlist Rationale: Balanced fit across schools, layout, and neighborhood signal.
- Evidence Gaps:
  - No direct Facebook group evidence from the last 7 days.
- Sources Used:
  - Zillow listing page
  - GreatSchools
  - NC School Report Cards
  - NCDOT project map
```

## Guardrails

- The packet must describe one home only.
- Alternate URLs must point to the same physical property.
- Missing evidence must stay visible in `evidence.gaps` and in the returned `Evidence Gaps` list.
- The worker must not upgrade blocked or unconfirmed verification into `active`.
- The worker must not return tracker states outside the canonical evaluate flow unless the caller explicitly asked.
- The report draft must keep the standard Home-Ops section order.