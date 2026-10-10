# Agent Skills (A Kit Agent's Own Skills)

## Purpose

A kit agent can carry skills of its own: folders under `skills/` in the agent folder, each with a `SKILL.md`. The desktop reads and checks them, lists them in a **Skills** section on the agent page's **Addons** tab, and hands every deliverable one to whichever engine the agent runs on, by that engine's own mechanism. Without this, an author's skills sat in the folder and no session ever saw them. The same section lists the skills the agent pins from the platform's catalog (`catalog_skills[]` in its manifest), which are shown and checked but not yet delivered to any engine.

## Core Concepts

- **Authored skill** — a folder `skills/<name>/` directly inside a kit agent's folder, holding a `SKILL.md` whose frontmatter names the skill and says what it is for. The only source of skills an engine gets today
- **Catalog skill (pin)** — an entry of the manifest's `catalog_skills[]` (contract 1.10.0): a skill from the platform's catalog, referenced by `package_id`, `package_uuid`, `name`, `revision_number`, an optional `version` label and `archive_sha256`. Its files never live under `skills/`; a host is meant to download the pinned revision and check it against the hash. The desktop downloads nothing yet, so a pin is a row and nothing more. Both sources share one row shape, told apart by `source` (`authored` / `catalog`)
- **Skill rules** — the checks a skill must pass. They are cinna-core's (`skill_manifest.py`), ported line for line: the codes, the sentences, the limits and the restricted frontmatter reader are core's. **Core is the source of truth**: a rule changes there first and is ported here after, and nothing is checked here that core would not say about the same folder
- **Issue** — one finding on a skill, with core's code and sentence. An **error** keeps the skill from every engine; a **warning** is worth knowing and changes nothing
- **Deliverable** — a skill with no error. Only deliverable skills reach an engine, in any form
- **Skills plugin** — a desktop-owned local Claude plugin per kit agent, under `<userData>/cinna-plugins/agents/<key>/`, whose `skills/` holds one symlink per deliverable skill pointing at the agent's real `skills/<name>/`. Claude loads it as a plugin; OpenCode is pointed at its `skills/` folder (the **links folder**)

## User Stories / Flows

### Seeing an agent's skills

1. Agent page → **Settings** → **Addons**. Below **MCP Connectors**, a kit agent has a **Skills** section; a bare agent has none, because it made no promise about a `skills/` folder
2. Each skill is a card in the connector card's shell: a name, an **Authored** badge, a status glyph and a reveal button on the title line, then the description clamped to two lines, a **Needs** line naming the credential slots its `SKILL.md` declares (two shown, the rest folded into `+N`), and the issues, each only when there are any
3. The glyph is the shared status glyph: the first error's sentence when there is one, else the warnings, else "Every engine of this agent gets this skill"
4. The reveal button opens the skill's `SKILL.md` in the file manager, or the skill's folder when it has no `SKILL.md`. A failed reveal is shown inside that skill's card, never as a page-level error
5. A pinned catalog skill is the same card with **From the catalog** instead of **Authored** (its title names the `package_id`), the pinned version muted beside the name — or `Revision <n>` when the pin states no version — and no reveal button, because none of its files are in the folder. Every such card carries the warning "Not on this computer yet.", and an error when its name clashes (below). The section's (?) says the pin lives in `cinna-agent.json` and that no session gets a catalog skill yet
6. With a `skills/` folder but no skill in it and no pin, the section says "No skills yet."
7. The **Addons** tab's badge counts skills beside connectors. When any connector is not connected or any skill has an issue (warning included) other than "Not on this computer yet.", the badge shows how many need attention, warning-toned, titled "*k* of *n* skills need attention" (or connectors, or addons when both kinds are present); otherwise the neutral total, titled with what it is made of. A catalog row's "Not on this computer yet." warning is left out of that count: every pin carries it until catalog skills can be downloaded, and the user cannot act on it
8. Adding, removing or editing a skill refreshes the tab without a manual rescan, on every platform

### A session using a skill

1. The agent's session starts. On Claude and OpenCode the engine already lists the agent's skills by name; the assembled prompt says only that its own skills are available through the skill tool. On Codex the prompt lists each skill with its description and the path of its `SKILL.md`, and tells the agent to read it before using the skill
2. The agent opens a skill when the task matches its description. On OpenCode this does not stop the turn for a click; on Claude it follows the session's ordinary approvals

## Business Rules

