# Config

Non-secret configuration the agent's scripts read: endpoints, field mappings,
thresholds, the list of things to watch. JSON or YAML, one file per concern.

```
config/
├── endpoints.json
└── thresholds.json
```

Two rules:

- **Never a secret.** Anything with a value that must not be seen goes in
  `credentials/.env` and is read through `scripts/cinna_credentials.py`.
- **Read it, do not hard-code it.** A number a human might want to change belongs
  here, not inside a script.
