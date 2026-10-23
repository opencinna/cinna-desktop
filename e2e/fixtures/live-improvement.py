"""Disposable cinna-core state for ``live-improvement-request.spec.ts``.

Run inside cinna-core's backend container with this file on stdin, as the other
live fixtures are (only the venv's ``httpx`` is imported; the superuser's
password is read from the container's own environment). The OpenAI key the two
cloud environments really run on is passed in by name, never on the command
line:

    umask 077
    export CINNA_E2E_OPENAI_KEY="$(grep '^OPENAI_API_KEY=' <desktop>/.env | cut -d= -f2-)"
    docker compose exec -T -e CINNA_E2E_OPENAI_KEY backend python - create < <desktop>/e2e/fixtures/live-improvement.py > /tmp/improvement.json
    CINNA_IMPROVEMENT_LIVE_FIXTURE=/tmp/improvement.json make e2e-one SPEC=e2e/specs/live-improvement-request.spec.ts
    docker compose exec -T backend python - cleanup < <desktop>/e2e/fixtures/live-improvement.py
    rm /tmp/improvement.json

Run the docker commands from cinna-core's checkout ($CINNA_CORE_PATH).

``create`` signs up two people, ``improve-e2e-a-<tag>@example.com`` (the
publisher) and ``improve-e2e-b-<tag>@example.com`` (the consumer), gives each an
``openai`` AI credential carrying the key and makes ``opencode/openai`` their
default conversation SDK, makes A an ``agent-developer``, has A create the cloud
agent ``Improve e2e <tag>`` (description and workflow prompt carry this
script's marker), waits for its environment, publishes it as a bundle B may use
(``users``, listed, a ``use`` grant), installs it as B (a consumer install,
``is_publisher_install: false``) and waits for that environment too. It prints
one JSON document in the shape ``liveTeamSharing.ts`` reads (people with their
web tokens, the admin's token) plus ``cloud``. Both environments really run a
model on that key; nothing here does — the spec makes the one turn.

``cleanup`` removes only what a run of this script made, found by the exact
email shape ``improve-e2e-[ab]-<8 hex>@example.com`` **and** — for agents and
bundles — the exact name ``Improve e2e <8 hex>`` **and** this script's
description marker: B's installs first (core's uninstall stops their
containers), then the bundle, then A's agent, then the people (their AI
credentials and every improvement request they sent or received go with them:
both foreign keys cascade). It prints counts only.

The JSON holds bearer tokens: keep it private (``umask 077``), outside the
repository, and delete it after the run.
"""
import json
import os
import re
import sys
import time
import uuid

import httpx

BASE = os.environ.get("CINNA_E2E_CORE_INTERNAL", "http://127.0.0.1:8000")
API = "/api/v1"
PREFIX = "improve-e2e-"
EMAIL_PATTERN = re.compile(r"^improve-e2e-[ab]-[0-9a-f]{8}@example\.com$")
MARKER = "Made by cinna-desktop e2e/fixtures/live-improvement.py; cleanup deletes it."
NAME = "Improve e2e"
NAME_PATTERN = re.compile(r"^Improve e2e [0-9a-f]{8}$")
DESCRIPTION = "Answers in one short sentence, for the desktop improvement-request e2e. " + MARKER
# Set at create so core never asks a model to rewrite the description from the template's prompt.
WORKFLOW = (
    "# Improve e2e\n\nYou are a terse assistant. Answer every message in one short sentence. "
    "Never use tools.\n\n" + MARKER + "\n"
)
SDK = "opencode/openai"


def ok(response: httpx.Response) -> httpx.Response:
    if response.status_code >= 400:
        raise SystemExit(f"{response.request.method} {response.request.url.path} -> {response.status_code}: {response.text[:300]}")
    return response


def login(client: httpx.Client, email: str, password: str) -> str:
    return ok(client.post(f"{API}/login/access-token", data={"username": email, "password": password})).json()["access_token"]


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def admin_token(client: httpx.Client) -> tuple[str, str]:
    token = login(client, os.environ["FIRST_SUPERUSER"], os.environ["FIRST_SUPERUSER_PASSWORD"])
    me = ok(client.get(f"{API}/users/me", headers=bearer(token))).json()
    return token, me["id"]


