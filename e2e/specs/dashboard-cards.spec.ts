import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine, type FakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { MANIFEST_FILE } from '../../src/shared/kit/manifest'

/**
 * Dashboards D2: component references in a chat message render as cards.
 *
 * A kit agent (`Sales Desk`) holds the D1 fixture components plus two made
 * here: `broken-feed`, whose endpoint script is missing (an error finding),
 * and `crm-pipeline`, which `requires_credentials` a slot the manifest
 * declares and nothing fills. The agent answers on the scripted fake ACP
 * engine (no model): its one reply is the message under test. Everything
 * the card reads comes from main's own resolver; nothing is stubbed but the
 * clipboard write (so the developer's clipboard is left alone).
 */

const AGENT = 'Sales Desk'
const TITLE = 'Component cards chat'
const PROMPT = 'Which components do you have?'
const MODEL = 'qwen3:8b'
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dashboards')
const UNKNOWN_ID = '00000000-1111-4222-8333-444444444444'

async function serveModels(): Promise<{ server: Server; host: string }> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' } }] }))
    } else if (req.url === '/api/version') res.end(JSON.stringify({ version: '0.6.2' }))
    else { res.writeHead(404); res.end('{}') }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { server, host: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

interface Arranged { acp: FakeAcpEngine; manifestId: string; slug: string; agentId: string }

/**
 * The agent, its components, a chat bound to it, and the fake engine that
 * answers `reply(manifestId, slug)`. Ends on the chat, after a relaunch.
 */
async function arrange(cinna: CinnaApp, host: string, reply: (manifestId: string, slug: string) => string): Promise<Arranged> {
  await cinna.skipOnboarding()
  const acp = await installFakeAcpEngine(cinna)
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT)
  for (const name of ['daily-notes', 'open-tasks', 'weekly-chart']) {
    cpSync(join(FIXTURES, name), join(agent.path, 'dashboards', name), { recursive: true })
  }
  mkdirSync(join(agent.path, 'app-data'), { recursive: true })
  cpSync(join(FIXTURES, 'app-data', 'notes.md'), join(agent.path, 'app-data', 'notes.md'))

  // broken-feed: an endpoint whose script is not there.
  mkdirSync(join(agent.path, 'dashboards', 'broken-feed'), { recursive: true })
  writeFileSync(join(agent.path, 'dashboards', 'broken-feed', 'component.json'), JSON.stringify({
    schema_version: 1, title: 'Broken feed', view: 'list',
    source: { endpoint: 'feed' }, endpoints: { feed: { script: 'api/feed.py' } }, size: 'm'
  }, null, 2))
  // crm-pipeline: valid, but needs a credential slot that is declared and empty.
  mkdirSync(join(agent.path, 'dashboards', 'crm-pipeline'), { recursive: true })
  writeFileSync(join(agent.path, 'dashboards', 'crm-pipeline', 'component.json'), JSON.stringify({
    schema_version: 1, title: 'CRM pipeline', view: 'markdown',
    source: { file: 'app-data/notes.md' }, requires_credentials: ['crm'], size: 'm'
  }, null, 2))
  const manifestPath = join(agent.path, MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  manifest.credentials = [{ name: 'crm', type: 'api_token', description: 'The CRM API token.' }]
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  const { manifestId, slug } = await cinna.page.evaluate(async ({ host, model, agentId, title }) => {
    await window.api.settings.set('autoChatTitles', false)
    const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Cards fixture Ollama', baseUrl: host, enabled: true })
    await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
    await window.api.localAgents.rescan()
    const loaded = await window.api.localAgents.get(agentId)
    if (!loaded.ok) throw new Error(loaded.message)
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { title, agentId, router: 'direct' })
    await window.api.chat.showInList(chat.id)
    return { manifestId: loaded.value.manifestId, slug: loaded.value.slug }
  }, { host, model: MODEL, agentId: agent.id, title: TITLE })
  expect(manifestId).toMatch(/^[0-9a-f-]{36}$/)
  acp.setScript({ prompt: { emit: [{ kind: 'update', update: {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply(manifestId, slug) }
  } }] } })

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await cinna.page.getByText(TITLE, { exact: true }).click()
  const composer = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await composer.fill(PROMPT)
  await composer.press('Enter')
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 })
  return { acp, manifestId, slug, agentId: agent.id }
}