- **Kit agents only.** Only a kit agent's record carries skills; on a bare agent the field is absent, and every surface (the tab, the badge, the engine config, the Claude plugin) asks whether the field is there rather than what kind of agent it is. A bare folder that runs natively on Claude loads whatever skills its own settings name, which is the engine's doing, not this feature's ([Bare Agents](bare_agents.md))
- **Only the agent's own sessions get its skills.** A chat conductor, an AI function, a synthetic chat runtime and Cinna's build session each run as an isolated folder too, and each is given no skills plugin
- **A skill is deliverable only when its frontmatter `name` equals its folder name and it has a description.** Claude names a plugin skill by its **folder** and OpenCode by its frontmatter **name**, so only a skill whose two agree is the same skill on both engines. A skill without a description gives the model nothing to decide when to open it. Both are core errors too (`name_mismatch`, `missing_description`); here they also decide what the engines can be handed
- **The other errors are core's, verbatim**: not a directory (including a **symlinked** skill folder, which is refused), no `SKILL.md`, unreadable (not UTF-8; a leading byte-order mark is tolerated), no valid frontmatter, no name, an invalid name (lowercase words joined by single hyphens, at most 64 characters), a name reserved by a platform command, a description over 1024 characters, an invalid `credentials:` block (the sentence names the first problem), and over budget
- **`cinna-tasks` is reserved.** An authored skill by that name is an error ("reserved by a platform skill") and is never linked, so it can never shadow the platform's [`cinna-tasks`](../../jobs/tasks/task_protocol.md) skill on any engine
- **Warnings never withhold a skill.** `secrets` — files in the skill that look like they hold a credential (`.env` and its variants except examples, `credentials.json`, SSH private keys, `.pem` / `.p12` / `.pfx` / `.key`), each named on the card — and `oversized`, a `SKILL.md` body above 64 KB
- **The budget is per agent, in name order**: at most 50 deliverable skills and 16 MB of skill files. Past either cap a skill that would have been delivered gets the `budget` error instead; a skill already in error costs nothing
- **What `skills/` holds besides skills is skipped silently**: plain files and dot-folders at its root are not skills (the kit ships `skills/README.md` as scaffolding). No `skills/`, or a `skills/` that is a file, is an agent with no skills
- **Skills do not decide readiness.** A broken skill is a row with its issue; the agent still runs, without that skill. The folder validator reports the same problems `kit.py validate` does — every skill error, the budget, a malformed pin, a pin clash — as **errors** in the agent's findings, because the platform leaves such a skill out and refuses to publish it; but the scanner ignores those findings when it decides whether the agent is `invalid`. An error there removes the whole agent from the engine, and one broken skill is no reason to stop an agent that runs fine without it ([Agents Home, Scanner & Folder Index](folder_index.md#readiness-in-the-order-the-user-cares-about))
- **The validator, the Addons tab and the engines use one scanner.** The findings come from the same code that builds the tab's rows and the engines' lists, so the three cannot disagree about which skills are broken. Two validator findings have no row issue: a `version` the platform would not keep as written (not one line of text, or over 64 characters) is a warning, as in `kit.py`; and the row's `secrets` and `shadowed` warnings are not findings, because `kit.py` does not report them (credential-looking files are the validator's secret check anyway)
- **A pin is checked field by field, as `kit.py` checks it.** `package_id` the catalog's id shape, `name` a skill name of at most 64 characters, `package_uuid` a UUID (compared canonically, so the same package pinned twice in two spellings is still a duplicate), `revision_number` a whole number of 1 or more, `version` absent, null or text of at most 64 characters, `archive_sha256` 64 lowercase hex characters. Each malformed field is its own error. A `package_id` that reads as a different skill name than the pin's `name` is only a warning: the `name` is what counts
- **A pin's name must be free.** It may not be a folder under `skills/` (broken ones included — "Remove the pin or rename the folder"; a catalog skill never lives under `skills/`), a skill the platform provides (`cinna-tasks`), or another pin's name. Each is an error on the pin's row and in the findings. Where an own skill and a pin share a name, both rows are listed, the own skill first
- **A pin is never delivered.** Nothing downloads a catalog skill, so every catalog row is not deliverable, and the plugin, the OpenCode config and the prompt read `skills/` only. A pin is not copied into `skills/` either: the contract forbids it
- **Declared credentials are shown, not checked.** The **Needs** line is neutral on purpose: a ✓ followed by code is how a credential row says *connected*, and nothing here checks or provides the slots. Providing them is not built
- **Each engine gets the skills by its own mechanism:**
  - **Claude** — the agent's skills plugin, passed beside the `cinna-tasks` plugin in the same session options, on the isolated branch only (a native folder loads its own skills from its settings). A plugin passed that way is not a user or project setting, so the isolated branch's `settingSources: []` does not hide it. Claude offers each skill as `<plugin>:<folder>`, the plugin named after the agent's slug when that is a clean kebab name, else `agent-skills`
  - **OpenCode** — the links folder is added to `skills.paths` after the bundle's own `skills/`, each deliverable skill is allowed by name in `permission.skill` beside `cinna-tasks`, and reads under the links folder are allowed in `external_directory`, because OpenCode reports a linked skill's location there, outside the project. Without the allows, every opening would stop the turn for a click under the agent's ask-by-default profile ([Permissions](permissions.md))
  - **Codex** — no skill loader, so the prompt lists each skill and the path of its `SKILL.md`. The path is inside the agent folder
