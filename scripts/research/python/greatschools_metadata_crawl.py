#!/usr/bin/env python3
"""
greatschools_metadata_crawl.py -- crawl4ai-backed GreatSchools school extractor.

The Node orchestrator spawns this script per assigned school. Stdout is exactly
one JSON object, shaped like school-metadata-fetch.mjs enrichment records.
Soft failures exit 0 with {"error": "..."}; hard environment failures exit 2.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from typing import Any
from urllib.parse import urlencode

for _stream in ("stdout", "stderr"):
    _io = getattr(sys, _stream, None)
    if _io is not None and hasattr(_io, "reconfigure"):
        try:
            _io.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
os.environ.setdefault("PYTHONIOENCODING", "utf-8")


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def hard_fail(reason: str) -> "te.NoReturn":
    sys.stderr.write(f"{reason}\n")
    sys.exit(2)


def build_search_url(school: str, state: str) -> str:
    params = urlencode({"q": school, "state": state or "NC"})
    return f"https://www.greatschools.org/search/search.page?{params}"


def normalize_name(value: str) -> str:
    cleaned = re.sub(r"\bschool\b", "", value or "", flags=re.IGNORECASE)
    cleaned = re.sub(r"[^a-z0-9]+", " ", cleaned.lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def level_from_code(value: Any) -> str | None:
    text = str(value or "").lower()
    if text == "e" or "elementary" in text:
        return "elementary"
    if text == "m" or "middle" in text:
        return "middle"
    if text == "h" or "high" in text:
        return "high"
    return None


def extract_search_payload(html: str) -> dict[str, Any] | None:
    match = re.search(r"gon\.search=(\{[\s\S]*?\});gon\.event_tracker_page_data=", html)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return None


def pick_school(schools: list[dict[str, Any]], wanted_name: str) -> dict[str, Any] | None:
    wanted = normalize_name(wanted_name)
    if not wanted:
        return schools[0] if schools else None

    best: tuple[int, dict[str, Any]] | None = None
    for school in schools:
        candidate = normalize_name(str(school.get("name") or ""))
        if not candidate:
            continue
        score = 0
        if candidate == wanted:
            score += 100
        elif wanted in candidate or candidate in wanted:
            score += 75
        wanted_tokens = set(wanted.split())
        candidate_tokens = set(candidate.split())
        if wanted_tokens and candidate_tokens:
            score += int(25 * len(wanted_tokens & candidate_tokens) / len(wanted_tokens | candidate_tokens))
        if school.get("type") == "school":
            score += 5
        if best is None or score > best[0]:
            best = (score, school)
    if best and best[0] >= 40:
        return best[1]
    return None


def pct_string(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text if text.endswith("%") else f"{text}%"


def camel_key(value: str) -> str:
    words = re.findall(r"[a-zA-Z0-9]+", value or "")
    if not words:
        return ""
    first, *rest = words
    return first[0].lower() + first[1:] + "".join(word[:1].upper() + word[1:] for word in rest)


def profile_url(path: str | None) -> str | None:
    if not path:
        return None
    if path.startswith("http"):
        return path
    return f"https://www.greatschools.org{path}"


def normalize_school_record(raw: dict[str, Any], school_name: str, search_url: str) -> dict[str, Any]:
    url = profile_url((raw.get("links") or {}).get("profile"))
    ethnicity: dict[str, str] = {}
    free_reduced = None
    for entry in raw.get("ethnicityInfo") or []:
        label = str(entry.get("label") or "").strip()
        percentage = pct_string(entry.get("percentage"))
        if not label or not percentage:
            continue
        if label.lower() == "low-income":
            free_reduced = percentage
            continue
        if label.lower() == "all students":
            continue
        ethnicity[label] = percentage

    subratings: dict[str, Any] = {}
    for label, value in (raw.get("subratings") or {}).items():
        key = camel_key(str(label).replace(" Rating", ""))
        if key:
            subratings[key] = value

    students_per_teacher = raw.get("studentsPerTeacher")
    ratio = f"{students_per_teacher}:1" if isinstance(students_per_teacher, (int, float)) else None
    rating = raw.get("rating")

    return {
        "name": str(raw.get("name") or school_name),
        "gradeLevel": raw.get("gradeLevels") or level_from_code(raw.get("levelCode")),
        "level": level_from_code(raw.get("levelCode") or raw.get("gradeLevels")),
        "district": raw.get("districtName"),
        "url": url or search_url,
        "source": "greatschools",
        "greatSchoolsRating": rating if isinstance(rating, (int, float)) else None,
        "greatSchoolsRatingScale": raw.get("ratingScale"),
        "nicheGrade": None,
        "subGrades": None,
        "greatSchoolsSubratings": subratings or None,
        "enrollment": raw.get("enrollment") if isinstance(raw.get("enrollment"), (int, float)) else None,
        "studentTeacherRatio": ratio,
        "freeReducedLunchPct": free_reduced,
        "percentProficient": {"math": None, "reading": None},
        "averageTeacherSalary": None,
        "ethnicityDistribution": ethnicity or None,
        "genderDistribution": None,
        "stateRating": None,
        "captureStatus": "captured" if url and (rating is not None or raw.get("enrollment") is not None) else "parse-failed",
        "attemptedUrls": [search_url] + ([url] if url else []),
        "finalUrl": url or search_url,
        "provider": "crawl4ai",
    }


async def crawl_one(crawler: Any, url: str, run_config: Any) -> tuple[bool, str, str]:
    try:
        result = await crawler.arun(url=url, config=run_config)
    except Exception as exc:
        sys.stderr.write(f"crawl4ai run failed for {url}: {exc}\n")
        return False, "", url
    if not getattr(result, "success", False):
        return False, "", url
    html = getattr(result, "html", "") or getattr(result, "cleaned_html", "") or ""
    final_url = getattr(result, "url", url) or url
    return True, html, final_url


async def capture(school: str, state: str, profile_dir: str) -> dict[str, Any]:
    try:
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig
    except ImportError:
        hard_fail("crawl4ai-not-installed (pip install -r scripts/research/python/requirements.txt && crawl4ai-setup)")

    search_url = build_search_url(school, state)
    browser_config = BrowserConfig(
        headless=True,
        user_data_dir=profile_dir,
        verbose=False,
    )
    run_config = CrawlerRunConfig(
        page_timeout=25000,
        wait_until="domcontentloaded",
        verbose=False,
        stream=False,
    )

    try:
        async with AsyncWebCrawler(config=browser_config) as crawler:
            ok, html, final_url = await crawl_one(crawler, search_url, run_config)
            if not ok or not html:
                return {"error": "search-fetch-failed", "attempted": [search_url]}
            if re.search(r"access to this page has been denied|captcha|are you a human", html, re.IGNORECASE):
                return {"error": "blocked", "attempted": [search_url]}
            payload = extract_search_payload(html)
            if not payload or not isinstance(payload.get("schools"), list):
                return {"error": "search-payload-missing", "attempted": [search_url], "finalUrl": final_url}
            picked = pick_school(payload["schools"], school)
            if not picked:
                return {"error": "school-not-found", "attempted": [search_url], "finalUrl": final_url}
            return normalize_school_record(picked, school, search_url)
    except Exception as exc:
        hint = str(exc)
        if "Executable doesn" in hint or "playwright" in hint.lower():
            hard_fail("playwright-browsers-missing (run: crawl4ai-setup)")
        sys.stderr.write(f"crawl4ai session error: {exc}\n")

    return {"error": "crawl-failed", "attempted": [search_url]}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GreatSchools school metadata extractor (crawl4ai).")
    parser.add_argument("--school", required=True, help="Assigned school name.")
    parser.add_argument("--city", default="", help="Accepted for parity with the Node side; not required for matching.")
    parser.add_argument("--state", default="NC", help="State abbreviation (default NC).")
    parser.add_argument("--profile-dir", default="output/crawl4ai-profile", help="Persistent crawl4ai profile path.")
    parser.add_argument("--json", action="store_true", help="Always emit JSON (default behavior; flag accepted for parity).")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    record = asyncio.run(capture(args.school, args.state, args.profile_dir))
    emit(record)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
