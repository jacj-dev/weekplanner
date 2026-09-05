#!/usr/bin/env python3
"""
Haalt het Zermelo-rooster op via de iCal-link en zet het om naar een klein
JSON-bestand (data/rooster.json) dat de statische website zelf kan inlezen.

Dit script draait NIET in de browser van een bezoeker (dat zou vanwege CORS
sowieso niet lukken), maar binnen een GitHub Actions-workflow: daar heeft het
gewoon internettoegang en mag het rechtstreeks bij Zermelo ophalen.

De iCal-URL (met de geheime access_token erin) staat NIET in dit bestand of
ergens anders in de repository -- die wordt via een GitHub Actions "secret"
aangeleverd als omgevingsvariabele ZERMELO_ICAL_URL. Zo blijft je toegangscode
uit je (publieke) broncode.

Gebruikt alleen Python's standaardbibliotheek, dus er hoeft niets
geinstalleerd te worden in de workflow.
"""

from __future__ import annotations

import calendar
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "rooster.json"

# ---------------------------------------------------------------------------
# Tijdzone: Europe/Amsterdam handmatig uitgerekend via de vaste EU-zomertijd-
# regel (laatste zondag van maart/oktober, 01:00 UTC), zodat er geen
# tijdzonedatabase (tzdata) nodig is op de GitHub Actions-runner.
# ---------------------------------------------------------------------------


def _last_sunday(year: int, month: int) -> datetime:
    last_day = calendar.monthrange(year, month)[1]
    d = datetime(year, month, last_day)
    d -= timedelta(days=(d.weekday() - 6) % 7)
    return d


def _amsterdam_utc_offset_hours(dt_utc_naive: datetime) -> int:
    year = dt_utc_naive.year
    dst_start = _last_sunday(year, 3).replace(hour=1, minute=0, second=0, microsecond=0)
    dst_end = _last_sunday(year, 10).replace(hour=1, minute=0, second=0, microsecond=0)
    return 2 if dst_start <= dt_utc_naive < dst_end else 1


def _utc_to_amsterdam(dt_utc_naive: datetime) -> datetime:
    return dt_utc_naive + timedelta(hours=_amsterdam_utc_offset_hours(dt_utc_naive))


# ---------------------------------------------------------------------------
# Minimale iCalendar-parser
# ---------------------------------------------------------------------------


def _unfold(raw_text: str) -> list[str]:
    raw_text = raw_text.replace("\r\n", "\n").replace("\r", "\n")
    lines: list[str] = []
    for line in raw_text.split("\n"):
        if line.startswith((" ", "\t")) and lines:
            lines[-1] += line[1:]
        elif line.strip() == "":
            continue
        else:
            lines.append(line)
    return lines


