# Credentials

What this agent needs in order to reach the outside world, and how a value gets
to it. **This folder documents slots; it never travels with a value.**

## Declare the slot first

Every credential is declared in `cinna-agent.json` under `credentials[]`:

```json
{
  "name": "Vendor Portal",
  "type": "api_token",
  "description": "Read-only token for the vendor portal API.",
  "env_prefix": "VENDOR_PORTAL_",
  "fields": ["token"],
  "optional": false
}
```

`type` is a platform credential type; `env_prefix` names the local variables for
the slot (`<env_prefix><FIELD in upper case>`, so `VENDOR_PORTAL_TOKEN`).

## Fill it in locally

```bash
cp credentials/.env.example credentials/.env
$EDITOR credentials/.env
```

`credentials/.env` is git-ignored and excluded from anything published. It stays
on this machine.

## Read it from a script

```python
from cinna_credentials import get_credential

token = get_credential("Vendor Portal", "token")
```

The same call works in the cloud, where the platform provides `credentials.json`
instead of the `.env`. Never read `.env` directly, and never accept a secret as a
command-line argument.

## Rules

- **Never print, echo or log a value** — not in a conversation, not in an error
  message, not in a debug line.
- A host may check that a variable *exists*. It never reads what it holds.
- In the cloud each slot becomes an empty draft to fill in on the server; the
  local value is not uploaded.
- Nothing secret goes in `config/`, `knowledge/`, `docs/` or a script.