def wait_for_core(client: httpx.Client, seconds: float = 90) -> None:
    """A bundle publish copies the workspace under /app/data, which reloads core's dev server."""
    deadline = time.monotonic() + seconds
    time.sleep(2)
    while time.monotonic() < deadline:
        try:
            if client.get(f"{API}/utils/health-check/").status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(1)
    raise SystemExit("core did not come back after the bundle publish")


def wait_running(client: httpx.Client, token: str, agent_id: str, label: str, seconds: float = 300) -> str:
    deadline = time.monotonic() + seconds
    status = "no environment yet"
    while time.monotonic() < deadline:
        agent = ok(client.get(f"{API}/agents/{agent_id}", headers=bearer(token))).json()
        env_id = agent.get("active_environment_id")
        if env_id:
            env = ok(client.get(f"{API}/environments/{env_id}", headers=bearer(token))).json()
            status = env["status"]
            if status == "running":
                return env_id
            if status == "error":
                raise SystemExit(f"{label}'s environment failed: {env.get('status_message')}")
        time.sleep(3)
    raise SystemExit(f"{label}'s environment was still {status!r} after {seconds:.0f} s")


def read_key() -> str:
    key = os.environ.get("CINNA_E2E_OPENAI_KEY", "").strip().strip('"').strip("'")
    if not key:
        raise SystemExit("CINNA_E2E_OPENAI_KEY is empty: pass the OpenAI key by name (docker compose exec -e CINNA_E2E_OPENAI_KEY)")
    return key


def create(client: httpx.Client) -> None:
    key = read_key()
    tag = uuid.uuid4().hex[:8]
    admin, admin_id = admin_token(client)
    people = {}
    creds = {}
    for label, full in (("a", "Publisher"), ("b", "Consumer")):
        email = f"{PREFIX}{label}-{tag}@example.com"
        password = uuid.uuid4().hex + "A!9"
        name = f"Improve {full} {tag}"
        user = ok(client.post(f"{API}/users/signup", json={"email": email, "password": password, "full_name": name})).json()
        token = login(client, email, password)
        people[label] = {"id": user["id"], "email": email, "name": name, "token": token}
        made = ok(client.post(f"{API}/ai-credentials/", headers=bearer(token), json={
            "name": f"OpenAI improve-e2e {tag}", "type": "openai", "api_key": key,
        })).json()
        ok(client.post(f"{API}/ai-credentials/{made['id']}/set-default", headers=bearer(token)))
        ok(client.patch(f"{API}/users/me", headers=bearer(token), json={"default_sdk_conversation": SDK}))
        creds[label] = made["id"]
    a, b = people["a"], people["b"]
    ok(client.patch(f"{API}/users/{a['id']}/role", headers=bearer(admin), json={"role": "agent-developer"}))

    name = f"{NAME} {tag}"
    agent = ok(client.post(f"{API}/agents/", headers=bearer(a["token"]), json={
        "name": name,
        "description": DESCRIPTION,
        "workflow_prompt": WORKFLOW,
        "entrypoint_prompt": "Say something.",
        "refiner_prompt": "",
    }, timeout=120)).json()
    agent_id = agent["id"]
    wait_running(client, a["token"], agent_id, "the publisher's agent")

    try:
        r = client.post(f"{API}/agents/{agent_id}/publish", headers=bearer(a["token"]), json={
            "release_notes": "Version 1 from the improvement e2e fixture",
            "display_name": name,
            "description": DESCRIPTION,
            "version": "1.0",
        }, timeout=120)
        ok(r)
    except httpx.HTTPError:
        pass
    wait_for_core(client)
    agent = ok(client.get(f"{API}/agents/{agent_id}", headers=bearer(a["token"]))).json()
    listed = ok(client.get(f"{API}/catalog/items", headers=bearer(a["token"]), params={"kind": "agent", "runs_on": "cloud"})).json()["data"]
    item = next((i for i in listed if i["id"] == agent.get("bundle_id")), None)
    if item is None:
        raise SystemExit("the published bundle is not in A's catalog (did the publish land?)")
    ok(client.patch(f"{API}/catalog/items/{item['uuid']}", headers=bearer(a["token"]), json={"visibility": "users", "is_listed": True}))
    grants = ok(client.get(f"{API}/catalog/items/{item['uuid']}/grants", headers=bearer(a["token"]))).json()
    grants = [{"principal": g["principal"], "access": g["access"]} for g in grants if g["principal"].get("user_id") != b["id"]]
    grants.append({"principal": {"user_id": b["id"]}, "access": "use"})
    ok(client.put(f"{API}/catalog/items/{item['uuid']}/grants", headers=bearer(a["token"]), json=grants))

    install = ok(client.post(f"{API}/catalog/{item['id']}/install", headers=bearer(b["token"]), json={
        "ai_credential_selections": {"conversation_credential_id": creds["b"]},
    }, timeout=180)).json()
    if not install.get("bundle_uuid") or install.get("is_publisher_install") is not False:
        raise SystemExit(f"B's install is not a consumer install: bundle_uuid={install.get('bundle_uuid')} is_publisher_install={install.get('is_publisher_install')}")
    install_env = wait_running(client, b["token"], install["id"], "B's install")
    env = ok(client.get(f"{API}/environments/{install_env}", headers=bearer(b["token"]))).json()

    print(json.dumps({
        "server": "http://localhost:8000",
        "tag": tag,
        "admin": {"id": admin_id, "token": admin},
        "people": people,
        "cloud": {
            "name": name,
            "publisherAgentId": agent_id,
            "installId": install["id"],
            "installEnvId": install_env,
            "installSdk": env.get("agent_sdk_conversation"),
            "bundleId": item["id"],
            "bundleUuid": item["uuid"],
        },
    }))


