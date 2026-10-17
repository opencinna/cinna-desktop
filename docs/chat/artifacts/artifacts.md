# Artifacts — publish what an agent left, as a page on Cinna

## Purpose

A folder agent leaves files: a report, a CSV, a folder with a small dashboard in it. An **artifact** is a copy of such a file or folder published to the signed-in Cinna instance as a frozen, versioned page its owner (and whoever they choose) opens in a browser, without the agent folder, the desktop or the agent being involved. The person publishes from the chat; the agent can also ask to, and the person decides ([Agent Publish](agent_publish.md)).

## Core Concepts

- **Artifact** — the published copy on cinna-core: a title, a kind, numbered revisions, who can see it, and a page at `<frontend>/artifact/<uuid>`. In code it is a `PublishedArtifact`, never to be confused with a task's `artifacts` field (`TaskArtifact`, `DelegationArtifact`), which is a link in a report.
- **Kind** — decided by core from the files sent: a **site** has an HTML entry and runs in a sandbox on core's page; **files** are browsed. A folder with a root `index.html` is a site; a lone `.html` file is a site; a folder with other `.html` files but no root `index.html` is files until the user picks a **start page**.
- **Revision** — publishing the same path again adds a revision to the same artifact (**Update**). The artifact's page, links and audience stay.
- **Artifact card** — the chat's own rendering of an artifact: an icon by kind, the title, revision and audience, then **Open** (core's page in the browser), **Copy link** and, for the owner, **Share…**. It sits right after the message the publish came from. A link to an artifact in an agent's text renders as the same card.
- **Audience** — two independent facts: *who can see it* (**only you** or **everyone on the instance**) and *how many public links are live*; core's web page can also share it with named people, which the card shows ("shared with 2 people") and the desktop never edits. "Public" is never a visibility. It is a link.
- **Public link** — an unguessable URL (optionally with a code) anyone can open. Its URL and code are shown once when created and are never stored on this machine.
- **Publish approval** — the card an agent's publish request waits on. See [Agent Publish](agent_publish.md).
- **Published memory** — the desktop's own record of which artifact a path on this machine was published as, per profile and server. It is what turns *Publish* into *Update*. There is no marker file in the agent's folder.

## Support

Artifacts exist only when **the active profile is a signed-in Cinna account and its instance's discovery document advertises `artifacts` at version 1 or more**. Otherwise no surface appears anywhere: no menu item, no header button, no card, no tool, no skill. A local-only profile never sees any of it.

- Discovery is read once per server per app session and cached. An instance that gains artifacts needs the app restarted before this machine offers them; closing and reopening a window is not enough.
- The limits (total bytes, file count, bytes per file) come from the instance's capabilities, read once a session. If they cannot be read the desktop uses core's own defaults (50 MB, 2000 files, 25 MB per file). An over-limit folder is refused on screen, from the same walk that publish repeats, and not by a failed upload.

## User Stories / Flows

### Publish a file or folder from the chat

