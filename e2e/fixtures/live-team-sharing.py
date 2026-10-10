"""Disposable cinna-core state for the live team-sharing specs.

Run inside cinna-core's backend container, with this file on stdin, so that
nothing is imported from the container's bind-mounted source tree (only the
venv's ``httpx``) and the superuser's password is read from the container's
own environment, never from a file and never printed:

    umask 077
    docker compose exec -T backend python - create < e2e/fixtures/live-team-sharing.py > /tmp/team-sharing.json
    npx electron-vite build
    CINNA_SHARING_LIVE_FIXTURE=/tmp/team-sharing.json make e2e-one SPEC=live-team-sharing   # all four specs
    docker compose exec -T backend python - cleanup < e2e/fixtures/live-team-sharing.py
    rm /tmp/team-sharing.json

Run the docker commands from cinna-core's checkout ($CINNA_CORE_PATH), with this
file's path relative to it. The specs leave core as they found it apart from
what cleanup removes: each test's agent is a fresh catalog entry, and the
specs that revoke, re-share or rotate a credential put it back.

``create`` signs up three people (A, B, C), has the first superuser ("admin")
create two ``api_token`` service credentials — ``Acme API <tag>`` with
``service_uri: acme-api``, shared with A and B, and ``Acme API (other) <tag>``
shared with nobody — and prints one JSON document: each person's id, email and
web access token (eight days), the admin's token, and the credential ids.
Desktop tokens are not minted here: core's live fifteen minutes and rotate, so
the spec mints a fresh pair for every app it launches (``liveTeamSharing.ts``).

``cleanup`` removes everything any run of this script made, found by the
``team-sharing-e2e-`` email prefix rather than by a fixture file, so a lost
fixture leaves nothing behind: every desktop agent in the catalog those people
publish or maintain (and any left without a publisher whose slug is a test
agent's, ``acme-reporter-<tag>-…``), with its repository, versions, grants and
reported local installs; the admin's ``Acme API … <tag>`` credentials; and the
people. Core keeps a desktop agent when its creator is deleted and refuses to
delete one while another person reports holding it, so the agents are listed
first (``scope=all``), the people deleted next (their local installs go with
them), and the agents deleted last. It prints counts only.

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
PREFIX = "team-sharing-e2e-"
CRED_NAME = "Acme API"
CRED_OTHER = "Acme API (other)"
# The slug of every agent the specs make: "Acme reporter <tag> <4 hex>" (liveTeamSharing.ts agentName).
AGENT_SLUG = re.compile(r"^acme-reporter-[0-9a-f]{8}-[0-9a-f]{4}(-mine)?$")


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
    for label in ("a", "b", "c"):
        email = f"{PREFIX}{label}-{tag}@example.com"
        password = uuid.uuid4().hex + "A!9"
        user = ok(client.post(f"{API}/users/signup", json={"email": email, "password": password, "full_name": f"Sharer {label.upper()} {tag}"})).json()
        people[label] = {"id": user["id"], "email": email, "name": f"Sharer {label.upper()} {tag}", "token": login(client, email, password)}

    def credential(name: str, secret: str) -> str:
        body = {
            "name": name,
            "type": "api_token",
            "service_uri": "acme-api",
            "allow_sharing": True,
            "allow_local_use": True,
            "credential_data": {"api_token_type": "bearer", "api_token": secret},
        }
        return ok(client.post(f"{API}/credentials/", headers=bearer(admin), json=body)).json()["id"]

    acme = credential(f"{CRED_NAME} {tag}", f"acme-shared-secret-{tag}")
    other = credential(f"{CRED_OTHER} {tag}", f"acme-other-secret-{tag}")
    shares = {}
    for label in ("a", "b"):
        r = ok(client.post(f"{API}/credentials/{acme}/shares", headers=bearer(admin), json={"shared_with_email": people[label]["email"]}))
        shares[label] = r.json()["id"]
    print(json.dumps({
        "server": "http://localhost:8000",
        "tag": tag,
        "admin": {"id": admin_id, "token": admin},
        "people": people,
        "credentials": {
            "acme": {"id": acme, "name": f"{CRED_NAME} {tag}", "secret": f"acme-shared-secret-{tag}", "shares": shares},
            "other": {"id": other, "name": f"{CRED_OTHER} {tag}", "secret": f"acme-other-secret-{tag}"},
        },
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

    # Desktop agents first, while their publisher and maintainers still name
    # the people: core detaches the publisher when a user is deleted.
    listed = ok(client.get(
        f"{API}/catalog/items",
        headers=bearer(admin),
        params={"kind": "agent", "runs_on": "desktop", "scope": "all"},
    )).json()["data"]
    doomed = []
    for item in listed:
        people = {(item.get("publisher") or {}).get("user_id")} | {m.get("user_id") for m in item.get("maintainers") or []}
        slug = (item.get("desktop") or {}).get("slug") or ""
        orphan = item.get("publisher") is None and AGENT_SLUG.match(slug) is not None
        if people & ids or orphan:
            doomed.append(item["uuid"])

    removed_users = 0
    for user in users:
        r = client.delete(f"{API}/users/{user['id']}", headers=bearer(admin))
        removed_users += r.status_code < 400

    removed_agents = 0
    refused_agents = 0
    for item_uuid in doomed:
        r = client.delete(f"{API}/catalog/items/{item_uuid}", headers=bearer(admin))
        if r.status_code in (204, 404):
            removed_agents += 1
        else:
            refused_agents += 1

    creds = ok(client.get(f"{API}/credentials/", headers=bearer(admin), params={"limit": 500})).json()
    removed_creds = 0
    for cred in creds.get("data", []):
        if cred["name"].startswith(CRED_NAME) and len(cred["name"].rsplit(" ", 1)[-1]) == 8:
            r = client.delete(f"{API}/credentials/{cred['id']}", headers=bearer(admin))
            removed_creds += r.status_code < 400
    print(json.dumps({
        "desktop_agents": removed_agents,
        "desktop_agents_refused": refused_agents,
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
            raise SystemExit("usage: python - create|cleanup < live-team-sharing.py")
