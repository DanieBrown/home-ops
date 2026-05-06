#!/usr/bin/env python3
"""
crawl4ai_page_fetch.py -- small crawl4ai page fetch sidecar.

Stdout is exactly one JSON object:
  { ok, url, finalUrl, status, html, error }

Hard environment failures exit 2 so the Node caller can fall back to its
existing fetch/hosted-browser strategy.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from typing import Any

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


def hard_fail(reason: str) -> "NoReturn":
    sys.stderr.write(f"{reason}\n")
    sys.exit(2)


def looks_blocked(html: str, status: int | None) -> bool:
    if status in (401, 403, 429):
        return True
    return bool(re.search(r"access to this page has been denied|captcha|are you a human|verify you are human", html or "", re.I))


async def capture(url: str, profile_dir: str, timeout_ms: int) -> dict[str, Any]:
    try:
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig
    except ImportError:
        hard_fail("crawl4ai-not-installed")

    browser_config = BrowserConfig(
        headless=True,
        user_data_dir=profile_dir,
        verbose=False,
    )
    run_config = CrawlerRunConfig(
        page_timeout=timeout_ms,
        wait_until="domcontentloaded",
        verbose=False,
        stream=False,
    )

    try:
        async with AsyncWebCrawler(config=browser_config) as crawler:
            result = await crawler.arun(url=url, config=run_config)
    except Exception as exc:
        hint = str(exc)
        if "Executable doesn" in hint or "playwright" in hint.lower():
            hard_fail("playwright-browsers-missing")
        return {"ok": False, "url": url, "finalUrl": url, "status": 0, "html": "", "error": hint}

    html = getattr(result, "html", "") or getattr(result, "cleaned_html", "") or ""
    final_url = getattr(result, "url", url) or url
    status = getattr(result, "status_code", None) or getattr(result, "status", None)
    success = bool(getattr(result, "success", False))
    if looks_blocked(html, status):
        return {
            "ok": False,
            "url": url,
            "finalUrl": final_url,
            "status": status or 403,
            "html": html,
            "error": "blocked",
        }
    if isinstance(status, int) and status >= 400:
        return {
            "ok": False,
            "url": url,
            "finalUrl": final_url,
            "status": status,
            "html": html,
            "error": f"http-{status}",
        }
    return {
        "ok": success and bool(html),
        "url": url,
        "finalUrl": final_url,
        "status": status or (200 if success else 0),
        "html": html,
        "error": None if success and html else "empty-or-failed",
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch one page through crawl4ai.")
    parser.add_argument("--url", required=True)
    parser.add_argument("--profile-dir", default="output/crawl4ai-profile")
    parser.add_argument("--timeout-ms", type=int, default=25000)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    emit(asyncio.run(capture(args.url, args.profile_dir, args.timeout_ms)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
