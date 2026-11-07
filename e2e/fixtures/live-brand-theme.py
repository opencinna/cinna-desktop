"""Disposable cinna-core state for the live brand-theme spec.

Run inside cinna-core's backend container, with this file on stdin, so that
nothing is imported from the container's bind-mounted source tree (only the
venv's ``httpx``) and the superuser's password is read from the container's
own environment, never from a file and never printed:

    umask 077
    docker compose exec -T backend python - create < e2e/fixtures/live-brand-theme.py > /tmp/brand-theme.json
    npx electron-vite build
    CINNA_BRAND_LIVE_FIXTURE=/tmp/brand-theme.json make e2e-one SPEC=e2e/specs/live-brand-theme.spec.ts
    docker compose exec -T backend python - cleanup < e2e/fixtures/live-brand-theme.py
    rm /tmp/brand-theme.json

Run the docker commands from cinna-core's checkout ($CINNA_CORE_PATH), with this
file's path relative to it.

``create`` refuses to run while the core has a published brand theme it did not
make: a server has exactly one, and the spec publishes and unpublishes its own,
so it would take a real brand off every desktop signed in to it. Otherwise it
signs up two people (A, B), logs in as the first superuser ("admin"), and
prints one JSON document: the server, a tag, the admin's web token, and each
person's id, email, name and web token. Themes are not uploaded here: the spec
uploads and publishes them itself, through the admin API and the admin page, so
it controls when each revision goes live.

``cleanup`` removes what any run made, found by name rather than by a fixture
file, so a lost fixture leaves nothing behind: it unpublishes the published
theme only when its name is one of the spec's (``E2E Brand <8 hex> …``, an
exact pattern; a looser match once destroyed a real credential on this core),
deletes every draft with such a name, deletes the people whose email starts
with ``brand-theme-e2e-``, and then (their local installs gone with them) the
catalog skills test 5 publishes as the admin: name exactly
``brand-theme-e2e-<8 hex>-<4 hex>`` *and* published by this admin. It prints
counts only.

The JSON holds bearer tokens: keep it private (``umask 077``), outside the
repository, and delete it after the run.
"""
import json
import os
import re
import sys
import uuid

import httpx

BASE = os.environ.get("CINNA_E2E_CORE_INTERNAL", "http://127.0.0.1:8000")
API = "/api/v1"
PREFIX = "brand-theme-e2e-"
# Only themes the spec made: liveBrandTheme.ts themeName().
THEME_NAME = re.compile(r"^E2E Brand [0-9a-f]{8}( [A-Za-z0-9]+)?$")
# Only the catalog skill test 5 publishes as the admin: the spec's brandSkillName().
SKILL_NAME = re.compile(r"^brand-theme-e2e-[0-9a-f]{8}-[0-9a-f]{4}$")


def ok(response: httpx.Response) -> httpx.Response:
    if response.status_code >= 400:
        raise SystemExit(f"{response.request.method} {response.request.url.path} -> {response.status_code}: {response.text[:300]}")
    return response


def login(client: httpx.Client, email: str, password: str) -> str:
    r = ok(client.post(f"{API}/login/access-token", data={"username": email, "password": password}))
    return r.json()["access_token"]


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def admin_token(client: httpx.Client) -> tuple[str, str]:
    email = os.environ["FIRST_SUPERUSER"]
    token = login(client, email, os.environ["FIRST_SUPERUSER_PASSWORD"])
    me = ok(client.get(f"{API}/users/me", headers=bearer(token))).json()
    return token, me["id"]


def drafts(client: httpx.Client, admin: str) -> list[dict]:
    return ok(client.get(f"{API}/admin/brand-theme/drafts", headers=bearer(admin))).json()["data"]


def create(client: httpx.Client) -> None:
    admin, admin_id = admin_token(client)
    foreign = [d for d in drafts(client, admin) if d["status"] == "published" and not THEME_NAME.match(d["name"])]
    if foreign:
        raise SystemExit(
            f"refusing: this core publishes the brand theme {foreign[0]['name']!r}; "
            "the spec would unpublish it. Unpublish it yourself (Admin -> Brand Theme) and run again."
        )
    tag = uuid.uuid4().hex[:8]
    people = {}
    for label in ("a", "b"):
        email = f"{PREFIX}{label}-{tag}@example.com"
        password = uuid.uuid4().hex + "A!9"
        name = f"Brand {label.upper()} {tag}"
        user = ok(client.post(f"{API}/users/signup", json={"email": email, "password": password, "full_name": name})).json()
        people[label] = {"id": user["id"], "email": email, "name": name, "token": login(client, email, password)}
    print(json.dumps({
        "server": "http://localhost:8000",
        "web": os.environ.get("FRONTEND_HOST", "http://localhost:5173"),
        "tag": tag,
        "admin": {"id": admin_id, "token": admin},
        "people": people,
    }))


def cleanup(client: httpx.Client) -> None:
    admin, admin_id = admin_token(client)
    ours = [d for d in drafts(client, admin) if THEME_NAME.match(d["name"])]
    unpublished = 0
    if any(d["status"] == "published" for d in ours):
        ok(client.post(f"{API}/admin/brand-theme/unpublish", headers=bearer(admin)))
        unpublished = 1
    removed_drafts = 0
    for draft in ours:
        r = client.delete(f"{API}/admin/brand-theme/drafts/{draft['id']}", headers=bearer(admin))
        removed_drafts += r.status_code in (204, 404)

    users = []
    skip = 0
    while True:
        page = ok(client.get(f"{API}/users/", headers=bearer(admin), params={"skip": skip, "limit": 100})).json()
        users += [u for u in page["data"] if u["email"].startswith(PREFIX)]
        skip += 100
        if skip >= page["count"]:
            break
    removed_users = 0
    for user in users:
        r = client.delete(f"{API}/users/{user['id']}", headers=bearer(admin))
        removed_users += r.status_code < 400

    # After the people: their reported local installs would block the delete (409).
    skills = [
        item for item in ok(client.get(f"{API}/catalog/items", headers=bearer(admin), params={"kind": "skill", "scope": "all"})).json()["data"]
        if SKILL_NAME.match(item.get("name") or "") and (item.get("publisher") or {}).get("user_id") == admin_id
    ]
    removed_skills = 0
    refused = []
    for item in skills:
        r = client.delete(f"{API}/catalog/items/{item['uuid']}", headers=bearer(admin))
        if r.status_code in (204, 404):
            removed_skills += 1
        else:
            refused.append(f"skill {item['name']}: {r.status_code} {r.text[:160]}")
    print(json.dumps({"unpublished": unpublished, "drafts": removed_drafts, "users": removed_users, "skills": removed_skills, "refused": refused}))


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    with httpx.Client(base_url=BASE, timeout=30) as http:
        if command == "create":
            create(http)
        elif command == "cleanup":
            cleanup(http)
        else:
            raise SystemExit("usage: python - create|cleanup < live-brand-theme.py")
