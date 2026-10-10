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
``credentials.erp``. For ``live-sharing-skill-credentials.spec.ts`` the admin
also makes, each shared with B only and carrying the same notes marker:
``ERP API catalog-e2e <tag> pair 1`` and ``… pair 2`` (``api_token``, Allow
local use, both with ``service_uri: ledger-pair-<tag>``: two candidates for
one skill slot, ``credentials.pair``), and ``ERP API catalog-e2e <tag> no
local`` (``api_token``, ``service_uri: ledger-nolocal-<tag>``, local use
**not** allowed, ``credentials.noLocal``). It also names one cloud agent (``runs_on: cloud``) the
catalog lists to everyone (public and listed), when there is one: creating a
cloud bundle needs a publisher's cloud environment, which a local stack does
not run, so the specs use an existing public one read-only and never install it.

``create cloud`` (opt-in; ``live-sharing-cloud.spec.ts``) also makes A an
``agent-developer``, gives A and B a placeholder Anthropic AI credential (an
environment refuses to exist without one; nothing ever calls it), has A create
the cloud agent ``Catalog cloud e2e <tag>`` (description and workflow prompt
carry this script's marker; the prompts are set so core never asks a model to
rewrite the description), waits (at most 300 s) for its environment to run,
writes ``skills/cloud-check-<tag>/`` (an ``erp-api`` slot and a script with no
``.py`` suffix) into its host-side workspace, publishes the skill to B
(``users`` + a grant) and the agent as a cloud bundle B may use (``users``,
listed, a ``use`` grant), and adds ``cloud`` to the JSON. A bundle publish
copies the workspace under ``/app/data``, which reloads core's dev server; the
script waits for it to come back.

``cleanup`` first removes the cloud side, through core's own delete paths so
their containers go too: agents owned by the ``catalog-e2e-`` people whose name
is exactly ``Catalog cloud e2e <tag>`` and whose description or workflow prompt
is this script's (found through the admin's environment listing), consumer
installs first, then the bundle, then A's agent. Then it removes everything any run made, found by the ``catalog-e2e-``
email prefix rather than by a fixture file: every desktop agent and skill
package those people publish or maintain (with their repositories, versions,
grants and reported local installs), the admin's ``ERP API catalog-e2e <tag>``
credentials (and their ``pair 1`` / ``pair 2`` / ``no local``
siblings) carrying this script's notes marker (their shares, including those ``provision-local`` made, go with
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
import time
import uuid
from pathlib import Path

import httpx

BASE = os.environ.get("CINNA_E2E_CORE_INTERNAL", "http://127.0.0.1:8000")
API = "/api/v1"
PREFIX = "catalog-e2e-"
CRED_NAME = "ERP API catalog-e2e"
# Only credentials this script made: the exact name shape and the notes marker.
CRED_PATTERN = re.compile(r"^ERP API catalog-e2e [0-9a-f]{8}( pair [12]| no local)?$")
CRED_NOTES = "Made by cinna-desktop e2e/fixtures/live-catalog.py; cleanup deletes it."
# ``create cloud`` only: one cloud agent of A's, its bundle and its skill. The
# agent, the bundle and every install of it carry exactly this name and this
# description, which is how cleanup finds them (with the owner's email prefix).
CLOUD_NAME = "Catalog cloud e2e"
CLOUD_NAME_PATTERN = re.compile(r"^Catalog cloud e2e [0-9a-f]{8}$")
CLOUD_DESCRIPTION = "A cloud agent for the desktop catalog e2e. " + CRED_NOTES
# Set at create so the database, not the environment's template, is the
# prompts' first source: otherwise the first prompt sync pulls the template's
# workflow prompt and core asks a model to rewrite the description.
CLOUD_WORKFLOW = "# Catalog cloud e2e\n\nAnswer questions about orders. " + CRED_NOTES + "\n"
CLOUD_SKILL_PATTERN = re.compile(r"^cloud-check-[0-9a-f]{8}$")
ENV_INSTANCES_DIR = os.environ.get("ENV_INSTANCES_DIR", "/agent-environments")
# The skill's script: the erp-api slot through the skill runtime's
# ``core.cinna_api``, printed as its type and a hash prefix, never the value.
# No ``.py`` suffix: core's dev server reloads on any ``.py`` under ``/app``,
# and published skills are stored there.
CLOUD_SKILL_SCRIPT = '''import hashlib
import sys

from core.cinna_api import credentials

cred = credentials.by_slot("erp-api")
if cred is None:
    print("cloud-skill: erp-api=none")
    sys.exit(0)
value = (cred.get("credential_data") or {}).get("http_header_value", "")
print(f"cloud-skill: erp-api={cred.get('type')} {hashlib.sha256(str(value).encode()).hexdigest()[:12]}")
'''


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


