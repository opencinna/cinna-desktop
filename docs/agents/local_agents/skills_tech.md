# Agent Skills — Technical Details

Implementation reference for [Agent Skills](skills.md).

## File Locations

### Main process
- `src/main/kit/skills.ts`: the port of cinna-core's `backend/app/services/agents/skill_manifest.py` (`parse_frontmatter`, `parse_credential_declarations`, `parse_skill_dir`, `scan_skills_root`, `apply_budget`). Core module: no Electron, `node:` builtins only
- `src/main/services/agentSkillsPlugin.ts`: the per-agent skills plugin and links folder. Core module: paths come from `runtimeHost`
- `src/main/services/localAgents/scannerService.ts`: sets `skills: scanAgentSkills(agentDir)` on a kit agent's DTO (`[]` on an unreadable one), and leaves the field off a bare agent's
- `src/main/services/localAgents/promptAssembly.ts`: `skillsSection(agentDir, context)`, `DesktopPromptContext.ownSkills`, and `resolveDesktopPromptContext(engine?)`
- `src/main/services/localAgents/watcherService.ts`: `WATCHED_SUBDIRS` (`docs`, `credentials`, `skills`) and `SKILLS_SUBDIR`
- `src/main/engine/engineConfigSource.ts`: `collectEngineAgents` builds the plugin and passes `ownSkills(plugin)`
- `src/main/engine/configGenerator.ts`: `EngineAgentInput.skillPaths` / `.skills`, `profileWithOwnSkills`, and the merged `skills.paths`
- `src/main/agents/drivers/acp/acpLaunchers.ts`: `ClaudeLauncherDeps.agentSkillsPlugin`; the OpenCode launcher forwarding `input.skillPaths`
- `src/main/agents/drivers/index.ts`: `kitAgentSkillsPlugin(userId, agentId)` and the `ownSkills` fallback in `folderSystemPrompt`
- `src/main/agents/drivers/acp/contracts/claude.contract.ts`: the entry `claude.session.options-plugins-agent-skills`

### Shared
- `src/shared/localAgents.ts`: `LocalAgentSkill`, `LocalAgentSkillIssue`, `LocalAgentSkillCredential`, `LocalAgentSkillSource` (`'authored'` only), and `LocalAgentDto.skills?`

### Renderer
- `src/renderer/src/components/agents/local/AgentAddonsTab.tsx`: the Skills section, `SkillRow`, `skillHealth`, and `useAddonsBadge(agentId, agentSkills?)`
- `src/renderer/src/components/agents/local/LocalAgentPage.tsx`: `addonsBadgeTitle(count, skills, problems)` and the badge
- `src/renderer/src/hooks/useLocalAgents.ts`: `useOpenAgentPath` (the reveal)

## Database Schema

None. Skills are read from the folder on every scan and every session plan; nothing about them is stored. The plugin's own record of what it was built from is a file beside it (below).

## IPC Channels

No new channel. Skills travel on `LocalAgentDto` through the existing `local-agent:get` / list reads. The reveal is `local-agent:open-path` with `relPath` = the skill's `path` (`skills/<name>/SKILL.md`), or `skills/<name>` when the issue is `missing_skill_md` or `not_a_directory`.

## Services & Key Methods

### `src/main/kit/skills.ts`
- Constants (core's): `SKILL_NAME_RE`, `MAX_NAME_LENGTH` 64, `MAX_DESCRIPTION_LENGTH` 1024, `MAX_VERSION_LENGTH` 64, `MAX_BODY_BYTES` 64 KB, `DEFAULT_MAX_SKILLS` 50, `DEFAULT_MAX_TOTAL_BYTES` 16 MB, `RESERVED_SKILL_NAMES` (the platform slash commands), `PLATFORM_SKILL_NAMES` (`cinna-tasks`; a test keeps it equal to `tasksSkillService.TASKS_SKILL_NAME`), `SKILL_CREDENTIAL_TYPES` (core's `CredentialType` minus `mcp_provider`), `MAX_SKILL_CREDENTIALS` 20, `ISSUE_MESSAGES`
- `parseSkillFrontmatter(text)`: core's restricted YAML subset, divergences included — scalars (`yes`/`no` as booleans, integers as `bigint` so `str()` is exact), flow and block sequences, block scalars, `- key: value` items as mappings. Throws only on a missing or unclosed fence
- `parseCredentialDeclarations(raw)`: the declarations, or the first problem as a phrase, which becomes the `invalid_credentials` sentence
- `parseSkillDir(skillDir, folderName)`: the error checks in core's order, stopping at the first; then `measureTree` (size and secret-looking files in one walk, symlinks skipped, `.git` / `node_modules` / `.venv` and other junk directories never entered) for the two warnings, ordered `secrets`, `shadowed`, `oversized`
- `scanAgentSkills(agentDir, {maxSkills, maxTotalBytes})`: every directory directly under `skills/` that is not a dot-entry, name-sorted, then `applyBudget`. Never throws
- `deliverableSkills(skills)`: the ones with no error
- `isSecretFilename(name)`: core's predicate plus the kit contract's `dotenv` rule
- `shadowed` and `projection_error` are in `ISSUE_MESSAGES` because they are core's vocabulary; the desktop never emits either

