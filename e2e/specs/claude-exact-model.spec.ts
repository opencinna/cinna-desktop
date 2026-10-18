import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { writeFakeClaudeCli, type FakeClaudeCli, type FakeClaudeLogEntry, type FakeClaudeModel } from '../fixtures/fakeClaudeCli'
import { MANIFEST_FILE } from '../../src/shared/kit/manifest'

/**
 * **Exact model selection on the Claude engine**: the Runs with panel's
 * Advanced picker lists the models Claude Code itself offers, with the effort
 * levels each model offers, writes the choice into `cinna-agent.json`, and the
 * next turn asks the session for exactly that model and effort. A declared
 * model the tool no longer offers is named in the panel and the composer,
 * whose Choose model lands on the Model select, and a turn on it says in the
 * chat that it ran on the tool's default.
 *
 * ## What is real and what is scripted
 *
 * Everything but the `claude` binary is the shipped code path: the Claude
 * launcher, the real `claude-agent-acp` adapter in its own Node process, the
 * model-catalogue probe (a promptless `session/new` plus one model set per
 * offered model), and the driver's `session/set_config_option` calls. The CLI
 * is `fakeClaudeCli.mjs`, saved as the Claude Path, which answers the Agent
 * SDK's `initialize` with a fixed model list (per-model
 * `supportedEffortLevels`) and every prompt with one fixed reply. No model is
 * called and nothing is billed.
 *
 * ## Why the CLI's log is the witness for "the session received it"
 *
 * The adapter turns the driver's ACP `set_config_option` for `model` into the
 * SDK's `set_model` control request, and the one for `effort` into
 * `apply_flag_settings { effortLevel }`. Both are read from the process whose
 * cwd is the agent's folder — the turn's — and not from the catalogue probe,
 * which runs in its own folder and sets every model in turn.
 */

const AGENT = 'Ledger Watcher'
const STALE_AGENT = 'Archive Sorter'
const REPLY = 'The ledger balances to the penny.'
const STALE_MODEL = 'claude-mythic-9'

/**
 * Claude Code's models as its `initialize` reports them; the names are the adapter's option names.
 * `supportsAutoMode`, or the adapter prefixes every reply with its Accept-edits fallback notice.
 */
const MODELS: FakeClaudeModel[] = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Opus 4.7', supportsAutoMode: true, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'sonnet', displayName: 'Sonnet 4.6', description: 'Sonnet 4.6 · everyday', supportsAutoMode: true, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'opus', displayName: 'Opus 4.7', description: 'Opus 4.7 · hardest', supportsAutoMode: true, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'] },
  { value: 'haiku', displayName: 'Haiku 4.5', description: 'Haiku 4.5 · fastest', supportsAutoMode: true }
]

/** The Model select's options for an agent naming no model: Cinna's floor (Sonnet), the tool's own default, then the list. */
const MODEL_OPTIONS = ['Not set — Sonnet 4.6', 'Claude Code default (Opus 4.7)', 'Sonnet 4.6', 'Opus 4.7', 'Haiku 4.5']
/** Opus's efforts, the tool's `default` folded into the select's own Default. */
const OPUS_EFFORTS = ['Default', 'Low', 'Medium', 'High', 'Xhigh']

const STALE_ROW = `This agent’s model “${STALE_MODEL}” is no longer offered by Claude Code.`
const STALE_LINE = 'Model no longer offered — choose another.'
const STALE_LINE_TITLE = `Claude Code no longer offers “${STALE_MODEL}”, so its turns run on Claude Code’s default until another model is chosen.`
const STALE_NOTE = `This agent’s model “${STALE_MODEL}” is no longer offered by Claude Code, so this turn ran on “Default (recommended)”. ` +
  'Choose another model in the agent’s Runs with panel.'

function manifestRuntime(agentPath: string): unknown {
  return JSON.parse(readFileSync(join(agentPath, MANIFEST_FILE), 'utf8')).runtime
}

/** A folder agent on the Claude engine with `runtime` as given, seeded over IPC. */
async function claudeAgent(cinna: CinnaApp, name: string, model: string | null): Promise<{ id: string; path: string }> {
  const root = await addAgentRoot(cinna)
  const created = await createFolderAgent(cinna, root, name, name)
  const saved = await cinna.page.evaluate(
    (input) =>
      window.api.localAgents.updateField({
        agentId: input.agentId,
        update: { field: 'runtime', value: { engine: 'claude', credential: null, modelId: input.model, complexity: null } },
        expectedStamp: input.stamp
      }),
    { agentId: created.id, model, stamp: created.stamps[MANIFEST_FILE]! }
  )
  expect(saved.ok, saved.ok ? '' : saved.message).toBe(true)
  return { id: created.id, path: created.path }
}

