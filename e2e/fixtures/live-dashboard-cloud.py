"""Disposable cinna-core state for ``live-dashboard-cloud.spec.ts`` (Dashboards D6).

Run inside cinna-core's backend container with this file on stdin, as the other
live fixtures are (only the venv's ``httpx`` is imported; the superuser's
password is read from the container's own environment). The AI keys the cloud
environments really run on are passed in by name, never on the command line:

    umask 077
    export CINNA_E2E_OPENAI_KEY="$(grep '^OPENAI_API_KEY=' <desktop>/.env | cut -d= -f2-)"
    export CINNA_E2E_ANTHROPIC_KEY="$(grep '^ANTHROPIC_API_KEY=' <desktop>/.env | cut -d= -f2-)"
    docker compose exec -T -e CINNA_E2E_OPENAI_KEY -e CINNA_E2E_ANTHROPIC_KEY -e CINNA_E2E_LIVE_MODEL \\
      backend python - create opencode claude-haiku < <desktop>/e2e/fixtures/live-dashboard-cloud.py > /tmp/dashcloud.json
    CINNA_DASHBOARD_CLOUD_LIVE_FIXTURE=/tmp/dashcloud.json make e2e-one SPEC=e2e/specs/live-dashboard-cloud.spec.ts
    docker compose exec -T backend python - cleanup < <desktop>/e2e/fixtures/live-dashboard-cloud.py
    rm /tmp/dashcloud.json

Run the docker commands from cinna-core's checkout ($CINNA_CORE_PATH), which
must be at ``2fca550b`` or later with migration ``7c1d4e8a2b90`` applied
(``docker compose exec -T backend alembic current`` names it).

``create <engine>…`` (``opencode`` and/or ``claude-haiku``; both when none is
named) signs up one person, ``dashcloud-e2e-<tag>@example.com``, makes them an
``agent-developer``, and per engine gives them an AI credential carrying the
key (``openai`` for ``opencode``, ``anthropic`` for ``claude-haiku``), points
their defaults at that engine (``opencode/openai`` with ``gpt-5.6-luna``,
``claude-code/anthropic`` with ``claude-haiku-4-5``; ``CINNA_E2E_LIVE_MODEL``
overrides the model on every engine) and creates the cloud agent ``Dash cloud
e2e <engine> <tag>`` (description and workflow prompt carry this script's
marker). Once its environment runs, three components are written into its
host-side workspace under ``dashboards/``:

- ``ledger-items`` — a native ``list`` whose ``items.py`` prints three rows,
  one of them ``stamp <tag>`` (only a run of these files can print it);
- ``ledger-page`` — an ``html`` page (``index.html`` + ``app.js``) that calls
  its ``ping`` endpoint with ``cinna.call`` and prints the answer;
- the endpoints are Python with no dependency (``python-env-advanced`` has no
  Node). The files live under ``/agent-environments``, not under the
  backend's ``/app``, so core's dev server does not reload on them.

It prints one JSON document in the shape ``liveTeamSharing.ts`` reads (the
person with their web token, the admin's token) plus ``agents``, keyed by
engine. Nothing here runs a model; the spec makes the turns.

``cleanup`` removes only what a run of this script made: agents whose owner's
email is exactly ``dashcloud-e2e-<8 hex>@example.com`` **and** whose name is
exactly ``Dash cloud e2e <engine> <8 hex>`` **and** whose description or
workflow prompt is this script's marker (core's delete stops their
containers; their blocks and dashboard chat sessions go with them), then those
people (their AI credentials and every dashboard, desktop-owned backing ones
included, go with them: the foreign keys cascade). It prints counts only.

The JSON holds bearer tokens: keep it private (``umask 077``), outside the
repository, and delete it after the run.
"""
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path

import httpx

BASE = os.environ.get("CINNA_E2E_CORE_INTERNAL", "http://127.0.0.1:8000")
API = "/api/v1"
PREFIX = "dashcloud-e2e-"
EMAIL_PATTERN = re.compile(r"^dashcloud-e2e-[0-9a-f]{8}@example\.com$")
MARKER = "Made by cinna-desktop e2e/fixtures/live-dashboard-cloud.py; cleanup deletes it."
NAME = "Dash cloud e2e"
NAME_PATTERN = re.compile(r"^Dash cloud e2e (opencode|claude-haiku) [0-9a-f]{8}$")
DESCRIPTION = "Keeps a small ledger for the desktop dashboards e2e. " + MARKER
# Set at create so core never asks a model to rewrite the description from the template's prompt.
WORKFLOW = (
    "# Dash cloud e2e\n\nYou keep a small ledger. Answer in one short sentence. "
    "When the user asks about what they see on a dashboard, read the dashboard context you are given. "
    "When asked to highlight rows on a tile, use your dashboards tools.\n\n" + MARKER + "\n"
)
ENV_INSTANCES_DIR = os.environ.get("ENV_INSTANCES_DIR", "/agent-environments")

