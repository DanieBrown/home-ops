#!/usr/bin/env python3
"""
crawl4ai_portal_extract.py -- Crawl4AI-backed portal extraction sidecar.

Stdout is exactly one JSON object:
  {
    mode, platform, url, finalUrl, statusCode, captureStatus,
    items, listing, snapshot, notes, error
  }

This script intentionally does not use proxies, captcha solving, or parallel
portal crawling. It either attaches to the existing hosted Chrome CDP endpoint
or parses a local --html-file fixture for tests.
"""

from __future__ import annotations

import argparse
import asyncio
import html as html_lib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

for _stream in ("stdout", "stderr"):
    _io = getattr(sys, _stream, None)
    if _io is not None and hasattr(_io, "reconfigure"):
        try:
            _io.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
os.environ.setdefault("PYTHONIOENCODING", "utf-8")


DETAIL_PATTERNS = {
    "zillow": re.compile(r"/homedetails/", re.I),
    "redfin": re.compile(r"/home/", re.I),
    "realtor": re.compile(r"/realestateandhomes-detail/", re.I),
    "homes": re.compile(r"/property/", re.I),
}

BLOCK_PATTERN = re.compile(
    r"429|access to this page has been denied|verify you are human|"
    r"are you a human|are you a robot|captcha|reference id|"
    r"processing your request|pardon our interruption|request unsuccessful|"
    r"unusual traffic|press\s*&?\s*hold|perimeterx|cloudflare|"
    r"enable javascript and cookies|one more step",
    re.I,
)

INACTIVE_PATTERN = re.compile(
    r"\boff[\s-]?market\b|\bno longer available\b|\bdelisted\b|"
    r"\bwithdrawn\b|\bpending\b|\bunder contract\b|\bcontingent\b|"
    r"\bsold\s+on\b|\bstatus\s*:?\s*sold\b",
    re.I,
)

ACTIVE_PATTERN = re.compile(
    r"\bfor sale\b|\bactive\b|\bschedule\s+(?:a\s+)?tour\b|"
    r"\brequest\s+(?:a\s+)?tour\b|\bcontact\s+(?:agent|realtor|builder)\b|"
    r"\bopen house\b|\bfacts and features\b|\bproperty details\b",
    re.I,
)

FULL_ADDRESS_RE = re.compile(
    r"\b\d{1,5}\s+[^|,\n]+?,\s*[A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5})?\b"
)


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def hard_fail(reason: str) -> "NoReturn":
    sys.stderr.write(f"{reason}\n")
    sys.exit(2)


