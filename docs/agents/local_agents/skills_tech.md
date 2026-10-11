# Agent Skills — Technical Details

Implementation reference for [Agent Skills](skills.md).

## File Locations

### Main process — reading and checking
- `src/main/kit/skills.ts`: the port of cinna-core's `backend/app/services/agents/skill_manifest.py` (`parse_frontmatter`, `parse_credential_declarations`, `parse_skill_dir`, `scan_skills_root`, `apply_budget`), plus the catalog-pin helpers ported from the kit's `tools/kit.py` (`catalog_skill_name`, `skill_version_problem`), the catalog rows and the cache-resolver types. Core module: no Electron, `node:` builtins only
- `src/main/kit/validator.ts`: `checkSkills()` and `checkCatalogSkills()`, the port of `kit.py validate`'s skill checks; re-exports `isSkillFinding()`
- `src/shared/kit/findings.ts`: `isSkillFinding()`, shared so the scanner and the agent page's `ReadinessStrip` judge a finding the same way
- `src/main/services/localAgents/scannerService.ts`: sets `skills: judgeSkillRows(agentSkillRows(agentDir, manifest, catalogSkillCache.resolverFor(desktop.shared_remote?.kind === 'cinna')), attached)` on a kit agent's DTO (a recorded 404 worded by the agent's own link) (`[]` on an unreadable one), and leaves the field off a bare agent's; `readiness()` drops `isSkillFinding` errors before deciding `invalid`
- `src/main/services/localAgents/localAgentService.ts`: `overlayEnabled` folds `withCatalogSkillUpdates` and `withSkillPublications` into every listed agent — read-time facts that no file in the folder holds
- `src/main/services/localAgents/watcherService.ts`: `WATCHED_SUBDIRS` (`docs`, `credentials`, `skills`) and `SKILLS_SUBDIR`

### Main process — catalog skills
- `src/main/services/catalogSkillService.ts`: add, update, remove, `ensurePinned` / `ensurePinnedInBackground`; the download (`fetchRevision`), changeability (`changeability`, `cinnaRepoIdOf`), the manifest write (`writePins`), the background credential fill and detach (`skillCredentials`, `detachUnusedCredentials`) and the start-up cache clean-up (`collectGarbage`). Core service
- `src/main/services/catalogSkillCache.ts`: the shared read-only cache. Core module: paths from `runtimeHost`
- `src/main/kit/skillArchive.ts`: `readSkillArchive`, `writeSkillTree`, `SkillArchiveError`, `MAX_ARCHIVE_BYTES` (16 MB), `MAX_UNPACKED_BYTES` (64 MB), `MAX_ENTRIES` (10,000). `node:zlib` only
- `src/main/services/catalogSkillUpdates.ts`: `activeListing`, `linkedEntry`, `changeableFromLink`, `withCatalogSkillUpdates`, `catalogSkillUpdateItems`. Kept apart from the service so `localAgentService` imports it without a cycle
- `src/main/services/catalogLocalInstalls.ts`: `reportSkillInstalled`, `reportSkillRemoved`
- `src/main/services/cinna-http.ts`: `cinnaFetchBytes` (capped binary GET) and `cinnaSend` (writes whose 4xx come back as data)
- `src/main/services/inboxService.ts`: `skillUpdateItems()`
- `src/main/services/localAgents/sharingService.ts`: `update` (when changes landed), `useTeamVersion` and `get` call `catalogSkillService.ensurePinnedInBackground`
- `src/main/ipc/catalogSkills.ipc.ts`: `registerCatalogSkillHandlers()`

