<!--
The first message of an unattended run — a schedule firing, with nobody there to
answer a question. One or two conversational sentences, fully self-contained: no
placeholder anybody has to fill in, no technical instruction.

Good:  "Check the invoices that arrived since yesterday and report anything without
        a purchase-order number."
Wrong: "Query the API and return JSON."            (technical, not a message)
Wrong: "Check invoices for <account>."             (a blank nobody will fill)

Mandatory once this agent has a schedule; harmless to leave as-is until then.
Defaults the run relies on belong in REFINER_PROMPT.md.
-->

Run the routine job for {{NAME}} and report what you found.