def _unescape(value: str) -> str:
    return (
        value.replace("\\n", "\n")
        .replace("\\N", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
    )


def _split_prop(line: str) -> tuple[str, dict, str]:
    if ":" not in line:
        return line.strip().upper(), {}, ""
    head, value = line.split(":", 1)
    parts = head.split(";")
    key = parts[0].strip().upper()
    params = {}
    for p in parts[1:]:
        if "=" in p:
            pk, pv = p.split("=", 1)
            params[pk.strip().upper()] = pv.strip()
    return key, params, value


def _parse_dt(value: str, params: dict) -> tuple[Optional[datetime], bool]:
    value = value.strip()
    if not value:
        return None, False
    if params.get("VALUE") == "DATE" or (len(value) == 8 and value.isdigit()):
        try:
            return datetime.strptime(value, "%Y%m%d"), True
        except ValueError:
            return None, False
    try:
        if value.endswith("Z"):
            dt_utc = datetime.strptime(value[:-1], "%Y%m%dT%H%M%S")
            return _utc_to_amsterdam(dt_utc), False
        return datetime.strptime(value, "%Y%m%dT%H%M%S"), False
    except ValueError:
        return None, False


def _parse_raw_events(raw_text: str) -> list[dict]:
    events: list[dict] = []
    current: Optional[dict] = None
    for line in _unfold(raw_text):
        key, params, value = _split_prop(line)
        if key == "BEGIN" and value.strip().upper() == "VEVENT":
            current = {
                "uid": None, "start": None, "end": None, "all_day": False,
                "summary": "", "location": "", "description": "", "status": "",
            }
            continue
        if key == "END" and value.strip().upper() == "VEVENT":
            if current is not None and current["start"] is not None:
                events.append(current)
            current = None
            continue
        if current is None:
            continue
        if key == "UID":
            current["uid"] = _unescape(value.strip())
        elif key == "SUMMARY":
            current["summary"] = _unescape(value.strip())
        elif key == "LOCATION":
            current["location"] = _unescape(value.strip())
        elif key == "DESCRIPTION":
            current["description"] = _unescape(value.strip())
        elif key == "STATUS":
            current["status"] = value.strip().upper()
        elif key == "DTSTART":
            dt, all_day = _parse_dt(value, params)
            current["start"], current["all_day"] = dt, all_day
        elif key == "DTEND":
            dt, _ = _parse_dt(value, params)
            current["end"] = dt
    return events


_BRACKET_RE = re.compile(r"^\[[^\]]{0,8}\]\s*")


def _strip_bracket(summary: str) -> str:
    return _BRACKET_RE.sub("", summary or "").strip()


def _change_note(description: str) -> Optional[str]:
    if not description or "Wijzigingen:" not in description:
        return None
    return description.split("Wijzigingen:", 1)[1].strip() or None


def _reconcile_cancellations(events: list[dict]) -> list[dict]:
    """Zermelo stuurt voor een vervallen les vaak twee events op hetzelfde
    tijdstip mee: het origineel plus een apart annuleringsbericht
    (STATUS:CANCELLED, titel met '[x] '-label). Die voegen we samen tot een
    les met een cancelled-vlag, zodat niets dubbel in het rooster verschijnt.
    """
    cancelled = [e for e in events if e.get("status") == "CANCELLED"]
    others = [e for e in events if e.get("status") != "CANCELLED"]

    lookup: dict[tuple, dict] = {}
    for e in others:
        lookup.setdefault((_strip_bracket(e["summary"]), e["start"], e["end"]), e)

    result = list(others)
    for c in cancelled:
        key = (_strip_bracket(c["summary"]), c["start"], c["end"])
        match = lookup.get(key)
        target = match if match is not None else c
        target["cancelled"] = True
        target["change_note"] = _change_note(c.get("description", "")) or "Les vervalt"
        if match is None:
            result.append(c)

    for e in result:
        e.setdefault("cancelled", False)
        if not e["cancelled"]:
            note = _change_note(e.get("description", ""))
            e["changed"], e["change_note"] = note is not None, note
        else:
            e["changed"] = False
        e["summary"] = _strip_bracket(e["summary"])
    return result


def parse_ics(raw_text: str) -> list[dict]:
    events = _reconcile_cancellations(_parse_raw_events(raw_text))
    events.sort(key=lambda e: e["start"])
    return events


# ---------------------------------------------------------------------------
# Ophalen + opslaan
# ---------------------------------------------------------------------------


def fetch_ics_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "weekplanner-site/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def to_json_records(events: list[dict]) -> list[dict]:
    records = []
    for e in events:
        records.append({
            "date": e["start"].strftime("%Y-%m-%d"),
            "start": e["start"].strftime("%H:%M"),
            "end": (e["end"] or e["start"]).strftime("%H:%M"),
            "summary": e["summary"],
            "location": e.get("location", ""),
            "cancelled": e.get("cancelled", False),
            "changed": e.get("changed", False),
            "change_note": e.get("change_note"),
        })
    return records


def main() -> None:
    url = os.environ.get("ZERMELO_ICAL_URL", "").strip()
    if not url:
        print("Fout: omgevingsvariabele ZERMELO_ICAL_URL is niet ingesteld.", file=sys.stderr)
        sys.exit(1)

    ics_text = fetch_ics_text(url)
    events = parse_ics(ics_text)
    records = to_json_records(events)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(
            {"generated_at": datetime.now().isoformat(timespec="seconds"), "lessons": records},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Klaar: {len(records)} lessen weggeschreven naar {OUTPUT_PATH}")


if __name__ == "__main__":
    main()