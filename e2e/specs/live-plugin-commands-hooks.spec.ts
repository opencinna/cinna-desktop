import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { LIVE_ENGINE, liveEngineOptions, requireLiveEngine } from '../fixtures/liveEngine'
import { AGENT, arrangeAgent, askAgent, coreDirectory, findFiles, liveSession, manifestOf, openAddons, openTile, picker, type DirectoryEntry, type Turn } from '../fixtures/livePlugins'

/**
 * @live — **the parts of a marketplace plugin only Claude takes natively —
 * commands and hooks — on a real engine, with plugins from the developer's
 * real cinna-core** (claude-plugins-official). Arranged as
 * `live-marketplace-plugins` is (helpers in `fixtures/livePlugins.ts`): a
 * kit folder agent on a profile linked to the local core, the plugin added
 * through Addons → Add. Nothing on core is synced, edited or deleted.
 *
 * - **C1 `commit-commands`, Claude.** The agent folder is made a git repo
 *   with one uncommitted witness file. The chat's whole message is
 *   `/commit-commands:commit`, Claude's name for the plugin's command, which
 *   reaches Claude only through Cinna's wrapper plugin
 *   (`agentPluginWrappers.ts`, a symlink to the cached `commands/`). Claude's
 *   own session transcript shows the CLI took it as the command and expanded
 *   its template (its `!`git status`` line run); the command's instructions
 *   commit: HEAD moves on and holds the witness.
 * - **C2 `commit-commands`, OpenCode.** The generated `opencode.json` still
 *   lists the command under its `command` key as
 *   `<agent key>/commit-commands:commit` bound to the agent, but that slash
 *   name in a chat never reaches OpenCode as a command: Cinna expands it
 *   itself (`pluginCommandExpansion.ts`, from `acpDriver`) and sends the
 *   template as a plain prompt, each `!`git …`` line a command the model is
 *   told to run first. OpenCode's own session store holds that prompt, not an
 *   already-run git status, and the agent commits.
 * - **C2b, OpenCode.** The same turn streams into Cinna's chat: its git
 *   commit is a tool part of the transcript, and the turn holds until the
 *   agent is done. (OpenCode runs a command of its own detached: its
 *   `session/prompt` answers `end_turn` at once and nothing is streamed —
 *   which is why Cinna expands a plugin's.)
 *
 * C1 needs the slash text to lead the prompt: Cinna's wire-only task context
 * follows a Claude slash command (`acpDriver.placeTurnContext`). C2's
 * expanded prompt is an ordinary message, the context in front of it.
 * - **H1 `explanatory-output-style`, Claude.** Its only part is a
 *   SessionStart hook, `bash "${CLAUDE_PLUGIN_ROOT}/hooks-handlers/session-start.sh"`,
 *   which injects "You are in 'explanatory' output style mode …" as context.
 *   The wrapper links `hooks/` and `hooks-handlers/` into the cache; a chat
 *   asked which output style mode its context names answers `explanatory`,
 *   a word no prompt holds. The script runs only if `${CLAUDE_PLUGIN_ROOT}`
 *   resolved through the wrapper, so the answer proves that too.
 * - **H2, same test.** The row's Hooks switch off → the pin's
 *   `disabled.hooks`, the next session's wrapper has no `hooks` link, and a
 *   new chat asked the same question answers `NONE`.
 *
 * Engine: C1 and H1/H2 `LIVE_ENGINE=claude` (with `CINNA_E2E_CLAUDE_AUTH=api_key`
 * for the .env key); C2 `LIVE_ENGINE=opencode`. Needs `CINNA_E2E_SERVER_URL` /
 * `_EMAIL` / `_PASSWORD`.
 *
 * ## Cost
 *
 * C1, C2 and C2b one turn each, H1/H2 two short turns.
 *
 * ## What it does not prove
 *
 * Commands on Codex or Antigravity (expanded by Cinna as on OpenCode, unit-
 * tested only); hooks there (not delivered); a hook
 * event other than SessionStart; declared (non-default) command paths; a
 * plugin's agents or LSP servers; the admin's `plugin_hooks` flag (the local
 * core allows hooks; that switch is unit-tested).
 */

