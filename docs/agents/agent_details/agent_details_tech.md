# Agent Details — Technical Details

## File Locations

Shared
- `src/shared/agentDetails.ts`: targets, the view, error codes, `AGENT_DETAILS_CSP`, `AGENT_DETAILS_FRAME_SANDBOX`, `AGENT_DETAILS_FRAME_HOST_PREFIX` (`det-`), `MAX_AGENT_DETAILS_BYTES` (1 MiB), `AGENT_DETAILS_FILES` (HTML first), `agentDetailsTargetKey`.

Main (hub core, no Electron)
- `src/main/services/agentDetails/agentDetailsService.ts`: `createAgentDetailsService(deps)`, `parseAgentDetailsTarget`, `agentDetailsPath`, `parseAgentDetailsBody`.
- `src/main/services/agentDetails/agentDetails.ts`: the production wiring, and `installAgentDetailsLocalFiles(reader)` for the host's file reader (default: `unsupported`, so the plain-Node hub shows no folder Details).
- `src/main/services/htmlPreview/agentDetailsFrameServer.ts`: `createAgentDetailsFrameServer`, `stripMetaRefresh`.
- `src/main/services/agentFiles/agentFileService.ts:readReservedFile()`, with `pathIn` on `fileSource.ts`, `hostFolderSource.ts` and `vaultFileSource.ts`.
- `src/main/auth/cinna-oauth.ts`: `CinnaEndpoints.agent_details`.

Main (desktop host)
- `src/main/ipc/agent_details.ipc.ts`: the three handlers.
- `src/main/host/desktop/htmlPreview.ts`: `agentDetailsFrameServer`, host routing, the navigation handler.
- `src/main/host/desktop/htmlPreviewGuards.ts`: `isAgentDetailsUrl`, `detailsExit`, and the `det-` branches of `mainFrameNavigation` and `previewFrameNavigation`.
- `src/main/index.ts`: installs `agentFileService.readReservedFile` as the local reader.

Preload: `window.api.agentDetails` (`get`, `openFrame`, `releaseFrame`).

Renderer
- `src/renderer/src/hooks/useAgentDetails.ts`: the query, key `['agent-details', profileId, targetKey]`, refetched on every mount.
- `src/renderer/src/components/agents/AgentDetailsButton.tsx`, `AgentDetailsModal.tsx` (also `agentDetailsShown`, `AGENT_DETAILS_TEXT`).
- Placement: `CatalogItemViews.tsx` (header button, version rows), `ExternalAgentActionsMenu.tsx` (Cinna agent ⋯), `local/AgentActionsMenu.tsx` (folder agent ⋯), `local/ManifestCards.tsx` and `local/VaultOverview.tsx` (vault Description card).

## IPC Channels

| Channel | Direction | Payload | Result |
|---|---|---|---|
| `agent-details:get` | renderer → main | `AgentDetailsTarget` | `{ ok: true, details }` / `{ ok: false, code, message }`; `details` never holds HTML |
| `agent-details:open-frame` | renderer → main | `AgentDetailsTarget` | `{ ok: true, token, url }` / failure |
| `agent-details:release-frame` | renderer → main | token | `{ success: true }` |

Failures are data (codes `unsupported`, `not_found`, `unavailable`); a thrown error would lose its code in transit. `get` and `open-frame` require user activation. The profile id is read once per call, so a switch mid-call cannot bind a page to the next profile.

## Services & Key Methods

- Remote reads: `GET /api/v1/catalog/items/<uuid>/details[?revision_number=N]` and `GET /api/v1/agents/<id>/details`, through `cinnaSend` for the profile. `revision_number` below 1 is never sent (core answers 422). Cache: per `profileId|path`, at most 64 (`MAX_AGENT_DETAILS_CACHE`), `If-None-Match` on repeat, a 304 reuses the entry, a 404 deletes it. The discovery document is asked per call (successes cached by `cinna-oauth`); a failed discovery means no button and is not remembered.
- `parseAgentDetailsBody`: strict; `generated` must be markdown, `etag` a non-empty string, anything else is `unavailable` and logged without content.
- Local reads: `getLocal` reads the two files through `readReservedFile(agentId, rel, maxBytes)`. `agent_not_found`, `unsupported` and `invalid_input` are `not_found`; `locked` is `unavailable` ("Unlock the vault…"); `not_found`, `not_a_file` and `credential_file` count as absent.
- `htmlFor(target, profileId)`: the HTML the last `get` read (at most 16, `MAX_AGENT_DETAILS_HTML`), else a fresh read; a non-HTML answer is `not_found`.
- `readReservedFile`: needs a source that previews and has `pathIn` (host folder, vault); requires the stat to be `inside` the agent folder, a file, not a credential file; reads whole; refuses a file that grew while read.

## The frame host

- `cinna-preview://det-<48 hex>/` serves one document and answers 404 for every other path, method other than GET/HEAD gets 405. At most 16 tokens (`MAX_AGENT_DETAILS_FRAME_TOKENS`), oldest dropped. A token requested under another profile is deleted.
- Headers on every response: the details CSP (`default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'`), `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `nosniff`. Core also puts the policy in a meta tag; the header is the desktop's own, so a page cannot depend on it.
- `stripMetaRefresh` removes `<meta http-equiv="refresh">` at register time, tolerant of case, quoting, attribute order and numeric character references.
- Iframe sandbox: `allow-top-navigation-by-user-activation` only (no scripts, no same origin, no popups, no forms), `referrerpolicy="no-referrer"`, keyed by URL so a new page is a new frame.
- Routing: `handlePreviewRequest` sends `det-` hosts here, beside the file preview, `art-` and `dash-` hosts.
- Navigation: `previewFrameNavigation` returns `open-external` for `https:` and `block` otherwise once a frame is on a `det-` URL, and `block` for any frame under one; `mainFrameNavigation` does the same for a top navigation initiated from one (a plain `http:` link is blocked, unlike an ordinary preview's). The handler in `htmlPreview.ts` opens an `open-external` verdict through the same one-open-per-click gate as the file preview.

## Configuration

- Discovery flag `agent_details` (a number, at least 1) in the server's discovery document.
- No settings and no new env vars.

## Security

- The renderer never holds publisher HTML or core's content beyond markdown; frame tokens are random, profile-bound and bounded.
- A folder agent's file is read only inside its folder, never a credential file, never with a consent prompt.
- Logs carry the kind and status, never the content.

## Tests

- `agentDetailsService.test.ts`, `agentDetailsFrameServer.test.ts`, `htmlPreviewGuards.test.ts` (det- cases), `agentFileService.test.ts` and `vaultFileSource.test.ts` (reserved files), renderer `AgentDetailsModal.test.tsx`, `local/AgentActionsMenu.test.tsx`.