/** The fake CLI, saved as the Claude Path; then a restart so the seeded agent reaches the renderer. */
async function arrange(cinna: CinnaApp): Promise<FakeClaudeCli> {
  await cinna.skipOnboarding()
  const fake = writeFakeClaudeCli(cinna, { models: MODELS, reply: REPLY })
  await cinna.page.evaluate((path) => window.api.settings.set('localAgentsClaudePath', path), fake.path)
  return fake
}

async function restart(cinna: CinnaApp): Promise<void> {
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
}

async function openAgentSettings(cinna: CinnaApp, name: string): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await cinna.page.locator('.app-sidebar-wrap').getByRole('button', { name, exact: true }).click()
  await expect(cinna.page.getByRole('heading', { level: 1 })).toHaveText(name)
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
}

/** The agent's new-chat composer: its sidebar row (a chat's composer chip carries the same name). */
async function openAgentComposer(cinna: CinnaApp, name: string): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await cinna.page.locator('.app-sidebar-wrap').getByRole('button', { name, exact: true }).click()
  await expect(cinna.page.getByRole('heading', { level: 1, name })).toBeVisible()
}

const composer = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
const notices = (cinna: CinnaApp) => cinna.page.getByRole('status', { name: 'Agent status' })
const runsWith = (cinna: CinnaApp) => cinna.page.getByRole('region', { name: 'Runs with' })

/** What the turn's own CLI process read — the one started in the agent's folder. */
function turnTraffic(fake: FakeClaudeCli, agentPath: string): FakeClaudeLogEntry[] {
  const folder = realpathSync(agentPath)
  return fake.log().filter((entry) => {
    try {
      return realpathSync(entry.cwd) === folder
    } catch {
      return false
    }
  })
}

const subtype = (entry: FakeClaudeLogEntry): string =>
  entry.message?.type === 'control_request' ? `control:${entry.message.request?.subtype}` : (entry.message?.type ?? entry.dir)

test('Advanced on a Claude agent lists Claude Code’s models and efforts, writes the pick, and the next turn sets both', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await arrange(cinna)
  const agent = await claudeAgent(cinna, AGENT, null)
  expect(manifestRuntime(agent.path)).toEqual({ engine: 'claude' })
  await restart(cinna)
  await openAgentSettings(cinna, AGENT)

  const panel = runsWith(cinna)
  const advanced = panel.getByRole('checkbox', { name: 'Advanced' })
  const model = panel.getByRole('combobox', { name: 'Model', exact: true })
  const effort = panel.getByRole('combobox', { name: 'Effort', exact: true })

  await test.step('ticking Advanced asks Claude Code for its list and shows it verbatim', async () => {
    await expect(advanced).toBeEnabled()
    await expect(advanced).not.toBeChecked()
    await advanced.check()
    // Enabled only once the probe's list has landed; the options are the tool's own.
    await expect(model).toBeEnabled({ timeout: 30_000 })
    await expect(model.locator('option')).toHaveText(MODEL_OPTIONS)
    await expect(model).toHaveValue('')
    // Nothing chosen: the effort has nothing to be the effort of.
    await expect(effort).toBeDisabled()
    // Nothing is written by the view change: the agent names neither a tier nor a model.
    expect(manifestRuntime(agent.path)).toEqual({ engine: 'claude' })
  })

  await test.step('picking a model writes runtime.model, and its own efforts appear', async () => {
    await model.selectOption('opus')
    await expect
      .poll(() => manifestRuntime(agent.path), { message: `${MANIFEST_FILE} names the model` })
      .toEqual({ engine: 'claude', model: 'opus' })
    await expect(effort).toBeEnabled()
    await expect(effort.locator('option')).toHaveText(OPUS_EFFORTS)
    await expect(effort).toHaveValue('')
  })

  await test.step('picking an effort writes runtime.effort beside it', async () => {
    await effort.selectOption('xhigh')
    await expect
      .poll(() => manifestRuntime(agent.path), { message: `${MANIFEST_FILE} names the effort beside the model` })
      .toEqual({ engine: 'claude', model: 'opus', effort: 'xhigh' })
    await expect(model).toHaveValue('opus')
    await expect(effort).toHaveValue('xhigh')
  })

  await test.step('the next turn sets that model and that effort on its session before the prompt', async () => {
    await openAgentComposer(cinna, AGENT)
    await composer(cinna).fill('Does the ledger balance?')
    await composer(cinna).press('Enter')
    await expect(cinna.page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 60_000 })

    const traffic = turnTraffic(fake, agent.path)
    const order = traffic.map(subtype)
    const setModel = traffic.findIndex((entry) => entry.message?.request?.subtype === 'set_model')
    const setEffort = traffic.findIndex((entry) =>
      entry.message?.request?.subtype === 'apply_flag_settings' &&
      (entry.message.request.settings as { effortLevel?: unknown } | undefined)?.effortLevel === 'xhigh')
    const prompt = order.indexOf('user')
    expect(setModel, `the turn's CLI was asked to set a model: ${order.join(', ')}`).toBeGreaterThan(-1)
    expect(traffic[setModel].message?.request?.model).toBe('opus')
    expect(setEffort, `the turn's CLI was asked for xhigh effort: ${order.join(', ')}`).toBeGreaterThan(setModel)
    expect(prompt, 'the prompt came after both').toBeGreaterThan(setEffort)
    // No other model was set on the turn's session.
    expect(traffic.filter((entry) => entry.message?.request?.subtype === 'set_model').map((entry) => entry.message?.request?.model))
      .toEqual(['opus'])
  })
})

