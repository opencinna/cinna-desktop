"""Disposable cinna-core state for the live catalog specs (``live-catalog-*.spec.ts``).

Run inside cinna-core's backend container, with this file on stdin, exactly as
``live-team-sharing.py`` is run (only the venv's ``httpx`` is imported, and the
superuser's password is read from the container's own environment):

    umask 077
    docker compose exec -T backend python - create < e2e/fixtures/live-catalog.py > /tmp/catalog.json
    npx electron-vite build
    CINNA_CATALOG_LIVE_FIXTURE=/tmp/catalog.json make e2e-one SPEC=live-catalog-agents
    docker compose exec -T backend python - cleanup < e2e/fixtures/live-catalog.py
    rm /tmp/catalog.json

Run the docker commands from cinna-core's checkout ($CINNA_CORE_PATH), with this
file's path relative to it.

``create`` signs up four people (A, B, C, D; D only ever appears as the
person a skill was not shared with, ``live-sharing-skill-audiences.spec.ts``), has the first superuser ("admin")
create one ``api_token`` service credential ``ERP API catalog-e2e <tag>`` with
``service_uri: erp-api``, Allow local use and sharing on, shared with A and B
(not C), and prints one JSON document in the shape ``liveTeamSharing.ts``
reads (people with their web tokens, the admin's token) plus
``credentials.erp``. It also names one cloud agent (``runs_on: cloud``) the
catalog lists to everyone (public and listed), when there is one: creating a
cloud bundle needs a publisher's cloud environment, which a local stack does
not run, so the specs use an existing public one read-only and never install it.

``cleanup`` removes everything any run made, found by the ``catalog-e2e-``
email prefix rather than by a fixture file: every desktop agent and skill
package those people publish or maintain (with their repositories, versions,
grants and reported local installs), the admin's ``ERP API catalog-e2e <tag>``
credentials carrying this script's notes marker (their shares, including those ``provision-local`` made, go with
them), and the people. Items are listed first (``scope=all``), the people
deleted next (their local installs go with them, which lifts core's "N people
use this" guard), the items last. It prints counts only.

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
PREFIX = "catalog-e2e-"
CRED_NAME = "ERP API catalog-e2e"
# Only credentials this script made: the exact name shape and the notes marker.
CRED_PATTERN = re.compile(r"^ERP API catalog-e2e [0-9a-f]{8}$")
CRED_NOTES = "Made by cinna-desktop e2e/fixtures/live-catalog.py; cleanup deletes it."


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


def create(client: httpx.Client) -> None:
    tag = uuid.uuid4().hex[:8]
    admin, admin_id = admin_token(client)
    people = {}
    for label in ("a", "b", "c", "d"):
        email = f"{PREFIX}{label}-{tag}@example.com"
        password = uuid.uuid4().hex + "A!9"
        name = f"Cataloger {label.upper()} {tag}"
        user = ok(client.post(f"{API}/users/signup", json={"email": email, "password": password, "full_name": name})).json()
        people[label] = {"id": user["id"], "email": email, "name": name, "token": login(client, email, password)}

    secret = f"erp-shared-secret-{tag}"
    erp = ok(client.post(f"{API}/credentials/", headers=bearer(admin), json={
        "name": f"{CRED_NAME} {tag}",
        "notes": CRED_NOTES,
        "type": "api_token",
        "service_uri": "erp-api",
        "allow_sharing": True,
        "allow_local_use": True,
        "credential_data": {"api_token_type": "bearer", "api_token": secret},
    })).json()["id"]
    shares = {}
    for label in ("a", "b"):
        r = ok(client.post(f"{API}/credentials/{erp}/shares", headers=bearer(admin), json={"shared_with_email": people[label]["email"]}))
        shares[label] = r.json()["id"]

    # A cloud agent B can see without a grant: public and listed. Read only.
    listed = ok(client.get(f"{API}/catalog/items", headers=bearer(people["b"]["token"]), params={"kind": "agent", "runs_on": "cloud"})).json()["data"]
    cloud = next(({"uuid": i["uuid"], "id": i["id"], "display_name": i["display_name"]} for i in listed if i.get("visibility") == "public"), None)

    print(json.dumps({
        "server": "http://localhost:8000",
        "tag": tag,
        "admin": {"id": admin_id, "token": admin},
        "people": people,
        "credentials": {"erp": {"id": erp, "name": f"{CRED_NAME} {tag}", "secret": secret, "shares": shares}},
        "cloudAgent": cloud,
    }))


def cleanup(client: httpx.Client) -> None:
    admin, _ = admin_token(client)
    users = []
    skip = 0
    while True:
        page = ok(client.get(f"{API}/users/", headers=bearer(admin), params={"skip": skip, "limit": 100})).json()
        users += [u for u in page["data"] if u["email"].startswith(PREFIX)]
        skip += 100
        if skip >= page["count"]:
            break
    ids = {u["id"] for u in users}

    # Items first, while their publisher and maintainers still name the people.
    doomed = []
    for params in ({"kind": "agent", "runs_on": "desktop", "scope": "all"}, {"kind": "skill", "scope": "all"}):
        for item in ok(client.get(f"{API}/catalog/items", headers=bearer(admin), params=params)).json()["data"]:
            people = {(item.get("publisher") or {}).get("user_id")} | {m.get("user_id") for m in item.get("maintainers") or []}
            if people & ids:
                doomed.append((item["kind"], item["uuid"]))

    removed_users = 0
    for user in users:
        r = client.delete(f"{API}/users/{user['id']}", headers=bearer(admin))
        removed_users += r.status_code < 400

    removed = {"agent": 0, "skill": 0}
    refused = []
    for kind, item_uuid in doomed:
        r = client.delete(f"{API}/catalog/items/{item_uuid}", headers=bearer(admin))
        if r.status_code in (204, 404):
            removed[kind] += 1
        else:
            refused.append(f"{kind} {item_uuid}: {r.status_code} {r.text[:160]}")

    creds = ok(client.get(f"{API}/credentials/", headers=bearer(admin), params={"limit": 500})).json()
    removed_creds = 0
    for cred in creds.get("data", []):
        if CRED_PATTERN.match(cred["name"]) and cred.get("notes") == CRED_NOTES:
            r = client.delete(f"{API}/credentials/{cred['id']}", headers=bearer(admin))
            removed_creds += r.status_code < 400
    print(json.dumps({
        "desktop_agents": removed["agent"],
        "skills": removed["skill"],
        "refused": refused,
        "credentials": removed_creds,
        "users": removed_users,
    }))


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    with httpx.Client(base_url=BASE, timeout=30) as http:
        if command == "create":
            create(http)
        elif command == "cleanup":
            cleanup(http)
        else:
            raise SystemExit("usage: python - create|cleanup < live-catalog.py")
