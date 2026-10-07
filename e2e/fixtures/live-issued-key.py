"""Live Core fixture + API checks for issued Agent API keys (plans/agent-api-issued-keys.md).

Runs INSIDE cinna-core's backend container (it imports Core's test helpers and
models). Copy it in and run one subcommand; the fixture JSON travels on stdin /
stdout, never on the command line:

    docker compose cp <desktop>/e2e/fixtures/live-issued-key.py backend:/tmp/live-issued-key.py
    docker compose exec -T backend python /tmp/live-issued-key.py create <PRODUCER_AGENT_ID> > "$FIXTURE"   # umask 077
    docker compose exec -T backend python /tmp/live-issued-key.py core-checks < "$FIXTURE"   # scenarios 1, 2, 7 (prints the updated fixture)
    docker compose exec -T backend python /tmp/live-issued-key.py env-sync-check < "$FIXTURE" # scenario 8 (prints the updated fixture)
    #   ... CINNA_ISSUED_KEY_LIVE_FIXTURE="$FIXTURE" make e2e-one SPEC=service-credentials GREP="live Core issued"
    docker compose exec -T backend python /tmp/live-issued-key.py holder-delete < "$FIXTURE" # scenario 9
    docker compose exec -T backend python /tmp/live-issued-key.py cleanup < "$FIXTURE"       # disposable users, self key

`create` makes two disposable users (recipient, other), an interactive PKCE
Desktop authorization for the recipient, and issues a key on the producer from
the producer's owner (the first superuser, password read from settings, never
printed) to the recipient. The producer's agent API and external access must be
on. Every check prints `PASS|FAIL <scenario> <what> <evidence>`; exit code 1 on
any FAIL. Only keys/credentials this script creates are touched.
"""
import json
import sys
import uuid

import httpx

BASE = "http://127.0.0.1:8000/api/v1"
client = httpx.Client(base_url=BASE, timeout=60)
# Core's desktop_auth helper builds paths with the /api/v1 prefix itself.
root_client = httpx.Client(base_url=BASE.removesuffix("/api/v1"), timeout=60)
failures: list[str] = []


def check(scenario: str, what: str, ok: bool, evidence: object = "") -> None:
    line = f"{'PASS' if ok else 'FAIL'} {scenario} {what} :: {evidence}"
    print(line, file=sys.stderr)
    if not ok:
        failures.append(line)


def login(email: str, password: str) -> dict[str, str]:
    r = client.post("/login/access-token", data={"username": email, "password": password})
    r.raise_for_status()
    return {"Authorization": "Bearer " + r.json()["access_token"]}


def admin_headers() -> dict[str, str]:
    from app.core.config import settings

    return login(settings.FIRST_SUPERUSER, settings.FIRST_SUPERUSER_PASSWORD)


def signup(label: str) -> dict:
    email = f"issued-key-e2e-{label}-{uuid.uuid4().hex[:10]}@example.com"
    password = uuid.uuid4().hex + "A!9"
    r = client.post("/users/signup", json={"email": email, "password": password})
    r.raise_for_status()
    return {"user_id": r.json()["id"], "email": email, "headers": login(email, password)}


def create(producer_id: str) -> None:
    from tests.utils.desktop_auth import obtain_desktop_tokens

    admin = admin_headers()
    me = client.get("/users/me", headers=admin).json()
    recipient, other = signup("recipient"), signup("other")
    recipient["desktop"] = obtain_desktop_tokens(root_client, recipient["headers"], device_name="Issued key live E2E")
    r = client.post(
        f"/agents/{producer_id}/agent-api/keys",
        headers=admin,
        json={"label": "issued-key live e2e", "issued_to_user_id": recipient["user_id"]},
    )
    r.raise_for_status()
    minted = r.json()
    print(json.dumps({
        "producer_id": producer_id,
        "admin": {"user_id": me["id"], "email": me["email"], "headers": admin},
        "recipient": recipient,
        "other": other,
        "key_id": minted["id"],
        "credential_id": minted["credential_id"],
        "mint_response_token": minted.get("token"),
        "base_url": minted["base_url"],
        "spec_url": minted["spec_url"],
    }))


