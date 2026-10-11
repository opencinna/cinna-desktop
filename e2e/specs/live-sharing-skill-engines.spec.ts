import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_FILE } from '../../src/shared/kit/manifest'
import { RUNTIME_PINS } from '../../src/shared/runtimePins'
import type { CinnaApp, Sandbox } from '../fixtures/app'
import { installCachedEngine } from '../fixtures/engine-cache'
import { LIVE_REQUESTED, requireLiveKey, seedOpenAiDefaultMode } from '../fixtures/live'
import {
  test,
  expect,
  addSkillToAgent,
  buildAgent,
  cachedSkillDir,
  catalogPinOf,
  catalogPins,
  chatStartedWith,
  codexThreadStarts,
  expectSlotCheck,
  installFakeCodex,
  openCodeConfigOf,
  openSkills,
  shareSkill,
  skillItem,
  skillName,
  skillRow,
  skillsPluginDir,
  slotCheckLine,
  slotCheckScript,
  startAgentChat,
  uniqueName,
  useFakeOpenCode,
  writeCatalogPins,
  writeSkill,
  type BuiltAgent,
  type CatalogFixture
} from '../fixtures/liveCatalog'
import { PersonApp, runCommand } from '../fixtures/liveTeamSharing'

/**
 * T2 — "their local agent sees the catalog skill": what each engine is handed
 * when B adds a skill A shared to B's own kit agent, against the real local
 * cinna-core (`e2e/fixtures/live-catalog.py`).
 *
 * The skill declares an `erp-api` credential slot and carries a script,
 * `scripts/skill_check`, that reads the slot through `core.cinna_api` and
 * prints a hash of what it found, never the value. No `.py` suffix: core's dev
 * server watches its skill store and restarts on a published `.py` file.
 *
 * - T2.1 and T2.2 run no model. The OpenCode config and assembled prompt are
 *   the files the real launcher writes for a turn on the scripted fake ACP
 *   agent (`fakeAcpEngine.ts`, behind a keyless Ollama credential); the Codex
 *   prompt is the `config.developer_instructions` of the `thread/start` the real Codex
 *   launcher sends to the scripted app-server (`fakeCodexAppServer.mjs`).
 * - T2.3a is billed: **one** OpenCode turn on the cheapest OpenAI model the
 *   app lists (`.env` `OPENAI_API_KEY`, `requireLiveKey`). It settles whether a
 *   per-name `allow` in `permission.skill` lets the skill load without an ask.
 * - T2.3b is billed and **opt-in**: one real Claude Code turn on `haiku`, on
 *   the developer's own Claude login. It runs only with
 *   `CINNA_E2E_CLAUDE_REAL_HOME=1` (plus the live fixture); otherwise it skips.
 *   Cost: one short turn, meant for `haiku` (the agent's `simple` tier;
 *   about $0.03). **But** a `model` in `~/.claude/settings.json` wins over the
 *   agent's model (the adapter applies `settings.model` after `options.model`),
 *   so on a machine with `"model": "opus"` the turn ran on `claude-opus-5[1m]`
 *   for $0.11 (2026-10-11) — fixed: the driver re-asserts the agent's model after
 *   session new/load, and the test asserts the turn ran on haiku ($0.046).
 *   The CLI finds the login only through the real `HOME`, so **B's app — and
 *   only B's — is launched with the real `HOME`**, a narrow exception to the
 *   suite's sandbox rule. What keeps it narrow:
 *   - B's userData is a throwaway temp dir (`CINNA_USER_DATA`) and
 *     `--use-mock-keychain` stays, so the app's own safeStorage never touches
 *     the login keychain; A stays fully sandboxed.
 *   - B's agents home is a fresh `~/.cinna-e2e-claude-*` folder, set as
 *     `localAgentsHome` and checked through `homeState` *before* `homeGrant`;
 *     on a fresh database the default `~/Documents/CinnaAgents` is a guarded
 *     path nobody acknowledged, so nothing creates it first. The mtimes of
 *     `~/Documents/CinnaAgents`, its `Local/` and `Cloud/` are compared before
 *     and after.
 *   - Afterwards the agents home, B's temp root, and the one
 *     `~/.claude/projects/<cwd>` folder the turn's temp cwd produced are
 *     deleted; nothing else under `~/.claude` (the CLI may still add its own
 *     bookkeeping for that cwd in `~/.claude.json`).
 *   - The binary is the pinned `claude` the developer's installed app already
 *     downloaded (`~/Library/Application Support/cinna-desktop/runtimes/`),
 *     set as `localAgentsClaudePath`; the test skips when it is not there and
 *     never downloads. Exactly one turn, never retried.
 *
 * Model turns in this file: 1 OpenCode, 1 Claude (opt-in).
 */