test('a declared model Claude Code no longer offers: the panel line, the composer’s Choose model, and the chat’s note', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await arrange(cinna)
  const agent = await claudeAgent(cinna, STALE_AGENT, STALE_MODEL)
  expect(manifestRuntime(agent.path)).toEqual({ engine: 'claude', model: STALE_MODEL })
  await restart(cinna)
  // The catalogue Claude Code offers, learned the way the panel learns it (a promptless session).
  const refreshed = await cinna.page.evaluate(() => window.api.engine.refreshModelCatalog('claude'))
  expect(refreshed.error).toBeNull()
  expect(refreshed.catalog.models.map((entry) => entry.id)).toEqual(MODELS.map((entry) => entry.value))

  await test.step('the new-chat composer names the model and offers Choose model, without blocking Send', async () => {
    await openAgentComposer(cinna, STALE_AGENT)
    const row = notices(cinna).getByRole('listitem').filter({ hasText: STALE_ROW })
    await expect(row).toHaveCount(1, { timeout: 15_000 })
    await expect(row.getByRole('button', { name: 'Choose model', exact: true })).toBeVisible()
    await composer(cinna).fill('Sort the archive by year.')
    await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  })

  await test.step('a turn runs on the tool’s default and the chat says so', async () => {
    await composer(cinna).press('Enter')
    await expect(cinna.page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 60_000 })
    // Once the turn is saved the note is an agent notice, folded in compact
    // mode to a dot whose tooltip is its first 117 characters; opening it shows
    // the whole sentence.
    const folded = cinna.page.getByRole('button', { name: 'Show agent notice', exact: true })
      .and(cinna.page.getByTitle(`${STALE_NOTE.slice(0, 117)}…`, { exact: true }))
    await expect(folded).toHaveCount(1, { timeout: 15_000 })
    await folded.click()
    await expect(cinna.page.getByRole('button', { name: 'Hide agent notice', exact: true }).filter({ hasText: STALE_NOTE }))
      .toHaveText(STALE_NOTE)
    // The CLI was started on the stale model (it rode in session/new's
    // options), so the session's own default is re-asserted before the
    // prompt — the real CLI answers a prompt on an unknown --model with an
    // error — and the stale model is never set.
    const traffic = turnTraffic(fake, agent.path)
    const order = traffic.map(subtype)
    const argv = traffic.find((entry) => entry.dir === 'argv')
    expect(argv?.args, 'the turn’s CLI was launched on the stale model').toEqual(expect.arrayContaining(['--model', STALE_MODEL]))
    const setModels = traffic.filter((entry) => entry.message?.request?.subtype === 'set_model').map((entry) => entry.message?.request?.model)
    expect(setModels, `the turn's CLI was moved onto the default: ${order.join(', ')}`).toEqual(['default'])
    const setModel = order.indexOf('control:set_model')
    expect(order.indexOf('user'), 'the prompt came after the default was set').toBeGreaterThan(setModel)
  })

  await test.step('Choose model lands on the agent’s Model select, under the panel’s own line', async () => {
    await openAgentComposer(cinna, STALE_AGENT)
    const row = notices(cinna).getByRole('listitem').filter({ hasText: STALE_ROW })
    await row.getByRole('button', { name: 'Choose model', exact: true }).click()
    const panel = runsWith(cinna)
    const model = panel.getByRole('combobox', { name: 'Model', exact: true })
    await expect(model).toBeFocused()
    await expect(model).toHaveValue(STALE_MODEL)
    await expect(panel.getByTitle(STALE_LINE_TITLE, { exact: true })).toHaveText(STALE_LINE)
  })
})
