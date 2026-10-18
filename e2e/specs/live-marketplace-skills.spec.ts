import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { LIVE_ENGINE, liveEngineOptions, requireLiveEngine, seedLiveModel, useLiveRuntime } from '../fixtures/liveEngine'
import { coreApi, linkLiveCinnaProfile, liveCoreSession } from '../fixtures/liveCinnaLink'
import type { LiveCinnaConfig } from '../fixtures/liveCinna'

/**
 * @live — **a real agent uses a skill from a real skills marketplace.** The
 * developer's local cinna-core has a skills-format marketplace named `skills`
 * (synced from github.com/anthropics/skills; this spec never syncs, edits or
 * deletes it). A kit folder agent on a profile linked to that core gets
 * `brand-guidelines` through Addons → Skills → Add → Marketplaces: the real
 * entries are listed (`claude-api` as unsupported, `no_skill_md`), Add pins
 * the current snapshot into `cinna-agent.json` and the row reads
 * `From skills`, current. One real turn through the agent's composer asks
 * for two of the brand's hex colours, naming the skill but no path. Then
 * Remove drops the pin.
 *
 * Witnesses, engine-neutral: the reply holds `#e8e6dc` and `#788c5d` (in the
 * snapshot's SKILL.md, checked in the cache, in no prompt); the transcript
 * has a tool call that opens the skill by name or reads its SKILL.md from the
 * sandbox's marketplace cache or plugin links folder, and no tool touches a
 * `brand-guidelines` path outside the sandbox; no error in the chat; no ask —
 * except on Antigravity, whose default approval is *Ask* for every command:
 * there at most four command asks run in the agent's folder are answered
 * Allow once and recorded (Gemini Flash often lists `skills/` first, then
 * `cat`s the cached SKILL.md); any other ask fails the test.
 *
 * Engine: `CINNA_E2E_LIVE_ENGINE` (`opencode` default, `claude`, `codex`,
 * `antigravity`), as `live-skills.spec.ts`. Needs the `CINNA_E2E_SERVER_URL` /
 * `_EMAIL` / `_PASSWORD` core with that marketplace; skips without them.
 *
 * ## Cost
 *
 * One short turn on the engine's cheap model. Run deliberately:
 * `make e2e-one SPEC=e2e/specs/live-marketplace-skills.spec.ts LIVE_ENGINE=<engine>`.
 *
 * ## What it does not prove
 *
 * That the agent would pick the skill unprompted (the prompt names it);
 * Update and "No longer available" against a real marketplace sync
 * (`marketplace-skills.spec.ts` does them on a fake core); a skill with
 * scripts or credential slots.
 */

test.use(liveEngineOptions())
test.beforeEach(() => requireLiveEngine())

const AGENT = 'Brand Desk'
const MARKETPLACE_ID = '58a3d94d-162e-42bb-a7ac-65be31a1dab7'
const MARKETPLACE = 'skills'
const SKILL = 'brand-guidelines'
const UNSUPPORTED = 'claude-api'
/** Light Gray and the tertiary Green accent, from the snapshot's SKILL.md. */
const FACTS = ['#e8e6dc', '#788c5d']

interface Turn {
  reply: string
  errors: string[]
  tools: Array<{ toolId?: string; toolName?: string; toolInput?: unknown; text: string }>
  results: Array<{ toolId?: string; toolStream?: string; text: string }>
}

/** The chat whose first user message is `prompt`, as main stores it. */
async function turnOf(cinna: CinnaApp, prompt: string): Promise<Turn | null> {
  return cinna.page.evaluate(async (first) => {
    for (const row of await window.api.chat.list()) {
      const chat = await window.api.chat.get(row.id)
      if (chat?.messages.find((message) => message.role === 'user')?.content !== first) continue
      const assistant = chat.messages.filter((message) => message.role === 'assistant')
      const parts = assistant.flatMap((message) => message.parts ?? [])
      return {
        reply: assistant.map((message) => message.content).join('\n'),
        errors: chat.messages.filter((message) => message.role === 'error').map((message) => message.content.slice(0, 500)),
        tools: parts.filter((part) => part.kind === 'tool')
          .map((part) => ({ toolId: part.toolId, toolName: part.toolName, toolInput: part.toolInput, text: part.text })),
        results: parts.filter((part) => part.kind === 'tool_result')
          .map((part) => ({ toolId: part.toolId, toolStream: part.toolStream, text: part.text }))
      }
    }
    return null
  }, prompt)
}