def normalize_space(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def strip_tags(value: str) -> str:
    text = re.sub(r"(?is)<script\b.*?</script>", " ", value or "")
    text = re.sub(r"(?is)<style\b.*?</style>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return normalize_space(html_lib.unescape(text))


def attrs_from_tag(tag_text: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for match in re.finditer(r"([a-zA-Z_:.-]+)\s*=\s*(['\"])(.*?)\2", tag_text or "", re.S):
        attrs[match.group(1).lower()] = html_lib.unescape(match.group(3))
    return attrs


def first_match(pattern: str, text: str, flags: int = re.I | re.S) -> str:
    match = re.search(pattern, text or "", flags)
    return normalize_space(html_lib.unescape(match.group(1))) if match else ""


def parse_meta(html: str) -> dict[str, str]:
    meta: dict[str, str] = {}
    for match in re.finditer(r"(?is)<meta\b([^>]*)>", html or ""):
        attrs = attrs_from_tag(match.group(1))
        key = attrs.get("property") or attrs.get("name")
        value = attrs.get("content")
        if key and value:
            meta[key] = normalize_space(value)
    return meta


def parse_headings(html: str) -> list[str]:
    headings = []
    for match in re.finditer(r"(?is)<h[12]\b[^>]*>(.*?)</h[12]>", html or ""):
        text = strip_tags(match.group(1))
        if text:
            headings.append(text)
    return headings[:12]


def parse_title(html: str) -> str:
    return first_match(r"<title\b[^>]*>(.*?)</title>", html)


def parse_json_scripts(html: str, *, next_data: bool = False) -> list[Any]:
    scripts: list[Any] = []
    if next_data:
        pattern = r"(?is)<script\b(?=[^>]*\bid\s*=\s*['\"]__NEXT_DATA__['\"])[^>]*>(.*?)</script>"
    else:
        pattern = r"(?is)<script\b(?=[^>]*application/ld\+json)[^>]*>(.*?)</script>"
    for match in re.finditer(pattern, html or ""):
        raw = html_lib.unescape(match.group(1).strip())
        if not raw:
            continue
        try:
            scripts.append(json.loads(raw))
        except Exception:
            continue
    return scripts


def collect_objects(value: Any, out: list[dict[str, Any]], depth: int = 0) -> list[dict[str, Any]]:
    if depth > 18:
        return out
    if isinstance(value, dict):
        out.append(value)
        for child in value.values():
            collect_objects(child, out, depth + 1)
    elif isinstance(value, list):
        for child in value:
            collect_objects(child, out, depth + 1)
    return out


def as_number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        for key in ("value", "amount", "price", "maxValue", "minValue"):
            parsed = as_number(value.get(key))
            if parsed is not None:
                return parsed
        return None
    text = str(value)
    match = re.search(r"-?\d+(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?", text)
    if not match:
        return None
    try:
        return float(match.group(0).replace(",", ""))
    except Exception:
        return None


def as_int(value: Any) -> int | None:
    parsed = as_number(value)
    return int(parsed) if parsed is not None else None


def pick_first(*values: Any) -> Any:
    for value in values:
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        return value
    return None


def normalize_status(raw: Any, text: str = "") -> str:
    raw_text = normalize_space(raw).lower()
    if re.search(r"in\s*stock|active|for[\s-]?sale|listed", raw_text, re.I):
        return "active"
    if re.search(r"off[\s-]?market|delisted|removed|withdrawn|not\s+for\s+sale", raw_text, re.I):
        return "off-market"
    if re.search(r"pending|under\s+contract|contingent", raw_text, re.I):
        return "pending"
    if re.search(r"\bsold\b|\bclosed\b", raw_text, re.I):
        return "sold"
    zone = (text or "")[:4000]
    if ACTIVE_PATTERN.search(zone):
        return "active"
    if INACTIVE_PATTERN.search(zone):
        if re.search(r"pending|under contract|contingent", zone, re.I):
            return "pending"
        if re.search(r"off[\s-]?market|delisted|withdrawn|no longer", zone, re.I):
            return "off-market"
        return "sold"
    return "unconfirmed"


def days_since(value: Any) -> int | None:
    if not value:
        return None
    text = str(value)
    try:
        clean = text.replace("Z", "+00:00")
        dt = datetime.fromisoformat(clean)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(0, int((datetime.now(timezone.utc) - dt).total_seconds() // 86400))
    except Exception:
        return None


def empty_listing(url: str, platform: str) -> dict[str, Any]:
    return {
        "address": None,
        "city": None,
        "state": None,
        "zip": None,
        "price": None,
        "priceHistory": [],
        "beds": None,
        "baths": None,
        "sqftFinished": None,
        "lotSqft": None,
        "lotAcres": None,
        "yearBuilt": None,
        "garage": None,
        "hoaMonthly": None,
        "hoaAnnual": None,
        "listingStatus": "unconfirmed",
        "daysOnMarket": None,
        "propertyType": None,
        "homeStyle": None,
        "builderName": None,
        "communityName": None,
        "assignedSchools": [],
        "photos": {"count": 0, "urls": []},
        "description": None,
        "listingAgent": None,
        "mls": None,
        "platform": platform,
        "url": url,
        "canonicalUrl": None,
        "extractedAt": datetime.now(timezone.utc).isoformat(),
        "confidence": "low",
        "coverageNotes": [],
    }


def merge_listing(target: dict[str, Any], patch: dict[str, Any]) -> None:
    for key, value in patch.items():
        if value is None or value == "":
            continue
        if key == "assignedSchools" and isinstance(value, list) and value and not target["assignedSchools"]:
            target["assignedSchools"] = value
            continue
        if key == "photos" and isinstance(value, dict) and value.get("count") and not target["photos"].get("count"):
            target["photos"] = value
            continue
        if target.get(key) in (None, "", []):
            target[key] = value


def score_confidence(listing: dict[str, Any]) -> str:
    required = ("address", "price", "beds", "baths", "sqftFinished", "yearBuilt")
    present = sum(1 for key in required if listing.get(key) is not None)
    if present >= 5:
        return "high"
    if present >= 3:
        return "medium"
    return "low"


def clean_school_name(value: Any) -> str:
    name = normalize_space(value)
    name = re.sub(r"^(?:Places|Transit|School Information|Information)\s+", "", name, flags=re.I)
    name = re.sub(r"^(?:Chatham|Wake)\s*[-:]\s*", "", name, flags=re.I)
    name = re.sub(r"^N\s+Chatham\s+Middle$", "North Chatham Middle School", name, flags=re.I)
    name = re.sub(r"\bHigh$", "High School", name, flags=re.I)
    name = re.sub(r"\bMiddle$", "Middle School", name, flags=re.I)
    name = re.sub(r"\bElementary$", "Elementary School", name, flags=re.I)
    name = normalize_space(name)
    if re.fullmatch(r"(?:Additional\s+)?(?:Elementary|Middle|High)(?:\s+School)?", name, re.I):
        return ""
    if re.fullmatch(r"Information\s+Elementary\s+School", name, re.I):
        return ""
    return name


def normalize_school(entry: dict[str, Any], source: str) -> dict[str, Any] | None:
    name = clean_school_name(pick_first(entry.get("name"), entry.get("schoolName"), entry.get("officialName")))
    if not name:
        return None
    raw_level = normalize_space(pick_first(entry.get("level"), entry.get("gradeLevel"), entry.get("type"), entry.get("gradeRange")))
    level = None
    level_haystack = f"{raw_level} {name}"
    if re.search(r"elementary|primary", level_haystack, re.I):
        level = "elementary"
    elif re.search(r"middle|junior", level_haystack, re.I):
        level = "middle"
    elif re.search(r"high|senior", level_haystack, re.I):
        level = "high"
    return {
        "name": name,
        "level": level or raw_level or None,
        "district": pick_first(entry.get("district"), entry.get("schoolDistrict")),
        "rating": as_number(pick_first(entry.get("rating"), entry.get("greatSchoolsRating"), entry.get("score"))),
        "source": source,
    }


def clean_entity_name(value: Any) -> str:
    text = normalize_space(value)
    text = re.split(r"\s+in\s+[A-Z][A-Za-z0-9'& -]{2,80}(?:\.|$)", text, maxsplit=1)[0]
    text = FULL_ADDRESS_RE.split(text, maxsplit=1)[0]
    text = re.split(
        r"\b(?:Community|Subdivision|Neighborhood|Schools?|School Information|"
        r"Property Details?|Listing Details?|Overview|New Construction|Interior|Exterior|Parking|Garage|"
        r"HOA|MLS|Contact|Schedule|Tour|For Sale|Price|Beds?|Baths?)\b",
        text,
        maxsplit=1,
        flags=re.I,
    )[0]
    text = re.sub(r"^[\s:;-]+|[\s:;.,-]+$", "", text)
    if len(text) < 3 or len(text) > 90:
        return ""
    if re.search(r"\b(?:homes\.com|listing|details?|information|property|school|rating)\b", text, re.I):
        return ""
    return text


def clean_builder_name(value: Any) -> str:
    text = clean_entity_name(value)
    text = re.sub(r"\b(?:Builder\s+Model|Model\s+Home|Home\s+Builder|Builder)\b.*$", "", text, flags=re.I)
    return clean_entity_name(text)


def clean_community_name(value: Any) -> str:
    text = clean_entity_name(value)
    text = re.sub(r"^(?:in|at|the)\s+", "", text, flags=re.I).strip()
    text = re.sub(r"\b(?:community|subdivision|neighborhood)\b.*$", "", text, flags=re.I).strip(" ,.;:-")
    if not text or re.search(r"\b(?:county|school district|top[- ]rated|builder|model|homes? for sale)\b", text, re.I):
        return ""
    return text if 3 <= len(text) <= 80 else ""


def value_name(value: Any) -> str:
    if isinstance(value, dict):
        return clean_entity_name(pick_first(value.get("name"), value.get("displayName"), value.get("title")))
    if isinstance(value, list):
        for item in value:
            name = value_name(item)
            if name:
                return name
        return ""
    return clean_entity_name(value)


def dedupe_schools(schools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for school in schools:
        normalized = normalize_school(school, school.get("source") or "listing")
        if not normalized:
            continue
        key = f"{normalized.get('name', '').lower()}|{normalized.get('level') or ''}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(normalized)
    rated_levels = {school.get("level") for school in unique if school.get("level") and school.get("rating") is not None}
    if rated_levels:
        unique = [
            school for school in unique
            if school.get("rating") is not None or school.get("level") not in rated_levels
        ]
    return unique[:12]


def extract_structured_enrichment(html: str, platform: str) -> dict[str, Any]:
    data = [*parse_json_scripts(html), *parse_json_scripts(html, next_data=True)]
    if not data:
        return {}

    patch: dict[str, Any] = {}
    schools: list[dict[str, Any]] = []
    objects = collect_objects(data, [])
    for obj in objects:
        if not isinstance(obj, dict):
            continue

        for key, value in obj.items():
            normalized_key = str(key).lower()
            if "builder" in normalized_key and not patch.get("builderName"):
                name = clean_builder_name(value_name(value))
                if name:
                    patch["builderName"] = name
            if normalized_key in {"community", "communityname", "subdivision", "subdivisionname", "neighborhood"} and not patch.get("communityName"):
                name = clean_community_name(value_name(value))
                if name:
                    patch["communityName"] = name

        typ = obj.get("@type")
        typ_text = " ".join(typ) if isinstance(typ, list) else str(typ or "")
        name = pick_first(obj.get("name"), obj.get("schoolName"), obj.get("officialName"))
        has_school_shape = bool(
            re.search(r"\bSchool\b", typ_text, re.I)
            or "schoolName" in obj
            or "greatSchoolsRating" in obj
            or re.search(r"\b(?:Elementary|Middle|High)\b", str(name or ""), re.I)
        )
        if has_school_shape and name:
            normalized = normalize_school(obj, platform)
            if normalized:
                schools.append(normalized)

    if schools:
        patch["assignedSchools"] = dedupe_schools(schools)
    return patch


def html_sections_after_headings(html: str, heading_pattern: str) -> list[str]:
    sections: list[str] = []
    heading_re = re.compile(r"(?is)<h[1-5]\b[^>]*>(.*?)</h[1-5]>", re.I)
    matches = list(heading_re.finditer(html or ""))
    for index, match in enumerate(matches):
        heading = strip_tags(match.group(1))
        if not re.search(heading_pattern, heading, re.I):
            continue
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else min(len(html), start + 12000)
        sections.append(html[start:end])
    return sections


def parse_school_names_from_text(text: str, source: str) -> list[dict[str, Any]]:
    schools: list[dict[str, Any]] = []
    name_pattern = r"([A-Z][A-Za-z0-9.' &-]{2,80}?\b(?:Elementary|Middle|High|Magnet|Academy)(?:\s+School)?)"
    def clean_text_school_name(raw: str) -> str:
        name = normalize_space(raw)
        parts = re.split(r"(?:[.!?]\s+|\bSchools?\s+)", name, flags=re.I)
        return clean_school_name(parts[-1] if parts else name)
    for match in re.finditer(name_pattern, text or ""):
        name = clean_text_school_name(match.group(1))
        window = text[match.start():match.end() + 80]
        rating = as_number(first_match(r"(\d{1,2})\s*/\s*10", window))
        schools.append({"name": name, "rating": rating, "source": source})
    for match in re.finditer(r"(\d{1,2})\s*/\s*10\s+" + name_pattern, text or ""):
        name = clean_text_school_name(match.group(2))
        schools.append({"name": name, "rating": as_number(match.group(1)), "source": source})
    return dedupe_schools(schools)


def extract_text_enrichment(html: str, body_text: str, platform: str) -> dict[str, Any]:
    patch: dict[str, Any] = {}
    listing_detail_text = " ".join(strip_tags(section) for section in html_sections_after_headings(html, r"listing\s*details?|property\s*details?|overview|builder"))
    search_text = normalize_space(f"{listing_detail_text} {body_text[:30000]}")

    for pattern in (
        r"\bBuilder\s*Name\s*:?\s*([A-Z][A-Za-z0-9'&./ -]{2,90})",
        r"\bBuilder\s*:?\s*([A-Z][A-Za-z0-9'&./ -]{2,90})",
        r"\bBuilt\s+by\s+([A-Z][A-Za-z0-9'&./ -]{2,90})",
        r"\bNew\s+Construction(?:\s+Home)?\s+by\s+([A-Z][A-Za-z0-9'&./ -]{2,90})",
        r"\bCommunity\s+by\s+([A-Z][A-Za-z0-9'&./ -]{2,90})",
    ):
        candidate = clean_builder_name(first_match(pattern, search_text))
        if candidate:
            patch["builderName"] = candidate
            break

    community = clean_community_name(first_match(
        r"\bat\s+\d{1,5}\s+[A-Za-z0-9.'# -]{2,80}?\s+in\s+([A-Z][A-Za-z0-9'&./ -]{2,90})(?:[!.,;]|\s+a\s+)",
        search_text,
    ))
    if not community:
        community = clean_community_name(first_match(r"\bin\s+([A-Z][A-Za-z0-9'&./ -]{2,90}),?\s+a\s+(?:charming\s+)?(?:[A-Za-z]+\s+)?community", search_text))
    if not community:
        community = clean_community_name(first_match(r"\b(?:Community|Subdivision|Neighborhood)\s*:?\s*([A-Z][A-Za-z0-9'&./ -]{2,90})", search_text))
    if community:
        patch["communityName"] = community

    mls = first_match(r"\bMLS(?:\s*Number|\s*#|#)\s*:?\s*([A-Z0-9-]{5,})", search_text)
    if mls:
        patch["mls"] = mls

    school_texts = [strip_tags(section) for section in html_sections_after_headings(html, r"schools?|school information")]
    school_texts.append(search_text)
    schools = dedupe_schools([school for text in school_texts for school in parse_school_names_from_text(text, platform)])
    if schools:
        patch["assignedSchools"] = schools

    return patch


def extract_jsonld_listing(html: str, url: str, platform: str, body_text: str) -> dict[str, Any]:
    patch: dict[str, Any] = {}

    def put(key: str, value: Any) -> None:
        if value is None or value == "":
            return
        if patch.get(key) in (None, ""):
            patch[key] = value

    json_ld = parse_json_scripts(html)
    objects = collect_objects(json_ld, [])
    address_obj = None
    for obj in objects:
        address = obj.get("address") if isinstance(obj, dict) else None
        if isinstance(address, dict) and (address.get("streetAddress") or address.get("addressLocality")):
            address_obj = address
            break
    if address_obj:
        patch["address"] = pick_first(address_obj.get("streetAddress"), address_obj.get("line"))
        patch["city"] = pick_first(address_obj.get("addressLocality"), address_obj.get("city"))
        patch["state"] = pick_first(address_obj.get("addressRegion"), address_obj.get("state"))
        patch["zip"] = pick_first(address_obj.get("postalCode"), address_obj.get("zip"))

    listing_candidates = []
    for obj in objects:
        typ = obj.get("@type") if isinstance(obj, dict) else None
        typ_text = " ".join(typ) if isinstance(typ, list) else str(typ or "")
        if re.search(r"Residence|RealEstateListing|SingleFamilyResidence|House|Product", typ_text, re.I):
            listing_candidates.append(obj)
    if not listing_candidates:
        listing_candidates = objects

    offers = []
    for obj in listing_candidates:
        raw = obj.get("offers") if isinstance(obj, dict) else None
        if isinstance(raw, list):
            offers.extend(item for item in raw if isinstance(item, dict))
        elif isinstance(raw, dict):
            offers.append(raw)

    for obj in listing_candidates:
        if not isinstance(obj, dict):
            continue
        entity = obj.get("mainEntity") if isinstance(obj.get("mainEntity"), dict) else obj
        put("beds", as_number(pick_first(entity.get("numberOfBedrooms"), entity.get("numberOfRooms"), obj.get("numberOfBedrooms"))))
        put("baths", as_number(pick_first(entity.get("numberOfBathroomsTotal"), entity.get("numberOfBathrooms"), obj.get("numberOfBathroomsTotal"), obj.get("numberOfBathrooms"))))
        floor = pick_first(entity.get("floorSize"), obj.get("floorSize"), entity.get("livingArea"), obj.get("livingArea"))
        put("sqftFinished", as_number(floor))
        put("yearBuilt", as_int(pick_first(entity.get("yearBuilt"), entity.get("dateBuilt"), obj.get("yearBuilt"))))
        put("propertyType", pick_first(entity.get("propertyType"), entity.get("category"), obj.get("propertyType"), obj.get("@type")))
        put("description", pick_first(obj.get("description"), entity.get("description")))
        posted_days = days_since(obj.get("datePosted"))
        if posted_days is not None:
            put("daysOnMarket", posted_days)

    if offers:
        offer = offers[0]
        price_spec = offer.get("priceSpecification") if isinstance(offer.get("priceSpecification"), dict) else {}
        patch["price"] = as_int(pick_first(offer.get("price"), price_spec.get("price")))
        patch["listingStatus"] = normalize_status(pick_first(offer.get("availability"), offer.get("itemCondition")), body_text)
        offered_by = offer.get("offeredBy")
        if isinstance(offered_by, list):
            offered_by = offered_by[0] if offered_by else None
        if isinstance(offered_by, dict) and offered_by.get("name"):
            patch["listingAgent"] = normalize_space(offered_by.get("name"))
    else:
        for obj in listing_candidates:
            if isinstance(obj, dict):
                price = as_int(obj.get("price"))
                if price is not None:
                    patch["price"] = price
                    break

    return patch


def find_realtor_listing(data: Any) -> dict[str, Any] | None:
    props = data.get("props", {}).get("pageProps", {}) if isinstance(data, dict) else {}
    candidates = [
        props.get("property"),
        props.get("initialState", {}).get("propertyDetails"),
        props.get("initialReduxState", {}).get("propertyDetails", {}).get("detailData"),
        props.get("initialReduxState", {}).get("propertyDetails"),
        props.get("detail"),
    ]
    return next((item for item in candidates if isinstance(item, dict)), None)


def extract_next_listing(html: str, platform: str, body_text: str) -> dict[str, Any]:
    scripts = parse_json_scripts(html, next_data=True)
    if not scripts:
        return {}
    data = scripts[0]
    patch: dict[str, Any] = {}
    if platform == "realtor":
        listing = find_realtor_listing(data)
        if not listing:
            return {}
        address = listing.get("address") or listing.get("location", {}).get("address") or {}
        desc = listing.get("description") or {}
        source = listing.get("source") if isinstance(listing.get("source"), dict) else {}
        hoa = listing.get("hoa") if isinstance(listing.get("hoa"), dict) else {}
        patch.update({
            "address": pick_first(address.get("line"), address.get("full_line"), address.get("streetAddress")),
            "city": address.get("city"),
            "state": pick_first(address.get("state_code"), address.get("state")),
            "zip": pick_first(address.get("postal_code"), address.get("zip")),
            "price": as_int(pick_first(listing.get("list_price"), listing.get("price"), listing.get("last_price"))),
            "beds": as_number(pick_first(desc.get("beds"), listing.get("beds"))),
            "baths": as_number(pick_first(desc.get("baths_consolidated"), desc.get("baths"), listing.get("baths"))),
            "sqftFinished": as_int(pick_first(desc.get("sqft"), listing.get("sqft"))),
            "lotSqft": as_int(desc.get("lot_sqft")),
            "yearBuilt": as_int(desc.get("year_built")),
            "garage": as_number(desc.get("garage")),
            "propertyType": pick_first(desc.get("type"), listing.get("prop_type")),
            "homeStyle": pick_first(desc.get("sub_type"), desc.get("style")),
            "description": pick_first(listing.get("text"), listing.get("description")),
            "listingStatus": normalize_status(listing.get("status"), body_text),
            "hoaMonthly": as_int(pick_first(hoa.get("fee"), hoa.get("amount"))),
            "builderName": pick_first((listing.get("builder") or {}).get("name") if isinstance(listing.get("builder"), dict) else None),
            "communityName": pick_first(
                (listing.get("community") or {}).get("name") if isinstance(listing.get("community"), dict) else None,
                (listing.get("subdivision") or {}).get("name") if isinstance(listing.get("subdivision"), dict) else None,
            ),
            "mls": source.get("listing_id"),
        })
        if isinstance(desc.get("baths_full"), (int, float)):
            patch["baths"] = desc.get("baths_full", 0) + 0.5 * desc.get("baths_half", 0) + 0.5 * desc.get("baths_3qtr", 0)
        if source.get("days_on_mls") is not None:
            patch["daysOnMarket"] = as_int(source.get("days_on_mls"))
        elif listing.get("days_on_market") is not None:
            patch["daysOnMarket"] = as_int(listing.get("days_on_market"))
        else:
            patch["daysOnMarket"] = days_since(listing.get("list_date"))
        advertisers = listing.get("advertisers") if isinstance(listing.get("advertisers"), list) else []
        if advertisers and isinstance(advertisers[0], dict):
            patch["listingAgent"] = advertisers[0].get("name")
        schools = []
        raw_schools = (listing.get("schools") or {}).get("schools") if isinstance(listing.get("schools"), dict) else []
        if isinstance(raw_schools, list):
            for school in raw_schools:
                if isinstance(school, dict):
                    normalized = normalize_school({
                        "name": school.get("name"),
                        "level": pick_first((school.get("education_levels") or [None])[0] if isinstance(school.get("education_levels"), list) else None, school.get("funding_type")),
                        "rating": school.get("rating"),
                        "district": (school.get("district") or {}).get("name") if isinstance(school.get("district"), dict) else school.get("district_id"),
                    }, "realtor")
                    if normalized:
                        schools.append(normalized)
        if schools:
            patch["assignedSchools"] = schools
    return patch


def extract_text_fallback(html: str, body_text: str) -> dict[str, Any]:
    patch: dict[str, Any] = {}
    address_match = FULL_ADDRESS_RE.search(body_text)
    if address_match:
        parts = [part.strip() for part in address_match.group(0).split(",")]
        patch["address"] = parts[0] if parts else None
        patch["city"] = parts[1] if len(parts) > 1 else None
        if len(parts) > 2:
            state_zip = parts[2].split()
            patch["state"] = state_zip[0] if state_zip else None
            patch["zip"] = state_zip[1] if len(state_zip) > 1 else None
    price = as_int(first_match(r"(\$\s*[\d,]+)", body_text))
    if price is not None:
        patch["price"] = price
    beds = as_number(first_match(r"(\d+(?:\.\d+)?)\s*(?:bd|bds|bed|beds)\b", body_text))
    baths = as_number(first_match(r"(\d+(?:\.\d+)?)\s*(?:ba|bath|baths)\b", body_text))
    sqft = as_int(first_match(r"([\d,]+)\s*(?:sq\.?\s*ft|sqft|square feet)\b", body_text))
    year = as_int(first_match(r"(?:built\s+in|year built[:\s]+)(\d{4})", body_text))
    if beds is not None:
        patch["beds"] = beds
    if baths is not None:
        patch["baths"] = baths
    if sqft is not None:
        patch["sqftFinished"] = sqft
    if year is not None:
        patch["yearBuilt"] = year
    hoa = as_int(first_match(r"(?:hoa|association fee)[^\$]{0,80}(\$\s*[\d,]+)", body_text))
    if hoa is not None and hoa < 2000:
        patch["hoaMonthly"] = hoa
    garage = as_number(first_match(r"(\d+)\s*(?:car|garage)", body_text))
    if garage is not None:
        patch["garage"] = garage
    patch["listingStatus"] = normalize_status("", body_text)
    return patch


def build_snapshot(html: str, final_url: str) -> dict[str, Any]:
    meta = parse_meta(html)
    body_text = strip_tags(html)
    return {
        "title": parse_title(html),
        "url": final_url,
        "headings": parse_headings(html),
        "meta": meta,
        "description": pick_first(meta.get("description"), meta.get("og:description"), ""),
        "excerpt": body_text[:1200],
        "bodyText": body_text[:60000],
    }


def extract_detail(html: str, url: str, final_url: str, platform: str, notes: list[str]) -> dict[str, Any]:
    snapshot = build_snapshot(html, final_url)
    body_text = snapshot["bodyText"]
    listing = empty_listing(url, platform)
    listing["canonicalUrl"] = first_match(r"<link\b(?=[^>]*rel=['\"]canonical['\"])[^>]*href=['\"]([^'\"]+)", html) or final_url
    merge_listing(listing, extract_jsonld_listing(html, url, platform, body_text))
    merge_listing(listing, extract_next_listing(html, platform, body_text))
    merge_listing(listing, extract_text_fallback(html, body_text))
    merge_listing(listing, extract_structured_enrichment(html, platform))
    merge_listing(listing, extract_text_enrichment(html, body_text, platform))
    listing["listingStatus"] = normalize_status(listing.get("listingStatus"), body_text)
    listing["confidence"] = score_confidence(listing)
    listing["coverageNotes"].extend(notes)
    if listing["confidence"] == "low":
        listing["coverageNotes"].append("crawl4ai detail extraction found limited structured listing facts")
    return {"listing": listing, "snapshot": snapshot}


def extract_price(text: str) -> str:
    return first_match(r"(\$\s*[\d,]+)", text)


def extract_address(text: str) -> str:
    match = FULL_ADDRESS_RE.search(text or "")
    return normalize_space(match.group(0)) if match else ""


def normalize_href(base_url: str, href: str) -> str:
    return urljoin(base_url, html_lib.unescape(href or ""))


def detail_href_matches(platform: str, href: str) -> bool:
    parsed = urlparse(href)
    haystack = f"{parsed.path}?{parsed.query}"
    pattern = DETAIL_PATTERNS.get(platform)
    if pattern:
        return bool(pattern.search(haystack))
    return any(candidate.search(haystack) for candidate in DETAIL_PATTERNS.values())


def extract_search_items(html: str, url: str, platform: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    anchor_pattern = re.compile(r"(?is)<a\b([^>]*)href\s*=\s*(['\"])(.*?)\2([^>]*)>(.*?)</a>")
    for match in anchor_pattern.finditer(html or ""):
        attrs = attrs_from_tag(f"{match.group(1)} {match.group(4)}")
        href = normalize_href(url, match.group(3))
        if not detail_href_matches(platform, href):
            continue
        canonical = href.split("#", 1)[0]
        if canonical in seen:
            continue
        seen.add(canonical)
        start = max(0, match.start() - 1800)
        end = min(len(html), match.end() + 1800)
        context_text = strip_tags(html[start:end])
        anchor_text = strip_tags(match.group(5))
        address = extract_address(f"{anchor_text} {context_text}")
        price = extract_price(context_text)
        items.append({
            "href": canonical,
            "anchorText": anchor_text,
            "addressText": address,
            "priceText": price,
            "metaText": context_text[:900],
            "ariaLabel": normalize_space(attrs.get("aria-label", "")),
            "text": context_text[:2400],
        })
        if len(items) >= 60:
            break
    return items


def capture_status(html: str, status_code: int | None, mode: str, items: list[dict[str, Any]] | None, listing: dict[str, Any] | None) -> str:
    if status_code in (401, 403, 429):
        return "blocked"
    if not html:
        return "empty"
    detail_has_core_facts = bool(
        mode == "detail"
        and listing
        and (listing.get("address") or listing.get("price"))
        and listing.get("confidence") in ("medium", "high")
    )
    if BLOCK_PATTERN.search(html or "") and not detail_has_core_facts:
        return "blocked"
    if mode == "search" and not items:
        return "empty"
    if mode == "detail" and listing and listing.get("confidence") == "low" and not listing.get("address") and not listing.get("price"):
        return "empty"
    return "captured"


async def crawl_url(args: argparse.Namespace) -> dict[str, Any]:
    try:
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig
    except ImportError:
        hard_fail("crawl4ai-not-installed")

    if not args.cdp_url:
        return {
            "html": "",
            "finalUrl": args.url,
            "statusCode": 0,
            "error": "missing-cdp-url",
        }

    browser_config = BrowserConfig(
        browser_mode="cdp",
        cdp_url=args.cdp_url,
        viewport_width=1440,
        viewport_height=1100,
        verbose=False,
    )
    run_config = CrawlerRunConfig(
        page_timeout=args.timeout_ms,
        wait_until="domcontentloaded",
        wait_for="css:body",
        delay_before_return_html=max(0.1, args.delay_ms / 1000),
        scan_full_page=args.mode == "search",
        max_scroll_steps=8 if args.mode == "search" else 3,
        scroll_delay=0.25,
        remove_overlay_elements=True,
        verbose=False,
        stream=False,
    )

    try:
        async with AsyncWebCrawler(config=browser_config) as crawler:
            result = await crawler.arun(url=args.url, config=run_config)
    except Exception as exc:
        hint = str(exc)
        if "Executable doesn" in hint or "playwright" in hint.lower():
            hard_fail("playwright-browsers-missing")
        return {
            "html": "",
            "finalUrl": args.url,
            "statusCode": 0,
            "error": hint,
        }

    return {
        "html": getattr(result, "html", "") or getattr(result, "cleaned_html", "") or "",
        "finalUrl": getattr(result, "url", args.url) or args.url,
        "statusCode": getattr(result, "status_code", None) or getattr(result, "status", None) or (200 if getattr(result, "success", False) else 0),
        "error": None if getattr(result, "success", False) else getattr(result, "error_message", None),
    }


async def run(args: argparse.Namespace) -> dict[str, Any]:
    notes: list[str] = []
    if args.html_file:
        html = Path(args.html_file).read_text(encoding="utf-8")
        crawl = {"html": html, "finalUrl": args.url, "statusCode": 200, "error": None}
        notes.append(f"parsed fixture {args.html_file}")
    else:
        crawl = await crawl_url(args)
        if crawl.get("error"):
            notes.append(str(crawl["error"]).splitlines()[0])

    html = crawl.get("html", "") or ""
    final_url = crawl.get("finalUrl") or args.url
    status_code = crawl.get("statusCode") or 0
    snapshot = build_snapshot(html, final_url) if html else {
        "title": "",
        "url": final_url,
        "headings": [],
        "meta": {},
        "description": "",
        "excerpt": "",
        "bodyText": "",
    }
    items: list[dict[str, Any]] = []
    listing: dict[str, Any] | None = None

    if html and args.mode == "search":
        items = extract_search_items(html, args.url, args.platform)
    elif html and args.mode == "detail":
        detail = extract_detail(html, args.url, final_url, args.platform, notes)
        listing = detail["listing"]
        snapshot = detail["snapshot"]

    status = capture_status(html, status_code, args.mode, items, listing)
    if status == "blocked" and "blocked or rate-limited response detected" not in notes:
        notes.append("blocked or rate-limited response detected")
    elif status == "empty" and not notes:
        notes.append("no portal listing data extracted")

    return {
        "schemaVersion": 1,
        "provider": "crawl4ai",
        "mode": args.mode,
        "platform": args.platform,
        "url": args.url,
        "finalUrl": final_url,
        "statusCode": status_code,
        "captureStatus": status,
        "items": items,
        "listing": listing,
        "snapshot": snapshot,
        "notes": notes,
        "error": crawl.get("error"),
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Crawl4AI portal search/detail extractor.")
    parser.add_argument("--mode", choices=["search", "detail"], required=True)
    parser.add_argument("--platform", default="other")
    parser.add_argument("--url", required=True)
    parser.add_argument("--cdp-url", default="")
    parser.add_argument("--timeout-ms", type=int, default=30000)
    parser.add_argument("--delay-ms", type=int, default=1200)
    parser.add_argument("--html-file", default="")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    emit(asyncio.run(run(args)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