1. In a folder agent's chat the user right-clicks a [file reference](../file_references/file_references.md) and picks **Publish…** (last in the menu), or opens the reference in the [file preview](../file_preview/file_preview.md) and uses **Publish…** in its header.
2. The **Publish** dialog opens with the path already inspected: a title (the name, a file's without the extension), an optional description, the kind line ("Mini-site · opens index.html", "3 files", "Markdown document"), the files with what is left out struck through and why, the total, and **Who can see it**: *Only you* (the default), *Everyone on the instance*, *Anyone with a link*.
3. A folder with HTML files but no `index.html` also shows a **Start page** picker; without a choice it is published as files.
4. If this path was published before the dialog offers **Update "<title>" (rev N)** — the default, taking that artifact's title and audience as its starting point — or **Publish as new**.
5. **Publish** packs, uploads and (when the user chose more than private) applies the audience; the button says the phase. On success the dialog closes and the card appears in the chat after the message the reference came from. A link created for "Anyone with a link" is shown once on the card.
6. A publish that worked while its follow-up did not (the audience, the link) is said once on the card — "Published, but it is still visible only to you: …" — and is not an error.

### Share, copy and revoke from the card

1. **Share…** opens a popover that reads core's current state: *Who can see it* and the **Public links** (live ones first, each revocable). Creating a link shows its URL once. Revoking asks inline in the link's own row ("People with this link lose access.").
2. Anything changed here, or on core's web page, shows on the card the next time it is read.

### An artifact link in the agent's text

1. An agent that publishes pastes the artifact's URL into its reply. A link whose path is exactly `/artifact/<uuid>` renders as a card, on the conditions in step 2: a skeleton at the card's height at once, then the card, or the ordinary link if the read fails. One card per artifact: a link to an artifact the chat already shows as a card (a publish's card, an agent's tool row) stays a link, so an agent repeating the URL it was given adds no second card.
2. The id is read from the profile's own core whatever host the link names, because a link the CLI or a colleague made reaches a fresh profile before any artifact URL has told it where core's web frontend lives. The card is drawn only when core's own `url` for that id is on the link's origin, so a look-alike host that borrows a real id stays a plain link. On the profile's server or a frontend origin core already named, the link is trusted without that comparison. Artifacts unsupported, or any other path, is a plain link and no read.

## Business Rules

### What may be published

- **Only paths inside the agent folder.** The renderer names a path only as `{agentId, path}`; main finds the folder itself and refuses a real path outside it. A file the transcript resolved outside the folder never offers **Publish…**.
- **Never what must not leave the machine.** A path with any of these segments is refused outright, and inside a published folder the same entries are dropped and listed in the dialog and in the result: `.git`, any `.env*`, `credentials/`, `app-data/`, `.claude/`, `node_modules/`, `*.pem`, `*.key`, `.DS_Store`, and any other dot-named file or folder ("hidden file"), as core's agent route and the `cinna-artifacts` skill have it. A credential file offers no **Publish…** at all.
- **Symlinks are never followed.** A link is listed as left out; a file that became a link between the dialog and the send is not read.
- **What is sent is what is on disk at publish, not what the dialog showed.** Main walks the path again, re-checks the limits, and refuses with "That start page is no longer in the folder" if the chosen entry vanished.
- **The walk stops counting once a limit is passed.** A huge folder is refused with the limit that tripped ("Over the limit: more than 2,000 files"), and the dialog says "At least N MB" rather than walking the rest. Nothing is sent.
- **Nothing to publish is a refusal**, not an empty artifact: every file excluded says so.

### Remembering and updating

- Publishing records `(profile, server, path) → artifact`. A path published twice as new has two entries; the latest is the one offered as *Update*.
- If the artifact being updated was deleted on core the update is refused as "gone"; the dialog switches to **Publish as new** and the memory entry is dropped.
- The chat's cards are persisted per chat and message, and go with the chat. A card whose message is gone renders nowhere.
- Everything is keyed by profile and server: the same path published from two accounts is two artifacts.

### Failures

- Every outcome is data. A refusal is said inside the dialog, which stays open and closes nothing; while publishing the dialog cannot be dismissed.
- A sign-in that expired says "Sign in to Cinna again, then try once more." and an unreachable instance says to check the connection.

## What this does not do

- It does not edit who an artifact is shared with by name; that is core's page.
- It does not delete or unpublish. A person does that on core.
- It does not keep a marker in the source folder, and it does not watch the folder for changes: *Update* is always a deliberate act.
- It does not publish outside the agent's folder, anything on the exclusion list, or from a profile without a Cinna account.
- It is not a task artifact: a task report's `artifacts` link stays what it was.

## Architecture Overview

```
Reference menu / preview header -> artifactPublish store -> PublishArtifactDialog
   -> window.api.artifacts.inspect / publish -> artifacts.ipc -> publishService
        -> inspect (walk, no symlinks) -> zip -> cinnaSend (multipart) -> cinna-core /api/v1/artifacts
        -> publishedArtifactRepo (memory + chat card) -> artifacts:changed -> cards re-read
Agent's text link -> ArtifactLinkCard -> artifacts:detail -> cinnaFetch
```

## Integration Points

- [File References](../file_references/file_references.md): the **Publish…** menu item, and the persisted message a reference was rendered in (where the card anchors).
- [File Preview](../file_preview/file_preview.md): the **Publish…** header button of an agent file.
- [Agent Publish](agent_publish.md): the `artifacts_publish` tool, its approval card and the Inbox row.
- [The Cinna Task Protocol](../../jobs/tasks/task_protocol.md): the `cinna` MCP server the tool lives on, and the skill delivery shared with `cinna-tasks`.
- [Kit Contract](../../agents/local_agents/kit_contract.md): the vendored `artifacts.schema.json` and `cinna-artifacts` skill (contract 1.12.0; the `artifacts/` folder role, 1.13.0).
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md): the signed-in profile that gates support.

[Technical details](artifacts_tech.md)
