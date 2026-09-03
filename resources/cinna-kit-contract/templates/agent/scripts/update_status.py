#!/usr/bin/env python3
"""Write ``app-data/storage/STATUS.md`` — the agent's one-line health report.

A host reads this file to show a status badge and a summary line, so it is
written **atomically**: a temporary file in the same directory, then a rename, so
a reader never sees half a file.

Format — YAML frontmatter, then optional markdown detail::

    ---
    status: ok
    summary: "42 invoices checked, none missing a PO number"
    timestamp: 2026-09-02T10:15:00Z
    ---

    Optional detail, in markdown.

Use it from another script::

    from update_status import write_status
    write_status("attention", "3 invoices without a PO number", body=table)

Or from the command line (this is the ``/run:status`` command)::

    uv run scripts/update_status.py --status ok --summary "Nothing to report"
"""

from __future__ import annotations

import argparse
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

AGENT_ROOT = Path(__file__).resolve().parents[1]
STATUS_PATH = AGENT_ROOT / "app-data" / "storage" / "STATUS.md"

#: Values a host understands. Anything else is shown as unknown.
STATUSES = ("ok", "attention", "error", "unknown")


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _quote(value: str) -> str:
    """One-line, double-quoted YAML scalar. Newlines become spaces."""
    flattened = " ".join(str(value).split())
    escaped = flattened.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def render_status(status: str, summary: str, body: str = "", timestamp: str | None = None) -> str:
    lines = [
        "---",
        f"status: {status if status in STATUSES else 'unknown'}",
        f"summary: {_quote(summary)}",
        f"timestamp: {timestamp or _now()}",
        "---",
        "",
    ]
    text = "\n".join(lines)
    if body:
        text += body.rstrip("\n") + "\n"
    return text


def write_status(
    status: str,
    summary: str,
    body: str = "",
    path: Path = STATUS_PATH,
    timestamp: str | None = None,
) -> Path:
    """Write the status file atomically and return its path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    content = render_status(status, summary, body, timestamp)
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=".status-", suffix=".tmp", delete=False
    )
    try:
        with handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(handle.name, path)
    except BaseException:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise
    return path


def collect() -> tuple[str, str, str]:
    """What the agent reports when nobody passed a summary.

    Replace this with the real check — read what the agent produced, count what
    matters, and return ``(status, summary, body)``. Keep it fast: a host runs it
    before showing the agent.
    """
    return "unknown", "No status reported yet.", ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--status", choices=STATUSES, help="health of the agent")
    parser.add_argument("--summary", help="one line a human reads first")
    parser.add_argument("--body", default="", help="optional markdown detail")
    args = parser.parse_args()

    status, summary, body = collect()
    if args.status:
        status = args.status
    if args.summary:
        summary = args.summary
    if args.body:
        body = args.body

    path = write_status(status, summary, body)
    print(f"{status}: {summary}")
    print(f"written to {path.relative_to(AGENT_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