test.use(liveEngineOptions())
test.beforeEach(() => requireLiveEngine())

const COMMITS = 'commit-commands'
const COMMIT_COMMAND = 'commit'
const STYLE = 'explanatory-output-style'
/** The mode the hook's additionalContext names: "You are in 'explanatory' output style mode". */
const STYLE_MODE = 'explanatory'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
}

/** The agent folder as a git repo with everything committed but one new witness file; answers the witness and HEAD. */
function arrangeRepo(agentPath: string): { witness: string; head: string } {
  if (!existsSync(join(agentPath, '.git'))) git(agentPath, 'init', '-q')
  git(agentPath, 'config', 'user.name', 'Cinna E2E')
  git(agentPath, 'config', 'user.email', 'e2e@cinna.invalid')
  git(agentPath, 'config', 'commit.gpgsign', 'false')
  git(agentPath, 'add', '-A')
  git(agentPath, 'commit', '-q', '--allow-empty', '-m', 'baseline')
  const witness = `notes/witness-${randomBytes(4).toString('hex')}.md`
  mkdirSync(join(agentPath, 'notes'), { recursive: true })
  writeFileSync(join(agentPath, witness), '# Release notes\n\n- Fixed the export of empty tables.\n')
  return { witness, head: git(agentPath, 'rev-parse', 'HEAD') }
}

