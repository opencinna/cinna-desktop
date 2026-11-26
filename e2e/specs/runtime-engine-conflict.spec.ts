import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { writeFakeClaudeCli, type FakeClaudeModel } from '../fixtures/fakeClaudeCli'
import { DESKTOP_STATE_FILE, MANIFEST_FILE } from '../../src/shared/kit/manifest'

/**
 * **The file and the app disagree about the engine** (`runsOn.ts`): an agent
 * the app created records `runsOn: { kind: 'default' }` in its
 * `app-data/desktop.json`, so an engine written into its `cinna-agent.json`
 * from outside (an assistant, an editor) does not move it. The Runs with panel
 * and the composer both say so, and each answer writes exactly one side:
 *
 * - V4, a `choice` conflict: Update file rewrites the manifest without its
 *   `engine` (every other key kept), the block turns into its settled note, and
 *   the next turn is dispatched to Claude Agent — proven from main's own
 *   per-turn line `[runtime] turn agent=… engine=claude … source=choice(default)`.
 * - V5, an `unrecorded` pin (no stored choice, file engine ≠ machine Default):
 *   Keep OpenCode records the file's engine as the choice and leaves the
 *   manifest byte for byte as it was.
 *
 * Machine Default = Claude Agent on the scripted `claude` CLI
 * (`fakeClaudeCli.mjs` behind the real adapter): nothing is billed.
 * `skipOnboarding()` pins the Default back to OpenCode on every launch, so
 * {@link arrangeDefault} sets it again after each one.
 */

const REPLY = 'The runtime question is settled.'
const MODELS: FakeClaudeModel[] = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Sonnet 4.6', supportsAutoMode: true }
]

function manifest(agentPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentPath, MANIFEST_FILE), 'utf8')) as Record<string, unknown>
}

function writeManifestRuntime(agentPath: string, runtime: Record<string, unknown>): void {
  const file = manifest(agentPath)
  file.runtime = runtime
  writeFileSync(join(agentPath, MANIFEST_FILE), `${JSON.stringify(file, null, 2)}\n`)
}

function desktopState(agentPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentPath, DESKTOP_STATE_FILE), 'utf8')) as Record<string, unknown>
}

/** Claude Agent as the Default runtime, on the fake CLI saved as the Claude Path. */
async function arrangeDefault(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('localAgentsDefaultEngine', 'claude'))
  await expect
    .poll(() => cinna.page.evaluate(() => window.api.settings.getAll().then((all) => all.localAgentsDefaultEngine)))
    .toBe('claude')
}

/** An agent created by the app on a Claude-default machine, visible to the renderer. */
async function appCreatedAgent(cinna: CinnaApp, name: string): Promise<{ id: string; path: string }> {
  await arrangeDefault(cinna)
  const fake = writeFakeClaudeCli(cinna, { models: MODELS, reply: REPLY })
  await cinna.page.evaluate((path) => window.api.settings.set('localAgentsClaudePath', path), fake.path)
  const root = await addAgentRoot(cinna)
  const created = await createFolderAgent(cinna, root, name)
  expect(desktopState(created.path).runsOn, 'the app records its own choice at create').toEqual({ kind: 'default' })
  await cinna.relaunch()
  await arrangeDefault(cinna)
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return { id: created.id, path: created.path }
}

async function openAgent(cinna: CinnaApp, name: string): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await cinna.page.locator('.app-sidebar-wrap').getByRole('button', { name, exact: true }).click()
  await expect(cinna.page.getByRole('heading', { level: 1, name })).toBeVisible()
}

async function openAgentSettings(cinna: CinnaApp, name: string): Promise<void> {
  await openAgent(cinna, name)
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
}

const runsWith = (cinna: CinnaApp) => cinna.page.getByRole('region', { name: 'Runs with' })
const openBlock = (cinna: CinnaApp) => runsWith(cinna).locator('[data-runtime-conflict="open"]')
const settledBlock = (cinna: CinnaApp) => runsWith(cinna).locator('[data-runtime-conflict="settled"]')
const composer = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
const composerRow = (cinna: CinnaApp, text: string) =>
  cinna.page.getByRole('status', { name: 'Agent status' }).getByRole('listitem').filter({ hasText: text })

