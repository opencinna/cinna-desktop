# Knowledge

Reference material this agent reads to be **correct**: business rules, how an
external system really behaves, terminology, the reasoning behind a decision. Not
instructions — those belong in `docs/WORKFLOW_PROMPT.md`.

One topic per file, named for the topic:

```
knowledge/
├── invoice_matching_rules.md
└── vendor_portal/
    ├── api_quirks.md
    └── field_mapping.md
```

Reference each topic from `docs/WORKFLOW_PROMPT.md` so the agent knows where to
look:

```markdown
## References
- `knowledge/invoice_matching_rules.md` — how a PO number is matched to an invoice.
```

Never put a credential, a tokenised URL or personal data here. This folder ships
with the agent and, in the cloud, may travel to other installs.