### Main process — sharing a skill
- `src/main/services/skillPublishService.ts`: `preview`, `publish`, and the pure helpers `catalogRefusal`, `toPreviewDto`, `withPreviousProviders`, `publishMeta`, `multipartBody`; `SKILL_PUBLISH_SENTENCES`, `PUBLISH_PREVIEW_PATH`, `PUBLISH_PATH`
- `src/main/kit/skillPack.ts`: `collectSkillTree`, `packSkillTarGz`, `skillTreeHash`, `MAX_SKILL_UPLOAD_BYTES` (16 MB), `MAX_SKILL_UPLOAD_MEMBERS` (2000)
- `src/main/kit/miniYaml.ts`: `setFrontmatterLine(raw, key, value)`
- `src/main/kit/publications.ts`: `SkillPublication`, `readSkillPublications`, `findSkillPublication`, `upsertSkillPublication`
- `src/main/services/skillPublications.ts`: `withSkillPublications` (the row's `shared` / `shareable`)
- `src/main/ipc/skillPublish.ipc.ts`: `registerSkillPublishHandlers()`

### Main process — delivery
- `src/main/services/agentSkillsPlugin.ts`: the per-agent skills plugin and links folder; `kitAgentDeliverableSkills`. Core module: paths come from `runtimeHost`
- `src/main/services/localAgents/promptAssembly.ts`: `skillsSection(agentDir, manifest, context)`, `DesktopPromptContext.ownSkills`, and `resolveDesktopPromptContext(engine?)`
- `src/main/engine/engineConfigSource.ts`: `collectEngineAgents` builds the plugin and passes `ownSkills(plugin)`
- `src/main/engine/configGenerator.ts`: `EngineAgentInput.skillPaths` / `.skills` / `.skillReadPaths`, `profileWithOwnSkills`, and the merged `skills.paths`
- `src/main/agents/drivers/acp/acpLaunchers.ts`: `ClaudeLauncherDeps.agentSkillsPlugin`; the OpenCode launcher forwarding `input.skillPaths`
- `src/main/agents/drivers/index.ts`: `kitAgentSkillsPlugin(userId, agentId)`, the `ownSkills` fallback in `folderSystemPrompt`, and the turn env through `engineCredentialEnv`
- `src/main/services/skillRuntime.ts`: `skillRuntimeSourceDir`, `skillRuntimeCopiesDir`, `ensureSkillRuntime`, `withSkillRuntime`, `engineCredentialEnv`
- `src/main/services/localAgents/commandService.ts`: kit commands and scheduled runs get the same env through `engineCredentialEnv`
- `resources/skill-runtime/core/cinna_api/` (`__init__.py`, `credentials.py`): the `core.cinna_api` shim. Shipped through `electron-builder.yml` `extraResources` as `Resources/skill-runtime` (kept out of the asar, `__pycache__` filtered); `.gitignore` ignores the bytecode a development run writes
- `src/main/agents/drivers/acp/contracts/claude.contract.ts`: the entry `claude.session.options-plugins-agent-skills`

### Shared
- `src/shared/localAgents.ts`: `LocalAgentSkill` (with catalog-only `packageId`, `packageUuid`, `revisionNumber`, `latestRevision`, `latestVersion`, `title`, `updatable`; authored-only `shared`, `shareable`), `LocalAgentSkillShared`, `LocalAgentSkillIssue`, `LocalAgentSkillCredential` (`filled?`, `attachment?`), `LocalAgentSkillSource`, `LocalAgentDto.skills?`
- `src/shared/kit/manifest.ts`: `CatalogSkillPin` and `CinnaAgentManifest.catalog_skills?`
- `src/shared/catalogSkills.ts`: `CatalogSkillAddInput`, `CatalogSkillNameInput`, `CatalogSkillEnsureInput`, `CatalogSkillRefusal`, `CatalogSkillOutcome`, `CatalogSkillEnsureResult`, `CatalogSkillEnsureFailure`
- `src/shared/skillPublish.ts`: `SkillPublishPreviewDto`, `SkillPublishSlot`, `SkillPublishCandidate`, `SkillPublishInput`, `SkillPublishPerson`, `SkillPublisherCredential`, `SkillPublishRefusal`, `SkillPublishOutcome`, `SkillPublishPreviewOutcome`
- `src/shared/inbox.ts`: `UpdateAvailableTarget` `'skill'` and its item variant (`skillName`, `skillTitle`, `pinnedRevision`)

### Preload
- `src/preload/index.ts`: `window.api.catalogSkills.{add, update, remove, ensure}`, `window.api.skillPublish.{preview, publish}`

### Renderer
- `src/renderer/src/components/agents/local/AgentAddonsTab.tsx`: the Skills section, `SkillRow`, `CatalogRowActions`, `skillHealth`, `slotHealth`, `needsAttention`, `notHere`, and `useAddonsBadge(agentId, agentSkills?)`
- `src/renderer/src/components/agents/local/ReadinessStrip.tsx`: adds **Finish setup** to a readiness line when `unattachedSkillSlots` is non-empty
- `src/renderer/src/utils/localAgents.ts`: `unattachedSkillSlots(skills)` — the deliverable skills' slots with `filled === false`, once each, in first-seen order
- `src/renderer/src/hooks/useCatalog.ts`: `invalidateLocalAgentsAfterListing(queryClient)`, called by `useCatalogItemsWatch` and `useSharingWatch` (`useSharing.ts`)
- `src/renderer/src/components/agents/local/ShareSkillDialog.tsx`: the Share dialog
- `src/renderer/src/components/agents/local/sharing/ShareDialogs.tsx`: `PeopleSearch`, `ChosenPeopleList`, `personLabel`, `ChosenPerson`, now exported for the Share dialog
- `src/renderer/src/components/agents/CatalogSkillAddMenu.tsx`: **Add to agent…** (see [Bundles Catalog — Technical Details](../bundles_catalog/bundles_catalog_tech.md))
- `src/renderer/src/components/agents/local/LocalAgentPage.tsx`: `addonsBadgeTitle(count, skills, problems)` and the badge
- `src/renderer/src/hooks/useCatalogSkills.ts`: `useAddCatalogSkill`, `addCatalogSkillKey`, `useCatalogSkillAdds`, `useUpdateCatalogSkill`, `useRemoveCatalogSkill`, `useEnsureCatalogSkills`, `catalogSkillOutcomeMessage`
- `src/renderer/src/hooks/useSkillPublish.ts`: `usePublishSkill`
- `src/renderer/src/hooks/useLocalAgents.ts`: `useOpenAgentPath` (the reveal)
- `src/renderer/src/utils/catalogItems.ts`: `CATALOG_SKILL_TEXT`, `SKILL_SHARE_TEXT`, `catalogVersionLabel`

## Database Schema

None. Skills are read from the folder (and the cache) on every scan and every session plan; nothing about them is stored. The plugin's record of what it was built from is a file beside it, a cached revision's is `.cinna-catalog-skill.json` inside it, the skill runtime's is `.cinna-runtime-hash` inside its copy, and a failed download is held in memory only.

## IPC Channels

Skills travel on `LocalAgentDto` through the existing `local-agent:get` / list reads. The reveal is `local-agent:open-path` with `relPath` = the skill's `path` (`skills/<name>/SKILL.md`), or `skills/<name>` when the issue is `missing_skill_md` or `not_a_directory`.

Every channel below gates on `userActivation.requireActivated()`, runs in the **settings** scope like every `local-agent:*` channel (the service reads the active Cinna profile itself), carries only ids, names and choices, and answers data — refusals included — because a thrown `DomainError`'s code does not survive IPC.

- `catalog-skills:add` `{agentId, packageUuid}` → `CatalogSkillOutcome`
- `catalog-skills:update` `{agentId, name}` → `CatalogSkillOutcome`
- `catalog-skills:remove` `{agentId, name}` → `CatalogSkillOutcome`
- `catalog-skills:ensure` `{agentId}` → `CatalogSkillEnsureResult` (`fetched`, `failed[]`)
- `skill-publish:preview` `{agentId, name}` → `SkillPublishPreviewOutcome`
- `skill-publish:publish` `SkillPublishInput` → `SkillPublishOutcome`; `people` and `publisherCredentials` are filtered field by field in the service
- `service-credentials:setup-skills` and the `autoAttached` payload of `service-credentials:changed`: see [Service Credentials](../service_credentials/README.md#skill-credential-slots)

## Services & Key Methods

### `src/main/kit/skills.ts`
- Constants (core's): `SKILL_NAME_RE`, `MAX_NAME_LENGTH` 64, `MAX_DESCRIPTION_LENGTH` 1024, `MAX_VERSION_LENGTH` 64, `MAX_BODY_BYTES` 64 KB, `DEFAULT_MAX_SKILLS` 50, `DEFAULT_MAX_TOTAL_BYTES` 16 MB, `RESERVED_SKILL_NAMES` (the platform slash commands), `PLATFORM_SKILL_NAMES` (`cinna-tasks`; a test keeps it equal to `tasksSkillService.TASKS_SKILL_NAME`), `SKILL_CREDENTIAL_TYPES` (core's `CredentialType` minus `mcp_provider`), `MAX_SKILL_CREDENTIALS` 20, `ISSUE_MESSAGES`, `CATALOG_ISSUE_MESSAGES`
- `parseSkillFrontmatter(text)`: core's restricted YAML subset, divergences included — scalars (`yes`/`no` as booleans, integers as `bigint` so `str()` is exact), flow and block sequences, block scalars, `- key: value` items as mappings. Throws only on a missing or unclosed fence
- `parseCredentialDeclarations(raw)`: the declarations, or the first problem as a phrase, which becomes the `invalid_credentials` sentence
- `parseSkillDir(skillDir, folderName)`: the error checks in core's order, stopping at the first; then `measureTree` (size, secret-looking files and links in one walk; symlinks never followed or counted, `.git` / `node_modules` / `.venv` and other junk directories never entered) for the warnings, ordered `secrets`, `links`, `shadowed`, `oversized` (`WARNING_PRECEDENCE`). Links are collected for the `links` warning except under `.pytest_cache` (`UNPACKED_DIR_NAMES`), which core walks (so `SKIP_DIR_NAMES` stays core's) but Share never packs. Used for a cached catalog folder too, with the pin's name as the folder name
- `scanAgentSkills(agentDir, {maxSkills, maxTotalBytes})`: every directory directly under `skills/` that is not a dot-entry, name-sorted, then `applyBudget`. Never throws. Never returns a catalog row
- `scanAgentSkillDetails(agentDir, options)`: the same scan with each row's `versionProblem` beside it, for `checkSkills()`
- `skillVersionProblem(raw)`: `kit.py`'s `skill_version_problem`. Not a row issue, only a validator warning
- `catalogSkillName(packageId)`: the skill name a catalog `package_id` seems to carry. Advisory, for the `name_differs` warning only
- `isCatalogPinName(name)`: `SKILL_NAME_RE` within 64 characters
- `catalogPinClashes(pins, authored)`: index → `('duplicate' | 'authored' | 'platform')[]`. `authored` is every folder name the scan lists, broken ones included
- `CatalogSkillRef`, `catalogSkillRefOf(pin)`: a pin as `{packageUuid, revisionNumber, name, archiveSha256}` (a non-whole or < 1 revision is null)
- `CatalogSkillCacheState` (`ready` with `dir` / `failed` with `message` / `missing`) and `CatalogSkillResolver`
- `catalogSkillRows(manifest, authored, resolve?)`: one row per usable pin, `source: 'catalog'`. Without a resolver, or for a `missing` revision: `path: ''`, `description: ''`, `deliverable: false`, the clash errors then `not_downloaded`. `failed`: the clash errors then `download_failed` with the failure's sentence. `ready`: `parseSkillDir(dir, pin.name)` decides — `path` the absolute cached `SKILL.md`, description and credentials from it, `version` the pin's label else the cached frontmatter's, issues the clash errors then the cached copy's own, `deliverable` only with no clash and a deliverable copy. A resolver that throws reads as `missing`
- `agentSkillRows(agentDir, manifest, resolve?)`: own rows plus catalog rows, stably name-sorted so an own skill precedes a pin of its name. What the scanner puts on the DTO and — through `deliverableSkills`, with `catalogSkillCache.resolve` — what every engine is given
- `deliverableSkills(skills)`: the ones with no error
- `isSecretFilename(name)`: core's predicate plus the kit contract's `dotenv` rule
- `shadowed` and `projection_error` are in `ISSUE_MESSAGES` because they are core's vocabulary; the desktop never emits either

### `src/main/kit/validator.ts`
- `checkCatalogSkills(report, manifest)` (in `validateManifest`, so the conformance set covers it): `catalog_skills` not an array → `manifest.catalog_skills.type`; per pin `.item`, `.package_id` (`/^[a-zA-Z0-9][a-zA-Z0-9.-]{1,253}$/`), `.name`, `.name.duplicate`, `.package_uuid` (canonicalised as Python's `str(uuid.UUID())` before the duplicate check; `_` and inner whitespace, which Python tolerates, are refused), `.package_uuid.duplicate`, `.revision_number`, `.version`, `.archive_sha256` — errors; `.package_id.name_differs` — a warning
- `checkSkills(report, agentDir, manifest)` (in `validateAgentFolder`, after `checkFiles`): each own row's error as `skills.<core issue code>` at `skills/<name>/SKILL.md` (`skills.not_a_directory` and `skills.budget` at the folder), `skills.oversized` and `skills.version` as warnings; then the folder-dependent pin clashes, `manifest.catalog_skills.name.authored_clash` or `.platform_clash`. Row warnings `secrets` and `shadowed`, and whether a pin is downloaded, are not reported
- `isSkillFinding(finding)`: the code starts with `skills.` or `manifest.catalog_skills`. The scanner's `readiness()` filters these out of the errors, and `ReadinessStrip` ignores them when it decides a legacy folder's only problem is its missing `id`; `isValid(report)` is unchanged and still counts them

### `src/main/services/catalogSkillCache.ts`
- `instanceKey(origin)`: `https://cinna.example.com:8443` → `https-cinna.example.com-8443`, `[a-z0-9.-]` only
- `cacheRefOf(ref)`: the pin's fields as safe path components (lowercased UUID, digest of 64 hex, `isCatalogPinName`, revision ≥ 1), or null. Nothing reaches a path or a request URL that did not pass it
- `resolve(ref)`: the resolver `kit/skills.ts` is handed. Tries the active profile's instance, then every other instance folder; `readyDir` checks that every folder from the cache root down is a real directory (`lstat`, never a link), that the marker's uuid, name, revision and digest equal the pin's, and that `<name>/` is a real directory. Else the remembered failure, else `missing`; a remembered 404 reads `BEHIND_SENTENCE`. Never throws
- `resolverFor(teamTracked)`: `resolve` with a remembered 404 worded `notAvailableSentence(teamTracked)` — `BEHIND_SENTENCE` or `WITHDRAWN_SENTENCE`. The record is shared by every agent pinning the revision, so it keeps only the fact
- `instanceOfPath(path)`: the instance folder a cached path lies in, or null outside the cache
- `has(instance, ref)`, `revisionDir(instance, ref)`, `root()`
- `install(instance, ref, archive)`: creates the chain folder by folder (`mkdirSync` without `recursive`, then `isRealDir`), because a recursive create would follow a linked instance or package folder; sweeps `<rev>.tmp-*` / `<rev>.old-*` older than 10 minutes; returns an existing matching revision; moves anything else at the final path aside (`lstat`, so even a dangling link is moved, never followed); writes the tree and marker (0444) into `<rev>.tmp-<stamp>` and renames it in. Losing the rename race to a matching revision keeps theirs. Clears the pin's failure
- `recordFailure(ref, message)` / `recordNotAvailable(ref)` / `clearFailure(ref)`: an in-memory map keyed `<uuid>/<revision>/<digest>`
- `removeTree(path)`: chmods back to writable, then removes, never following a link
- `revisionKeyOf(pin)`: a raw pin's `<uuid lowercased>/<revision>`, or null when its `package_uuid` is not a UUID or its `revision_number` not a whole number of 1 or more. Package and revision only: a pin whose digest does not match the cached copy still keeps the folder, which the next install moves aside if it must
- `isEmpty()`: no cache root, or only `.`-names in it
- `collectGarbage(keep)`: walks `<instance>/<uuid>/<revision>` and removes each revision whose `uuid/revision` (lowercased) is not in `keep`, on every instance, then the `<uuid>` and `<instance>` folders left empty. A link at any level is removed as a link (`realChildren`); `<rev>.tmp-*` / `<rev>.old-*` only once older than `STALE_STAGING_MS` (10 minutes); `.`-names never. Synchronous, so nothing in this process installs or resolves in between. Answers `{removed}` and logs a count when anything went
- `_reset(root)`: tests

### `src/main/kit/skillArchive.ts`
- `readSkillArchive(gz, name)`: size cap, then `gunzipSync` with `maxOutputLength` 64 MB, then a ustar walk with pax `x`/`g` and GNU `L`/`K` headers and checksum checks; regular files (`0`, `\0`, `7`) and directories only — a hard link, symlink or anything else is a `SkillArchiveError`; path checks; exactly one root, `skills/<name>/` or `<name>/`; no duplicate path case-insensitively; `SKILL.md` at the top. Touches no disk
- `writeSkillTree(target, archive)`: folders and files with 0444 / 0555 modes, folders made read-only last

### `src/main/services/catalogSkillService.ts`
- `skillDownloadPath(uuid, n)`: `/api/v1/skills/packages/{uuid}/revisions/{n}/download`
- `fetchRevision(profile, host, target)`: one in-flight promise per `<instance>/<uuid>/<revision>/<digest>`; skips a revision already in that instance; `cinnaFetchBytes` with `MAX_ARCHIVE_BYTES`; `too_large` when over; the digest must equal both `X-Content-SHA256` and the pin's `archive_sha256` (`hash_mismatch` otherwise, logged); `readSkillArchive` then `catalogSkillCache.install` (`write_failed` on a disk refusal). Records or clears the failure. `downloadRefusal` maps errors: `CinnaReauthRequired` or a 401 → `reauth_required`; 403 → `download_failed` "The server did not allow this download."; 404 → `NotAvailable`, agent-independent, recorded with `recordNotAvailable` (the promise and the record are shared across agents). Each caller (add, update, ensurePinned) passes the outcome through `phrased`, which makes it `download_failed` with the update-the-team-agent-first sentence (`BEHIND_SENTENCE`) when its own agent is team-tracked, else the access-withdrawn one (`WITHDRAWN_SENTENCE`) — `teamTrackedOf(dir)`, asked only on a 404 and once per verb: the `shared_remote` link, else a git `origin` `cinnaRepoIdOf` recognises (git missing or failing → tracked, the hedged sentence); no server or not a Cinna user → `no_account`; `SkillArchiveError` → `invalid_archive` with its sentence
- `locateKit(userId, agentId)`: `not_found`, or `not_kit_agent` when the DTO has no `skills` or the manifest cannot be read
- `changeability(dir, listing)`: `gitService.readShareRemote(dir)`; without an own-repo origin, the `shared_remote` link alone (`linkedEntry`). With one, `cinnaRepoIdOf` — `…/git/<repo_id>.git` on `http(s)`, counted as Cinna when the folder recorded `cinna.server`, or the origin is a known host that `libraryTrust` trusts — and the listing entry by `cloneUrl` or `repoId`, falling back to the link's access. `use` → `read_only`; Cinna but unknown access → `access_unknown`; anything else → `ok`
- `skillItem(profile, uuid)`: the cached listing's skill item, refreshed once when missing (a reauth error is rethrown; any other refresh error is logged)
- `latestPinOf(item)`: a pin from `item.latest.revision_number`, `item.skill.archive_sha256` (lowercased), `item.name` and the trimmed `item.latest.version`; null when any is unusable
- `clashOf(dir, pins, name, except)`: platform name, an own skill folder, or another pin's name
- `writePins(dir, change)`: `readWithStamp` → `change(pins)` (may refuse on the fresh read) → `writeIfUnchanged`. `KitError('manifest_modified')` → `manifest_modified`; other `KitError` → `write_failed`. Answers the manifest `id` for the install report
- `settle(rootId, agentId)`: `scannerService.markAllRootsDirty()` and `LOCAL_AGENT_CHANGED_CHANNEL` with `reason: 'rescan'`
- `addToAgent(userId, agentId, packageUuid)`: account → kit → listing item → `latestPinOf` → `changeability` → `already_added` / `clash` on the current pins → `fetchRevision` → `writePins` re-checking both → settle → `reportInstalled` → `void skillCredentials(agentId)`
- `update(userId, agentId, name)`: as add, against the pin named `name`; already at or past the latest answers `ok` with the current revision and does nothing; the moved pin keeps `name` and unknown keys, drops the old `version`. In the background `detachUnusedCredentials` first, then `skillCredentials`: a later version can drop a slot, and what was attached for it goes before the new slots fill
- `remove(userId, agentId, name)`: changeability, then `writePins` filtering the pin out; `reportSkillRemoved` when the manifest has an `id` and a server is set; then `void detachUnusedCredentials(agentId)`. The cache is left alone: the next start's `collectGarbage` removes the revision if nothing pins it
- `ensurePinned(userId, agentId)`: every usable, non-clashing pin whose `resolve` is not `ready`; without an account each gets the `no_account` failure recorded; else `fetchRevision` one after another, reporting each success. Settles once. Never throws (`write_failed` "The pinned skills could not be checked." on the unexpected)
- `ensurePinnedInBackground(userId, agentId)`: `ensurePinned` then `skillCredentials`, unawaited
- `skillCredentials(agentId)`: imports `serviceCredentials/service` lazily (as the drivers do, so this module does not pull it in), `autoAttachSkills`, and publishes `SERVICE_CREDENTIALS_CHANGED` with `{autoAttached: {agentId, items}}` to `'all'` when it attached anything
- `detachUnusedCredentials(agentId)`: imports the credential service lazily, like `skillCredentials`, and runs `detachUnusedAutoAttachments`; logged, never failing the verb. It runs after `settle`, and the credential service re-reads the agent from its folder, so it sees the pins just written ([Service Credentials](../service_credentials/README.md#detaching-what-it-attached))
- `pinnedRevisions()`: the keep set — under the settings scope (the profiles share one agents list), every registered root through `scannerService.scanRootCached`, so a folder the index has not seen yet counts; each DTO with `skills` (a kit agent) has its manifest read fresh and every pin through `revisionKeyOf`. `{ok: false}` when an indexed folder agent's `localPath` is not among the scanned paths (its root unreadable) or a kit agent's manifest cannot be read
- `collectGarbage()`: `catalogSkillCache.isEmpty()` → `{ok: true, removed: 0}` without reading any pin; else `pinnedRevisions()`, and on `ok: false` a `warn` and nothing removed; else `catalogSkillCache.collectGarbage(keep)`. Synchronous, never throws. Called once from `initializeHubCore` (`src/main/hub/core.ts`) through `setImmediate`, off the boot path and before a profile activates, so no turn or schedule holds a path into the cache
- `guarded(verb, run)`: a lost session is `reauth_required`; anything else is logged and `write_failed` with the error's sentence

### `src/main/services/catalogSkillUpdates.ts`
- `linkedEntry(dir, listing)`: the `app-data/desktop.json` `shared_remote` link of kind `cinna`, matched to the listing by `repo_id` or `bundle_id`; `{linked, access}`
- `changeableFromLink(dir, listing)`: not linked, or linked with access other than null and `use`
- `withCatalogSkillUpdates(agent)`: on every catalog row, `title` (`display_name`), `latestRevision`, `latestVersion` from the active profile's cached listing, and `updatable` = changeable and latest past the pin; plus a `catalog_unavailable` warning issue (appended after the row's own) when the listing loaded (`available: true`), the agent has no Cinna `shared_remote` link, the package is not among its skill items, the row is not `not_downloaded`/`download_failed`, and its cached copy lies in the listing host's instance (`instanceOfPath(row.path) === instanceKey(listing.host)`; the lookup falls back to other instances, whose copies this listing does not speak for). Never a validator finding, never touches `deliverable`. Never throws
- `catalogSkillUpdateItems(agents, listing)`: one `UpdateAvailableInboxItem` with `target: 'skill'` per agent and `updatable` pin; `versionLabel`, `changedBy` and `changedAt` only when the listing's `latest` is still the version the number names

### `src/main/services/skillPublishService.ts`
- `preview(userId, agentId, name)`: account → `locateSkill` (an authored row of a kit agent) → `invalidRefusal` (the row's first error as `skill_invalid`) → `POST publish-preview` with `{name, frontmatter, package_uuid?}` (the frontmatter as JSON, `bigint` as a number where safe) → `toPreviewDto` → for an existing package, `withPreviousProviders(preview, listedSkill(…), selfId(profile))`
- `withPreviousProviders`: `canProvide` false only when the listing names a publisher other than the stored token's `sub`; each `required_credential_specs` slot provided `publisher` by a credential still among the candidates becomes `current`; any other provided slot, or no listing row, makes `providersCarried` false
- `publish(userId, input)`: account → skill → `unchangeableRefusal(profile, dir)` (`changeableFromLink` over `activeListing(profile)`; refused `access_unknown` when `linkedEntry` has no access, else `read_only`) → `invalidRefusal` → `collectSkillTree` (`treeRefusal`: `has_link`, `special_file`, `secrets` naming up to three paths, `unreadable`, `too_large`, `too_many_files`) → `packSkillTarGz` → size check → `publishMeta(input, recorded uuid)` → `upload` (`cinnaSend` multipart `meta` JSON + `archive` `<name>.tar.gz`). A `package_exists` on a first share whose body names the package is retried once with `package_uuid` and without `visibility` / `grants`. Then `writeVersion` (`setFrontmatterLine`, through a dot-prefixed temp file), `packageIdOf` (a refreshed listing, else a second preview), `content_hash` from the answer or `skillTreeHash` over the folder as sent with the version written, `upsertSkillPublication`, settle. `recorded: false` when either file write failed. Changeability is checked by the link and the listing only, as `shareable` is drawn — not by the git `origin` that `catalogSkillService.changeability` also reads. `preview` has no changeability check
- `publishMeta(input, packageUuid)`: `release_notes` (trimmed, 10,000 characters); on a first share only, people deduplicated and access-checked, `visibility` `public` for Everyone else `users` when anyone is named, `grants` without `use` grants under `public`; `publisher_credentials` `{slot, credential_id}`
- `catalogRefusal(status, body)`: core's coded refusals (`detail.code`) to `SkillPublishRefusal`, `package_exists` carrying the package uuid when given; `SKILL_PUBLISH_SENTENCES` holds every sentence, leading with what the person can do

### `src/main/kit/skillPack.ts` / `miniYaml.ts` / `publications.ts`
- `collectSkillTree(skillDir)`: walks with `lstat`; skips `.git`, `.venv`, `node_modules`, `__pycache__`, `.mypy_cache`, `.ruff_cache`, `.pytest_cache` and `*.pyc` / `*.pyo`; reports links, special files, secret-looking names (`isSecretFilename`), unreadable files, over 16 MB or over 2000 members
- `packSkillTarGz(name, tree)`: deterministic ustar (pax `path` records for long or non-ASCII paths), every member under `<name>/`, gzip header mtime 0 and OS 255 as Python writes it
- `skillTreeHash(name, files)`: core's `PublishService.hash_workspace_tree` over `skills/<name>/…`, the `content_hash` recorded
- `setFrontmatterLine(raw, key, value)`: a port of core's `_write_version_to_skill_md` — replaces a top-level `key:` line or inserts after `name:` (else at the top), keeping BOM, line endings, quoting, comments and body byte for byte; null when there is no frontmatter, the file is not UTF-8, or the value would break the line
- `upsertSkillPublication(agentDir, entry)`: replaces the entry with the same `platform_url` (trailing slash ignored) and `name`, keeping unknown keys, or appends; creates `{publications: [], skills: [entry]}`; refuses to overwrite a file that is not a JSON object; temp file then rename

### `src/main/services/skillPublications.ts`
- `withSkillPublications(agent)`: for every authored row, `shared` from this account's server's `publications.json` entry and `shareable` = active account, `changeableFromLink`, deliverable, and — once shared — `edit` or `maintain` on the package in the cached listing. Never throws

### `src/main/services/agentSkillsPlugin.ts`
- `agentSkillsPluginDir(agentId)`: `<userData>/cinna-plugins/agents/<first 16 hex of sha256(agentId)>`. Keyed by the agent id, so it is stable across a rename and never a path built from a renderer string
- `agentSkillsPluginName(slug)`: the slug when it matches `SKILL_NAME_RE` within 64 characters and is not `cinna-tasks`, else `FALLBACK_PLUGIN_NAME` (`agent-skills`). A name with a space silently drops the whole plugin on Claude
- `kitAgentDeliverableSkills(agentDir, manifest)`: `deliverableSkills(agentSkillRows(agentDir, manifest, catalogSkillCache.resolve))`
- `ensureKitAgentSkillsPlugin({id, path})`: **the one entry point** both engines use. Reads the manifest fresh (slug, else the folder name; no manifest, no pins) and the skills fresh, so the Claude launcher and the OpenCode config never write the same folder from different inputs; a launcher that once used the folder basename and its own scan flapped the plugin's name and contents against the OpenCode config. Returns `{dir, skills, readPaths?}` or null; `readPaths` is `[catalogSkillCache.root()]` only when a catalog skill is linked
- `ensureAgentSkillsPlugin(input)`: sweeps leftovers, then returns the existing folder when `.cinna-agent-skills.json` records the same `{name, links}` (link targets included, so a re-pinned revision rebuilds) and every link is still a symlink; otherwise builds a staging tree — `.claude-plugin/plugin.json`, `skills/<name>` as a `dir` symlink (a `junction` on Windows) to `skillFolder()` (the agent's `skills/<name>` or the cached folder), the state file — and `swapInto`s it. Never throws
- Removal of an old plugin goes through `rm`, which unlinks a symlink and never follows it into the agent's folder or the cache

### `src/main/agents/drivers/index.ts`
- `kitAgentSkillsPlugin(userId, agentId)`: null for a synthetic runtime profile, an AI function profile, a missing row, a chat conductor or a development (build) agent; otherwise `ensureKitAgentSkillsPlugin`. Wired as `ClaudeLauncherDeps.agentSkillsPlugin`
- `folderSystemPrompt(engine)`: for a kit agent whose context says `ownSkills: 'skill'`, asks `kitAgentSkillsPlugin` and downgrades to `'pointer'` when it answers null or throws
- The turn's env is `engineCredentialEnv(plan.spec.env, prepared)`, where `prepared` is `serviceCredentialService.prepare(agentId)` — `{path, skillRuntime: agent.skills !== undefined}`

### `src/main/agents/drivers/acp/acpLaunchers.ts`
- Claude: on the isolated branch only, `deps.agentSkillsPlugin(ctx.userId, ctx.agentId)` through `safely`; its path joins `tasksSkillPlugin()`'s in `_meta.claudeCode.options.plugins`, `cinna-tasks` first. Not asked on the native branch. The path is not part of the spec key
- OpenCode: `buildEngineConfig` receives `input.skillPaths` (the bundle's `skills/`). Before that was wired, the launcher dropped it, so an OpenCode ACP session had no `skills.paths` at all and `cinna-tasks` never reached it

### `src/main/engine/engineConfigSource.ts` / `configGenerator.ts`
- `collectEngineAgents`: for a DTO carrying `skills`, `ensureKitAgentSkillsPlugin({id, path})` before the prompt, then `ownSkills: plugin ? 'skill' : 'pointer'` into the prompt and `ownSkills(plugin)` — `{skillPaths: [<plugin>/skills], skills: <names>, skillReadPaths?: plugin.readPaths}` — onto the entry
- `buildEngineConfig`: `skills.paths` is the bundle's paths, then each emitted agent's `skillPaths`, deduplicated in order; `skillReadPaths` never join it. The config bytes feed `digestEngineConfig`, so a change in the set restarts the warm process
- `profileWithOwnSkills(profile, skills, readPaths)`: the profile's `skill` entry (else `{'*': 'ask'}`) with each name set to `allow` after `cinna-tasks`, and `external_directory` with `<path>/*` allowed for the links folder and each `skillReadPaths` entry. `'*': 'ask'` stays first and the last matching rule wins. A manifest's own `skill` or `external_directory` replaces the whole entry, as every override does

### `src/main/services/localAgents/promptAssembly.ts`
- `skillsSection(agentDir, manifest, context)`: null when no skill is deliverable; with `ownSkills: 'skill'` one sentence saying the skill tool has them (naming the pinned catalog skills when any is delivered); otherwise `## Your skills` with one line per skill — name, description with whitespace collapsed, `SKILL.md` path (absolute for a catalog skill). Placed after `## Your knowledge` and before the handover block
- `resolveDesktopPromptContext(engine?)`: with an engine, `ownSkills` is `'pointer'` for Codex and `'skill'` for the others; without one it is absent, which reads as `'pointer'`

### `src/main/services/skillRuntime.ts`
- `skillRuntimeSourceDir()`: `Resources/skill-runtime` packaged, `<app>/resources/skill-runtime` in development (the bundled kit's rule)
- `ensureSkillRuntime(source?)`: `contractTreeHash(source)`; returns `<userData>/skill-runtime/<first 16 hex>/` when its `.cinna-runtime-hash` matches; else copies without `__pycache__` into `.tmp-<pid>-<time>`, writes the hash file, `swapInto`, and removes every other entry. Null on failure, logged
- `withSkillRuntime(env, dir)`: `dir` first on `PYTHONPATH`, the rest kept after it, never twice
- `engineCredentialEnv(base, prepared, runtimeDir?)`: `CINNA_CREDENTIALS_PATH` set to the delivered file or removed; the runtime prepended when `prepared.skillRuntime`

### `src/main/services/localAgents/watcherService.ts`
- The per-directory fallback (Linux, or wherever recursive watching is refused) watches `skills/` — a skill appearing or going — and each `skills/<name>/`, where its `SKILL.md` is edited. Without the second level an edit was invisible there. The cache is not watched: every change to it comes from a verb that settles

## Renderer Components

| Component | Notes |
|---|---|
| `AgentAddonsTab` | Takes `onFinishSetup` from `LocalAgentPage` (`finishSetup.open`; the page owns the dialog) and passes it to every `SkillRow`. A "Skills" `SettingsSection` after MCP Connectors, only when `agent.skills` is present, with a (?) explaining the layout, what each engine gets, that an errored skill is left out, and that a catalog skill is pinned in `cinna-agent.json` and downloaded once. Owns the reveal mutation and one `revealError` keyed by skill name; the catalog verbs (`useUpdateCatalogSkill`, `useEnsureCatalogSkills`, `useRemoveCatalogSkill`) with `skillBusy`, `skillError` and `confirmingRemove`, so a verb in flight outlives the row's re-render when its rescan lands; and the share (`usePublishSkill`, `sharingSkill`, `shareError`), so a share outlives its dialog. `readOnly` from `useListedShareStatus(agent.id)`: unread, or a `cinna` remote without `edit` / `maintain`. Try again reads its own row's entry from `ensure`'s `failed`. List keys are `source:name:index` |
| `SkillRow` | The connector card's shell (ux_rules rule 13). Title line (`min-h-12`): `Sparkles`, the title (a catalog row's listing `title`, else the name; tooltip `title — name`), the muted version (`catalogVersionLabel(revisionNumber, version)` for a pin; for a shared own skill `Version N` plus a **Shared** `SettingsBadge` titled with the package id), **Authored** or **From the catalog**, `CredentialStatusGlyph` with `skillHealth(skill)`, then the actions: Share (`Share2`, own skills with `shareable`), reveal (own skills), and for a pin Update (`ArrowUpCircle`, `updatable` and not `readOnly`), Try again (`RotateCw`, `notHere`) and Remove (`Trash2`, not `readOnly`), a `Loader2` in place of the busy one. Then the description, the `data-skill-slots` **Needs** line (`MAX_SLOT_CHIPS` 2, then `+N`; each chip led by a 12px `CredentialStatusGlyph` from `slotHealth(credential)` — `ok` when `filled`, `warning` when not, worded by whether an `attachment` exists, none when `filled` is undefined; the line's tooltip adds `· attached` / `· not attached`; ending in a **Finish setup** link, `ml-auto`, when `onFinishSetup` is given and the skill is deliverable with a `filled === false` slot), the issues, the Remove confirm in an `AnimatedCollapse`, and last one `role="alert"` line for a reveal or verb error, the latter dropped when an issue already says it |
| `ShareSkillDialog` | `DialogShell`, keyed by skill name. Every row present from the first frame (Version and Catalog id read **Loading…** until `skill-publish:preview` answers), so the preview landing changes words, not the footprint. Slots from the row's own credentials, enabled once the preview names candidates; a slot select per slot (`OWN` = each person connects their own; preselected `current` on a later version; no candidates offered when `canProvide` is false) with `providersNotKept` / `publisherProvidersNotKept` lines; Note; on a first share (`!isRepublish`) **Who can use it**: Everyone checkbox, `PeopleSearch`, `ChosenPeopleList` with `unsent` striking through Can use under Everyone. Does not own the share: `onShare` is the tab's; closes on success only, refusal under the fields |
| `useAddonsBadge(agentId, agentSkills)` | `{count, problems, skills}`: connectors plus skills; problems are connectors with an `mcpProblem` plus skills with any issue other than `not_downloaded` or, when deliverable, any credential with `filled === false` (`needsAttention`), so `download_failed` counts and an unjudged slot does not |
| `ReadinessStrip` | `(readiness === 'credentials_needed' || unattachedSkillSlots(agent.skills).length > 0) && onFinishSetup` shows **Finish setup**, but only inside a line the strip already draws: the early `return null` does not look at skill slots, so a skill-only gap raises no strip |
| `LocalAgentPage` | The badge shows `problems` warning-toned when there are any, else the neutral `count`; `addonsBadgeTitle` names connectors, skills or addons |
| `invalidateLocalAgentsAfterListing` | Invalidates `LOCAL_AGENTS_KEY` and the `['local-agent']` prefix (every open agent page) on each `catalog:items-changed` and `sharing:changed`. A row's `latestRevision` / `updatable` / `title` and an own skill's `shareable` are folded in by `localAgentService` from main's cached listing on every `get` / `list`, not by the scan, so no folder push follows a listing move; before this an open Skills row showed **Update** only after something else re-read the agent. The events carry no payload saying what moved, so it runs on each one. `sharing:changed` is needed beside `catalog:items-changed` because a desktop agent's move publishes only that event, and access (which decides `updatable`) lives there |
| `useCatalogSkills` hooks | Each settles by invalidating the local-agent list, the agent and the Inbox. `useAddCatalogSkill` runs under `addCatalogSkillKey(packageUuid)` so `useCatalogSkillAdds` reads every add of that package from the mutation cache, whichever menu started it |

## Configuration

None user-facing. The skill limits are core's constants above; changing one is a change in core first. The archive and upload limits mirror core's publish limits. `electron-builder.yml` ships `resources/skill-runtime` as an extra resource, filtered of `__pycache__`.

## Security

- **Only deliverable skills are linked**, so a name is always `SKILL_NAME_RE` and a link is never built from an unchecked string. The plugin folder's key is a hash
- **A symlinked skill folder is refused** (`not_a_directory`), so a link in the plugin never points through the agent's folder to somewhere else
- **The real `skills/` is never handed to OpenCode**: a skill there registers by frontmatter name and a later path wins, and an authored `cinna-tasks` replaced the platform's. `cinna-tasks` is a reserved name, never linked by folder, frontmatter name or pin name
- The OpenCode allows are scoped: reads under the links folder and, only when a catalog skill is linked, under the cache root; opening the agent's own skills by name only
- **The download's token goes only to the profile's own server**: `cinnaFetchBytes` and `cinnaSend` accept a path, never an absolute URL, and refuse a session that changed mid-request. Only a UUID, a revision number and a digest that passed `cacheRefOf` reach the request path
- **Nothing unchecked is written**: two digests, then the safe reader, then a staged, marked, renamed revision; read-only modes; no write or read through a link anywhere in the cache chain
- **Sharing sends nothing that fails preflight**: links, special files and secret-looking files are refused before any byte leaves; core refuses secrets again on its side
- **The skill runtime is never run from the signed bundle**: only the `userData` copy is on `PYTHONPATH`, so Python's bytecode cannot modify the app. A bare folder never gets it
- The `secrets` warning names credential-looking files a skill holds; it does not withhold the skill from engines, as core does not

## Tests

- `src/main/kit/skills.test.ts`: frontmatter subset, versions, credential declarations, every error and warning, BOM, non-UTF-8, symlinked folder, skipped root entries, budget order, `PLATFORM_SKILL_NAMES` against the bundled `kit.json`, `catalogSkillName`, catalog rows (clash errors, unusable pins skipped, `missing` / `failed` / `ready` from a resolver, a cached copy checked by the same rules) and their merge with own rows
- `src/main/kit/skillArchive.test.ts` (fixtures from `kit/testSupport/skillTar.ts`, including an archive core built): both roots, pax and GNU long names, links, hard links, devices, traversal, absolute paths, duplicates in any case, a wrong or second top folder, missing `SKILL.md`, a gzip bomb, read-only layout
- `src/main/services/catalogSkillService.test.ts`: add / update / remove / ensure against a fake server and a temp cache — both digests, U9 refusals, the git-less fallback to the link, an untrusted `/git/<x>.git` origin as the developer's own, name clashes, refusals as data, a refused archive, local-install reports, a refusal recorded on the row, one shared 404 worded per agent (tracked and untracked, either order), slots filled after a sharing verb's fetch, in-flight keying by digest, a non-UUID pin making no request, complete-or-absent installs, markers of another digest, linked `<uuid>` and revision folders, per-pin failures, `instanceKey`, the background detach after Remove (on the pins as written) and before the re-fill after Update, and garbage collection (kept on every instance, unindexed kit folders counted, bare folders pin nothing, stale versus fresh staging, dot-names, links removed as links, no pin read with nothing cached, skipped on an unparsable or missing manifest or an unreachable indexed agent); and `catalogSkillUpdates` (the update signal, titles, the Inbox items)
- `src/main/kit/skillPack.test.ts`, `miniYaml.test.ts` (`setFrontmatterLine`; holds a raw NUL — diff it with `--text`), `publications.test.ts`, `src/main/services/skillPublishService.test.ts`: deterministic bytes, preflight refusals, `read_only` / `access_unknown` before anything is sent or written and a share from a team agent with `edit`, the `package_exists` retry without access, meta for first and later shares, previous providers, the two file writes and `recorded`
- `src/main/services/skillRuntime.test.ts`: `PYTHONPATH` order for a kit agent and none for a bare one, the dev path, the `extraResources` entry, the `userData` copy (never the shipped folder), its rebuild only on a changed tree, no entry when the copy fails, and the shim itself (`require_slot` as core's, nothing without `CINNA_CREDENTIALS_PATH`, no platform token call); `commandService.test.ts`: a command's env through the same hook
- `src/main/services/agentSkillsPlugin.test.ts`: links to the real folders and to a cached revision's read-only folder under a stable per-agent key, no link for a clashing pin or one whose digest is not the cached one, rebuild on a changed set, removed link or slug, plugin name rules, no authored `cinna-tasks`
- `configGenerator.test.ts`, `engineConfigSource.test.ts`, `acpLaunchers.test.ts`: `skills.paths` order, per-name allows, the cache read allow without a skills path, manifest override, restart on a changed set, the Claude plugin pair on the isolated branch only
- `promptAssembly.test.ts`, `src/main/agents/drivers/index.test.ts`: the section per engine with catalog skills, its position, and the pointer fallback
- `sharingService.test.ts`: the background fetch after Get and after an Update, and none after a refused Update
- `validator.test.ts`, `conformance.test.ts`, `scannerService.test.ts`: skill and pin findings, and readiness left alone
- `AgentAddonsTab.test.tsx`, `LocalAgentPage.test.tsx`, `ShareSkillDialog.test.tsx`, `CatalogBrowserModal.test.tsx`, `InboxView.updates.test.tsx`: rows and actions, read-only agents, the confirm, errors, the badge (an unattached deliverable slot counts, an attached or unjudged one does not), slot glyphs and the row's Finish setup; the Share dialog's states; the Add to agent menu; the skill Update card
- `ReadinessStrip.test.tsx`: Finish setup added to a readiness line for a skill slot, and no strip for a skill-only gap
- `useCatalog.itemsWatch.test.tsx`: both watches re-read the local-agent list and pages
- `claude.contract.test.ts`: `claude.session.options-plugins-agent-skills` against the real pinned CLI (`make contract ENGINE=claude`)
- E2E, on the built app (how to run and what each asserts: [Writing E2E Tests](../../development/e2e/e2e_llm.md)): `skills-validation.spec.ts` (an authored skill's row, no account, every error and the `links` warning); against a real local cinna-core, `live-catalog-skills` / `-access` and `live-sharing-skill-audiences` (one person, the team, everyone, nobody; core's local-install record; an editor who is not the publisher), `-engines` (what each engine is handed, and one billed OpenCode turn; the Claude turn is `fixme`), `-lifecycle` (revoke, private, the delete guard, U7 behind, Remove detaching only what it attached, the restart clean-up) and `-credentials` (`provision-local`, each person's own, `not_allowed_locally` / `not_shareable`, a wrong type, two candidates, later versions), and `live-sharing-cloud` (a skill published from a cloud agent's workspace, added to a desktop agent)
