#!/usr/bin/env python3
"""Credential access for this agent — the same call locally and in the cloud.

Two places a credential can come from:

* **Cloud** — the platform writes ``credentials.json`` at the agent root, a JSON
  object keyed by credential-slot name, each value an object of field/value pairs.
* **Local** — ``credentials/.env`` holds one variable per field, named
  ``<env_prefix><FIELD in upper case>``. ``env_prefix`` is declared per slot in
  ``cinna-agent.json``; when a slot does not declare one it is derived from the
  slot name (``Vendor Portal`` -> ``VENDOR_PORTAL_``). Real environment variables
  win over the file, so a host can inject a value without writing to disk.

Use one call either way::

    from cinna_credentials import get_credential

    password = get_credential("Odoo", "password")
    odoo = get_credential("Odoo")            # every field of the slot, as a dict

Never print, log or pass a returned value anywhere but the client that needs it.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

AGENT_ROOT = Path(__file__).resolve().parents[1]
CLOUD_CREDENTIALS = AGENT_ROOT / "credentials.json"
LOCAL_ENV = AGENT_ROOT / "credentials" / ".env"
MANIFEST = AGENT_ROOT / "cinna-agent.json"


class CredentialError(RuntimeError):
    """A declared credential, or one of its fields, is not configured."""


def _read_json(path: Path) -> Any:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def _slots() -> list[dict]:
    manifest = _read_json(MANIFEST)
    if not isinstance(manifest, dict):
        return []
    slots = manifest.get("credentials")
    return [s for s in slots if isinstance(s, dict)] if isinstance(slots, list) else []


def _slot(name: str) -> dict:
    for slot in _slots():
        if slot.get("name") == name:
            return slot
    return {}


def derive_env_prefix(name: str) -> str:
    """``Vendor Portal`` -> ``VENDOR_PORTAL_``. Used when a slot declares none."""
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").upper()
    if not cleaned:
        raise CredentialError("credential name has no usable characters")
    if not cleaned[0].isalpha():
        cleaned = "C_" + cleaned
    return cleaned + "_"


def _env_prefix(name: str) -> str:
    declared = _slot(name).get("env_prefix")
    return declared if isinstance(declared, str) and declared else derive_env_prefix(name)


def _parse_env_file(path: Path) -> dict[str, str]:
    """Minimal .env reader: ``KEY=value``, optional ``export``, # comments,
    optional single or double quotes. No interpolation, by design."""
    values: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return values
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def _cloud_payload(name: str) -> dict[str, Any] | None:
    data = _read_json(CLOUD_CREDENTIALS)
    if not isinstance(data, dict):
        return None
    payload = data.get(name)
    return payload if isinstance(payload, dict) else None


def _local_payload(name: str) -> dict[str, Any] | None:
    prefix = _env_prefix(name)
    merged: dict[str, str] = {**_parse_env_file(LOCAL_ENV), **os.environ}
    payload = {
        key[len(prefix):].lower(): value
        for key, value in merged.items()
        if key.startswith(prefix) and value != ""
    }
    return payload or None


def get_credential(
    name: str,
    field: str | None = None,
    *,
    default: Any = None,
    required: bool = True,
) -> Any:
    """Return one field of a credential slot, or the whole slot as a dict.

    Raises :class:`CredentialError` when the slot (or the field) is missing and
    ``required`` is true; otherwise returns ``default``.
    """
    payload = _cloud_payload(name) or _local_payload(name)
    if payload is None:
        if required:
            raise CredentialError(
                f"credential {name!r} is not configured. "
                f"Set {_env_prefix(name)}<FIELD> in credentials/.env "
                f"(see credentials/README.md)."
            )
        return default
    if field is None:
        return payload
    value = payload.get(field)
    if value in (None, ""):
        if required:
            raise CredentialError(
                f"credential {name!r} has no {field!r}. "
                f"Set {_env_prefix(name)}{field.upper()} in credentials/.env."
            )
        return default
    return value


def has_credential(name: str, field: str | None = None) -> bool:
    """True when the slot (or that field of it) has a value. Reads no value out."""
    return get_credential(name, field, required=False) not in (None, "", {})


def main() -> int:
    """Report which declared slots are configured. Prints names, never values."""
    slots = _slots()
    if not slots:
        print("No credential slots declared in cinna-agent.json.")
        return 0
    for slot in slots:
        name = str(slot.get("name", ""))
        state = "configured" if has_credential(name) else "missing"
        print(f"{name}: {state}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