const MODEL = 'qwen3:8b'
let ollama: Server
let ollamaHost = ''

/** Just enough of Ollama for the keyless credential to list one model. */
test.beforeAll(async () => {
  ollama = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' } }] }))
      return
    }
    if (req.url === '/api/version') {
      res.end(JSON.stringify({ version: '0.6.2' }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve))
  ollamaHost = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => ollama.close(() => resolve()))
})

const SKILL_DESCRIPTION = 'Check which ERP API credential this agent can reach. Use it whenever you are asked to check the ERP credential.'
const SKILL_BODY = [
  '# ERP credential check',
  '',
  "Run this skill's script with python3, using the absolute path of this skill's base directory:",
  '',
  '    python3 <base directory>/scripts/skill_check',
  '',
  'Reply with the exact line it prints and nothing else. Do not read or run anything else.',
  ''
].join('\n')

/** What `skill_check` prints once the admin's ERP API reached the agent. */
const skillCheckLine = (fixture: CatalogFixture): string => slotCheckLine(fixture, 'skill-check')

/** The skill-tool sentence of the assembled prompt, with and without pinned catalog skills. */
const PROMPT_WITH_CATALOG =
  'Your own skills, from `skills/` in this folder, and the catalog skills this agent pins are available through the skill tool by name. Open one when the task matches its description.'
const PROMPT_OWN_ONLY = 'Your own skills, from `skills/` in this folder, are available through the skill tool by name. Open one when the task matches its description.'

/** A writes `skill` (slot + script) into a fresh agent of A's and shares it from the Skills row with `people`. */
async function shareFromA(a: PersonApp, fixture: CatalogFixture, skills: { name: string; people: CatalogFixture['people']['b'][] }[]): Promise<void> {
  const workshop = uniqueName(fixture, 'Skill workshop')
  const source = await buildAgent(a, fixture, { name: workshop })
  for (const skill of skills) {
    writeSkill(source.path, skill.name, {
      description: SKILL_DESCRIPTION,
      credentials: [{ slot: 'erp-api', type: 'api_token', description: 'The ERP API token.' }],
      body: SKILL_BODY,
      files: { 'scripts/skill_check': slotCheckScript('skill-check') }
    })
  }
  await a.page.evaluate(() => window.api.localAgents.rescan())
  for (const skill of skills) {
    await shareSkill(a, workshop, skill.name, { people: skill.people, note: 'For the engines spec' })
    await expect(skillRow(a, skill.name, 'Authored')).toContainText('Version 1')
  }
}

/** The pinned skill's credential slot is connected to the admin's ERP API (Add fills it without asking). */
async function expectErpSlotConnected(b: PersonApp, fixture: CatalogFixture, agentId: string): Promise<void> {
  await expect
    .poll(async () => {
      const setup = await b.page.evaluate((id) => window.api.serviceCredentials.setupState(id), agentId)
      if (!setup.ok) return setup.message
      return setup.value.skillSlots.map((slot) => `${slot.slot}:${slot.type}:${slot.state}:${slot.attached?.credential.name ?? ''}`)
    }, { timeout: 30_000 })
    .toEqual([`erp-api:api_token:connected:${fixture.credentials.erp.name}`])
}

/** One turn on the fake OpenCode in a new chat; resolves once the launcher wrote the config and the fake was prompted. */
async function fakeOpenCodeTurn(b: PersonApp, fake: Awaited<ReturnType<typeof useFakeOpenCode>>, agent: BuiltAgent, text: string) {
  const before = fake.received('session/prompt').length
  await startAgentChat(b, agent.name, text)
  await expect.poll(() => fake.received('session/prompt').length, { timeout: 60_000 }).toBeGreaterThan(before)
  const written = openCodeConfigOf(b, agent.id)
  expect(written, 'the launcher wrote no opencode.json naming the agent').not.toBeNull()
  return written!
}

/** Switch the agent to Codex on the scripted app-server, relaunch, and answer the developer instructions of one turn. */
async function fakeCodexPrompt(b: PersonApp, agent: BuiltAgent, text: string): Promise<string> {
  const executable = installFakeCodex(b)
  await b.page.evaluate((path) => window.api.settings.set('localAgentsCodexPath', path), executable)
  const current = await b.page.evaluate((id) => window.api.localAgents.get(id), agent.id)
  if (!current.ok) throw new Error(current.message)
  const saved = await b.page.evaluate(
    (input) =>
      window.api.localAgents.updateField({
        agentId: input.id,
        expectedStamp: input.stamp,
        update: { field: 'runtime', value: { engine: 'codex', credential: null, modelId: null, complexity: 'medium' } }
      }),
    { id: agent.id, stamp: current.value.stamps[MANIFEST_FILE]! }
  )
  expect(saved.ok).toBe(true)
  await b.relaunch()
  await expect.poll(() => b.page.evaluate(() => window.api.localTools.codexAuth())).toEqual({ state: 'logged_in', method: 'chatgpt' })
  const before = codexThreadStarts(b).length
  await startAgentChat(b, agent.name, text)
  await expect.poll(() => codexThreadStarts(b).length, { timeout: 60_000 }).toBeGreaterThan(before)
  // A folder agent's prompt rides in the thread's config, not in `developerInstructions` (a plain chat's).
  return String(codexThreadStarts(b).at(-1).params.config?.developer_instructions ?? '')
}

