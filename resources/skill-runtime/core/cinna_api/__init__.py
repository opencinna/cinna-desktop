"""
cinna_api for skill scripts on Cinna Desktop.

A skill script finds its credential by **slot** — the credential's service
URI — exactly as it does in a cinna-core environment::

    from core.cinna_api import credentials, CredentialMissing

    try:
        erp = credentials.require_slot("erp-public-api")
    except CredentialMissing as exc:
        print(exc)  # names the slot and where to fix it — relay it verbatim
        raise SystemExit(1)

Desktop writes the credentials attached to the agent to the file
``CINNA_CREDENTIALS_PATH`` names, in the shape core syncs, and this package
reads it fresh on every call.

Supported here: ``credentials`` (``all``, ``get``, ``by_type``,
``all_by_type``, ``by_slot``, ``require_slot``, ``agent_api_session``,
``access_token``, refreshed through Cinna Desktop's token endpoint), ``CredentialMissing`` and
``CredentialRefreshError``. Not supported: the agent REST API SDK (``api``,
``caller``, ``Caller``, ``error`` and the FastAPI / Pydantic re-exports),
which only an agent served by cinna-core has.
"""
from .credentials import CredentialMissing, CredentialRefreshError, credentials

__all__ = [
    "credentials",
    "CredentialMissing",
    "CredentialRefreshError",
]