### `src/main/services/agentSkillsPlugin.ts`
- `agentSkillsPluginDir(agentId)`: `<userData>/cinna-plugins/agents/<first 16 hex of sha256(agentId)>`. Keyed by the agent id, so it is stable across a rename of the folder or the agent and never a path built from a renderer string
- `agentSkillsPluginName(slug)`: the slug when it matches `SKILL_NAME_RE` within 64 characters and is not `cinna-tasks`, else `FALLBACK_PLUGIN_NAME` (`agent-skills`). A name with a space silently drops the whole plugin on Claude
- `ensureKitAgentSkillsPlugin({id, path})`: **the one entry point** both engines use. Scans `skills/` fresh and reads the slug fresh from the manifest (`manifest.slug`, else the folder name, as the scanner does), so the Claude launcher and the OpenCode config never write the same folder from different inputs; a launcher that once used the folder basename and its own scan flapped the plugin's name and contents against the OpenCode config. Returns `{dir, skills}` or null
- `ensureAgentSkillsPlugin(input)`: sweeps leftovers (`<key>.tmp-*`, `<key>.previous*`), then returns the existing folder when `.cinna-agent-skills.json` records the same `{name, links}` and every link is still a symlink; otherwise builds a staging tree — `.claude-plugin/plugin.json` (`name`, `version: '1'`), `skills/<name>` as a `dir` symlink (a `junction` on Windows, which needs no developer mode), the state file — and `swapInto`s it. Never throws: a failure is logged and answers null
- Removal of an old plugin goes through `rm`, which unlinks a symlink and never follows it into the agent's folder

### `src/main/agents/drivers/index.ts`
- `kitAgentSkillsPlugin(userId, agentId)`: null for a synthetic runtime profile, an AI function profile, a missing row, a chat conductor or a development (build) agent; otherwise locates the folder through `localAgentService.locate` and calls `ensureKitAgentSkillsPlugin`. Wired as `ClaudeLauncherDeps.agentSkillsPlugin`
- `folderSystemPrompt(engine)`: for a kit agent whose context says `ownSkills: 'skill'`, asks `kitAgentSkillsPlugin` and downgrades to `'pointer'` when it answers null or throws