/** `<userData>/catalog-skills/*`, the read allow a linked catalog skill brings. */
const cacheReadAllow = (b: PersonApp): string => `${join(b.sandbox.userData, 'catalog-skills')}/*`

test('T2.1 B adds A’s shared skill to B’s agent: linked in the plugin, in OpenCode’s skills.paths and permission.skill, listed in the Codex prompt, and its script reads the ERP slot', async ({ team }) => {
  test.setTimeout(600_000)
  const { fixture } = team
  const skill = skillName('erp-check')
  const mine = uniqueName(fixture, 'Ledger bot')

  const a = await team.open('a')
  await shareFromA(a, fixture, [{ name: skill, people: [fixture.people.b] }])
  const item = await skillItem(fixture, fixture.people.b.token, skill)
  expect(item?.access).toBe('use')

  const b = await team.open('b')
  await b.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const fake = await useFakeOpenCode(b, ollamaHost, MODEL)
  const agent = await buildAgent(b, fixture, { name: mine })
  await addSkillToAgent(b, skill, mine)
  expect(catalogPins(agent.path)).toEqual([expect.objectContaining({ name: skill, package_uuid: item.uuid, revision_number: 1 })])
  await expect.poll(() => cachedSkillDir(b, item.uuid, 1, skill)).not.toBeNull()
  const cached = cachedSkillDir(b, item.uuid, 1, skill)!
  await expectErpSlotConnected(b, fixture, agent.id)

  await test.step('the Skills row: from the catalog, every engine gets it', async () => {
    await openSkills(b, mine)
    await expect(skillRow(b, skill, 'From the catalog').getByRole('img', { name: 'Every engine of this agent gets this skill', exact: true })).toBeVisible()
  })

  await test.step('/run: scripts read the ERP API by slot through core.cinna_api — the agent’s own and the cached skill’s', async () => {
    await expectSlotCheck(b, mine, slotCheckLine(fixture))
    const commands = readFileSync(join(agent.path, 'docs/CLI_COMMANDS.yaml'), 'utf8')
    writeFileSync(
      join(agent.path, 'docs/CLI_COMMANDS.yaml'),
      `${commands}  - name: skill-check\n    description: The catalog skill's own script.\n    command: uv run python ${JSON.stringify(join(cached, 'scripts/skill_check'))}\n`
    )
    await b.page.evaluate(() => window.api.localAgents.rescan())
    await runCommand(b, mine, 'skill-check')
    await expect(b.page.getByText(skillCheckLine(fixture))).toBeVisible({ timeout: 60_000 })
  })

  await test.step('OpenCode: the links folder holds a link to the cached revision, in skills.paths, allowed by name', async () => {
    const { config, entry } = await fakeOpenCodeTurn(b, fake, agent, 'Hello from the structural check.')
    const plugin = skillsPluginDir(b, agent.id)
    const links = join(plugin, 'skills')
    expect(readdirSync(links)).toEqual([skill])
    expect(readlinkSync(join(links, skill))).toBe(cached)
    expect(config.skills.paths).toContain(links)
    expect(entry.permission.skill).toEqual({ '*': 'ask', 'cinna-tasks': 'allow', [skill]: 'allow' })
    expect(entry.permission.external_directory).toMatchObject({ '*': 'ask', [`${links}/*`]: 'allow', [cacheReadAllow(b)]: 'allow' })
    // The cache is read-allowed, never a skills path.
    expect(config.skills.paths.some((path: string) => path.startsWith(join(b.sandbox.userData, 'catalog-skills')))).toBe(false)
    expect(entry.prompt).toContain(PROMPT_WITH_CATALOG)
  })

  await test.step('Claude: the same folder is the agent’s skills plugin, named after its slug', async () => {
    const manifest = JSON.parse(readFileSync(join(skillsPluginDir(b, agent.id), '.claude-plugin', 'plugin.json'), 'utf8'))
    expect(manifest.name).toBe(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(agent.slug) && agent.slug.length <= 64 ? agent.slug : 'agent-skills')
  })

  await test.step('Codex: the prompt lists the skill with the cached SKILL.md to read', async () => {
    const prompt = await fakeCodexPrompt(b, agent, 'Hello from the Codex check.')
    expect(prompt).toContain('## Your skills')
    expect(prompt).toContain(`- \`${skill}\` — ${SKILL_DESCRIPTION} — \`${join(cached, 'SKILL.md')}\``)
  })
})

