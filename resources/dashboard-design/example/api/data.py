"""Dashboard endpoint: headline figures, weekly revenue per channel and a note.

Usage: echo '{}' | uv run python dashboards/<name>/api/data.py

stdin is the params object; stdout is one JSON value, which the page receives
through `cinna.onData`. cwd is the agent folder. Read data something else
prepared under app-data/dashboards/<name>/; never crawl on every call.
"""

import json
import sys
from datetime import date, timedelta
from pathlib import Path

COMPONENT = Path(__file__).resolve().parent.parent.name
DATA_FILE = Path("app-data") / "dashboards" / COMPONENT / "revenue.json"

SAMPLE = {
    "direct": ("Direct", [12.1, 12.8, 13.0, 13.9, 14.2, 14.0, 15.1, 15.6, 16.2, 16.0, 17.1, 17.9]),
    "partners": ("Partners", [6.2, 6.0, 6.8, 7.1, 7.0, 7.6, 7.9, 8.4, 8.1, 8.8, 9.0, 9.6]),
    "market": ("Marketplace", [2.1, 2.5, 2.4, 3.0, 3.6, 3.9, 4.4, 4.2, 5.0, 5.6, 5.9, 6.4]),
}


def sample() -> dict:
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    weeks = []
    for back in range(11, -1, -1):
        day = monday - timedelta(weeks=back)
        year, week, _ = day.isocalendar()
        weeks.append({"id": f"{year}-W{week:02d}", "label": f"{day:%b} {day.day}"})
    series = [
        {"id": key, "label": label, "values": [round(v * 1000) for v in values]}
        for key, (label, values) in SAMPLE.items()
    ]
    return {"weeks": weeks, "series": series, "notice": "Sample data: nothing has been written yet."}


def main() -> None:
    json.loads(sys.stdin.read() or "{}")
    data = json.loads(DATA_FILE.read_text(encoding="utf-8")) if DATA_FILE.is_file() else sample()
    weeks, series = data["weeks"], data["series"]
    totals = [sum(s["values"][i] for s in series) for i in range(len(weeks))]
    this_week = totals[-1]
    last_week = totals[-2] if len(totals) > 1 else this_week
    leader = max(series, key=lambda s: s["values"][-1] - s["values"][-2] if len(s["values"]) > 1 else 0)
    result = {
        "kpis": [
            {"label": "Revenue this week", "value": this_week, "format": "money",
             "delta": this_week - last_week, "trend": totals},
            {"label": "Average week", "value": round(sum(totals) / len(totals)), "format": "money",
             "delta": None, "trend": None},
            {"label": "Best mover", "text": leader["label"], "delta": None, "trend": leader["values"]},
        ],
        "weeks": weeks,
        "series": series,
        "note": f"{leader['label']} grew most this week. Totals are before refunds.",
    }
    if data.get("notice"):
        result["notice"] = data["notice"]
    print(json.dumps(result))


if __name__ == "__main__":
    main()