/** The agent folder's commits since `base`, and whether HEAD holds `witness`. */
function committedSince(agentPath: string, base: string, witness: string): { subjects: string[]; holdsWitness: boolean; pending: string } {
  const subjects = git(agentPath, 'log', '--format=%s', `${base}..HEAD`).split('\n').filter(Boolean)
  const holdsWitness = git(agentPath, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').includes(witness)
  return { subjects, holdsWitness, pending: git(agentPath, 'status', '--porcelain', '--', witness) }
}

/** A plugin from core's directory, or the test skipped. */
async function directoryPlugin(name: string): Promise<{ config: Parameters<typeof coreDirectory>[0]; token: string; entry: DirectoryEntry }> {
  const { config, token } = await liveSession()
  const entry = (await coreDirectory(config, token)).find((row) => row.kind === 'plugin' && row.name === name)
  test.skip(!entry, `core lists no ${name} plugin`)
  return { config, token, entry: entry as DirectoryEntry }
}

/** The picker's runs-code Add for `plugin`, pinned and cached; the dialog closed. */
async function addPlugin(cinna: CinnaApp, agent: { id: string; path: string }, entry: DirectoryEntry): Promise<void> {
  const section = await openAddons(cinna)
  const { dialog, detail } = picker(cinna)
  await openTile(cinna, section, entry.name, entry.name, 'Plugin')
  await detail.getByRole('button', { name: 'Add — runs code on this computer', exact: true }).click()
  await expect(detail.getByText('Ready in the next chat', { exact: true })).toBeVisible({ timeout: 90_000 })
  const pins = (manifestOf(agent.path).marketplace_plugins ?? []) as Array<Record<string, unknown>>
  expect(pins).toHaveLength(1)
  expect(pins[0]).toMatchObject({ entry_uuid: entry.ref.id, name: entry.name, marketplace_name: 'claude-plugins-official', archive_sha256: entry.digest?.replace(/^sha256:/, '') })
  await detail.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

/** `<userData>/cinna-plugins/agents/<key>-plugins/<plugin>`: the Claude wrapper (`agentPluginWrappers.ts`). */
function wrapperDir(cinna: CinnaApp, agentId: string, plugin: string): string {
  return join(cinna.sandbox.userData, 'cinna-plugins', 'agents', `${createHash('sha256').update(agentId).digest('hex').slice(0, 16)}-plugins`, plugin)
}

/** The cached snapshot folder of `plugin` (the one holding its `.claude-plugin/plugin.json`). */
function cachedPluginDir(cinna: CinnaApp, plugin: string): string {
  const manifests = findFiles(join(cinna.sandbox.userData, 'marketplace-plugins'), join('.claude-plugin', 'plugin.json'))
    .filter((file) => (JSON.parse(readFileSync(file, 'utf8')) as { name?: string }).name === plugin)
  expect(manifests, `${plugin}'s snapshot is cached once`).toHaveLength(1)
  return join(manifests[0], '..', '..')
}

/** Claude may ask before the command's git calls; answer only git staging and committing in the agent folder. */
function gitAsk(agentPath: string): (text: string) => boolean {
  const roots = [agentPath, realpathSync(agentPath)]
  return (text) => /^The agent is asking to run a command/.test(text) && /\bgit (add|commit|status|diff|log|branch)\b/.test(text) && !/\bgit push\b/.test(text) &&
    (!/"cwd":"/.test(text) || roots.some((root) => text.includes(`"cwd":"${root}"`)))
}

/** Every user message text in Claude's session transcripts under the sandbox HOME, oldest file first. */
function claudeUserTexts(cinna: CinnaApp): string[] {
  return findFiles(join(cinna.sandbox.home, '.claude', 'projects'), '.jsonl').flatMap((file) =>
    readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      const row = JSON.parse(line) as { type?: string; message?: { content?: unknown } }
      if (row.type !== 'user') return []
      const content = row.message?.content
      if (typeof content === 'string') return [content]
      return Array.isArray(content) ? content.filter((part: { type?: string }) => part.type === 'text').map((part: { text?: string }) => part.text ?? '') : []
    })
  )
}

/** The turn ran a tool or answered (a commit command may end with no text, as its instructions ask). */
const ranATool = (turn: Turn): boolean => turn.tools.length > 0 || turn.reply.trim() !== ''

/**
 * OpenCode's own record of the turn (`<userData>/acp/opencode-data/opencode.db`,
 * `session_message` rows): each `user` row's text — for a plugin command,
 * the prompt Cinna expanded it to — and whether an `idle` row followed the
 * last one (OpenCode is done with the turn).
 */
function openCodeSession(cinna: CinnaApp): { users: string[]; idle: boolean } {
  const file = join(cinna.sandbox.userData, 'acp', 'opencode-data', 'opencode.db')
  if (!existsSync(file)) return { users: [], idle: false }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = db.prepare('SELECT type, data FROM session_message ORDER BY rowid').all() as Array<{ type: string; data: string }>
    const users = rows.filter((row) => row.type === 'user').map((row) => String((JSON.parse(row.data) as { text?: unknown }).text ?? ''))
    const lastUser = rows.map((row) => row.type).lastIndexOf('user')
    return { users, idle: lastUser >= 0 && rows.slice(lastUser).some((row) => row.type === 'idle') }
  } finally {
    db.close()
  }
}

/* ---------------------------------------------------------------- C */

