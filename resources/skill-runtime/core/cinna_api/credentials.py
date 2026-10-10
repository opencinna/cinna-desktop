"""
Fresh-read credentials accessor for skill scripts on Cinna Desktop.

Vendored from cinna-core's env-side ``core/cinna_api/credentials.py``
(``backend/app/env-templates/app_core_base/core/``) and kept to its behaviour
and its messages, so a skill written for a cloud agent runs unchanged on a
desktop agent. The differences:

- The file is the one ``CINNA_CREDENTIALS_PATH`` names, read again on every
  call (environment included); with the variable unset there is no file and
  every slot is ``not_linked``. Desktop unsets it when nothing is attached.
- :meth:`_Credentials.access_token` never calls the platform: a desktop agent
  has no environment token. It answers the synced token while it has
  ``min_ttl`` left, otherwise raises :class:`CredentialRefreshError`
  (``unavailable``). Desktop delivers no Google OAuth credential today, so in
  practice it raises ``credential_not_linked``.

Slots
-----
A skill finds its credential by **slot**: the credential's non-secret
``service_uri``, carried top-level on every real entry together with
``is_placeholder``. :meth:`_Credentials.require_slot` raises
:class:`CredentialMissing` with a message that names the slot and the fix, so a
script can fail in a way the agent can relay to the user verbatim.

This module must stay importable with no network and without ``requests``:
``AgentApiSession`` is defined on first use.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

#: ``type`` markers of the synthetic entries written beside the credentials.
#: They are not credentials and never satisfy a slot.
_CURRENT_USER_TYPE = "current_user"
_OWNER_IDENTITY_TYPE = "owner_identity_token"
_SYNTHETIC_TYPES = frozenset({_CURRENT_USER_TYPE, _OWNER_IDENTITY_TYPE})

_AGENT_API_TYPE = "agent_api"


def _credentials_path() -> Path | None:
    value = os.getenv("CINNA_CREDENTIALS_PATH")
    return Path(value) if value else None


#: Human words for an issued agent_api key synced token-less
#: (the entry's ``unavailable_reason``).
_UNAVAILABLE_REASON_WORDS = {
    "key_revoked": "the key was revoked by its issuer or its producer is gone",
    "key_expired": "the key has expired",
    "key_paused": "the producer has paused API access",
}

_UNAVAILABLE_REASON_FIXES = {
    "key_revoked": "ask the producer's owner for a new key.",
    "key_expired": "ask the producer's owner for a new key.",
    "key_paused": "it works again by itself once the producer's owner resumes access.",
}


class CredentialMissing(Exception):
    """A slot the script needs has no usable credential.

    ``reason`` is ``"not_linked"`` (no credential with this slot is linked to
    the agent), ``"not_configured"`` (one is linked but not filled in yet), or,
    for an issued ``agent_api`` key synced without its token, ``"key_revoked"``,
    ``"key_expired"`` or ``"key_paused"`` — then ``key_status`` carries the
    detailed status (e.g. ``"revoked_by_issuer"``). ``str(exc)`` is stable and
    written for a person: relay it verbatim.
    """

    def __init__(self, slot: str, reason: str, key_status: str | None = None):
        # ``args`` must be the constructor arguments so the exception
        # round-trips through pickle; ``__str__`` builds the message.
        super().__init__(slot, reason, key_status)
        self.slot = slot
        self.reason = reason
        self.key_status = key_status

    def __str__(self) -> str:
        if self.reason in _UNAVAILABLE_REASON_WORDS:
            detail = f", {self.key_status}" if self.key_status else ""
            return (
                f"credential_unavailable: the credential for slot '{self.slot}' "
                f"is unavailable: {_UNAVAILABLE_REASON_WORDS[self.reason]} "
                f"({self.reason}{detail}). Fix: "
                f"{_UNAVAILABLE_REASON_FIXES[self.reason]}"
            )
        if self.reason not in ("not_linked", "not_configured"):
            detail = f", {self.key_status}" if self.key_status else ""
            return (
                f"credential_unavailable: the credential for slot '{self.slot}' "
                f"is unavailable ({self.reason}{detail})."
            )
        if self.reason == "not_configured":
            return (
                f"credential_missing: the credential for slot '{self.slot}' is "
                "linked but not filled in yet. Fix: open the agent's Credentials "
                "tab and complete it."
            )
        return (
            f"credential_missing: no credential for slot '{self.slot}' is linked "
            "to this agent. Fix: open the agent's Credentials tab and link a "
            f"credential whose service URI (slot) is '{self.slot}'."
        )


_REFRESH_ERROR_MESSAGES = {
    "credential_not_linked": (
        "credential '{cid}' is not linked to this agent. Fix: open the agent's "
        "Credentials tab and link it."
    ),
    "unavailable": (
        "the platform could not be reached to refresh credential '{cid}' and "
        "the synced token has expired. Try again shortly."
    ),
}

#: Mirrors the platform's ``OAUTH_ON_DEMAND_MAX_MIN_TTL_SECONDS`` default.
_MAX_MIN_TTL_SECONDS = 1800


class CredentialRefreshError(Exception):
    """An OAuth access token could not be obtained.

    ``code`` is ``credential_not_linked`` or ``unavailable`` here (core's
    platform refresh codes never occur on a desktop). ``str(exc)`` is written
    for a person: relay it verbatim.
    """

    def __init__(self, code: str, credential_id: str):
        super().__init__(code, credential_id)
        self.code = code
        self.credential_id = credential_id

    def __str__(self) -> str:
        template = _REFRESH_ERROR_MESSAGES.get(
            self.code, "could not get an access token for credential '{cid}' ({code})."
        )
        return f"{self.code}: " + template.format(cid=self.credential_id, code=self.code)


_DEFAULT_PORTS = {"http": 80, "https": 443}


def _origin(url: str) -> tuple[str, str, int | None] | None:
    """``(scheme, host, effective port)`` of an absolute URL, lowercased.

    ``None`` when the URL has no host or an unparseable port, which never
    equals any origin.
    """
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if not parts.hostname:
        return None
    scheme = parts.scheme.lower()
    if port is None:
        port = _DEFAULT_PORTS.get(scheme)
    return scheme, parts.hostname.lower(), port


_agent_api_session_class: type | None = None


def _get_agent_api_session_class() -> type:
    """Define ``AgentApiSession`` on first use, so importing this module
    never imports ``requests``."""
    global _agent_api_session_class
    if _agent_api_session_class is not None:
        return _agent_api_session_class

    import requests
    from requests.structures import CaseInsensitiveDict

    class AgentApiSession(requests.Session):
        """A ``requests.Session`` pre-authorised for one ``agent_api`` connection.

        A relative ``url`` is joined onto :attr:`base_url` with exactly one
        ``/``; an absolute ``http(s)://`` URL is sent as given. The
        ``Authorization`` header goes only to :attr:`base_url`'s origin
        (scheme, host and effective port), on requests and on redirects; a
        header passed explicitly for one request is still sent. Only the verb
        methods (``get``, ``post``, ... and ``request``) are guarded.
        """

        def __init__(self, base_url: str, spec_url: str | None):
            super().__init__()
            self.base_url = base_url
            self.spec_url = spec_url
            self._credential_header_names: list[str] = []

        def set_credential_header(self, name: str, value: str) -> None:
            """Set a session header sent only to :attr:`base_url`'s origin."""
            self.headers[name] = value
            self._credential_header_names.append(name)

        def request(self, method, url, *args, **kwargs):  # type: ignore[override]
            target = str(url)
            if not target.lower().startswith(("http://", "https://")):
                target = f"{self.base_url.rstrip('/')}/{target.lstrip('/')}"
            elif not self._is_producer_origin(target):
                # ``headers`` is the third positional after method and url.
                if len(args) > 2:
                    args = (*args[:2], self._without_credentials(args[2]), *args[3:])
                else:
                    kwargs["headers"] = self._without_credentials(kwargs.get("headers"))
            return super().request(method, target, *args, **kwargs)

        def _is_producer_origin(self, url: str) -> bool:
            origin = _origin(url)
            return origin is not None and origin == _origin(self.base_url)

        def _without_credentials(self, headers: Any) -> CaseInsensitiveDict:
            # requests drops a merged header whose per-request value is None.
            merged = CaseInsensitiveDict(headers or {})
            for name in self._credential_header_names:
                if name not in merged:
                    merged[name] = None
            return merged

        def rebuild_auth(self, prepared_request, response):  # type: ignore[override]
            super().rebuild_auth(prepared_request, response)
            if not self._is_producer_origin(str(prepared_request.url)):
                for name in self._credential_header_names:
                    if name in prepared_request.headers:
                        del prepared_request.headers[name]

    _agent_api_session_class = AgentApiSession
    return AgentApiSession