test('T2.2 a pin B cannot see and a pin not yet downloaded reach no engine, and each row says why', async ({ team }) => {
  test.setTimeout(600_000)
  const { fixture } = team
  const hidden = skillName('erp-hidden')
  const seen = skillName('erp-later')
  const own = skillName('own-notes')
  const mine = uniqueName(fixture, 'Ledger bot')

  const a = await team.open('a')
  await shareFromA(a, fixture, [
    { name: hidden, people: [] },
    { name: seen, people: [fixture.people.b] }
  ])
  const hiddenItem = await skillItem(fixture, fixture.people.a.token, hidden)
  const seenItem = await skillItem(fixture, fixture.people.b.token, seen)
  expect(await skillItem(fixture, fixture.people.b.token, hidden)).toBeUndefined()
  expect(seenItem?.access).toBe('use')

  const b = await team.open('b')
  await b.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const fake = await useFakeOpenCode(b, ollamaHost, MODEL)
  const agent = await buildAgent(b, fixture, { name: mine, skill: { name: own, description: 'Keep notes about the ledger.', body: 'Write notes.\n' } })
  // By hand, as a `git pull` or an editor leaves them: nothing is downloaded.
  writeCatalogPins(agent.path, [catalogPinOf(hiddenItem), catalogPinOf(seenItem)])
  await b.page.evaluate(() => window.api.localAgents.rescan())

  await test.step('both rows read Not on this computer yet., with Try again', async () => {
    await openSkills(b, mine)
    for (const name of [hidden, seen]) {
      const row = skillRow(b, name, 'From the catalog')
      await expect(row.getByRole('img', { name: 'Not on this computer yet.', exact: true })).toBeVisible()
      await expect(row.getByRole('button', { name: `Download ${name} again`, exact: true })).toBeVisible()
    }
    await expect(skillRow(b, own, 'Authored').getByRole('img', { name: 'Every engine of this agent gets this skill', exact: true })).toBeVisible()
  })

  const plugin = skillsPluginDir(b, agent.id)
  const links = join(plugin, 'skills')
  await test.step('OpenCode: only the own skill is linked and allowed; the prompt promises no catalog skill', async () => {
    const { config, entry } = await fakeOpenCodeTurn(b, fake, agent, 'Hello before any download.')
    expect(readdirSync(links)).toEqual([own])
    expect(config.skills.paths).toContain(links)
    expect(entry.permission.skill).toEqual({ '*': 'ask', 'cinna-tasks': 'allow', [own]: 'allow' })
    expect(entry.permission.external_directory).not.toHaveProperty(cacheReadAllow(b))
    expect(entry.prompt).toContain(PROMPT_OWN_ONLY)
    expect(entry.prompt).not.toContain(hidden)
    expect(entry.prompt).not.toContain(seen)
  })

  await test.step('Try again: the hidden pin fails in words, the visible one downloads', async () => {
    await openSkills(b, mine)
    await skillRow(b, hidden, 'From the catalog').getByRole('button', { name: `Download ${hidden} again`, exact: true }).click()
    const hiddenRow = skillRow(b, hidden, 'From the catalog')
    // Core answers 404 to someone with no access. On B's own agent, which no team tracks and which has no
    // copy, that is Disconnected: the row says the agent can't download it, and offers Check again (not
    // Download again) in case access comes back.
    const why = 'Disconnected — this skill is no longer in the catalog for you, so this agent can’t download it. Ask a maintainer for access, or remove it.'
    await expect(hiddenRow.getByRole('img', { name: why, exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(hiddenRow.getByRole('listitem')).toHaveText([why])
    await expect(hiddenRow.getByRole('button', { name: `Check ${hidden} again`, exact: true })).toBeVisible()
    await expect(hiddenRow.getByRole('button', { name: `Download ${hidden} again`, exact: true })).toHaveCount(0)
    await expect(skillRow(b, seen, 'From the catalog').getByRole('img', { name: 'Every engine of this agent gets this skill', exact: true })).toBeVisible({ timeout: 60_000 })
    expect(cachedSkillDir(b, hiddenItem.uuid, 1, hidden)).toBeNull()
    expect(cachedSkillDir(b, seenItem.uuid, 1, seen)).not.toBeNull()
  })

  const cachedSeen = cachedSkillDir(b, seenItem.uuid, 1, seen)!
  await test.step('OpenCode, next turn: the downloaded pin is linked and allowed, the hidden one still is not', async () => {
    const { entry } = await fakeOpenCodeTurn(b, fake, agent, 'Hello after the download.')
    expect(readdirSync(links).sort()).toEqual([own, seen].sort())
    expect(readlinkSync(join(links, seen))).toBe(cachedSeen)
    expect(entry.permission.skill).toEqual({ '*': 'ask', 'cinna-tasks': 'allow', [own]: 'allow', [seen]: 'allow' })
    expect(entry.prompt).toContain(PROMPT_WITH_CATALOG)
    expect(existsSync(join(links, hidden))).toBe(false)
  })

  await test.step('Codex: the prompt lists the own skill and the downloaded pin, never the hidden one', async () => {
    const prompt = await fakeCodexPrompt(b, agent, 'Hello from the Codex check.')
    expect(prompt).toContain(`- \`${seen}\` — ${SKILL_DESCRIPTION} — \`${join(cachedSeen, 'SKILL.md')}\``)
    expect(prompt).toContain(`- \`${own}\` — Keep notes about the ledger. — `)
    expect(prompt).not.toContain(hidden)
  })
})

test.describe('real model turns', () => {
  test('T2.3a OpenCode: B’s agent opens the catalog skill by name with no permission ask, and its script reads the ERP slot', async ({ team }) => {
    requireLiveKey()
    test.setTimeout(600_000)
    const { fixture } = team
    const skill = skillName('erp-check')
    const mine = uniqueName(fixture, 'Ledger bot')

    const a = await team.open('a')
    await shareFromA(a, fixture, [{ name: skill, people: [fixture.people.b] }])
    const item = await skillItem(fixture, fixture.people.b.token, skill)

    const b = await team.open('b')
    installCachedEngine(b.sandbox.userData)
    await b.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
    const model = await seedOpenAiDefaultMode(b as unknown as CinnaApp)
    const agent = await buildAgent(b, fixture, { name: mine })
    await addSkillToAgent(b, skill, mine)
    await expect.poll(() => cachedSkillDir(b, item.uuid, 1, skill)).not.toBeNull()
    await expectErpSlotConnected(b, fixture, agent.id)

    // Named outright: on the first run gpt-4.1-mini, asked only to "use your <name> skill", called
    // `task` with the skill's name as a subagent type and never opened the skill.
    const prompt = `Open the ${skill} skill with your skill tool, follow it to check the ERP credential, and reply with the exact line its script prints.`
    await startAgentChat(b, mine, prompt)
    /** Every ask the turn raised, as its block read. A skill ask ends the wait: it is the finding. */
    const asks: string[] = []
    await expect
      .poll(
        async () => {
          const block = b.page.getByText(/^The agent is asking to /)
          if ((await block.count()) > 0) {
            const text = await block.first().innerText()
            asks.push(text)
            if (text === 'The agent is asking to skill') return 'a skill ask'
            await b.page.getByRole('button', { name: 'Allow once', exact: true }).first().click()
            return 'answered an ask'
          }
          const chat = await chatStartedWith(b, prompt)
          const error = chat?.messages.find((message: any) => message.role === 'error')
          if (error) return `error: ${String(error.content).slice(0, 300)}`
          const busy = (await b.page.getByRole('button', { name: 'Stop', exact: true }).count()) > 0
          const answered = chat?.messages.some((message: any) => message.role === 'assistant')
          return !busy && answered ? 'done' : 'running'
        },
        { timeout: 300_000, intervals: [1000] }
      )
      .toMatch(/^(done|a skill ask|error: .*)$/)

    const chat = await chatStartedWith(b, prompt)
    const parts = chat.messages.filter((message: any) => message.role === 'assistant').flatMap((message: any) => message.parts ?? [])
    const tools = parts.filter((part: any) => part.kind === 'tool')
    const results = parts.filter((part: any) => part.kind === 'tool_result')
    test.info().annotations.push(
      { type: 'model', description: model },
      { type: 'tool calls', description: JSON.stringify(tools.map((part: any) => ({ name: part.toolName, input: part.toolInput }))).slice(0, 2000) },
      { type: 'asks', description: JSON.stringify(asks) }
    )
    // Item 4: a per-name `allow` in permission.skill loads the skill without a click.
    const permissionAsks = tools.filter((part: any) => part.toolName === 'cinna_permission_request')
    expect(permissionAsks.filter((part: any) => part.toolInput?.action === 'skill')).toEqual([])
    expect(asks.filter((text) => text === 'The agent is asking to skill')).toEqual([])
    // OpenCode's `skill` call carries no input over ACP; its result names the skill it opened.
    const opened = tools
      .filter((part: any) => part.toolName === 'skill')
      .map((part: any) => results.find((result: any) => result.toolId === part.toolId)?.text ?? '')
    expect(opened.some((text: string) => text.startsWith(`<skill_content name="${skill}">`)), 'the skill tool opened the catalog skill').toBe(true)
    expect(results.some((part: any) => String(part.text).includes(skillCheckLine(fixture))), 'the skill’s script printed the ERP slot line').toBe(true)
  })

  test('T2.3b Claude Code: B’s agent invokes the catalog skill as <plugin>:<name>', async ({ team }) => {
    test.skip(
      !CLAUDE_REAL_HOME,
      'Opt-in: set CINNA_E2E_CLAUDE_REAL_HOME=1 to run one billed Claude Code turn on your own login (B’s app gets your real HOME; see the file header)'
    )
    test.skip(!LIVE_REQUESTED, 'live specs run only through make e2e-live or make e2e-one SPEC=<live spec>')
    const claudePath = pinnedClaudePath()
    test.skip(!existsSync(claudePath), `the pinned Claude Code ${RUNTIME_PINS.claude.cli} is not installed under the real app's runtimes folder`)
    test.setTimeout(600_000)
    // Two desktop defects this test found on 2026-10-11, both fixed: the Skill call's input was never stored
    // (the adapter fills `{ skill }` in a later tool_call_update whose narration did not grow, which
    // StreamPartsAccumulator dropped), and the turn ran on the user's own `~/.claude/settings.json` model
    // (`opus`) instead of the agent's haiku, which the driver now re-asserts after session new/load.
    const { fixture } = team
    const skill = skillName('erp-check')
    const mine = uniqueName(fixture, 'Ledger bot')
    const realHome = homedir()
    const before = realProfileFingerprint()
    const projectsBefore = claudeProjects()

    const a = await team.open('a')
    await shareFromA(a, fixture, [{ name: skill, people: [fixture.people.b] }])
    const item = await skillItem(fixture, fixture.people.b.token, skill)
    expect(item?.access).toBe('use')

    // B: a throwaway userData and agents home; only HOME is the real one.
    const root = mkdtempSync(join(tmpdir(), 'cinna-e2e-claude-'))
    const sandbox: Sandbox = { root, home: realHome, userData: join(root, 'userData') }
    mkdirSync(sandbox.userData, { recursive: true })
    const agentsHome = mkdtempSync(join(realHome, '.cinna-e2e-claude-'))
    const b = new RealHomePerson(fixture.people.b, sandbox, fixture, agentsHome, claudePath)
    const evidence: Record<string, unknown> = {}
    let prompt = ''
    let passed = false
    try {
      await b.setUp()
      expect(b.rootPath).toBe(agentsHome)
      await b.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
      const agent = await buildAgent(b, fixture, { name: mine })
      expect(agent.path.startsWith(`${agentsHome}/`)).toBe(true)
      // Claude, haiku (the `simple` tier), and Ask every time: haiku has no auto-mode reviewer, so the CLI
      // would run `default` anyway, and on some CLIs `set_mode auto` fails the turn on haiku.
      const current = await b.page.evaluate((id) => window.api.localAgents.get(id), agent.id)
      if (!current.ok) throw new Error(current.message)
      const saved = await b.page.evaluate(
        (input) =>
          window.api.localAgents.updateField({
            agentId: input.id,
            expectedStamp: input.stamp,
            update: { field: 'runtime', value: { engine: 'claude', credential: null, modelId: null, complexity: 'simple' } }
          }),
        { id: agent.id, stamp: current.value.stamps[MANIFEST_FILE]! }
      )
      expect(saved.ok).toBe(true)
      const approval = await b.page.evaluate((id) => window.api.localAgents.setClaudeApproval(id, 'ask'), agent.id)
      expect(approval.ok).toBe(true)
      await b.relaunch()
      await addSkillToAgent(b, skill, mine)
      await expect.poll(() => cachedSkillDir(b, item.uuid, 1, skill)).not.toBeNull()
      await expectErpSlotConnected(b, fixture, agent.id)

      // As the engine probe asked it: the skill by its bare name, so `<plugin>:<name>` is the CLI's listing, not the prompt's.
      prompt = `Check the ERP credential using your ${skill} skill (invoke it with the Skill tool), and reply with only the line its script prints.`
      await startAgentChat(b, mine, prompt)
      const asks: string[] = []
      await expect
        .poll(
          async () => {
            const block = b.page.getByText(/^The agent is asking to /)
            if ((await block.count()) > 0) {
              if (asks.length >= 4) return 'too many asks'
              asks.push(await block.first().innerText())
              await b.page.getByRole('button', { name: 'Allow once', exact: true }).first().click()
              return 'answered an ask'
            }
            const chat = await chatStartedWith(b, prompt)
            const error = chat?.messages.find((message: any) => message.role === 'error')
            if (error) return `error: ${String(error.content).slice(0, 300)}`
            const busy = (await b.page.getByRole('button', { name: 'Stop', exact: true }).count()) > 0
            const answered = chat?.messages.some((message: any) => message.role === 'assistant')
            return !busy && answered ? 'done' : 'running'
          },
          { timeout: 300_000, intervals: [1000] }
        )
        .toMatch(/^(done|too many asks|error: .*)$/)

      const chat = await chatStartedWith(b, prompt)
      const assistant = chat.messages.filter((message: any) => message.role === 'assistant')
      const parts = assistant.flatMap((message: any) => message.parts ?? [])
      const tools = parts.filter((part: any) => part.kind === 'tool')
      const results = parts.filter((part: any) => part.kind === 'tool_result')
      const plugin = JSON.parse(readFileSync(join(skillsPluginDir(b, agent.id), '.claude-plugin', 'plugin.json'), 'utf8')).name
      evidence.model = assistant.map((message: any) => message.telemetry?.model).filter(Boolean)
      evidence.costUsd = assistant.reduce((sum: number, message: any) => sum + (message.telemetry?.costUsd ?? 0), 0)
      // The agent's model, not the user's own Claude settings model.
      expect((evidence.model as string[]).length, 'the turn reports its model').toBeGreaterThan(0)
      for (const model of evidence.model as string[]) expect(model).toMatch(/haiku/i)
      test.info().annotations.push(
        { type: 'plugin', description: String(plugin) },
        { type: 'tool calls', description: JSON.stringify(tools.map((part: any) => ({ id: part.toolId, name: part.toolName, input: part.toolInput }))).slice(0, 2000) },
        { type: 'asks', description: JSON.stringify(asks) }
      )
      expect(plugin).toBe(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(agent.slug) && agent.slug.length <= 64 ? agent.slug : 'agent-skills')
      const skillCalls = tools.filter((part: any) => part.toolName === 'Skill')
      evidence.storedSkillParts = skillCalls
      evidence.storedPermissionParts = tools.filter((part: any) => part.toolName === 'cinna_permission_request')
      // The CLI's own record of the call (its project folder for this temp cwd; deleted in `finally`).
      evidence.transcriptSkillCalls = [...claudeProjects()]
        .filter((name) => !projectsBefore.has(name) && name.startsWith(`${claudeProjectName(agentsHome)}-`))
        .flatMap((name) => transcriptToolUses(join(realHome, '.claude', 'projects', name), 'Skill'))
      expect(skillCalls.length, 'a Skill tool part was stored').toBeGreaterThan(0)
      expect(evidence.transcriptSkillCalls, 'the CLI invoked the catalog skill as <plugin>:<name>').toContainEqual({ name: 'Skill', input: expect.objectContaining({ skill: `${plugin}:${skill}` }) })
      // No ask for loading the skill: no permission part links back to a Skill call.
      const skillIds = new Set(skillCalls.map((part: any) => part.toolId))
      const permissionAsks = tools.filter((part: any) => part.toolName === 'cinna_permission_request')
      expect(permissionAsks.filter((part: any) => skillIds.has(part.toolInput?.callId))).toEqual([])
      expect(results.some((part: any) => String(part.text).includes(skillCheckLine(fixture))), 'the skill’s script printed the ERP slot line').toBe(true)
      // Last, so the checks above run while this defect stands: the stored part names it too (any input field).
      expect(skillCalls.flatMap((part: any) => Object.values(part.toolInput ?? {})), 'the stored Skill call names the catalog skill under its plugin').toContain(`${plugin}:${skill}`)
      passed = true
    } finally {
      if (!passed) {
        try {
          writeFileSync(test.info().outputPath('b-screen.yaml'), await b.page.locator('body').ariaSnapshot())
          await b.page.screenshot({ path: test.info().outputPath('b-screen.png') })
        } catch {
          // the app may be gone already
        }
      }
      await b.close().catch(() => {})
      // The agents home and the one Claude project folder this run's temp cwd produced, nothing else.
      const prefix = claudeProjectName(agentsHome)
      const made = [...claudeProjects()].filter((name) => !projectsBefore.has(name))
      const ours = made.filter((name) => name.startsWith(`${prefix}-`))
      for (const name of ours) rmSync(join(realHome, '.claude', 'projects', name), { recursive: true, force: true })
      evidence.claudeProjectsRemoved = ours.length
      evidence.otherNewClaudeProjects = made.length - ours.length
      execFileSync('chmod', ['-R', 'u+w', agentsHome], { stdio: 'ignore' })
      rmSync(agentsHome, { recursive: true, force: true })
      evidence.agentsHomeRemoved = !existsSync(agentsHome)
      // B's temp root too, pass or fail: b-evidence.json in the test's output folder is the record.
      try {
        execFileSync('chmod', ['-R', 'u+w', root], { stdio: 'ignore' })
      } catch {
        // already gone
      }
      rmSync(root, { recursive: true, force: true })
      evidence.realAgentsHomeBefore = before
      evidence.realAgentsHomeAfter = realProfileFingerprint()
      test.info().annotations.push({ type: 'real-HOME safety', description: JSON.stringify(evidence) })
      writeFileSync(test.info().outputPath('b-evidence.json'), JSON.stringify(evidence, null, 2))
    }
    expect(evidence.agentsHomeRemoved).toBe(true)
    expect(evidence.otherNewClaudeProjects).toBe(0)
    expect(evidence.realAgentsHomeAfter).toEqual(before)
  })
})

/** Whether the developer opted into T2.3b's real-HOME Claude turn. */
const CLAUDE_REAL_HOME = process.env.CINNA_E2E_CLAUDE_REAL_HOME === '1'

/** The pinned Claude Code as the developer's own installed app keeps it (read only; never downloaded here). */
function pinnedClaudePath(): string {
  return join(homedir(), 'Library', 'Application Support', 'cinna-desktop', 'runtimes', `claude-${RUNTIME_PINS.claude.cli}`, 'claude')
}

/** How Claude Code names a cwd's folder under `~/.claude/projects`. */
function claudeProjectName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

/** The `tool_use` blocks named `tool` in a Claude project folder's transcripts: name and input only. */
function transcriptToolUses(dir: string, tool: string): { name: string; input: unknown }[] {
  const out: { name: string; input: unknown }[] = []
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.includes(`"name":"${tool}"`)) continue
      try {
        const content = JSON.parse(line)?.message?.content
        for (const block of Array.isArray(content) ? content : []) {
          if (block?.type === 'tool_use' && block.name === tool) out.push({ name: block.name, input: block.input })
        }
      } catch {
        // a partial line
      }
    }
  }
  return out
}