interface CoreEntry {
  id: string
  name: string
  marketplace_id: string
  marketplace_name: string
  supported: boolean
  unsupported_reason: string | null
  skill_archive_sha256: string | null
  commit_hash: string | null
}

/** Every skills entry core shows this person, all pages. */
async function discoverSkills(config: LiveCinnaConfig, token: string): Promise<CoreEntry[]> {
  const rows: CoreEntry[] = []
  for (let skip = 0; ; skip += 100) {
    const page = await coreApi(config, token, `/llm-plugins/discover?plugin_type=skills&skip=${skip}&limit=100`)
    expect(page.status, 'core lists the skills marketplace entries').toBe(200)
    const data = (Array.isArray(page.body) ? page.body : page.body?.data ?? []) as CoreEntry[]
    rows.push(...data)
    if (data.length < 100) return rows
  }
}

function marketplacePins(agentPath: string): Array<Record<string, unknown>> {
  const manifest = JSON.parse(readFileSync(join(agentPath, 'cinna-agent.json'), 'utf8')) as Record<string, unknown>
  return (manifest.marketplace_skills ?? []) as Array<Record<string, unknown>>
}

/** `<userData>/marketplace-skills/<instance>/<entry>/<sha>/<name>/`, when its SKILL.md is there. */
function cachedSnapshotDir(cinna: CinnaApp, entryUuid: string, sha: string, name: string): string | null {
  const root = join(cinna.sandbox.userData, 'marketplace-skills')
  if (!existsSync(root)) return null
  for (const instance of readdirSync(root)) {
    const dir = join(root, instance, entryUuid, sha, name)
    if (existsSync(join(dir, 'SKILL.md'))) return dir
  }
  return null
}

/** Agents → the agent → Settings → Addons, and its Skills section. */
async function openSkillsSection(cinna: CinnaApp): Promise<Locator> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Addons/ }).click()
  return page
    .getByRole('tabpanel')
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'Skills', exact: true }) })
}