### `src/main/agents/drivers/acp/acpLaunchers.ts`
- Claude: on the isolated branch only, `deps.agentSkillsPlugin(ctx.userId, ctx.agentId)` through `safely`; its path joins `tasksSkillPlugin()`'s in `_meta.claudeCode.options.plugins`, each `{type: 'local', path}`, `cinna-tasks` first. Either may be missing; neither gives no `plugins` key. Not asked on the native branch. Like the `cinna-tasks` plugin's, the path is not part of the spec key
- OpenCode: `buildEngineConfig` now receives `input.skillPaths` (the bundle's `skills/`). **Before this, the launcher dropped it**, so an OpenCode ACP session had no `skills.paths` at all and `cinna-tasks` never reached it, although `collectEngineConfigInput` computed it

### `src/main/engine/engineConfigSource.ts` / `configGenerator.ts`
- `collectEngineAgents`: for a DTO carrying `skills` (a kit agent), `ensureKitAgentSkillsPlugin({id, path})` before the prompt, then `ownSkills: plugin ? 'skill' : 'pointer'` into the prompt and `ownSkills(plugin)` — `{skillPaths: [<plugin>/skills], skills: <names>}` — onto the entry
- `buildEngineConfig`: `skills.paths` is the bundle's paths, then each emitted agent's `skillPaths`, deduplicated in order; a skipped agent adds none. The config bytes feed `digestEngineConfig`, so a change in the set restarts the warm process
- `profileWithOwnSkills(profile, skills, skillPaths)`: the profile's `skill` entry (else `{'*': 'ask'}`) with each name set to `allow` after `cinna-tasks`, and `external_directory` with `<links folder>/*` allowed. `'*': 'ask'` stays first, and the last matching rule wins, so any other skill still asks. A manifest's own `skill` or `external_directory` replaces the whole entry, as every override does

### `src/main/services/localAgents/promptAssembly.ts`
- `skillsSection(agentDir, context)`: null when no skill is deliverable; with `ownSkills: 'skill'` one sentence saying the skill tool has them; otherwise `## Your skills` with one line per skill — name, description with whitespace collapsed, `SKILL.md` path. Placed after `## Your knowledge` and before the handover block
- `resolveDesktopPromptContext(engine?)`: with an engine, `ownSkills` is `'pointer'` for Codex and `'skill'` for the others; without one it is absent, which reads as `'pointer'`

### `src/main/services/localAgents/watcherService.ts`
- The per-directory fallback (Linux, or wherever recursive watching is refused) watches `skills/` — a skill appearing or going — and each `skills/<name>/`, where its `SKILL.md` is edited. Without the second level an edit was invisible there

## Renderer Components

| Component | Notes |
|---|---|
| `AgentAddonsTab` | A "Skills" `SettingsSection` after MCP Connectors, only when `agent.skills` is present, with a (?) explaining the layout, what each engine gets and that an errored skill is left out. Owns the reveal mutation and one `revealError` keyed by skill name |
| `SkillRow` | The connector card's shell (ux_rules rule 13). Title line: `Sparkles`, name, `Authored` badge, `CredentialStatusGlyph` with `skillHealth(skill)`, reveal `SettingsIconButton`. Then the `line-clamp-2` description (padding on the wrapper, since a clamped box clips at its padding edge), the `data-skill-slots` **Needs** line (`MAX_SLOT_CHIPS` 2, then `+N`, every slot in the title), the issues list (`paths` as code chips), and the reveal error (`role="alert"`) last |
| `useAddonsBadge(agentId, agentSkills)` | `{count, problems, skills}`: connectors plus skills; problems are connectors with an `mcpProblem` plus skills with any issue. The skills come from the agent the page already holds, so no extra IPC |
| `LocalAgentPage` | The badge shows `problems` warning-toned when there are any, else the neutral `count`; `addonsBadgeTitle` names connectors, skills or addons |

## Configuration

None user-facing. The limits are core's constants above; changing one is a change in core first.

## Security

- **Only deliverable skills are linked**, so a name is always `SKILL_NAME_RE` and a link is never built from an unchecked string. The links point inside the agent's own folder; the plugin folder's key is a hash
- **A symlinked skill folder is refused** (`not_a_directory`), so a link in the plugin never points through the agent's folder to somewhere else
- **The real `skills/` is never handed to OpenCode**: a skill there registers by frontmatter name and a later path wins, and an authored `cinna-tasks` replaced the platform's. `cinna-tasks` is also a reserved name, and never linked by folder or by frontmatter name
- The OpenCode allows are scoped: reads under the links folder only, and opening the agent's own skills by name only
- The `secrets` warning names credential-looking files a skill holds; it does not withhold the skill, as core does not

## Tests

- `src/main/kit/skills.test.ts`: frontmatter subset, versions, credential declarations, every error and warning, BOM, non-UTF-8, symlinked folder, skipped root entries, budget order
- `src/main/services/agentSkillsPlugin.test.ts`: links to the real folders under a stable per-agent key, rebuild only on a changed set or a removed link or slug, plugin name rules, no authored `cinna-tasks`, sweep of interrupted builds, the shared builder's fresh scan and slug
- `src/main/services/localAgents/watcherService.fallback.test.ts`: the fallback watches `skills/` and each skill folder
- `configGenerator.test.ts`, `engineConfigSource.test.ts`, `acpLaunchers.test.ts`: `skills.paths` order, per-name allows, manifest override, links folder never the real one, restart on a changed set, the Claude plugin pair on the isolated branch only
- `promptAssembly.test.ts`, `src/main/agents/drivers/index.test.ts`: the section per engine, its position, and the pointer fallback when the plugin could not be written
- `claude.contract.test.ts`: `claude.session.options-plugins-agent-skills` against the real pinned CLI (`make contract ENGINE=claude`)
- `AgentAddonsTab.test.tsx`, `LocalAgentPage.test.tsx`: the rows, the reveal and its error, no section on a bare agent, the badge count and title