/** One card in the transcript, by the component (or reference name) it shows. */
function card(cinna: CinnaApp, name: string) {
  return cinna.page.locator('[data-component-cards]').getByRole('group', { name: `Component ${name}`, exact: true })
}

let models: { server: Server; host: string }
test.beforeEach(async () => { models = await serveModels() })
test.afterEach(async () => {
  models.server.closeAllConnections()
  await new Promise<void>((resolve) => models.server.close(() => resolve()))
})

test('two references become two cards, a backticked one stays text; Add to dashboard places one and Copy reference copies the id form', async ({ cinna }) => {
  test.setTimeout(150_000)
  const backticked = (slug: string): string => `cinna://component/${slug}/weekly-chart`
  const { manifestId, slug } = await arrange(cinna, models.host, (id, s) => [
    'Here is what I keep for you:',
    '',
    `cinna://component/id:${id}/open-tasks`,
    `cinna://component/${s}/daily-notes`,
    '',
    `The chart is \`${backticked(s)}\`, ask me to show it.`
  ].join('\n'))
  const page = cinna.page

  await test.step('two cards, in one list, with titles and the owning agent; the code span is text', async () => {
    await expect(page.locator('[data-component-cards]')).toHaveCount(1)
    await expect(page.locator('[data-component-cards] [data-component-card]')).toHaveCount(2)
    for (const title of ['Open tasks', 'Daily notes']) {
      const c = card(cinna, title)
      await expect(c).toBeVisible()
      await expect(c).toContainText(AGENT)
      await expect(c).toContainText('Not on a dashboard yet.')
      await expect(c.getByRole('button', { name: `Add ${title} to a dashboard`, exact: true })).toBeVisible()
      await expect(c.getByRole('button', { name: `Preview ${title}`, exact: true })).toBeVisible()
    }
    await expect(page.getByText(backticked(slug), { exact: true })).toBeVisible()
    await expect(card(cinna, 'Weekly signups')).toHaveCount(0)
    await expect(page.getByText('Here is what I keep for you:', { exact: true })).toBeVisible()
  })

  await test.step('Add to dashboard… → Add: the card shows On My dashboard, and the dashboard has the tile', async () => {
    const c = card(cinna, 'Daily notes')
    await c.getByRole('button', { name: 'Add Daily notes to a dashboard', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add Daily notes to a dashboard' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(c).toContainText('On My dashboard')
    await expect(card(cinna, 'Open tasks')).toContainText('Not on a dashboard yet.')
    await c.getByRole('button', { name: 'My dashboard', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('My dashboard')
    const grid = page.getByTestId('dashboard-grid')
    await expect(grid.getByRole('group', { name: 'Daily notes' }).getByText('Call')).toBeVisible({ timeout: 30_000 })
    await expect(grid.locator('[data-tile-id]')).toHaveCount(1) // not getByRole('group'): a tile with params adds its filters <fieldset>
  })

  await test.step('Copy reference writes the canonical id form, also for the card written by slug', async () => {
    await cinna.electronApp.evaluate(({ clipboard }) => {
      const g = globalThis as unknown as { __copied: string[] }
      g.__copied = []
      clipboard.writeText = (text: string) => { g.__copied.push(text) }
    })
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    await page.getByText(TITLE, { exact: true }).click()
    const c = card(cinna, 'Daily notes')
    await c.getByRole('button', { name: 'Copy reference', exact: true }).click()
    await expect(c.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
    const copied = await cinna.electronApp.evaluate(() => (globalThis as unknown as { __copied: string[] }).__copied)
    expect(copied).toEqual([`cinna://component/id:${manifestId}/daily-notes`])
  })
})

test('a component gone from its agent and an agent not on this machine read as misses, with nothing to add', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna, models.host, (_id, s) => [
    'Two of these:',
    '',
    `cinna://component/${s}/old-report`,
    `cinna://component/id:${UNKNOWN_ID}/open-tasks`
  ].join('\n'))
  const page = cinna.page
  await expect(page.locator('[data-component-cards] [data-component-card]')).toHaveCount(2)

  const gone = card(cinna, 'old-report')
  await expect(gone.locator('[data-miss-reason="gone"]')).toHaveText(`Not in ${AGENT}.`)
  await expect(gone).toContainText(AGENT)
  await expect(gone.getByRole('button', { name: 'Open agent', exact: true })).toBeVisible()
  await expect(gone.getByRole('button', { name: /^Add / })).toHaveCount(0)
  await expect(gone.getByRole('button', { name: /^Preview / })).toHaveCount(0)

  const elsewhere = card(cinna, 'open-tasks')
  await expect(elsewhere.locator('[data-miss-reason="agent_not_here"]')).toHaveText('Its agent is not on this machine.')
  await expect(elsewhere.getByRole('button', { name: /^Add / })).toHaveCount(0)
  await expect(elsewhere.getByRole('button', { name: 'Copy reference', exact: true })).toBeVisible()
})

test('a component with an error shows the finding and Ask to fix fills the composer; one missing a credential names it and offers no Preview or Add', async ({ cinna }) => {
  test.setTimeout(120_000)
  const { acp, manifestId } = await arrange(cinna, models.host, (_id, s) => [
    'Two need attention:',
    '',
    `[The feed](cinna://component/${s}/broken-feed)`,
    `cinna://component/${s}/crm-pipeline`
  ].join('\n'))
  const page = cinna.page
  await expect(page.locator('[data-component-cards] [data-component-card]')).toHaveCount(2)

  await test.step('broken-feed: the finding (no separate summary line), no Add; Ask to fix fills without sending', async () => {
    const c = card(cinna, 'Broken feed')
    await expect(c).toContainText(`The feed · ${AGENT}`)
    // The listed findings say it; no separate "Has problems to fix" line above them.
    await expect(c).not.toContainText('Has problems to fix')
    const problems = c.getByRole('list', { name: 'Problems with Broken feed' })
    await expect(problems.getByRole('listitem')).toHaveText(['endpoints.feed.script names api/feed.py, which does not exist.'])
    // core's backticked field name renders as code, not as literal backticks
    await expect(problems.getByRole('listitem').locator('code')).toHaveText('endpoints.feed.script')
    await expect(c.getByRole('button', { name: /^Add / })).toHaveCount(0)
    await expect(c.getByRole('button', { name: /^Preview / })).toHaveCount(0)
    await c.getByRole('button', { name: 'Ask to fix', exact: true }).click()
    const composer = page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue(new RegExp(
      `^Please fix the dashboard component Broken feed so it passes the check:\\ncinna://component/id:${manifestId}/broken-feed\\n\\n- .*: \`endpoints\\.feed\\.script\` names api/feed\\.py, which does not exist\\.$`
    ))
    expect(acp.received('session/prompt')).toHaveLength(1)
  })

  await test.step('crm-pipeline: Needs the crm credential, Open Credentials, no Preview or Add', async () => {
    const c = card(cinna, 'CRM pipeline')
    await expect(c.locator('[data-missing-credentials]')).toHaveText('Needs the crm credential. Open Credentials')
    // the credential sentence takes the placements line: the card does not also say it is not on a dashboard
    await expect(c).not.toContainText('Not on a dashboard yet.')
    await expect(c.getByRole('button', { name: 'Open Credentials', exact: true })).toBeVisible()
    await expect(c.getByRole('button', { name: /^Add / })).toHaveCount(0)
    await expect(c.getByRole('button', { name: /^Preview / })).toHaveCount(0)
    await expect(c.getByRole('button', { name: 'Copy reference', exact: true })).toBeVisible()
  })
})
