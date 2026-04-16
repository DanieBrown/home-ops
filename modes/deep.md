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

## Shortlist Batch Branch

When the user asks for a batch deep dive on the shortlist, or when the latest compare workflow clearly established a compare top 10 cohort:

1. Read `data/shortlist.md` and use the populated rows in the current compare shortlist table as the target set.
2. Load the existing evaluation reports for those same shortlisted homes.
3. Research each home across all deep-dive axes below.
4. Write one batch brief to `reports/deep-shortlist-{YYYY-MM-DD}.md`.
5. Update `data/shortlist.md` with:
	- deep batch status
	- deep batch report path
	- refined top 3 after deeper research
6. End by rerunning the compare framework across that same shortlist using the new deep findings and narrow it to the best three homes, not just the original evaluation summaries.
7. Open the direct listing URL for each home in the refined top 3 in its own browser tab so the user can review the finalists immediately. Prefer the listing URL from the underlying report. If a direct listing URL is unavailable, open the report file instead.

If any tagged shortlist home has not been fully evaluated yet, run the evaluate workflow first before doing the deep batch. If the shortlist contains fewer than ten populated viable homes, research only the populated rows and say that the current shortlist is smaller than ten.

## Research Axes

Organize the deep dive around these sections:

1. Immediate Area and Neighborhood Identity
2. School Ecosystem
3. Development Pipeline and Future Change
4. Commute and Daily Convenience
5. Risk Review
6. Resale Outlook
7. Buyer-Specific Verdict

## What to Research

### 1. Immediate Area and Neighborhood Identity
- subdivision reputation if identifiable
- street character and traffic feel
- family-friendliness and community feel
- recurring praise or complaints from locals

### 2. School Ecosystem
- assigned schools and ratings
- parent sentiment patterns
- school-crowding or redistricting concerns
- extracurricular or support-program strength

### 3. Development Pipeline and Future Change
- nearby subdivisions or rezoning
- commercial growth that could improve or hurt convenience
- road projects and widening plans
- any signs of overbuilding or infrastructure strain

### 4. Commute and Daily Convenience
- access to Raleigh and RTP
- grocery, parks, urgent care, and family amenities
- bottlenecks or road chokepoints

### 5. Risk Review
- flood or drainage issues
- road noise
- adjacency to unattractive uses
- HOA or municipal-service concerns

### 6. Resale Outlook
- likely buyer appeal in 3 to 7 years
- whether the home type and area should remain liquid
- risks that could hurt future marketability

### 7. Buyer-Specific Verdict
- why this area does or does not fit Daniel's stated priorities
- what would need to be validated in person before moving forward

## Output Requirements For Shortlist Batches

When deep mode is operating on the current compare shortlist, the final brief should contain:

1. Per-home deep findings for the shortlisted set
2. Cross-home risk comparison
3. Deep-adjusted top 3
4. Best fit after deeper research
5. Runner-up after deeper research
6. Why the homes outside the refined top 3 fell back
7. What changed from the original compare result

## Output Style

- Prefer a direct research brief over a generic prompt.
- If the user explicitly asks for a reusable prompt, provide one tailored to the address or area.
- Distinguish clearly between evidence, inference, and unresolved questions.
- When running the shortlist batch branch, persist the refined top 3 back into `data/shortlist.md` after writing the batch brief.
- When the shortlist batch branch finishes, the refined top 3 should also be open in separate browser tabs for review.