def cleanup(client: httpx.Client) -> None:
    admin, _ = admin_token(client)
    users = []
    skip = 0
    while True:
        page = ok(client.get(f"{API}/users/", headers=bearer(admin), params={"skip": skip, "limit": 100})).json()
        users += [u for u in page["data"] if EMAIL_PATTERN.match(u["email"] or "")]
        skip += 100
        if skip >= page["count"]:
            break
    ids = {u["id"] for u in users}

    agents: dict[str, dict] = {}
    for owner in ids:
        envs = ok(client.get(f"{API}/admin/agent-environments/", headers=bearer(admin), params={"owner_id": owner, "limit": 500})).json()["data"]
        for env in envs:
            if env["agent_id"] in agents:
                continue
            r = client.get(f"{API}/agents/{env['agent_id']}", headers=bearer(admin))
            if r.status_code != 200:
                continue
            agent = r.json()
            marked = agent.get("description") == DESCRIPTION or agent.get("workflow_prompt") == WORKFLOW
            if agent.get("owner_id") in ids and NAME_PATTERN.match(agent.get("name") or "") and marked:
                agents[agent["id"]] = agent
    removed = {"installs": 0, "bundles": 0, "agents": 0, "users": 0, "refused": []}
    for agent in agents.values():
        if agent.get("bundle_uuid") and agent.get("is_publisher_install") is False:
            r = client.post(f"{API}/agents/{agent['id']}/uninstall", headers=bearer(admin), timeout=120)
            if r.status_code < 400:
                removed["installs"] += 1
            else:
                removed["refused"].append(f"install {agent['id']}: {r.status_code} {r.text[:160]}")
    items = ok(client.get(f"{API}/catalog/items", headers=bearer(admin), params={"kind": "agent", "runs_on": "cloud", "scope": "all"})).json()["data"]
    for item in items:
        publisher = (item.get("publisher") or {}).get("user_id")
        if publisher in ids and NAME_PATTERN.match(item.get("display_name") or "") and item.get("description") == DESCRIPTION:
            r = client.delete(f"{API}/catalog/items/{item['uuid']}", headers=bearer(admin))
            if r.status_code in (204, 404):
                removed["bundles"] += 1
            else:
                removed["refused"].append(f"bundle {item['uuid']}: {r.status_code} {r.text[:160]}")
    for agent in agents.values():
        if agent.get("bundle_uuid") and agent.get("is_publisher_install") is False:
            continue
        r = client.delete(f"{API}/agents/{agent['id']}", headers=bearer(admin), timeout=120)
        if r.status_code < 400:
            removed["agents"] += 1
        else:
            removed["refused"].append(f"agent {agent['id']}: {r.status_code} {r.text[:160]}")
    for user in users:
        r = client.delete(f"{API}/users/{user['id']}", headers=bearer(admin))
        removed["users"] += r.status_code < 400
    print(json.dumps(removed))


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    with httpx.Client(base_url=BASE, timeout=30) as http:
        if command == "create":
            create(http)
        elif command == "cleanup":
            cleanup(http)
        else:
            raise SystemExit("usage: python - create|cleanup < live-improvement.py")
