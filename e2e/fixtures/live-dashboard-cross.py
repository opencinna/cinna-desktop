"""Disposable cinna-core state for ``live-dashboard-cross.spec.ts`` (Dashboards across desktop, core and CLI).

Same shape and calling convention as ``live-dashboard-cloud.py`` (run it inside
cinna-core's backend container with this file on stdin; the AI keys are passed by
name), but with its own people, agents and marker, so neither script's cleanup
can ever match the other's data:

    umask 077
    export CINNA_E2E_OPENAI_KEY="$(grep '^OPENAI_API_KEY=' <desktop>/.env | cut -d= -f2-)"
    export CINNA_E2E_ANTHROPIC_KEY="$(grep '^ANTHROPIC_API_KEY=' <desktop>/.env | cut -d= -f2-)"
    docker compose exec -T -e CINNA_E2E_OPENAI_KEY -e CINNA_E2E_ANTHROPIC_KEY -e CINNA_E2E_LIVE_MODEL \\
      backend python - create opencode claude-haiku < <desktop>/e2e/fixtures/live-dashboard-cross.py > /tmp/dashcross.json
    CINNA_DASHBOARD_CROSS_LIVE_FIXTURE=/tmp/dashcross.json make e2e-one SPEC=e2e/specs/live-dashboard-cross.spec.ts
    docker compose exec -T backend python - cleanup < <desktop>/e2e/fixtures/live-dashboard-cross.py
    rm /tmp/dashcross.json

Run the docker commands from cinna-core's checkout ($CINNA_CORE_PATH), at
``c32f211b`` or later (the CLI's ``dashboards/capabilities`` route) with
migration ``7c1d4e8a2b90`` applied.

``create <engine>…`` (``opencode`` and/or ``claude-haiku``) signs up one person,
``dashcross-e2e-<tag>@example.com``, makes them an ``agent-developer`` (so they
can mint a CLI account setup token), and per engine gives them an AI credential
(``openai`` for ``opencode`` with ``gpt-5.6-luna``, ``anthropic`` for
``claude-haiku`` with ``claude-haiku-4-5``; ``CINNA_E2E_LIVE_MODEL`` overrides),
and creates the cloud agent ``Dash cross e2e <engine> <tag>``, waiting until its
environment runs. **It writes no component**: the spec authors them through
cinna-cli, which is part of what it proves.

``cleanup`` removes only what a run of this script made: agents whose owner's
email is exactly ``dashcross-e2e-<8 hex>@example.com`` **and** whose name is
exactly ``Dash cross e2e <engine> <8 hex>`` **and** whose description or
workflow prompt is this script's marker; then those people (their AI
credentials, CLI tokens and every dashboard, desktop-owned backing ones
included, cascade). It prints counts only.

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
PREFIX = "dashcross-e2e-"
EMAIL_PATTERN = re.compile(r"^dashcross-e2e-[0-9a-f]{8}@example\.com$")
MARKER = "Made by cinna-desktop e2e/fixtures/live-dashboard-cross.py; cleanup deletes it."
NAME = "Dash cross e2e"
NAME_PATTERN = re.compile(r"^Dash cross e2e (opencode|claude-haiku) [0-9a-f]{8}$")
DESCRIPTION = "Keeps a small ledger for the desktop/core/CLI dashboards e2e. " + MARKER
# Set at create so core never asks a model to rewrite the description from the template's prompt.
WORKFLOW = (
    "# Dash cross e2e\n\nYou keep a small ledger. Answer in one short sentence. "
    "When asked to repeat a line verbatim, reply with exactly that line on its own, outside backticks. "
    "When the user asks about what they see on a dashboard, read the dashboard context you are given. "
    "When asked to change a tile, use your dashboards tools.\n\n" + MARKER + "\n"
)

ENGINES = {
    "opencode": {"sdk": "opencode/openai", "type": "openai", "key_env": "CINNA_E2E_OPENAI_KEY", "model": "gpt-5.6-luna"},
    "claude-haiku": {"sdk": "claude-code/anthropic", "type": "anthropic", "key_env": "CINNA_E2E_ANTHROPIC_KEY", "model": "claude-haiku-4-5"},
}


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


def read_key(name: str) -> str:
    key = os.environ.get(name, "").strip().strip('"').strip("'")
    if not key:
        raise SystemExit(f"{name} is empty: pass the key by name (docker compose exec -e {name})")
    return key


def create(client: httpx.Client, engines: list[str]) -> None:
    for engine in engines:
        if engine not in ENGINES:
            raise SystemExit(f"unknown engine {engine!r}: use {', '.join(ENGINES)}")
    keys = {engine: read_key(ENGINES[engine]["key_env"]) for engine in engines}
    model_override = os.environ.get("CINNA_E2E_LIVE_MODEL", "").strip()
    tag = uuid.uuid4().hex[:8]
    admin, admin_id = admin_token(client)
    email = f"{PREFIX}{tag}@example.com"
    password = uuid.uuid4().hex + "A!9"
    full_name = f"Cross Owner {tag}"
    user = ok(client.post(f"{API}/users/signup", json={"email": email, "password": password, "full_name": full_name})).json()
    token = login(client, email, password)
    person = {"id": user["id"], "email": email, "name": full_name, "token": token}
    ok(client.patch(f"{API}/users/{user['id']}/role", headers=bearer(admin), json={"role": "agent-developer"}))

    agents = {}
    for engine in engines:
        spec = ENGINES[engine]
        model = model_override or spec["model"]
        cred = ok(client.post(f"{API}/ai-credentials/", headers=bearer(token), json={
            "name": f"{spec['type']} dashcross-e2e {tag}", "type": spec["type"], "api_key": keys[engine],
        })).json()
        ok(client.post(f"{API}/ai-credentials/{cred['id']}/set-default", headers=bearer(token)))
        ok(client.patch(f"{API}/users/me", headers=bearer(token), json={
            "default_sdk_conversation": spec["sdk"],
            "default_sdk_building": spec["sdk"],
            "default_ai_credential_conversation_id": cred["id"],
            "default_ai_credential_building_id": cred["id"],
            "default_model_override_conversation": model,
            "default_model_override_building": model,
        }))
        name = f"{NAME} {engine} {tag}"
        agent = ok(client.post(f"{API}/agents/", headers=bearer(token), json={
            "name": name,
            "description": DESCRIPTION,
            "workflow_prompt": WORKFLOW,
            "entrypoint_prompt": "Ask about the ledger.",
            "refiner_prompt": "",
        }, timeout=120)).json()
        env_id = wait_running(client, token, agent["id"], name)
        env = ok(client.get(f"{API}/environments/{env_id}", headers=bearer(token))).json()
        agents[engine] = {
            "id": agent["id"],
            "name": name,
            "envId": env_id,
            "sdk": env.get("agent_sdk_conversation"),
            "model": env.get("model_override_conversation") or model,
        }

    print(json.dumps({
        "server": "http://localhost:8000",
        "tag": tag,
        "admin": {"id": admin_id, "token": admin},
        "people": {"a": person},
        "agents": agents,
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
    removed = {"agents": 0, "users": 0, "refused": []}
    for agent in agents.values():
        r = client.delete(f"{API}/agents/{agent['id']}", headers=bearer(admin), timeout=120)
        if r.status_code < 400:
            removed["agents"] += 1
        else:
            removed["refused"].append(f"agent {agent['id']}: {r.status_code} {r.text[:160]}")
    for user in users:
        r = client.delete(f"{API}/users/{user['id']}", headers=bearer(admin))
        if r.status_code < 400:
            removed["users"] += 1
        else:
            removed["refused"].append(f"user {user['id']}: {r.status_code} {r.text[:160]}")
    print(json.dumps(removed))


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    with httpx.Client(base_url=BASE, timeout=30) as http:
        if command == "create":
            create(http, sys.argv[2:] or ["opencode", "claude-haiku"])
        elif command == "cleanup":
            cleanup(http)
        else:
            raise SystemExit("usage: python - create [opencode] [claude-haiku] | cleanup < live-dashboard-cross.py")
