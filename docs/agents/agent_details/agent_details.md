# Agent Details

## Purpose

A person deciding whether to install an agent, or opening one for the first time, reads everything it can do on one page, without clicking through settings tabs. A **Details** button opens that page in a modal from the catalog, from the agent picker's catalog cards and from an installed or own agent's page. The agent's `description` is untouched: it stays the short line on tiles, lists and headers.

## Core Concepts

- **Details page**: one document per agent version. Either the publisher's own file (`docs/AGENT_DETAILS.html` or `docs/AGENT_DETAILS.md` in the agent folder) or, when there is none, a markdown summary **cinna-core generates** from the agent's settings. <!-- nocheck -->
- **Custom vs generated**: `source` is `custom` when a publisher file won, `generated` otherwise. A generated answer is always markdown.
- **Platform summary**: core's generated page, always sent beside a custom one. A custom page is the publisher's pitch; credentials, schedules and commands are platform facts the reader can always check, so the modal offers a **Publisher's page / Platform summary** switch whenever both exist.
- **Reserved file**: the two fixed paths, named in the kit's `layout.json` (`agent.details_files`, contract 1.28.0). HTML wins when both exist. See [Kit Contract](../local_agents/kit_contract.md#agent-details-page-1280).
- **Target**: what is asked about. A catalog item (latest version, or one revision), a Cinna agent by its core id, or a folder or vault agent on this computer.
- **Details frame**: the sandboxed `cinna-preview://det-<token>/` frame that shows a publisher's HTML. See [File Preview](../../chat/file_preview/file_preview.md#html-pages) for the shared scheme.

## User Stories / Flows

1. Before installing, the user sees a secondary **Details** button leading every agent tile's footer (Settings → Catalog and the catalog dialog), left of Install / Update / Open, and on every catalog card of the chat's agent picker. Opening the item adds one in its header, and each version row carries a Details icon for that revision. Skills never have one. A version older than the Details feature has no page; its modal says so and offers no retry.
2. On an agent's own page, **Details** is a header button immediately left of Settings / Start chat, never an entry of the ⋯ menu. A Cinna agent shows it when it is a synced remote agent with a core target; a folder or vault agent shows it when its folder (or vault) holds a Details file. The menu entry and the vault Description card's control were retired so the control is in one place on every page, where a reader looks before choosing to chat.
3. The modal shows markdown as a document, or the publisher's HTML in a frame. A custom page from core also shows the Publisher's page / Platform summary switch.
4. Opened from the picker, the modal does not close the picker beneath it, and Escape closes only the modal.
5. A link in a publisher's HTML opens in the user's browser; the page itself never moves.

## Business Rules

- **Core is the only producer; the desktop renders.** One generator means the layout cannot drift between web, desktop and mobile. The desktop therefore has no generator: a folder agent that was never shared shows only its own file, and has no Platform summary.
- **The button appears only when there is something to show or something to retry.**
  - Hidden: the server does not advertise Details (the `agent_details` discovery flag is absent or below 1), the profile is not a signed-in Cinna account (for a remote target), core answers 404 (no access, unknown revision, a skill, or an agent that never had one), a local agent has no file, or the target is malformed.
  - Kept: any other failure (network, 5xx, 403, an answer in an unknown shape, a vault that is locked, a file over the cap or not UTF-8). The modal says why and offers Retry. A button that vanishes on a flaky network would read as "this agent has no page".
  - Skills never have Details: only cloud and desktop catalog agents offer the control.
  - A tile asks for its own page, so a list of agent tiles costs one `agent-details:get` per tile on mount (cached by URL and revalidated, so a reopen is a 304). The button sits first in the footer row: when main's answer arrives later it appears to the left and moves no other button (ux_rules rule 1).
- **Nothing closes on an error.** Loading and failures stay in the modal body.
- **A folder agent's file follows core's rules (C1).** At most 1 MiB, strict UTF-8, whitespace-only counts as absent, HTML before markdown. An HTML file that is too large or not UTF-8 falls back to the markdown one; if neither is usable the failure names the file and why ("is over 1 MiB", "is not UTF-8 text"), so its builder learns what to fix. Warnings (`both_present`, `too_large`, `invalid_encoding`) are informational; they never pick the winner. The file is read again on every request, so an edit shows on the next open.
- **The file must be inside the agent folder, and a file.** It is read through the agent-file gate, stricter than a file reference: an approval for a path outside the folder does not count, nothing prompts, and a credential file is never read.
- **Core answers are cached by URL and revalidated** with the ETag, so reopening is a 304. A 404 drops the cached copy.
- **The publisher's HTML never reaches the renderer.** Main keeps it and serves it only to a frame. Why: it is third-party markup, and this page is meant to be a document, not an app.
  - The frame has no scripts, no same origin, no forms and no popups. Content policy: no network, inline styles, `data:` images and fonts.
  - The page loads once and never navigates again, whatever it asks for (a link, a reload, a `<meta http-equiv="refresh">`, another `cinna-preview:` URL). A click on an `https:` link goes to the browser; `http:` and anything else is dropped. Without this a refresh tag could send the window, or the browser, somewhere on the page's own.
  - A frame token is served only to the profile that asked, and a failure to read the page forgets the copy main held, so a frame never shows a page core has since revoked.
- **Markdown is a document.** Raw HTML is dropped, images show their alt text (core's v1 rule), and `http(s)` links go out.

## Architecture Overview

```
catalog item / Cinna agent -> useAgentDetails -> agent-details:get -> agentDetailsService -> core (details endpoints, ETag)
folder / vault agent       -> useAgentDetails -> agent-details:get -> agentDetailsService -> agentFileService.readReservedFile
publisher HTML             -> AgentDetailsModal -> agent-details:open-frame -> det- token -> cinna-preview://det-<token>/ (iframe)
```

## Integration Points

- [Bundles Catalog](../bundles_catalog/bundles_catalog.md): the catalog dialog and Settings → Profile → Catalog show the tile button, the header button and the version-row icons; the version label the modal shows from a row is the catalog's own (`v1.6`, else `Version N`). The chat's agent picker shows the button on its catalog cards ([Inline Catalog Install](../bundles_catalog/inline_install.md)).
- [Remote Agents](../remote_agents/remote_agents.md): a synced Cinna agent's page header carries Details.
- [Local Agents](../local_agents/agents_tab.md) and [Vault](../vault/vault.md): a folder or vault agent's own file, with the button in the agent page's header.
- [Kit Contract](../local_agents/kit_contract.md#agent-details-page-1280): the reserved paths and the guide that tells a builder agent when to write one (only when the user asks).
- [File Preview](../../chat/file_preview/file_preview.md#html-pages): the same `cinna-preview:` scheme and navigation guards, with a stricter `det-` host.
- [Technical details](agent_details_tech.md).