def core_checks(fx: dict) -> None:
    admin, rec, other = fx["admin"]["headers"], fx["recipient"]["headers"], fx["other"]["headers"]
    producer, cred = fx["producer_id"], fx["credential_id"]

    # ---- 1. Issue to self -------------------------------------------------------------------
    r = client.post(f"/agents/{producer}/agent-api/keys", headers=admin, json={"label": "issued-key live e2e self"})
    self_key = r.json()
    fx["self_key"] = {"key_id": self_key.get("id"), "credential_id": self_key.get("credential_id")}
    check("S1", "self mint returns token once", r.status_code == 200 and bool(self_key.get("token")), f"HTTP {r.status_code} token_len={len(self_key.get('token') or '')}")
    listed = client.get("/credentials/", headers=admin, params={"limit": 1000}).json()
    row = next((c for c in listed.get("data", []) if c["id"] == self_key.get("credential_id")), None)
    check("S1", "key in admin credentials, owned by admin", bool(row) and row.get("owner_id") in (None, fx["admin"]["user_id"]), {k: (row or {}).get(k) for k in ("owner_id", "type", "service_uri", "agent_api_key_status", "category")})
    rv = client.post(f"/credentials/{self_key.get('credential_id')}/agent-api-key/reveal", headers=admin)
    check("S1", "admin reveals own key", rv.status_code == 200 and rv.json().get("token") == self_key.get("token"), f"HTTP {rv.status_code}")
    # Second call to mint is not possible; the token is never returned again (holder info has no token).
    hi = client.get(f"/credentials/{self_key.get('credential_id')}/agent-api-key", headers=admin)
    check("S1", "holder info has no token field value", hi.status_code == 200 and self_key.get("token") not in hi.text, f"HTTP {hi.status_code}")

    # ---- 2. Issue to recipient --------------------------------------------------------------
    check("S2", "mint response to recipient has token=null", fx["mint_response_token"] is None, f"token={fx['mint_response_token']!r}")
    for path, method in ((f"/credentials/{cred}/agent-api-key/reveal", "post"), (f"/credentials/{cred}/with-data", "get"), (f"/credentials/{cred}/agent-api-key", "get")):
        r = getattr(client, method)(path, headers=admin)
        check("S2", f"admin (issuer, superuser) refused {method.upper()} {path.split(cred)[1]}", 400 <= r.status_code < 500 and "token" not in r.text, f"HTTP {r.status_code} {r.text[:120]}")
    listed = client.get("/credentials/", headers=rec, params={"limit": 1000}).json()
    row = next((c for c in listed.get("data", []) if c["id"] == cred), None)
    check("S2", "recipient lists the key", bool(row), {k: (row or {}).get(k) for k in ("owner_id", "type", "service_uri", "agent_api_key_status")})
    rv = client.post(f"/credentials/{cred}/agent-api-key/reveal", headers=rec)
    token = rv.json().get("token") if rv.status_code == 200 else None
    check("S2", "recipient reveals", bool(token), f"HTTP {rv.status_code}")
    hi = client.get(f"/credentials/{cred}/agent-api-key", headers=rec).json()
    check("S2", "holder info: base_url/spec_url/issuer/status", hi.get("base_url") == fx["base_url"] and hi.get("status") == "active" and (hi.get("issuer") or {}).get("email") == fx["admin"]["email"], {k: hi.get(k) for k in ("base_url", "spec_url", "status", "service_uri", "issuer_saw_value")})
    sp = client.get(f"/credentials/{cred}/agent-api-key/spec", headers=rec)
    check("S2", "recipient views producer spec", sp.status_code == 200 and "paths" in sp.json(), f"HTTP {sp.status_code} paths={list((sp.json() or {}).get('paths', {}))[:4] if sp.status_code == 200 else sp.text[:100]}")
    call = client.get(f"{fx['base_url']}/greetings".replace("http://localhost:8000/api/v1", ""), headers={"Authorization": f"Bearer {token}"}, timeout=120)
    check("S2", "recipient token calls producer GET /greetings", call.status_code == 200, f"HTTP {call.status_code} {call.text[:40]!r}")
    for body in ({"allow_sharing": True}, {"allow_template_sharing": True}):
        r = client.put(f"/credentials/{cred}", headers=rec, json=body)
        after = client.get(f"/credentials/{cred}", headers=rec).json()
        flag = next(iter(body))
        check("S2", f"recipient cannot set {flag}", r.status_code >= 400 and not after.get(flag), f"HTTP {r.status_code} {r.text[:110]}")

    # ---- 7. Older Desktop (no include) ------------------------------------------------------
    dh = {"Authorization": "Bearer " + fx["recipient"]["desktop"]["access_token"]}
    plain = client.get("/external/credentials", headers=dh)
    items = plain.json().get("items", []) if plain.status_code == 200 else []
    check("S7", "list without include has no agent_api items", plain.status_code == 200 and not any(i["type"] == "agent_api" for i in items), f"HTTP {plain.status_code} types={sorted({i['type'] for i in items})}")
    m = client.post("/external/credentials/materialize", headers=dh, json={"credential_ids": [cred]})
    refused = m.json().get("refused", []) if m.status_code == 200 else []
    check("S7", "materialize without include refuses unsupported_type", m.status_code == 200 and not m.json().get("items") and refused and refused[0]["reason"] == "unsupported_type", f"HTTP {m.status_code} {refused}")
    opt = client.get("/external/credentials", headers=dh, params={"include": "agent_api_keys"}).json().get("items", [])
    key_item = next((i for i in opt if i["id"] == cred), None)
    check("S7", "list with include lists the key with facts", bool(key_item) and key_item.get("key_status") == "active" and (key_item.get("agent_api") or {}).get("base_url") == fx["base_url"], json.dumps({k: (key_item or {}).get(k) for k in ("type", "relation", "service_uri", "key_status", "local_use_allowed", "agent_api")})[:400])
    m2 = client.post("/external/credentials/materialize", headers=dh, params={"include": "agent_api_keys"}, json={"credential_ids": [cred]}).json()
    entry = (m2.get("items") or [{}])[0].get("entry") or {}
    check("S7", "materialize with include delivers token + public URLs", (entry.get("credential_data") or {}).get("token") == token and entry["credential_data"].get("base_url") == fx["base_url"], {k: v for k, v in (entry.get("credential_data") or {}).items() if k != "token"})

    print(json.dumps(fx))