test('@live C1 Claude runs a plugin slash command, /commit-commands:commit, delivered through the wrapper plugin', async ({ cinna }) => {
  test.skip(LIVE_ENGINE.name !== 'claude', 'C1 is the Claude pass; OpenCode runs C2')
  test.setTimeout(8 * 60_000)
  const { config, token, entry } = await directoryPlugin(COMMITS)
  expect((entry as unknown as { components?: { commands?: string[] } }).components?.commands).toContain(COMMIT_COMMAND)
  const agent = await arrangeAgent(cinna, config, token)
  await addPlugin(cinna, agent, entry)

  await test.step('the row lists the command', async () => {
    const section = await openAddons(cinna)
    const row = section.locator(`[data-plugin-row="${COMMITS}"]`)
    await row.getByRole('button', { expanded: false }).click()
    await expect(row.getByText(`/${COMMIT_COMMAND}`, { exact: true })).toBeVisible()
  })

  const { witness, head } = arrangeRepo(agent.path)
  const prompt = `/${COMMITS}:${COMMIT_COMMAND}`
  const { turn } = await askAgent(cinna, agent.path, prompt, { allow: gitAsk(agent.path), settled: ranATool })

  await test.step('the wrapper carries the plugin’s commands as a link into the cache', async () => {
    const wrapper = wrapperDir(cinna, agent.id, COMMITS)
    expect(lstatSync(join(wrapper, 'commands')).isSymbolicLink()).toBe(true)
    expect(realpathSync(readlinkSync(join(wrapper, 'commands')))).toBe(realpathSync(join(cachedPluginDir(cinna, COMMITS), 'commands')))
    expect(JSON.parse(readFileSync(join(wrapper, '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({ name: COMMITS })
  })

  await test.step('Claude ran the plugin’s command: its template, with the git status it gathered, is the turn’s message', async () => {
    // Claude's own transcript of the session (`<sandbox HOME>/.claude/projects/<cwd>/<session>.jsonl`).
    // Before withTurnContext, Cinna's task context led the prompt and the CLI never saw a command:
    // the model then had to find it through its Skill tool.
    const users = claudeUserTexts(cinna)
    console.log(`live-plugin-commands-hooks C1 Claude messages: ${JSON.stringify(users.map((m) => m.slice(0, 400)))}`)
    expect(users.some((text) => text.includes(`<command-name>/${COMMITS}:${COMMIT_COMMAND}</command-name>`)), 'the CLI took the message as the command').toBe(true)
    const expanded = users.filter((text) => text.includes('Based on the above changes, create a single git commit.'))
    expect(expanded).toHaveLength(1)
    expect(expanded[0]).toMatch(/- Current git status: On branch \S+\nUntracked files:[\s\S]*\tnotes\//)
  })

  await test.step('the command committed the witness file in the agent folder', async () => {
    expect(turn.errors).toEqual([])
    const after = committedSince(agent.path, head, witness)
    console.log(`live-plugin-commands-hooks C1 commits: ${JSON.stringify(after)}`)
    expect(after.subjects.length, 'HEAD moved on from the baseline').toBeGreaterThan(0)
    expect(after.subjects, 'the commit message is the model’s own, not the prompt').not.toContain(prompt)
    expect(after.holdsWitness, `HEAD holds ${witness}`).toBe(true)
    expect(after.pending, 'nothing of the witness is left uncommitted').toBe('')
  })
})

/** C2's arrange and turn: the plugin added, the repo with its witness, `/<agent key>/commit-commands:commit` sent; git asks answered. */
async function openCodeCommandTurn(cinna: CinnaApp): Promise<{ agent: { id: string; path: string }; key: string; command: string; prompt: string; witness: string; head: string; turn: Turn }> {
  const { config, token, entry } = await directoryPlugin(COMMITS)
  const agent = await arrangeAgent(cinna, config, token)
  await addPlugin(cinna, agent, entry)
  // configGenerator.engineAgentKey: the slug's key form and the first 8 hex of sha256(agent id).
  const key = `${basename(agent.path).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40)}-${createHash('sha256').update(agent.id).digest('hex').slice(0, 8)}`
  const command = `${key}/${COMMITS}:${COMMIT_COMMAND}`
  const { witness, head } = arrangeRepo(agent.path)
  const prompt = `/${command}`
  const { turn } = await askAgent(cinna, agent.path, prompt, { allow: gitAsk(agent.path), settled: ranATool })
  return { agent, key, command, prompt, witness, head, turn }
}

test('@live C2 OpenCode lists the plugin command as <agent key>/commit-commands:commit, and Cinna sends it expanded', async ({ cinna }) => {
  test.skip(LIVE_ENGINE.name !== 'opencode', 'C2 is the OpenCode pass; Claude runs C1')
  test.setTimeout(8 * 60_000)
  const { agent, key, command, prompt, witness, head, turn } = await openCodeCommandTurn(cinna)

  await test.step('opencode.json lists the command under `command`, bound to the agent', async () => {
    const file = join(cinna.sandbox.userData, 'acp', 'opencode', createHash('sha256').update(agent.id).digest('hex').slice(0, 16), 'opencode.json')
    const generated = JSON.parse(readFileSync(file, 'utf8')) as { agent?: Record<string, { prompt?: string }>; command?: Record<string, { template?: string; description?: string; agent?: string }> }
    expect(Object.keys(generated.agent ?? {}), 'the agent’s key is the one the command is named by').toContain(key)
    const names = Object.keys(generated.command ?? {})
    console.log(`live-plugin-commands-hooks C2 commands: ${JSON.stringify(names)}`)
    expect(names).toEqual(expect.arrayContaining([`${key}/${COMMITS}:clean_gone`, command, `${key}/${COMMITS}:commit-push-pr`]))
    const cached = readFileSync(join(cachedPluginDir(cinna, COMMITS), 'commands', `${COMMIT_COMMAND}.md`), 'utf8')
    expect(generated.command?.[command]).toMatchObject({ description: 'Create a git commit', agent: key })
    expect(cached).toContain(generated.command?.[command]?.template?.trim().split('\n')[0] ?? '<no template>')
  })

  await test.step('OpenCode’s message is Cinna’s expansion of the command: its template, the git status left for the model to run', async () => {
    const messages = openCodeSession(cinna).users
    console.log(`live-plugin-commands-hooks C2 OpenCode messages: ${JSON.stringify(messages.map((m) => m.slice(0, 1500)))}`)
    expect(messages).toHaveLength(1)
    // Not the slash text, and not OpenCode's own expansion (which would hold the git status already run).
    expect(messages[0]).not.toContain(prompt)
    expect(messages[0]).toContain(`The user ran the command /${COMMITS}:${COMMIT_COMMAND}. Follow its instructions:`)
    expect(messages[0]).toContain('Based on the above changes, create a single git commit.')
    expect(messages[0]).toContain('- Current git status: [run `git status` and use its output here]')
    expect(messages[0]).not.toMatch(/Untracked files:/)
  })

  await test.step('the command committed the witness file in the agent folder', async () => {
    expect(turn.errors).toEqual([])
    const after = committedSince(agent.path, head, witness)
    console.log(`live-plugin-commands-hooks C2 commits: ${JSON.stringify(after)}`)
    expect(after.subjects.length, 'HEAD moved on from the baseline').toBeGreaterThan(0)
    expect(after.holdsWitness, `HEAD holds ${witness}`).toBe(true)
    expect(after.pending, 'nothing of the witness is left uncommitted').toBe('')
  })
})

test('@live C2b the OpenCode command turn streams its git commit into Cinna’s transcript', async ({ cinna }) => {
  test.skip(LIVE_ENGINE.name !== 'opencode', 'C2b is the OpenCode pass')
  // OpenCode 2.0.27 runs a prompt that is one of its own commands detached: `session/prompt` answers
  // `end_turn` about 80 ms after it is sent and no `session/update` for the turn reaches the wire.
  // Cinna expands a plugin's command itself, so the turn is an ordinary prompt: it streams, and it
  // ends only once the agent has committed.
  test.setTimeout(8 * 60_000)
  const { agent, head, witness, turn } = await openCodeCommandTurn(cinna)
  expect(turn.errors).toEqual([])
  expect(committedSince(agent.path, head, witness).holdsWitness, 'the commit is made by the time the turn ends').toBe(true)
  await expect.poll(() => openCodeSession(cinna).idle, { message: 'OpenCode is done with the turn Cinna ended', timeout: 15_000 }).toBe(true)
  const commits = turn.tools.filter((tool) => /git commit/.test(JSON.stringify(tool.toolInput ?? '') + tool.text))
  console.log(`live-plugin-commands-hooks C2b the commit was made; Cinna's transcript: ${turn.tools.length} tool parts, reply ${JSON.stringify(turn.reply.slice(0, 200))}`)
  expect(commits.length, 'the transcript shows the git commit the agent ran').toBeGreaterThan(0)
})

/* ---------------------------------------------------------------- H */

test('@live H1 a plugin’s SessionStart hook runs through ${CLAUDE_PLUGIN_ROOT} in the wrapper, and H2 its Hooks switch stops it', async ({ cinna }) => {
  test.skip(LIVE_ENGINE.name !== 'claude', 'hooks are delivered to Claude only')
  test.setTimeout(10 * 60_000)
  const { config, token, entry } = await directoryPlugin(STYLE)
  const agent = await arrangeAgent(cinna, config, token)
  await addPlugin(cinna, agent, entry)
  const cached = cachedPluginDir(cinna, STYLE)

  await test.step('the cached hook runs its script through ${CLAUDE_PLUGIN_ROOT} and injects the mode', async () => {
    expect(readFileSync(join(cached, 'hooks', 'hooks.json'), 'utf8')).toContain('${CLAUDE_PLUGIN_ROOT}/hooks-handlers/session-start.sh')
    expect(readFileSync(join(cached, 'hooks-handlers', 'session-start.sh'), 'utf8')).toContain(`You are in '${STYLE_MODE}' output style mode`)
  })

  const section = await openAddons(cinna)
  const row = section.locator(`[data-plugin-row="${STYLE}"]`)
  const hooks = row.locator(`section[aria-label="Hooks of ${STYLE}"]`).getByRole('switch', { name: 'Hooks', exact: true })
  await test.step('the row counts one hook event, its Hooks switch on', async () => {
    await expect(row.locator('[data-plugin-summary]')).toHaveText('1 hook event')
    await row.getByRole('button', { expanded: false }).click()
    await expect(hooks).toHaveAttribute('aria-checked', 'true')
    await expect(row.locator('[data-plugin-hook-events]')).toHaveText('SessionStart')
  })

  const question = (n: number): string =>
    `(${n}) Does any context you were given at session start (for example from a hook) say you are in a particular output style mode? ` +
    'If it does, reply with only the name of that mode, one word, as written there. If it does not, reply with only NONE. Do not run any tool.'
  expect(question(1).toLowerCase()).not.toContain(STYLE_MODE)

  await test.step('H1 a new chat is given the hook’s context', async () => {
    const { turn } = await askAgent(cinna, agent.path, question(1))
    expect(turn.errors).toEqual([])
    const wrapper = wrapperDir(cinna, agent.id, STYLE)
    for (const name of ['hooks', 'hooks-handlers']) {
      expect(lstatSync(join(wrapper, name)).isSymbolicLink(), `the wrapper links ${name}/`).toBe(true)
      expect(realpathSync(readlinkSync(join(wrapper, name)))).toBe(realpathSync(join(cached, name)))
    }
    expect(turn.reply.toLowerCase()).toContain(STYLE_MODE)
  })

  await test.step('H2 the Hooks switch off writes disabled.hooks, and the next chat has no hook context', async () => {
    const section2 = await openAddons(cinna)
    const row2 = section2.locator(`[data-plugin-row="${STYLE}"]`)
    await row2.getByRole('button', { expanded: false }).click()
    const toggle = row2.locator(`section[aria-label="Hooks of ${STYLE}"]`).getByRole('switch', { name: 'Hooks', exact: true })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => (manifestOf(agent.path).marketplace_plugins as Array<{ disabled?: unknown }>)[0].disabled).toEqual({ hooks: true })

    const { turn } = await askAgent(cinna, agent.path, question(2))
    expect(turn.errors).toEqual([])
    // A plugin whose only part was its hooks carries nothing for Claude now: no wrapper at all.
    const wrapper = wrapperDir(cinna, agent.id, STYLE)
    expect(existsSync(join(wrapper, 'hooks')), 'the next session’s wrapper links no hooks/').toBe(false)
    expect(turn.reply.toLowerCase()).not.toContain(STYLE_MODE)
    expect(turn.reply.trim()).toMatch(/^NONE\.?$/)
  })
})