def wait_for_core(client: httpx.Client, seconds: float = 90) -> None:
    """Until core answers its health check: a bundle publish copies the
    workspace (``__init__.py`` included) under ``/app/data/bundles``, and the
    dev server's ``--reload`` restarts on it."""
    deadline = time.monotonic() + seconds
    time.sleep(2)
    while time.monotonic() < deadline:
        try:
            if client.get(f"{API}/utils/health-check/").status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(1)
    raise SystemExit("core did not come back after a bundle publish")


def publish_bundle(client: httpx.Client, token: str, agent_id: str, body: dict) -> dict:
    """POST /agents/{id}/publish, surviving the reload it causes; answers the revision."""
    try:
        r = client.post(f"{API}/agents/{agent_id}/publish", headers=bearer(token), json=body, timeout=120)
        revision = ok(r).json()
    except httpx.HTTPError:
        revision = None
    wait_for_core(client)
    if revision is None:
        raise SystemExit("the bundle publish answered nothing (core restarted mid-request); check the catalog by hand")
    return revision


def create_cloud(client: httpx.Client, admin: str, people: dict, tag: str) -> dict:
    """A's cloud agent with a skill, the skill published to B, the agent published as a bundle B may use."""
    timings: dict[str, float] = {}
    started = time.monotonic()
    a, b = people["a"], people["b"]
    ok(client.patch(f"{API}/users/{a['id']}/role", headers=bearer(admin), json={"role": "agent-developer"}))
    # An environment refuses to exist without an AI key for its SDK
    # (claude-code/anthropic by default). Nothing here runs a model, so the key
    # is a placeholder: A's for the agent, B's for the install of its bundle.
    # Both go when cleanup deletes their owners.
    for label in ("a", "b"):
        made = ok(client.post(f"{API}/ai-credentials/", headers=bearer(people[label]["token"]), json={
            "name": f"Anthropic catalog-e2e {tag}",
            "type": "anthropic",
            "api_key": "sk-ant-catalog-e2e-placeholder-never-called",
        })).json()
        ok(client.post(f"{API}/ai-credentials/{made['id']}/set-default", headers=bearer(people[label]["token"])))
    name = f"{CLOUD_NAME} {tag}"
    agent = ok(client.post(f"{API}/agents/", headers=bearer(a["token"]), json={
        "name": name,
        "description": CLOUD_DESCRIPTION,
        "workflow_prompt": CLOUD_WORKFLOW,
        "entrypoint_prompt": "Ask about orders.",
        "refiner_prompt": "",
    }, timeout=120)).json()
    agent_id = agent["id"]
    envs = ok(client.get(f"{API}/agents/{agent_id}/environments", headers=bearer(a["token"]))).json()["data"]
    if len(envs) != 1:
        raise SystemExit(f"the new cloud agent has {len(envs)} environments, expected its default one")
    env_id = envs[0]["id"]

    # The default environment builds and starts in the background: bounded.
    deadline = time.monotonic() + 300
    status = ""
    while time.monotonic() < deadline:
        env = ok(client.get(f"{API}/environments/{env_id}", headers=bearer(a["token"]))).json()
        status = env["status"]
        if status == "running":
            break
        if status == "error":
            raise SystemExit(f"the cloud agent's environment failed: {env.get('status_message')}")
        time.sleep(3)
    else:
        raise SystemExit(f"the cloud agent's environment was still {status!r} after 300 s")
    timings["environment_running_s"] = round(time.monotonic() - started, 1)
    deadline = time.monotonic() + 60
    while not ok(client.get(f"{API}/agents/{agent_id}", headers=bearer(a["token"]))).json().get("active_environment_id"):
        if time.monotonic() > deadline:
            raise SystemExit("the cloud agent's environment is running but was never activated")
        time.sleep(2)

    # The skill, written into the host-side workspace the publish reads.
    skill = f"cloud-check-{tag}"
    folder = Path(ENV_INSTANCES_DIR) / env_id / "app" / "workspace" / "skills" / skill
    (folder / "scripts").mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(
        "---\n"
        f"name: {skill}\n"
        "description: Checks which ERP credential this agent's skills can reach.\n"
        "credentials:\n"
        "  - slot: erp-api\n"
        "    type: api_token\n"
        "    description: The ERP API.\n"
        "---\n\n"
        "Run `scripts/cloud_check` before answering about orders.\n"
    )
    (folder / "scripts" / "cloud_check").write_text(CLOUD_SKILL_SCRIPT)
    revision = ok(client.post(
        f"{API}/agents/{agent_id}/skills/{skill}/publish",
        headers=bearer(a["token"]),
        json={"version": "1.0.0", "release_notes": "From the cloud e2e fixture", "visibility": "users", "grant_emails": [b["email"]]},
        timeout=120,
    )).json()
    timings["skill_published_s"] = round(time.monotonic() - started, 1)

    publish_bundle(client, a["token"], agent_id, {
        "release_notes": "Version 1 from the cloud e2e fixture",
        "display_name": name,
        "description": CLOUD_DESCRIPTION,
        "version": "1.0",
    })
    timings["bundle_published_s"] = round(time.monotonic() - started, 1)
    agent = ok(client.get(f"{API}/agents/{agent_id}", headers=bearer(a["token"]))).json()
    listed = ok(client.get(f"{API}/catalog/items", headers=bearer(a["token"]), params={"kind": "agent", "runs_on": "cloud"})).json()["data"]
    item = next((i for i in listed if i["id"] == agent["bundle_id"]), None)
    if item is None:
        raise SystemExit("the published bundle is not in A's catalog")
    ok(client.patch(f"{API}/catalog/items/{item['uuid']}", headers=bearer(a["token"]), json={"visibility": "users", "is_listed": True}))
    grants = ok(client.get(f"{API}/catalog/items/{item['uuid']}/grants", headers=bearer(a["token"]))).json()
    grants = [{"principal": g["principal"], "access": g["access"]} for g in grants if g["principal"].get("user_id") != b["id"]]
    grants.append({"principal": {"user_id": b["id"]}, "access": "use"})
    ok(client.put(f"{API}/catalog/items/{item['uuid']}/grants", headers=bearer(a["token"]), json=grants))
    timings["total_s"] = round(time.monotonic() - started, 1)
    return {
        "agentId": agent_id,
        "envId": env_id,
        "name": name,
        "description": CLOUD_DESCRIPTION,
        "bundleId": item["id"],
        "bundleUuid": item["uuid"],
        "skill": {"name": skill, "packageId": str(revision["package_id"]), "revision": revision["revision_number"]},
        "timings": timings,
    }


