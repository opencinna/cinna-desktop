#!/usr/bin/env python3
"""Credential access for this agent — the same call locally and in the cloud.

Precedence: the injected CINNA_CREDENTIALS_PATH array, credentials/credentials.json
(array or envelope), the legacy root object, environment, then credentials/.env.
Attached entries replace a whole slot; placeholders never merge environment fields.

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
HELPER_VERSION = "1.4.0"
CLOUD_CREDENTIALS = AGENT_ROOT / "credentials" / "credentials.json"
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
    for slot in _slots():
        if slot.get("type") == name or slot.get("service_uri") == name:
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


def _entries() -> list[dict]:
    paths = []
    if os.environ.get("CINNA_CREDENTIALS_PATH"):
        paths.append(Path(os.environ["CINNA_CREDENTIALS_PATH"]))
    paths.append(CLOUD_CREDENTIALS)
    for path in paths:
        data = _read_json(path)
        if isinstance(data, dict):
            data = data.get("credentials")
        if isinstance(data, list):
            return [e for e in data if isinstance(e, dict)]
    return []


def _match(entries: list[dict]) -> dict | None:
    filled = [e for e in entries if not e.get("is_placeholder")]
    if not filled:
        return {} if entries else None
    data = filled[0].get("credential_data")
    return dict(data) if isinstance(data, dict) else None


def by_slot(slot: str, credential_type: str | None = None) -> dict | None:
    """Strict service_uri lookup; never falls back to names or types."""
    return _match([e for e in _entries() if e.get("service_uri") == slot
                   and (credential_type is None or e.get("type") == credential_type)])


def require_slot(slot: str, credential_type: str | None = None) -> dict:
    result = by_slot(slot, credential_type)
    if not result:
        raise CredentialError(f"credential slot {slot!r} is not configured. Attach a filled credential to this agent.")
    return result


def _cloud_payload(name: str) -> dict[str, Any] | None:
    entries = _entries()
    slot = _slot(name)
    if slot:
        # A declared name identifies a service, not every token of its type.
        candidates = [e for e in entries if e.get("type") == slot.get("type")]
        explicit = slot.get("service_uri")
        groups = ([e for e in candidates if e.get("service_uri") == explicit],) if explicit else (
            [e for e in candidates if e.get("name") == slot.get("name")],
            [e for e in candidates if e.get("service_uri") == slot.get("name")],
        )
    else:
        # Keep explicit type lookups compatible for callers without manifest slots.
        groups = ([e for e in entries if e.get("name") == name],
                  [e for e in entries if e.get("service_uri") == name],
                  [e for e in entries if e.get("type") == name])
    for candidates in groups:
        result = _match(candidates)
        if result is not None:
            return result
    data = _read_json(AGENT_ROOT / "credentials.json")
    if isinstance(data, dict) and isinstance(data.get(name), dict):
        return data[name]
    return None


def agent_root() -> Path:
    return AGENT_ROOT


def _coerce(field: str, raw: str) -> Any:
    if field == "port" or field.endswith("_port"):
        try:
            return int(raw.strip())
        except ValueError:
            return raw
    if field.startswith(("is_", "use_")):
        if raw.strip().lower() in ("true", "yes", "1", "on"):
            return True
        if raw.strip().lower() in ("false", "no", "0", "off"):
            return False
    return raw


def _local_payload(name: str) -> dict[str, Any] | None:
    prefix = _env_prefix(name)
    merged: dict[str, str] = {**_parse_env_file(LOCAL_ENV), **os.environ}
    payload = {
        key[len(prefix):].lower(): _coerce(key[len(prefix):].lower(), value)
        for key, value in merged.items()
        if key.startswith(prefix) and value != ""
    }
    return payload or None


def get_credential(
    name: str,
    field: str | None = None,
    *,
    default: Any = None,
    required: bool = False,
) -> Any:
    """Return one field of a credential slot, or the whole slot as a dict.

    Raises :class:`CredentialError` when the slot (or the field) is missing and
    ``required`` is true; otherwise returns ``default``.
    """
    payload = _cloud_payload(name)
    if payload is None:
        payload = _local_payload(name)
    if not payload:
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


def require_credential(name: str, field: str | None = None) -> Any:
    return get_credential(name, field, required=True)


def list_credential_slots() -> list[dict]:
    return _slots()


MissingCredentialError = CredentialError


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
