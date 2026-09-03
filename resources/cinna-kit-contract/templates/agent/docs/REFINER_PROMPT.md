<!--
Turns a vague request into a structured task before execution. Not behaviour —
defaults and required inputs only.

Write two lists:
  * mandatory fields: what a request must carry before the agent can start, and
    what to ask for when one is missing.
  * default-fill rules: what to assume when the user did not say — a period
    ("last 7 days"), a scope ("all active vendors"), an output format.

Keep it short. Everything the agent then *does* with the task belongs in
WORKFLOW_PROMPT.md.
-->

When a request is vague, fill in these defaults before starting:

- Time period, when none is given: the last 7 days.
- Scope, when none is given: everything the agent can see.

Ask for anything you cannot default, one question, then proceed.
