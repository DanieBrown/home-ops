#!/usr/bin/env python3
"""
school_metadata_crawl.py -- crawl4ai-backed Niche school extractor.

Pilot integration replacing the raw fetch() path inside
scripts/research/school-metadata-fetch.mjs. The Node orchestrator spawns this
script per assigned school. Stdout is exactly one JSON object.

Soft failures (page unreachable, schema empty) exit 0 with {"error": "..."}.
Hard environment failures (crawl4ai not installed, browsers missing) exit 2.

Output shape mirrors the JS parseSchoolFromHtml() return so the Node merge
layer is unchanged.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from typing import Any

# Windows consoles default to cp1252 and crawl4ai's progress UI prints non-ASCII
# arrows. Force UTF-8 on stdout/stderr so those writes don't crash the worker.
for _stream in ("stdout", "stderr"):
    _io = getattr(sys, _stream, None)
    if _io is not None and hasattr(_io, "reconfigure"):
        try:
            _io.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
os.environ.setdefault("PYTHONIOENCODING", "utf-8")


GRADE_LETTERS = {
    "aplus": "A+", "a": "A", "aminus": "A-",
    "bplus": "B+", "b": "B", "bminus": "B-",
    "cplus": "C+", "c": "C", "cminus": "C-",
    "dplus": "D+", "d": "D", "dminus": "D-",
    "f": "F",
}

GRADE_PATTERNS = (
    ("elementary", re.compile(r"elementary", re.IGNORECASE)),
    ("middle", re.compile(r"middle", re.IGNORECASE)),
    ("high", re.compile(r"\bhigh\b", re.IGNORECASE)),
)


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def hard_fail(reason: str) -> "te.NoReturn":
    sys.stderr.write(f"{reason}\n")
    sys.exit(2)


def niche_slug(value: str) -> str:
    lowered = value.lower().replace("&", " and ")
    cleaned = re.sub(r"[^a-z0-9]+", "-", lowered)
    return cleaned.strip("-")


def build_niche_urls(school: str, city: str, state: str) -> list[str]:
    has_school_suffix = bool(re.search(r"\bschool\b", school, re.IGNORECASE))
    stripped = re.sub(r"\bschool\b", "", school, flags=re.IGNORECASE).strip()
    variants = [school]
    # Strip "School" when present — Niche sometimes drops it for elementary slugs.
    if stripped and stripped.lower() != school.lower():
        variants.append(stripped)
    # Append "School" when missing — Niche often requires it for middle/high
    # (e.g. "Holly Grove Middle" 404s; "Holly Grove Middle School" resolves).
    if not has_school_suffix:
        variants.append(f"{school} School")
    state_slug = (state or "NC").lower()
    city_slug = niche_slug(city)
    seen: set[str] = set()
    urls: list[str] = []
    for variant in variants:
        slug = f"{niche_slug(variant)}-{city_slug}-{state_slug}"
        if slug in seen:
            continue
        seen.add(slug)
        urls.append(f"https://www.niche.com/k12/{slug}/")
    return urls


def infer_grade_level(name: str) -> str | None:
    for grade, pattern in GRADE_PATTERNS:
        if pattern.search(name):
            return grade
    return None


def decode_json_string(value: str) -> str:
    return value.replace(r"/", "/").replace(r"\"", '"')


def extract_overall_grade(html: str) -> dict[str, str] | None:
    match = re.search(
        r"overall-grade__niche-grade[\s\S]{0,400}?niche__grade--([a-z]+)",
        html,
    )
    if not match:
        return None
    class_key = match.group(1)
    letter = GRADE_LETTERS.get(class_key)
    if not letter:
        return None
    return {"letter": letter, "classKey": class_key}


def extract_fact_by_label(html: str, label: str) -> Any:
    """Mirror of the JS extractFactByLabel — pulls the first
    "label":"X","value":Z triple out of Niche's embedded JSON blob.
    """
    escaped = re.escape(label)
    pattern = re.compile(
        rf'"label":"{escaped}"(?:[^{{}}]{{0,200}})"value":'
        r'(?:"([^"]*)"|([0-9.]+)|(\{[^{}]+\})|(null))'
    )
    match = pattern.search(html)
    if not match:
        return None
    if match.group(1) is not None:
        return decode_json_string(match.group(1))
    if match.group(2) is not None:
        try:
            return float(match.group(2)) if "." in match.group(2) else int(match.group(2))
        except ValueError:
            return None
    if match.group(3) is not None:
        try:
            return json.loads(match.group(3))
        except json.JSONDecodeError:
            return None
    return None


def as_percent(value: Any) -> float | None:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return round(numeric * 1000) / 10


def parse_decimal_object(obj: Any) -> dict[str, str] | None:
    if not isinstance(obj, dict):
        return None
    result: dict[str, str] = {}
    for key, value in obj.items():
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            continue
        result[key] = f"{round(numeric * 1000) / 10}%"
    return result or None


def parse_school_from_html(html: str, name: str, source_url: str) -> dict[str, Any]:
    overall = extract_overall_grade(html)

    sub_grade_keys = {
        "academics": "Academics",
        "teachers": "Teachers",
        "diversity": "Diversity",
        "collegePrep": "College Prep",
        "clubs": "Clubs & Activities",
        "sports": "Sports",
        "healthSafety": "Health & Safety",
    }
    sub_grades: dict[str, Any] = {}
    for camel, label in sub_grade_keys.items():
        value = extract_fact_by_label(html, label)
        if isinstance(value, (int, float)):
            sub_grades[camel] = value

    enrollment = extract_fact_by_label(html, "Students")
    ratio_raw = extract_fact_by_label(html, "Student-Teacher Ratio")
    ratio = f"{ratio_raw}:1" if isinstance(ratio_raw, (int, float)) else None
    free_reduced = extract_fact_by_label(html, "Free or Reduced Lunch")
    proficient_math = extract_fact_by_label(html, "Percent Proficient - Math")
    proficient_reading = extract_fact_by_label(html, "Percent Proficient - Reading")
    salary = extract_fact_by_label(html, "Average Teacher Salary")
    grades_label = extract_fact_by_label(html, "Grades")
    diversity_raw = extract_fact_by_label(html, "Student Diversity")
    gender_raw = extract_fact_by_label(html, "Gender")

    return {
        "name": name,
        "gradeLevel": grades_label if isinstance(grades_label, str) else infer_grade_level(name),
        "url": source_url,
        "source": "niche.com",
        "nicheGrade": overall,
        "subGrades": sub_grades or None,
        "enrollment": enrollment if isinstance(enrollment, (int, float)) else None,
        "studentTeacherRatio": ratio,
        "freeReducedLunchPct": as_percent(free_reduced),
        "percentProficient": {
            "math": as_percent(proficient_math),
            "reading": as_percent(proficient_reading),
        },
        "averageTeacherSalary": salary if isinstance(salary, (int, float)) else None,
        "ethnicityDistribution": parse_decimal_object(diversity_raw),
        "genderDistribution": parse_decimal_object(gender_raw),
        "greatSchoolsRating": None,
        "stateRating": None,
        "captureStatus": "captured" if overall else "parse-failed",
    }


async def crawl_one(crawler: Any, url: str, run_config: Any) -> tuple[bool, str, str]:
    """Fetch a single URL through the supplied crawler. Returns
    (success, html, final_url)."""
    try:
        result = await crawler.arun(url=url, config=run_config)
    except Exception as exc:  # crawl4ai surfaces its own exceptions
        sys.stderr.write(f"crawl4ai run failed for {url}: {exc}\n")
        return False, "", url
    if not getattr(result, "success", False):
        return False, "", url
    html = getattr(result, "html", "") or getattr(result, "cleaned_html", "") or ""
    final_url = getattr(result, "url", url) or url
    return True, html, final_url


async def capture(school: str, city: str, state: str, profile_dir: str) -> dict[str, Any]:
    try:
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig
    except ImportError:
        hard_fail("crawl4ai-not-installed (pip install -r scripts/research/python/requirements.txt && crawl4ai-setup)")

    urls = build_niche_urls(school, city, state)
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
            for url in urls:
                ok, html, final_url = await crawl_one(crawler, url, run_config)
                if not ok or not html:
                    continue
                if "overall-grade__niche-grade" not in html:
                    continue
                parsed = parse_school_from_html(html, school, final_url)
                parsed["attemptedUrls"] = urls
                parsed["finalUrl"] = final_url
                parsed["provider"] = "crawl4ai"
                return parsed
    except Exception as exc:
        hint = str(exc)
        if "Executable doesn" in hint or "playwright" in hint.lower():
            hard_fail("playwright-browsers-missing (run: crawl4ai-setup)")
        sys.stderr.write(f"crawl4ai session error: {exc}\n")

    return {"error": "all-candidates-failed", "attempted": urls}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Niche school metadata extractor (crawl4ai).")
    parser.add_argument("--school", required=True, help="Assigned school name as written in the listing.")
    parser.add_argument("--city", required=True, help="City of the home being scored.")
    parser.add_argument("--state", default="NC", help="State abbreviation (default NC).")
    parser.add_argument("--profile-dir", default="output/crawl4ai-profile", help="Persistent stealth profile path.")
    parser.add_argument("--json", action="store_true", help="Always emit JSON (default behavior; flag accepted for parity with the Node side).")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    record = asyncio.run(capture(args.school, args.city, args.state, args.profile_dir))
    emit(record)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