function claudeProjects(): Set<string> {
  const dir = join(homedir(), '.claude', 'projects')
  return new Set(existsSync(dir) ? readdirSync(dir) : [])
}

/**
 * Whether `~/Documents/CinnaAgents` exists, and the mtimes of it and its `Local/` and `Cloud/`:
 * B's app must create nothing there and add or remove no agent folder.
 */
function realProfileFingerprint(): Record<string, number | null> {
  const base = join(homedir(), 'Documents', 'CinnaAgents')
  const mtime = (path: string): number | null => (existsSync(path) ? statSync(path).mtimeMs : null)
  return { home: mtime(base), local: mtime(join(base, 'Local')), cloud: mtime(join(base, 'Cloud')) }
}

/**
 * Person B on the developer's real `HOME`, so the pinned `claude` finds their login — but with a
 * throwaway userData and an agents home in a fresh `~/.cinna-e2e-claude-*` folder, set before
 * anything can create or grant the default `~/Documents/CinnaAgents`. On a fresh database that
 * default is a guarded path nobody acknowledged, so `ensureHome` refuses it until then.
 */
class RealHomePerson extends PersonApp {
  constructor(
    person: CatalogFixture['people']['b'],
    sandbox: Sandbox,
    fixture: CatalogFixture,
    private readonly agentsHome: string,
    private readonly claudePath: string
  ) {
    super('b', person, sandbox, fixture)
  }