ENGINES = {
    "opencode": {"sdk": "opencode/openai", "type": "openai", "key_env": "CINNA_E2E_OPENAI_KEY", "model": "gpt-5.6-luna"},
    "claude-haiku": {"sdk": "claude-code/anthropic", "type": "anthropic", "key_env": "CINNA_E2E_ANTHROPIC_KEY", "model": "claude-haiku-4-5"},
}

LIST_COMPONENT = {
    "schema_version": 1,
    "title": "Ledger items",
    "description": "The ledger's open items.",
    "view": "list",
    "source": {"endpoint": "items"},
    "endpoints": {"items": {"script": "api/items.py", "description": "The open ledger items. No params."}},
    "refresh": {"max_age": "1h"},
    "size": "m",
}

PAGE_COMPONENT = {
    "schema_version": 1,
    "title": "Ledger page",
    "description": "A page that asks the ledger for a ping.",
    "view": "html",
    "entry": "index.html",
    "source": {"endpoint": "data"},
    "endpoints": {
        "data": {"script": "api/data.py", "description": "Nothing to show. No params."},
        "ping": {"script": "api/ping.py", "description": "Echoes n with the environment's answer. Params: n."},
    },
    "refresh": {"max_age": "1h"},
    "size": "m",
}

PAGE_HTML = (
    '<!doctype html><html><head><meta charset="utf-8"><title>Ledger page</title></head>'
    '<body style="padding:40px 12px 12px;font:12px sans-serif"><p id="state">loading</p><p id="call">no call</p>'
    '<script src="./app.js"></script></body></html>'
)

PAGE_SCRIPT = """cinna.ready.then(async function (meta) {
  document.getElementById("state").textContent = "ready " + meta.component
  try {
    var value = await cinna.call("ping", { n: 7 })
    document.getElementById("call").textContent = "call " + JSON.stringify(value)
  } catch (err) {
    document.getElementById("call").textContent = "call failed " + (err && err.message)
  }
})
"""


def items_script(tag: str) -> str:
    return (
        "import json\n"
        "print(json.dumps({'items': [\n"
        "    {'id': 'kestrel', 'title': 'Kestrel ledger'},\n"
        "    {'id': 'osprey', 'title': 'Osprey invoice'},\n"
        f"    {{'id': 'stamp', 'title': 'stamp {tag}'}},\n"
        "]}))\n"
    )


PING_SCRIPT = (
    "import json, sys\n"
    "params = json.loads(sys.stdin.read() or '{}')\n"
    "print(json.dumps({'pong': params.get('n'), 'from': 'env'}))\n"
)


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


def write_components(env_id: str, tag: str) -> None:
    root = Path(ENV_INSTANCES_DIR) / env_id / "app" / "workspace" / "dashboards"
    files = {
        "ledger-items/component.json": json.dumps(LIST_COMPONENT, indent=2),
        "ledger-items/api/items.py": items_script(tag),
        "ledger-page/component.json": json.dumps(PAGE_COMPONENT, indent=2),
        "ledger-page/index.html": PAGE_HTML,
        "ledger-page/app.js": PAGE_SCRIPT,
        "ledger-page/api/data.py": "import json\nprint(json.dumps({}))\n",
        "ledger-page/api/ping.py": PING_SCRIPT,
    }
    for rel, text in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(0o644)
    for folder in {p.parent for p in (root / rel for rel in files)} | {root}:
        folder.chmod(0o755)


def wait_listed(client: httpx.Client, token: str, agent_id: str, names: set[str], seconds: float = 120) -> None:
    """Until core lists the components (its list is cached for 10 s)."""
    deadline = time.monotonic() + seconds
    seen: set[str] = set()
    while time.monotonic() < deadline:
        r = client.get(f"{API}/agents/{agent_id}/dashboards/", headers=bearer(token), timeout=60)
        if r.status_code == 200:
            listed = r.json().get("components", [])
            seen = {c["name"] for c in listed if not c.get("has_errors")}
            if names <= seen:
                return
            broken = [c for c in listed if c["name"] in names and c.get("has_errors")]
            if broken:
                raise SystemExit(f"core finds problems in {[c['name'] for c in broken]}: {[c.get('findings') for c in broken]}")
        time.sleep(3)
    raise SystemExit(f"core never listed {sorted(names - seen)} for the agent")


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
    full_name = f"Dash Owner {tag}"
    user = ok(client.post(f"{API}/users/signup", json={"email": email, "password": password, "full_name": full_name})).json()
    token = login(client, email, password)
    person = {"id": user["id"], "email": email, "name": full_name, "token": token}
    ok(client.patch(f"{API}/users/{user['id']}/role", headers=bearer(admin), json={"role": "agent-developer"}))

    agents = {}
    for engine in engines:
        spec = ENGINES[engine]
        model = model_override or spec["model"]
        cred = ok(client.post(f"{API}/ai-credentials/", headers=bearer(token), json={
            "name": f"{spec['type']} dashcloud-e2e {tag}", "type": spec["type"], "api_key": keys[engine],
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
        write_components(env_id, tag)
        wait_listed(client, token, agent["id"], {"ledger-items", "ledger-page"})
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
            raise SystemExit("usage: python - create [opencode] [claude-haiku] | cleanup < live-dashboard-cloud.py")