test('@live a folder agent answers from a skill added out of the real skills marketplace, then the skill is removed', async ({ cinna }) => {
  test.setTimeout(8 * 60_000)
  const session = await liveCoreSession()
  test.skip(!session.ok, session.ok ? '' : session.reason)
  if (!session.ok) return
  const { config, token } = session

  const entries = (await discoverSkills(config, token)).filter((row) => row.marketplace_id === MARKETPLACE_ID)
  const target = entries.find((row) => row.name === SKILL)
  test.skip(!target, `core has no ${SKILL} entry in the ${MARKETPLACE} marketplace (${MARKETPLACE_ID})`)
  const entry = target as CoreEntry
  expect(entry.supported).toBe(true)
  expect(entries.find((row) => row.name === UNSUPPORTED)).toEqual(expect.objectContaining({ supported: false, unsupported_reason: 'no_skill_md' }))

  await cinna.skipOnboarding()
  const model = await seedLiveModel(cinna)
  console.log(`live-marketplace-skills model: ${model}`)
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))

  const agent = await test.step('a kit agent on a profile linked to the real core', async () => {
    const root = await addAgentRoot(cinna)
    const created = await createFolderAgent(cinna, root, AGENT, 'Answers questions about the company brand.')
    await useLiveRuntime(cinna, created.id)
    await linkLiveCinnaProfile(cinna, config, token)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    expect((await cinna.page.evaluate(() => window.api.auth.getCurrent()))?.type).toBe('cinna_user')
    return created
  })

  let section = await openSkillsSection(cinna)
  const page = cinna.page
  const dialog = page.getByRole('dialog', { name: 'Add skill' })
  const list = dialog.locator('[data-marketplace-skills-list]')
  const tile = (name: string): Locator => list.getByRole('group', { name, exact: true })

  await test.step('Skills → Add → Marketplaces lists the real entries, claude-api unsupported', async () => {
    await expect(section.getByText('No skills yet.', { exact: true })).toBeVisible()
    await section.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(dialog).toBeVisible()
    const sources = dialog.getByRole('radiogroup', { name: 'Where skills come from' })
    await sources.getByRole('radio', { name: 'Marketplaces', exact: true }).click()
    await expect(sources.getByRole('radio', { name: 'Marketplaces', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(tile(SKILL)).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('combobox', { name: 'Marketplace' }).selectOption({ label: MARKETPLACE })
    await expect
      .poll(() => list.locator('[data-marketplace-skill]').evaluateAll((tiles) => tiles.map((t) => t.getAttribute('aria-label') ?? '').sort()))
      .toEqual(entries.map((row) => row.name).sort())
    await expect(tile(SKILL)).toHaveAttribute('data-marketplace-skill', entry.id)
    await expect(tile(SKILL)).toHaveAttribute('data-marketplace-skill-state', 'addable')
    await expect(tile(SKILL).getByTitle(`From the ${MARKETPLACE} marketplace`)).toHaveText(MARKETPLACE)
    const reason = 'This skill has no valid SKILL.md, so there is nothing to add.'
    await expect(tile(UNSUPPORTED)).toHaveAttribute('data-marketplace-skill-state', 'unsupported')
    await expect(tile(UNSUPPORTED).getByText(reason, { exact: true })).toBeVisible()
    const blocked = tile(UNSUPPORTED).getByRole('button', { name: `Add ${UNSUPPORTED} to this agent`, exact: true })
    await expect(blocked).toBeDisabled()
    await expect(blocked).toHaveAttribute('title', reason)
  })

  let cached = ''
  await test.step(`Add pins ${SKILL} into cinna-agent.json; the cached snapshot holds the facts`, async () => {
    await tile(SKILL).getByRole('button', { name: `Add ${SKILL} to this agent`, exact: true }).click()
    await expect(tile(SKILL)).toHaveAttribute('data-marketplace-skill-state', 'added', { timeout: 60_000 })
    await expect(tile(SKILL).getByRole('button', { name: `${SKILL} added`, exact: true })).toBeDisabled()
    const pins = marketplacePins(agent.path)
    console.log(`live-marketplace-skills pin: ${JSON.stringify(pins)}`)
    // The entry has no version (`""` on core), so the pin's is null.
    expect(pins).toEqual([
      {
        entry_uuid: entry.id,
        marketplace_uuid: MARKETPLACE_ID,
        marketplace_name: MARKETPLACE,
        name: SKILL,
        archive_sha256: entry.skill_archive_sha256,
        commit_hash: entry.commit_hash,
        version: null
      }
    ])
    cached = cachedSnapshotDir(cinna, entry.id, entry.skill_archive_sha256 as string, SKILL) ?? ''
    expect(cached, 'the snapshot is cached').not.toBe('')
    const skillMd = readFileSync(join(cached, 'SKILL.md'), 'utf8')
    for (const fact of FACTS) expect(skillMd, `the snapshot's SKILL.md holds ${fact}`).toContain(fact)

    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const row = section.locator(`[data-skill-row="${SKILL}"]`)
    await expect(row).toHaveAttribute('data-skill-source', 'marketplace')
    await expect(row).toHaveAttribute('data-marketplace-skill', entry.id)
    await expect(row).toHaveAttribute('data-marketplace-skill-state', 'current', { timeout: 30_000 })
    await expect(row.getByText(`From ${MARKETPLACE}`, { exact: true })).toBeVisible()
    await expect(row.getByRole('button', { name: `Remove ${SKILL} from this agent`, exact: true })).toBeVisible()
  })

  const prompt =
    `Use your ${SKILL} skill: what are the exact hex codes of the brand's Light Gray and of its Green accent? ` +
    'Reply with only the two hex codes.'

  await test.step('the question is typed into the agent’s composer', async () => {
    await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
    const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await input.fill(prompt)
    await input.press('Enter')
    await expect(page.getByRole('combobox', { name: 'Send a follow-up · Esc Esc to stop', exact: true }))
      .toBeVisible({ timeout: 30_000 })
  })

  let turn: Turn | null = null
  /** Asks answered on Antigravity (its default approval is Ask): commands run in the agent folder only. */
  const asks: string[] = []
  const askable = LIVE_ENGINE.name === 'antigravity'
  await test.step(askable ? 'the turn ends with an answer; asks only for commands in the agent folder' : 'the turn ends with an answer and no ask', async () => {
    const ask = page.locator('div').filter({ has: page.getByText(/^The agent is asking to /) }).filter({ has: page.getByRole('button', { name: 'Allow once', exact: true }) }).last()
    let outcome = 'running'
    await expect.poll(async () => {
      if ((await ask.count()) > 0) {
        const text = await ask.innerText()
        // Antigravity asks before every command; answer only a command run in the agent's own folder.
        const cwd = /"cwd":"([^"]*)"/.exec(text)?.[1] ?? ''
        const inAgent = /^The agent is asking to run a command/.test(text) && [agent.path, realpathSync(agent.path)].includes(cwd)
        if (!askable || !inAgent || asks.length >= 4) return (outcome = `ask: ${text.slice(0, 500)}`)
        asks.push(text.slice(0, 500))
        await ask.getByRole('button', { name: 'Allow once', exact: true }).click()
        return (outcome = 'answered an ask')
      }
      turn = await turnOf(cinna, prompt)
      if (turn && turn.errors.length > 0) return (outcome = `error: ${turn.errors[0]}`)
      const busy = (await page.getByRole('button', { name: 'Stop', exact: true }).count()) > 0
      return (outcome = !busy && turn !== null && turn.reply.trim() !== '' ? 'done' : 'running')
    }, { message: 'the turn ends, or stops on an ask or an error', timeout: 4 * 60_000, intervals: [1000] }).toMatch(/^(done|ask: |error: )/)
    expect(outcome).toBe('done')
    console.log(`live-marketplace-skills asks answered: ${JSON.stringify(asks)}`)
    if (!askable) expect(asks).toEqual([])
  })

  const settled = turn as unknown as Turn
  const summary = JSON.stringify(settled.tools.map((tool) => ({ name: tool.toolName, input: tool.toolInput, text: tool.text.slice(0, 200) }))).slice(0, 3000)
  test.info().annotations.push(
    { type: 'model', description: model },
    { type: 'tool calls', description: summary },
    { type: 'reply', description: settled.reply.slice(0, 500) },
    { type: 'asks', description: JSON.stringify(asks) }
  )
  console.log(`live-marketplace-skills ${LIVE_ENGINE.label}: tools ${summary}`)
  console.log(`live-marketplace-skills reply: ${JSON.stringify(settled.reply.slice(0, 300))}`)

  await test.step('the transcript shows the pinned skill opened, from this sandbox, without an error', async () => {
    expect(settled.errors).toEqual([])
    const resultsOf = (toolId: string | undefined) => settled.results.filter((result) => toolId !== undefined && result.toolId === toolId)
    const textOf = (tool: Turn['tools'][number]): string =>
      [JSON.stringify(tool), ...resultsOf(tool.toolId).map((result) => result.text)].join('\n')
    // Both spellings of the sandbox: tmpdir() is /var/folders/…, its real path /private/var/folders/….
    const roots = [cinna.sandbox.userData, realpathSync(cinna.sandbox.userData)]
    // The agent's own folder is the sandbox too: Codex sometimes tries `<agent>/skills/<name>/SKILL.md` first.
    const sandbox = [...roots, agent.path, realpathSync(agent.path)]
    const touched = settled.tools.filter((tool) => textOf(tool).includes(SKILL))
    expect(touched.length, `a tool call opens or reads ${SKILL}`).toBeGreaterThan(0)
    // Any absolute path to a brand-guidelines folder a tool named is in this sandbox, never the developer's own skills.
    const paths = touched
      .flatMap((tool) => textOf(tool).match(/(?<![\w.~-])~?(?:\/[\w.@~+%-]+)+/g) ?? [])
      .filter((path) => path.includes(`/${SKILL}`))
    const foreign = paths.filter((path) => !sandbox.some((root) => path.startsWith(root)))
    console.log(`live-marketplace-skills skill paths: ${JSON.stringify([...new Set(paths)])}`)
    expect(foreign, 'no tool read a brand-guidelines skill from outside the sandbox').toEqual([])
  })

  await test.step('the reply carries the two colours from the skill', async () => {
    for (const fact of FACTS) expect(settled.reply.toLowerCase()).toContain(fact)
    await expect(page.getByText(new RegExp(FACTS[0], 'i')).first()).toBeVisible()
  })

  await test.step('Remove drops the pin from cinna-agent.json', async () => {
    section = await openSkillsSection(cinna)
    const row = section.locator(`[data-skill-row="${SKILL}"]`)
    await row.getByRole('button', { name: `Remove ${SKILL} from this agent`, exact: true }).click()
    const confirm = row.getByRole('group', { name: `Remove ${SKILL} from this agent`, exact: true })
    await confirm.getByRole('button', { name: 'Remove skill', exact: true }).click()
    await expect.poll(() => marketplacePins(agent.path)).toEqual([])
    await expect(section.locator(`[data-skill-row="${SKILL}"]`)).toHaveCount(0)
    await expect(section.getByText('No skills yet.', { exact: true })).toBeVisible()
  })
})