test('V4: an engine written into the file from outside is a conflict; Update file drops it and the turn runs on Claude', async ({ cinna }) => {
  test.setTimeout(150_000)
  const NAME = 'Harbor Clerk'
  const agent = await appCreatedAgent(cinna, NAME)
  writeManifestRuntime(agent.path, { engine: 'opencode', complexity: 'complex' })
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  const CONFLICT = 'File asks for OpenCode; runs on Claude Agent.'

  await test.step('the composer row names both sides and offers Update file', async () => {
    await openAgent(cinna, NAME)
    const row = composerRow(cinna, CONFLICT)
    await expect(row).toHaveCount(1, { timeout: 15_000 })
    await expect(row.getByRole('button', { name: 'Update file', exact: true })).toBeVisible()
  })

  await test.step('the Runs with panel shows the same conflict in its block', async () => {
    await openAgentSettings(cinna, NAME)
    await expect(openBlock(cinna).locator('p')).toHaveText(CONFLICT)
    await expect(openBlock(cinna).locator('[data-conflict-actions]').getByRole('button', { name: 'Update file', exact: true })).toBeVisible()
  })

  await test.step('Update file removes engine from the file, keeps complexity, and leaves the settled note', async () => {
    await openBlock(cinna).getByRole('button', { name: 'Update file', exact: true }).click()
    await expect
      .poll(() => manifest(agent.path).runtime, { message: `${MANIFEST_FILE} loses its engine` })
      .toEqual({ complexity: 'complex' })
    await expect(settledBlock(cinna)).toHaveText(`Updated ${MANIFEST_FILE}.`)
    await expect(openBlock(cinna)).toHaveCount(0)
    expect(desktopState(agent.path).runsOn).toEqual({ kind: 'default' })
  })

  await test.step('the next turn is dispatched to Claude Agent by the stored choice', async () => {
    const output: string[] = []
    const capture = (chunk: unknown): void => { output.push(String(chunk)) }
    cinna.electronApp.process().stdout?.on('data', capture)
    cinna.electronApp.process().stderr?.on('data', capture)
    await openAgent(cinna, NAME)
    await expect(composerRow(cinna, CONFLICT)).toHaveCount(0)
    await composer(cinna).fill('Is the runtime question settled?')
    await composer(cinna).press('Enter')
    await expect(cinna.page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 60_000 })
    const plain = (): string => output.join('').replace(/\x1b\[[0-9;]*m/g, '')
    const turnLines = (): string[] => plain().split('\n').filter((line) => line.includes('[runtime] turn '))
    await expect.poll(turnLines, { message: 'main logs the turn' }).toHaveLength(1)
    expect(turnLines()[0]).toMatch(new RegExp(`\\[runtime\\] turn agent=${agent.id} engine=claude model=\\S+ source=choice\\(default\\)$`))
  })
})

test('V5: an unrecorded engine pin; Keep OpenCode records the file’s engine and leaves the file alone', async ({ cinna }) => {
  test.setTimeout(120_000)
  const NAME = 'Quay Keeper'
  const agent = await appCreatedAgent(cinna, NAME)
  const state = desktopState(agent.path)
  delete state.runsOn
  writeFileSync(join(agent.path, DESKTOP_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`)
  writeManifestRuntime(agent.path, { engine: 'opencode' })
  const manifestBefore = readFileSync(join(agent.path, MANIFEST_FILE), 'utf8')
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  const NOTICE = 'File pins OpenCode; Default is Claude Agent.'

  await test.step('the panel names the pin against the Default runtime', async () => {
    await openAgentSettings(cinna, NAME)
    await expect(openBlock(cinna).locator('p')).toHaveText(NOTICE)
    await expect(openBlock(cinna).getByRole('button', { name: 'Use Default', exact: true })).toBeVisible()
  })

  await test.step('Keep OpenCode, behind the chevron, records the engine as the choice', async () => {
    await openBlock(cinna).getByRole('button', { name: 'More ways to settle the runtime', exact: true }).click()
    await cinna.page.getByRole('menu', { name: 'More ways to settle the runtime' })
      .getByRole('menuitem', { name: 'Keep OpenCode', exact: true }).click()
    await expect
      .poll(() => desktopState(agent.path).runsOn, { message: `${DESKTOP_STATE_FILE} records the file’s engine` })
      .toEqual({ kind: 'engine', engine: 'opencode' })
    await expect(settledBlock(cinna)).toHaveText('Keeps running on OpenCode.')
    await expect(openBlock(cinna)).toHaveCount(0)
    expect(readFileSync(join(agent.path, MANIFEST_FILE), 'utf8'), `${MANIFEST_FILE} is untouched`).toBe(manifestBefore)
  })
})