class _Credentials:
    """Typed accessor over credentials.json. Reads the file fresh on each call."""

    def _load(self) -> list[dict]:
        """Read + parse credentials.json. Returns [] when missing/unreadable."""
        path = _credentials_path()
        try:
            if path is None or not path.is_file():
                return []
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                return data
            # Tolerate a {"credentials": [...]} envelope just in case.
            if isinstance(data, dict) and isinstance(data.get("credentials"), list):
                return data["credentials"]
            logger.warning("credentials.json has unexpected shape: %s", type(data).__name__)
            return []
        except (OSError, json.JSONDecodeError) as e:
            logger.warning("Failed to read credentials.json: %s", e)
            return []

    def all(self) -> list[dict]:
        """Return every credential dict (read fresh)."""
        return self._load()

    def get(self, credential_id: str) -> dict | None:
        """Return the credential whose ``id`` (or ``name``) matches, or None."""
        for cred in self._load():
            if str(cred.get("id")) == str(credential_id) or cred.get("name") == credential_id:
                return cred
        return None

    def access_token(self, credential_id: str, *, min_ttl: int = 300) -> str:
        """
        Return the synced OAuth access token while it is valid for at least
        ``min_ttl`` seconds. Never calls the platform (see the module note).

        Raises :class:`CredentialRefreshError` (relay ``str(exc)`` verbatim).
        """
        cid = str(credential_id)
        min_ttl = max(0, min(int(min_ttl), _MAX_MIN_TTL_SECONDS))
        entry = self.get(cid)
        if entry is None:
            raise CredentialRefreshError("credential_not_linked", cid)
        data = entry.get("credential_data") or {}
        local_token = data.get("access_token")
        expires_at = data.get("expires_at")
        remaining = expires_at - time.time() if isinstance(expires_at, (int, float)) else None
        if local_token and remaining is not None and remaining > min_ttl:
            return local_token
        raise CredentialRefreshError("unavailable", str(entry.get("id") or cid))

    def by_type(self, credential_type: str) -> dict | None:
        """Return the first credential of the given ``type``, or None."""
        for cred in self._load():
            if cred.get("type") == credential_type:
                return cred
        return None

    def all_by_type(self, credential_type: str) -> list[dict]:
        """Return every credential of the given ``type`` (read fresh)."""
        return [c for c in self._load() if c.get("type") == credential_type]

    def by_slot(self, slot: str) -> dict | None:
        """
        Return a real credential whose ``service_uri`` equals ``slot``, or
        None. Prefer an available, filled credential over a token-less
        (``unavailable_reason``) one and over any remaining placeholder.
        Synthetic entries never match.
        """
        return self._find_slot(self._load(), slot)

    def require_slot(self, slot: str) -> dict:
        """
        Return the credential for ``slot``, or raise :class:`CredentialMissing`:
        ``not_linked`` when none is linked, ``not_configured`` when the linked
        one is still a placeholder, or the entry's ``unavailable_reason``
        (``key_revoked`` / ``key_expired`` / ``key_paused``, with
        ``.key_status``) for an issued key synced without its token.
        """
        return self._require_slot_in(self._load(), slot)

    def agent_api_session(self, slot: str) -> Any:
        """
        Return an ``AgentApiSession`` (a ``requests.Session``) for the
        ``agent_api`` credential in ``slot``: ``Authorization: Bearer <token>``,
        plus the caller-identity header when an identity entry provides one,
        and ``.base_url`` / ``.spec_url`` from the credential. Needs
        ``requests`` installed.

        Raises :class:`CredentialMissing` like :meth:`require_slot`, and
        ``ValueError`` when the slot holds a credential of another type.
        """
        entries = self._load()
        entry = self._require_slot_in(entries, slot)
        if entry.get("type") != _AGENT_API_TYPE:
            raise ValueError(
                f"The credential for slot '{slot}' is of type "
                f"'{entry.get('type')}', not '{_AGENT_API_TYPE}'."
            )

        data = entry.get("credential_data") or {}
        session = _get_agent_api_session_class()(
            base_url=str(data.get("base_url") or ""),
            spec_url=data.get("spec_url"),
        )
        session.set_credential_header("Authorization", f"Bearer {data.get('token') or ''}")

        identity = next((e for e in entries if e.get("type") == _OWNER_IDENTITY_TYPE), None)
        if identity is not None:
            identity_data = identity.get("credential_data") or {}
            header, token = identity_data.get("header"), identity_data.get("token")
            if header and token:
                session.set_credential_header(header, token)
        return session

    @staticmethod
    def _find_slot(entries: list[dict], slot: str) -> dict | None:
        """The best entry for ``slot``: an available, filled one first, then an
        unavailable (token-less issued key) one, then a placeholder."""
        unavailable = None
        placeholder = None
        for cred in entries:
            if not isinstance(cred, dict):
                continue
            if cred.get("type") in _SYNTHETIC_TYPES:
                continue
            if cred.get("service_uri") != slot:
                continue
            if cred.get("is_placeholder") is True:
                if placeholder is None:
                    placeholder = cred
            elif cred.get("unavailable_reason"):
                if unavailable is None:
                    unavailable = cred
            else:
                return cred
        return unavailable or placeholder

    @classmethod
    def _require_slot_in(cls, entries: list[dict], slot: str) -> dict:
        entry = cls._find_slot(entries, slot)
        if entry is None:
            raise CredentialMissing(slot, "not_linked")
        if entry.get("is_placeholder") is True:
            raise CredentialMissing(slot, "not_configured")
        if entry.get("unavailable_reason"):
            raise CredentialMissing(slot, str(entry["unavailable_reason"]), entry.get("key_status"))
        return entry


# Singleton accessor — stateless (no caching), safe to import once.
credentials = _Credentials()
