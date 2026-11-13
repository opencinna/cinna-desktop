"""Disposable cinna-core state for ``live-oauth-slot-authorize.spec.ts``.

Run inside cinna-core's backend container with this file on stdin; the spec
does it itself, from ``$CINNA_CORE_PATH``:

    docker compose exec -T backend python - <command> [arg] < e2e/fixtures/live-oauth-slot.py

``create`` signs up one person ``oauth-slot-e2e-<tag>@example.com`` and prints
JSON: the API and web origins, the tag and the person (id, email, name, web
token). The spec keeps it in memory; nothing is written to disk.

``inspect <credential_id>`` prints what core holds for exactly that credential:
type, service_uri, owner email and ``oauth_status`` (computed by core's own
``oauth_status`` from the decrypted blob). Never a secret value.

``ready <credential_id>`` stands in for Google's consent: it stores a fake
token blob on exactly that credential through core's own ``encrypt_field``
(``access_token`` ``ya29.e2e-oauth-slot-<first 8 of the id>``, a numeric
``expires_at`` two hours ahead so nothing refreshes against Google, a fake
refresh token). Refused unless the credential is a Google OAuth type owned by
an ``oauth-slot-e2e-`` person.

``delete <credential_id>`` deletes exactly that credential through core's
``CredentialsService.delete_credential``, with the same ownership guard.

``cleanup <user_id>`` deletes every credential owned by exactly that user (by
id, through the same service), then the user (admin ``DELETE /users/{id}``).
Refused unless the user's email starts with ``oauth-slot-e2e-``. It never
matches anything by name: a loose name match once destroyed a real admin
credential on a local core.
"""
import asyncio
import json
import os
import sys
import time
import uuid

import httpx

BASE = os.environ.get("CINNA_E2E_CORE_INTERNAL", "http://127.0.0.1:8000")
API = "/api/v1"
PREFIX = "oauth-slot-e2e-"
GOOGLE_TYPES = {
    "gmail_oauth", "gmail_oauth_readonly", "gdrive_oauth", "gdrive_oauth_readonly",
    "gcalendar_oauth", "gcalendar_oauth_readonly", "gmeet_oauth", "gmeet_oauth_readonly",
}


def ok(response: httpx.Response) -> httpx.Response:
    if response.status_code >= 400:
        raise SystemExit(f"{response.request.method} {response.request.url.path} -> {response.status_code}: {response.text[:300]}")
    return response


def login(client: httpx.Client, email: str, password: str) -> str:
    return ok(client.post(f"{API}/login/access-token", data={"username": email, "password": password})).json()["access_token"]


def create() -> None:
    tag = uuid.uuid4().hex[:8]
    email = f"{PREFIX}{tag}@example.com"
    password = uuid.uuid4().hex + "A!9"
    name = f"OAuth Slot {tag}"
    with httpx.Client(base_url=BASE, timeout=60) as client:
        user = ok(client.post(f"{API}/users/signup", json={"email": email, "password": password, "full_name": name})).json()
        token = login(client, email, password)
    print(json.dumps({
        "server": "http://localhost:8000",
        "web": "http://localhost:5173",
        "tag": tag,
        "person": {"id": user["id"], "email": email, "name": name, "token": token},
    }))


def _session():
    from sqlmodel import Session

    from app.core.db import engine

    return Session(engine)


def _owned_test_credential(session, credential_id: str):
    """Exactly that credential, and only when an ``oauth-slot-e2e-`` person owns it."""
    from app.models.credentials.credential import Credential
    from app.models.users.user import User

    credential = session.get(Credential, uuid.UUID(credential_id))
    if credential is None:
        raise SystemExit(f"no credential {credential_id}")
    owner = session.get(User, credential.owner_id)
    if owner is None or not owner.email.startswith(PREFIX):
        raise SystemExit(f"credential {credential_id} is not owned by a {PREFIX} person; refusing")
    return credential, owner


def inspect(credential_id: str) -> None:
    from app.services.credentials.credentials_service import CredentialsService
    from app.services.credentials.oauth_refresh_service import oauth_status

    with _session() as session:
        credential, owner = _owned_test_credential(session, credential_id)
        try:
            data = CredentialsService.decrypt_credential_data(session, credential)
        except Exception:
            data = {}
        print(json.dumps({
            "id": str(credential.id),
            "type": credential.type.value,
            "service_uri": credential.service_uri,
            "owner_email": owner.email,
            "oauth_status": oauth_status(data),
        }))


def ready(credential_id: str) -> None:
    from app.core.security import encrypt_field

    with _session() as session:
        credential, owner = _owned_test_credential(session, credential_id)
        if credential.type.value not in GOOGLE_TYPES:
            raise SystemExit(f"credential {credential_id} is {credential.type.value}, not a Google OAuth type; refusing")
        now = int(time.time())
        blob = {
            "access_token": f"ya29.e2e-oauth-slot-{credential_id[:8]}",
            "refresh_token": "e2e-oauth-slot-fake-refresh",
            "token_type": "Bearer",
            "expires_at": now + 7200,
            "scope": "https://www.googleapis.com/auth/gmail.readonly",
            "granted_user_email": owner.email,
            "granted_user_name": "OAuth Slot E2E",
            "granted_at": now,
        }
        credential.encrypted_data = encrypt_field(json.dumps(blob))
        session.add(credential)
        session.commit()
        print(json.dumps({"ok": True}))


def delete(credential_id: str) -> None:
    from app.services.credentials.credentials_service import CredentialsService

    with _session() as session:
        credential, owner = _owned_test_credential(session, credential_id)
        asyncio.run(CredentialsService.delete_credential(session=session, credential_id=credential.id, owner_id=owner.id))
        print(json.dumps({"deleted": str(credential.id)}))


def cleanup(user_id: str) -> None:
    from sqlmodel import select

    from app.models.credentials.credential import Credential
    from app.models.users.user import User
    from app.services.credentials.credentials_service import CredentialsService

    with _session() as session:
        user = session.get(User, uuid.UUID(user_id))
        if user is None:
            print(json.dumps({"credentials": 0, "users": 0}))
            return
        if not user.email.startswith(PREFIX):
            raise SystemExit(f"user {user_id} is not an {PREFIX} person; refusing")
        ids = [c.id for c in session.exec(select(Credential).where(Credential.owner_id == user.id)).all()]
        for credential_id in ids:
            asyncio.run(CredentialsService.delete_credential(session=session, credential_id=credential_id, owner_id=user.id))
    with httpx.Client(base_url=BASE, timeout=60) as client:
        admin = login(client, os.environ["FIRST_SUPERUSER"], os.environ["FIRST_SUPERUSER_PASSWORD"])
        ok(client.delete(f"{API}/users/{user_id}", headers={"Authorization": f"Bearer {admin}"}))
    print(json.dumps({"credentials": len(ids), "users": 1}))


if __name__ == "__main__":
    command, *args = sys.argv[1:] or [""]
    commands = {"create": create, "inspect": inspect, "ready": ready, "delete": delete, "cleanup": cleanup}
    if command not in commands:
        raise SystemExit(f"usage: python - {{{'|'.join(commands)}}} [id]")
    commands[command](*args)
