# Service credentials

Credentials supplies explicitly attached service accounts, tokens, and logins to real local folder agents. It is independent of AI Credentials and requires no skill installation.

## Using credentials

1. In Default Settings → Credentials, select **Add Credential**, search the type cards, then fill in the type-specific form for an API token, IMAP/SMTP login, Odoo login, or Google service account. Every form exposes **Service URI**, with a hint explaining how it matches a credential type to an agent requirement. Values are write-only; editing metadata preserves the encrypted value unless you select **Replace stored values**.
2. With a Cinna profile active, Profile Settings → Credentials lists owned and shared cloud records. Use **Manage on Remote** beside **Sync Now** to manage values and sharing in Cinna web. A shared record requires its owner's **Allow local use** consent.
3. Open an agent's Settings → Credentials and attach records. Detach removes generated files after a running turn releases the folder; it leaves the record and other agents' attachments intact. Missing references remain visible and recover when access returns.
4. For older kit folders, use **Update credential helper**. This checks the file stamp before replacing `scripts/cinna_credentials.py`.

Attached values override `.env` for a whole matching slot. The page reports overlapping variable names. Readiness and the Python helper require both the credential type and the declared service: an explicit `service_uri`, or the slot name matched against credential name/service URI. A token for another service does not satisfy the slot. Readiness checks metadata and names, never values. A missing credential warns; an unsafe generated-file destination refuses execution.

## Runtime contract

Kit agents receive a cloud-compatible array at `credentials/credentials.json`. Bare agents receive it under the Hub's userData `agent-credentials/<realpath hash>/` directory, outside their folder. Only `CINNA_CREDENTIALS_PATH` is injected into script children; values never enter process environment variables or the prompt. The prompt lists names, types, slots, and availability.

The shared 1.4.0 Python reader uses the injected path, the nested array/envelope, the legacy root object, then environment and `.env`. `get_credential`/`has_credential`, `require_credential`/`list_credential_slots`, and strict `by_slot`/`require_slot` are supported. Files are reread on every call. Placeholders cannot silently borrow environment fields. Service-account keys live in separately inventoried JSON files; SSH private-key installation and MCP-provider delivery are excluded.

Runtime preparation occurs inside the per-agent turn lock, after launch planning and before process/session acquisition. Session identity includes a fingerprint of effective credential material and cloud account identity, independent of the lifecycle epoch. Empty attachments have a stable fingerprint across resume and re-authentication. Commands use the same preparation hook. Synthetic chat/conductor/build runtimes, remote A2A, and custom ACP transports do not receive attachments. Each delegated local executor resolves its own attachments through its ordinary folder driver; delegation permissions remain unchanged.

## Storage and lifecycle

`service_credentials` stores metadata and keystore-encrypted bundles. Local records use `__default__`; cloud cache rows are scoped to the local profile, server origin, and cloud UUID. The metadata DTO includes `hasValues`, never payloads. Service credentials reject Linux `basic_text` storage without changing app-wide provider/OAuth encryption behavior. An unavailable secure keystore forbids secret writes and preparation removes generated secrets before refusing execution.

Desktop State stores UUID-only attachment lists: machine-wide local references and cloud references keyed by `sha256(serverOrigin + "\n" + jwt.sub)[:16]`. This recovers intent after signing into a recreated local profile while keeping another account's list inert. Activation derives this identity from the stored token without refreshing it or waiting for network access.

Cloud metadata sync runs every five minutes, on activation/renewal, and on demand. Manual sync is pinned to the displayed active profile. Profile retirement aborts old credential requests; a new profile never joins another profile’s pending sync. Credential HTTP requests bypass the browser cache and have a 30-second timeout. Secret delivery is lazy for attached records. Near-expiry OAuth refresh happens on Core; Desktop never receives refresh tokens. Failed/malformed lists do not prune cache rows. Owner opt-out, disappearance, or access refusal clears the payload and queues regeneration. Same-account offline use is allowed until OAuth expiry; shared cached values also expire seven days after delivery. Owned non-OAuth cache has no TTL.

Epoch checks after awaited work prevent old-account and suspended responses from updating cache or files. Background writes coalesce until the agent is free. Profile changes clean generated content before the next turn; cleanup failure blocks only that agent's turn, while profile activation and other agents continue. Attachment changes also wait for the running turn to release the folder and reject if the account changes while waiting. Logout removes cloud cache rows but retains UUID attachment intent. Timers stop on retirement, reauth failure, suspend, and shutdown; resume catches up. HTTP 403 reports a permission refusal and retains scheduled retries; HTTP 401 requires reauthentication. A full activation scan removes inventoried bare secrets for folders that no longer exist, preserving unrecorded files.

## File and output boundaries

Generated directories are mode `0700`, files `0600`. Writes use exclusive temporary files, fsync, and rename, and unchanged bytes retain their modification time. UserData inventories permit deletion only of names written by this feature. Authored files and `credentials/README.md` are preserved. Kit writes require static kit ignore coverage plus actual untracked/ignored Git status; missing Git or a broken repository fails closed. The full `credentials/` directory is excluded from export and content hashes in Desktop, Core, and CLI.

Known sensitive strings of at least eight characters are redacted before transcript/task/request/delegation persistence, task and handover files, logs, renderer events (including split chunks and nested agent events), and outbound Cinna task/delegation writes. Retired secrets stay in memory until shutdown to cover finishing old turns. Raw values and their JSON-escaped file representation (including `api_key` fields) are covered. This is substring redaction: other encoded/transformed values and strings shorter than eight characters are outside its guarantee. Generated files are plaintext for execution; local processes running as the same OS user can read them. Revocation cannot recall copies made outside the managed cache. Long turns do not refresh files mid-turn.

## Implementation and verification

Hub owns `src/main/services/serviceCredentials/`, the repository/migration, and redaction. IPC and renderer consume metadata-only typed outcomes. The follow-on skills feature should call this attachment/materialization service, never implement a second delivery path.

See [verification.md](verification.md) for exercised flows and commands. Core API documentation lives in `workflow-runner-core/docs/application/desktop_credentials/README.md`.

Desktop reads and validates the contract 1.4 sibling `publications.json` ledger. Legacy `manifest.publications` remains readable when no sibling exists; reads never migrate or mutate either file.