def env_sync_check(fx: dict) -> None:
    from sqlmodel import Session

    from app.core.db import engine
    from app.models import Agent, AgentCredentialLink
    from app.services.bundles.bundle_id_service import BundleIdService
    from app.services.credentials.credentials_service import CredentialsService

    admin, rec, other = fx["admin"]["headers"], fx["recipient"]["headers"], fx["other"]["headers"]
    producer, cred = fx["producer_id"], fx["credential_id"]
    token = client.post(f"/credentials/{cred}/agent-api-key/reveal", headers=rec).json().get("token")
    # ---- 8. Cloud env sync rule -------------------------------------------------------------
    # Disposable agent rows without environments: bringing up an env per user is heavy, so this
    # exercises CredentialsService.prepare_credentials_for_environment, the payload builder env sync
    # pushes into the container.
    with Session(engine) as s:
        ids = [uuid.uuid4(), uuid.uuid4()]
        rec_agent = Agent(id=ids[0], bundle_id=BundleIdService.generate_bundle_id(ids[0]), name="issued-key e2e recipient agent", owner_id=uuid.UUID(fx["recipient"]["user_id"]))
        other_agent = Agent(id=ids[1], bundle_id=BundleIdService.generate_bundle_id(ids[1]), name="issued-key e2e other agent", owner_id=uuid.UUID(fx["other"]["user_id"]))
        s.add(rec_agent); s.add(other_agent); s.commit()
        fx["probe_agents"] = [str(rec_agent.id), str(other_agent.id)]
    r = client.post(f"/agents/{fx['probe_agents'][0]}/credentials", headers=rec, json={"credential_id": cred})
    check("S8", "recipient links key to own agent (API)", r.status_code == 200, f"HTTP {r.status_code} {r.text[:100]}")
    r = client.post(f"/agents/{fx['probe_agents'][1]}/credentials", headers=other, json={"credential_id": cred})
    check("S8", "other user cannot link recipient's key (API)", r.status_code in (400, 403, 404), f"HTTP {r.status_code} {r.text[:100]}")
    r = client.post(f"/agents/{producer}/credentials", headers=admin, json={"credential_id": cred})
    check("S8", "superuser issuer cannot link recipient's key to producer (API)", r.status_code in (400, 403, 404), f"HTTP {r.status_code} {r.text[:100]}")
    with Session(engine) as s:
        # Force the forbidden state the API refuses, to prove the payload builder drops it anyway.
        s.add(AgentCredentialLink(agent_id=uuid.UUID(fx["probe_agents"][1]), credential_id=uuid.UUID(cred))); s.commit()
        owned = CredentialsService.prepare_credentials_for_environment(s, uuid.UUID(fx["probe_agents"][0]))["credentials_json"]
        foreign = CredentialsService.prepare_credentials_for_environment(s, uuid.UUID(fx["probe_agents"][1]))["credentials_json"]
    o = next((e for e in owned if str(e.get("id")) == cred), None)
    check("S8", "recipient-owned agent payload includes key with token", bool(o) and (o.get("credential_data") or {}).get("token") == token, {"ids": [str(e.get("id")) for e in owned], "keys": sorted((o or {}).get("credential_data", {}).keys())})
    check("S8", "non-recipient agent payload excludes key", not any(str(e.get("id")) == cred for e in foreign), {"ids": [str(e.get("id")) for e in foreign]})
    print(json.dumps(fx))