  override async setUp(): Promise<void> {
    await this.start()
    await this.waitForShell()
    const registered = await this.page.evaluate(
      (p) => window.api.auth.register({ accountType: 'local', username: p.email, displayName: p.name }),
      this.person
    )
    if (!registered.success || !registered.user) throw new Error('could not register B’s profile')
    await this.writeTokens()
    const logged = await this.page.evaluate((userId) => window.api.auth.login({ userId }), registered.user.id)
    if (!logged.success) throw new Error('could not activate B’s profile')
    await this.page.evaluate(() => window.api.settings.set('localAgentsDefaultEngine', 'opencode'))
    await this.page.evaluate((path) => window.api.settings.set('localAgentsHome', path), this.agentsHome)
    const state = await this.page.evaluate(() => window.api.localAgents.homeState())
    if (state.path !== this.agentsHome || state.guarded) throw new Error('B’s agents home is not the throwaway folder; refusing to grant')
    await this.page.evaluate(() => window.api.localAgents.homeGrant())
    const roots = await this.page.evaluate(() => window.api.localAgents.rootsList())
    if (roots.length !== 1 || roots[0].path !== this.agentsHome || !roots[0].isDefault) throw new Error('B has a root outside the throwaway agents home')
    this.rootPath = this.agentsHome
    await this.page.evaluate((path) => window.api.settings.set('localAgentsClaudePath', path), this.claudePath)
    await this.relaunch()
    const current = await this.page.evaluate(() => window.api.auth.getCurrent())
    expect(current?.username).toBe(this.person.email)
  }
}
