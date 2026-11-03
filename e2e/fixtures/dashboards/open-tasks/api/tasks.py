"""Open tasks for the dashboard: params JSON on stdin, one JSON value on stdout.

Counts its own runs in app-data/dashboards/open-tasks/runs.txt, so you can see
when the tile recomputed and when it showed its cached result.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

params = json.load(sys.stdin) if not sys.stdin.isatty() else {}
limit = int(params.get("limit", 5))

runs_file = Path("app-data/dashboards/open-tasks/runs.txt")
runs_file.parent.mkdir(parents=True, exist_ok=True)
runs = int(runs_file.read_text() or "0") + 1 if runs_file.exists() else 1
runs_file.write_text(str(runs))

tasks = [
    {"id": "t1", "title": "Renew the Acme contract", "subtitle": "Due Friday", "priority": "high", "badge": "sales"},
    {"id": "t2", "title": "Review Dana's Q3 deck", "subtitle": "Shared yesterday", "priority": "medium"},
    {"id": "t3", "title": "Book the offsite venue", "priority": "low", "url": "https://example.com/venues"},
    {"id": "t4", "title": "Clear the support queue", "meta": "12 open", "priority": "medium"},
]

print(json.dumps({
    "items": tasks[:limit],
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "run": runs,
}))