def holder_delete(fx: dict) -> None:
    admin, rec, producer, cred = fx["admin"]["headers"], fx["recipient"]["headers"], fx["producer_id"], fx["credential_id"]
    before = client.get(f"/agents/{producer}/agent-api/access", headers=admin).json()
    had = any(k["id"] == fx["key_id"] for e in before.get("data", []) for k in e["keys"])
    status_before = next((k["status"] for e in before.get("data", []) for k in e["keys"] if k["id"] == fx["key_id"]), None)
    r = client.delete(f"/credentials/{cred}", headers=rec, params={"force": "true"})
    check("S9", "recipient deletes their copy", r.status_code in (200, 204), f"HTTP {r.status_code} {r.text[:150]}")
    after = client.get(f"/agents/{producer}/agent-api/access", headers=admin).json()
    gone = not any(k["id"] == fx["key_id"] for e in after.get("data", []) for k in e["keys"])
    check("S9", "row disappears from admin access list", had and gone, f"before={had}({status_before}) after_present={not gone}")
    g = client.get(f"/credentials/{cred}", headers=rec)
    check("S9", "credential gone for recipient", g.status_code == 404, f"HTTP {g.status_code}")
    print(json.dumps(fx))


def cleanup(fx: dict) -> None:
    admin = admin_headers()
    if fx.get("probe_agents"):
        from sqlmodel import Session

        from app.core.db import engine
        from app.models import Agent

        with Session(engine) as s:
            for aid in fx["probe_agents"]:
                a = s.get(Agent, uuid.UUID(aid))
                if a is not None:
                    s.delete(a)
            s.commit()
        print(f"deleted probe agents {fx['probe_agents']}", file=sys.stderr)
    sk = fx.get("self_key") or {}
    if sk.get("key_id"):
        r = client.post(f"/agents/{fx['producer_id']}/agent-api/keys/{sk['key_id']}/revoke", headers=admin)
        print(f"revoke self key: HTTP {r.status_code}", file=sys.stderr)
        r = client.delete(f"/credentials/{sk['credential_id']}", headers=admin, params={"force": "true"})
        print(f"delete self credential: HTTP {r.status_code}", file=sys.stderr)
    for who in ("recipient", "other"):
        r = client.delete("/users/me", headers=fx[who]["headers"])
        print(f"delete {who}: HTTP {r.status_code}", file=sys.stderr)
    r = client.put(f"/agents/{fx['producer_id']}", headers=admin, json={"agent_api_external_access_enabled": True})
    print(f"external access ON: HTTP {r.status_code} -> {r.json().get('agent_api_external_access_enabled')}", file=sys.stderr)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "create":
        create(sys.argv[2])
    else:
        fixture = json.loads(sys.stdin.read())
        {"core-checks": core_checks, "env-sync-check": env_sync_check, "holder-delete": holder_delete, "cleanup": cleanup}[cmd](fixture)
    sys.exit(1 if failures else 0)