def create(client: httpx.Client, cloud_mode: bool = False) -> None:
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

    def admin_credential_for_b(name: str, service_uri: str, secret: str, local: bool) -> str:
        made = ok(client.post(f"{API}/credentials/", headers=bearer(admin), json={
            "name": name,
            "notes": CRED_NOTES,
            "type": "api_token",
            "service_uri": service_uri,
            "allow_sharing": True,
            "allow_local_use": local,
            "credential_data": {"api_token_type": "bearer", "api_token": secret},
        })).json()["id"]
        ok(client.post(f"{API}/credentials/{made}/shares", headers=bearer(admin), json={"shared_with_email": people["b"]["email"]}))
        return made

    # Two credentials B may use for one skill slot: nothing is attached without asking.
    pair_slot = f"ledger-pair-{tag}"
    pair = []
    for n in (1, 2):
        secret_n = f"ledger-pair-{n}-{uuid.uuid4().hex[:12]}"
        name_n = f"{CRED_NAME} {tag} pair {n}"
        pair.append({"id": admin_credential_for_b(name_n, pair_slot, secret_n, True), "name": name_n, "secret": secret_n})
    # One B is shared, for a skill slot, without Allow local use.
    no_local_slot = f"ledger-nolocal-{tag}"
    no_local_name = f"{CRED_NAME} {tag} no local"
    no_local = admin_credential_for_b(no_local_name, no_local_slot, f"ledger-nolocal-{uuid.uuid4().hex[:12]}", False)

    # A cloud agent B can see without a grant: public and listed. Read only.
    listed = ok(client.get(f"{API}/catalog/items", headers=bearer(people["b"]["token"]), params={"kind": "agent", "runs_on": "cloud"})).json()["data"]
    cloud = next(({"uuid": i["uuid"], "id": i["id"], "display_name": i["display_name"]} for i in listed if i.get("visibility") == "public"), None)

    made = create_cloud(client, admin, people, tag) if cloud_mode else None

    print(json.dumps({
        "server": "http://localhost:8000",
        "tag": tag,
        "admin": {"id": admin_id, "token": admin},
        "people": people,
        "credentials": {
            "erp": {"id": erp, "name": f"{CRED_NAME} {tag}", "secret": secret, "shares": shares},
            "pair": {"slot": pair_slot, "items": pair},
            "noLocal": {"id": no_local, "name": no_local_name, "slot": no_local_slot},
        },
        "cloudAgent": cloud,
        **({"cloud": made} if made else {}),
    }))