- **OpenCode is never pointed at the agent's real `skills/`.** It registers every `SKILL.md` under a path by its frontmatter name and a later path wins, so it would register broken and reserved skills too, and an authored `cinna-tasks` there replaced the platform's skill. The links folder holds only deliverable skills, which is why the same folder serves both engines
- **Links, not copies.** An edit to a `SKILL.md` reaches the engine through the link with nothing rebuilt, and the links folder is rebuilt only when the *set* of deliverable skills, or the plugin's name, changes. On OpenCode the set is part of the generated config, so adding or removing a skill replaces the warm process and an unchanged set never does
- **The prompt never promises what the engine was not given.** "Available through the skill tool" is said only when the links folder was written; when it could not be, the prompt falls back to the Codex-style listing with paths, which is true on every engine. The `cinna-tasks` stub has no such fallback, which is the gap [The Cinna Task Protocol](../../jobs/tasks/task_protocol.md) names
- **A failure to deliver skills never fails a turn.** A plugin that cannot be written is a session without the agent's skills, logged
- **What is not built**: downloading or delivering a catalog skill (pins are listed and checked only), adding or changing a pin from the app, publishing a skill (the validator checks a `publications.json` → `skills[]` record another tool wrote, nothing more), and providing a skill's declared credentials

## Architecture Overview

```
<agent>/skills/<name>/SKILL.md
     │  scanAgentSkills (core's rules) ─┐
cinna-agent.json catalog_skills[] ──┴ agentSkillRows ── scannerService → LocalAgentDto.skills
     │      (pins: rows only, never delivered)               └─ Addons tab: Skills section, badge
     │  validateAgentFolder: skills.* / manifest.catalog_skills* findings (not counted for readiness)
     ▼  deliverable only
ensureKitAgentSkillsPlugin ──► <userData>/cinna-plugins/agents/<key>/
                                  .claude-plugin/plugin.json
                                  skills/<name> → symlink to <agent>/skills/<name>
     ├─ Claude:   session options plugins: [cinna-tasks, agent skills plugin]   (isolated branch)
     ├─ OpenCode: skills.paths: [bundle skills/, links folder] + permission.skill allow per name
     └─ prompt:   "## Your skills" — skill-tool line (Claude, OpenCode) or listing with paths (Codex, or plugin not written)
```

## Integration Points

- [Agent Addons](addons.md): the tab that hosts the Skills section and the badge that counts skills beside connectors
- [The Local Engine & Prompt Assembly](engine.md): the generated OpenCode config and the "Your skills" prompt section
- [The Claude Engine](claude_engine.md): the isolated branch and the desktop-owned plugins it loads
- [The Codex Engine](codex_engine.md): no skill loader, so a listing with paths
- [Local Agent Permissions](permissions.md): the per-skill `skill` allow and the links-folder read allow
- [The Cinna Task Protocol](../../jobs/tasks/task_protocol.md): the platform's `cinna-tasks` skill, which an authored skill may not shadow and whose plugin the agent's loads beside
- [Agents Home, Scanner & Folder Index](folder_index.md): the scanner that reads `skills/` and the watcher that refreshes on its changes, and the readiness ladder skill findings are kept out of
- [Kit Contract](kit_contract.md): contract 1.10.0's `catalog_skills[]` and `publications.json` → `skills[]`, and the validator that ports `kit.py`'s skill checks
- [Claude Code Interface Contract](contracts/claude_interface.md): `claude.session.options-plugins-agent-skills`, the expectation that a second plugin of symlinked skills loads under `settingSources: []`

Sub-doc: [Technical Details](skills_tech.md)