def cleanup_cloud(client: httpx.Client, admin: str, ids: set[str]) -> dict:
    """Every cloud agent ``create cloud`` made, every install of its bundle,
    and the bundle, through core's own delete paths (which stop and remove
    their containers). An agent is this script's only when its owner is one of
    the ``catalog-e2e-`` people **and** its name is ``Catalog cloud e2e <tag>``
    **and** its description is this script's; agents are found through the
    admin's environment listing filtered by owner. Before the people go: a
    deleted owner would strand the containers. Consumer installs first (they
    hold the bundle), then the bundle, then the publisher's agent."""
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
            marked = agent.get("description") == CLOUD_DESCRIPTION or agent.get("workflow_prompt") == CLOUD_WORKFLOW
            if CLOUD_NAME_PATTERN.match(agent["name"] or "") and marked:
                agents[agent["id"]] = agent
    removed = {"installs": 0, "bundles": 0, "agents": 0, "refused": []}
    for agent in agents.values():
        if agent.get("bundle_uuid") and not agent.get("is_publisher_install"):
            r = client.post(f"{API}/agents/{agent['id']}/uninstall", headers=bearer(admin), timeout=120)
            if r.status_code < 400:
                removed["installs"] += 1
            else:
                removed["refused"].append(f"install {agent['id']}: {r.status_code} {r.text[:160]}")
    items = ok(client.get(f"{API}/catalog/items", headers=bearer(admin), params={"kind": "agent", "runs_on": "cloud", "scope": "all"})).json()["data"]
    for item in items:
        people = {(item.get("publisher") or {}).get("user_id")} | {m.get("user_id") for m in item.get("maintainers") or []}
        if people & ids and CLOUD_NAME_PATTERN.match(item.get("display_name") or "") and item.get("description") == CLOUD_DESCRIPTION:
            r = client.delete(f"{API}/catalog/items/{item['uuid']}", headers=bearer(admin))
            if r.status_code in (204, 404):
                removed["bundles"] += 1
            else:
                removed["refused"].append(f"bundle {item['uuid']}: {r.status_code} {r.text[:160]}")
    for agent in agents.values():
        if agent.get("bundle_uuid") and not agent.get("is_publisher_install"):
            continue
        r = client.delete(f"{API}/agents/{agent['id']}", headers=bearer(admin), timeout=120)
        if r.status_code < 400:
            removed["agents"] += 1
        else:
            removed["refused"].append(f"agent {agent['id']}: {r.status_code} {r.text[:160]}")
    return removed


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
    cloud = cleanup_cloud(client, admin, ids)

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
        "cloud": cloud,
    }))


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    with httpx.Client(base_url=BASE, timeout=30) as http:
        if command == "create":
            create(http, cloud_mode=sys.argv[2:3] == ["cloud"])
        elif command == "cleanup":
            cleanup(http)
        else:
            raise SystemExit("usage: python - create [cloud]|cleanup < live-catalog.py")
