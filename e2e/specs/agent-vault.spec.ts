import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync, type Dirent } from 'node:fs'
import { join, relative } from 'node:path'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { createFolderAgent } from '../fixtures/seed'
import { writeFakeClaudeCli, type FakeClaudeCli, type FakeClaudeInput } from '../fixtures/fakeClaudeCli'
import type { LocalAgentDto } from '../../src/shared/localAgents'
import { RUNTIME_PINS } from '../../src/shared/runtimePins'

/**
 * **Agent Vault** on the fake backend (`CINNA_VAULT_FAKE=1`): the real
 * cinna-vaultd from `out/main/vaultd.js` run as a host Node process, with
 * approvals granted at once. No VM, no helper, no prompt — so nothing here
 * proves isolation, the helper's prompts or the network allowlist; it proves
 * the app's side of the flow: the Security tab, Move to vault… with its steps
 * and rollback, Delete original, the safe in the sidebar and title, the
 * composer's locked row, and that a vault chat's words never reach SQLite.
 *
 * The engine inside is the scripted Claude CLI (`fakeClaudeCli.ts`) saved as
 * `localAgentsClaudePath`: E2E downloads no Claude, and the move streams in
 * whatever binary the app resolved for itself. Its answer is a constant, so a
 * reply proves a turn ran inside the vault and nothing about what it was sent —
 * except in V9, where a prompt with a code word is answered `Heard <code>.`
 * and a prompt with the hold marker is held open on a `Bash` tool use until
 * the SDK's interrupt (logged by the fake), so Send now's stop and the drained
 * prompt are witnessed at the CLI inside the vault. A tool call in progress
 * withdraws steering, so the follow-up is queued without a file.
 *
 * **Needs the network.** The move's `rebuild` step runs `uv python install`
 * in a fresh vault directory for the scaffold's `pyproject.toml` and
 * `.python-version`, which downloads CPython (~16 MB, about 2 s) on every move,
 * the failing one in V4 included. The scaffold ships no `uv.lock`: every move
 * here moves it in without one, and the rebuild locks it inside (`uv lock
 * --no-build`, wheels only) before it syncs. V4 makes that lock fail with a
 * dependency that has no wheel (resolved against PyPI).
 */

const AGENT = 'Vault Probe'
const REPLY = 'Hello from the fake vault.'
const MOVE_TIMEOUT = 240_000
/** The agent page's tabs about the folder on this Mac; a count badge may follow the name ("Commands 1"). */
const FOLDER_TABS = [/^Commands/, /^Schedules/, /^Dashboards/, /^Folder/]
const VAULT_LOCKED = 'This agent is in a vault that is locked. Unlock it to send a message.'

test.use({ env: { CINNA_VAULT_FAKE: '1' } })

/**
 * Skip onboarding, a scripted Claude, and a kit folder agent on the Claude
 * engine in the default agents home, as the scaffold makes it (no `uv.lock`).
 */
async function arrangeClaudeAgent(cinna: CinnaApp, reply = REPLY): Promise<LocalAgentDto> {
  return (await arrangeClaude(cinna, { reply })).agent
}

/** `arrangeClaudeAgent`, with the scripted CLI's options and its handle. */
async function arrangeClaude(
  cinna: CinnaApp,
  input: Omit<FakeClaudeInput, 'models'>
): Promise<{ agent: LocalAgentDto; fake: FakeClaudeCli }> {
  await cinna.skipOnboarding()
  const fake = writeFakeClaudeCli(cinna, {
    models: [{ value: 'default', displayName: 'Default', description: 'fake', supportsAutoMode: true }],
    ...input
  })
  await cinna.page.evaluate((path) => window.api.settings.set('localAgentsClaudePath', path), fake.path)
  // The default agents home: a vault moves only agents in the main agents folder.
  await cinna.page.evaluate(() => window.api.localAgents.homeGrant())
  const roots = await cinna.page.evaluate(() => window.api.localAgents.rootsList())
  const root = roots.find((r) => r.isDefault)
  if (!root) throw new Error('no default agents root after homeGrant')
  const created = await createFolderAgent(cinna, root, AGENT)
  const set = await cinna.page.evaluate(
    ({ id, stamp }) =>
      window.api.localAgents.updateField({
        agentId: id,
        update: { field: 'runtime', value: { engine: 'claude', credential: null, modelId: null, complexity: null } },
        expectedStamp: stamp
      } as never),
    { id: created.id, stamp: created.stamps['cinna-agent.json'] }
  )
  expect(set.ok, JSON.stringify(set)).toBe(true)
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return { agent: created, fake }
}

async function openAgent(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: AGENT }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: AGENT })).toBeVisible()
}

async function openSecurity(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  await openAgent(cinna)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /^Security/ }).click()
}

/** Move over IPC (arrange): the same `vault:move-in` the dialog calls; done once the row is a vault agent's. */
async function moveOverIpc(cinna: CinnaApp, agentId: string): Promise<void> {
  const started = await cinna.page.evaluate((id) => window.api.vault.moveIn(id, { sizeBytes: 10 * 1024 ** 3 }), agentId)
  expect(started.ok, JSON.stringify(started)).toBe(true)
  await expect
    .poll(
      async () => {
        const got = await cinna.page.evaluate((id) => window.api.localAgents.get(id), agentId)
        return got.ok ? got.value.vault != null : false
      },
      { timeout: MOVE_TIMEOUT, message: 'the move marks the agent row as a vault agent' }
    )
    .toBe(true)
}

/** Every path, link target and file's bytes under `dir`, as one hash. */
function treeHash(dir: string): string {
  const hash = createHash('sha256')
  const walk = (current: string): void => {
    const entries: Dirent[] = readdirSync(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = join(current, entry.name)
      const rel = relative(dir, full)
      const stat = lstatSync(full)
      hash.update(`${rel}\0${stat.mode}\0`)
      if (stat.isSymbolicLink()) hash.update(readlinkSync(full))
      else if (stat.isDirectory()) walk(full)
      else hash.update(readFileSync(full))
    }
  }
  walk(dir)
  return hash.digest('hex')
}

/** How many `messages` rows the sandbox database holds for `chatId` (refuses any other profile). */
async function sqliteMessageCount(cinna: CinnaApp, chatId: string): Promise<{ messages: number; vaultId: string | null }> {
  return cinna.electronApp.evaluate(({ app }, input) => {
    if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${input.userData}/cinna.db`, { readonly: true, fileMustExist: true })
    try {
      const count = db.prepare('SELECT count(*) AS n FROM messages WHERE chat_id = ?').get(input.chatId) as { n: number }
      const chat = db.prepare('SELECT vault_id AS vaultId FROM chats WHERE id = ?').get(input.chatId) as { vaultId: string | null } | undefined
      return { messages: count.n, vaultId: chat?.vaultId ?? null }
    } finally {
      db.close()
    }
  }, { userData: cinna.sandbox.userData, chatId })
}

test('V1 the Security tab offers Move to vault and says what a vault protects against', async ({ cinna }) => {
  await arrangeClaudeAgent(cinna)
  const page = cinna.page
  await openAgent(cinna)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  // Permissions is now the second section of Security; no tab is called Permissions.
  await expect(page.getByRole('tab', { name: /^Permissions/ })).toHaveCount(0)
  await page.getByRole('tab', { name: /^Security/ }).click()

  await expect(page.getByText('Agent Vault', { exact: true })).toBeVisible()
  await expect(page.getByText('Not in a vault', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Isolates this agent so no other app or agent on this Mac can read or prompt it.', { exact: true })
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Move to vault…' })).toBeEnabled()
  // The fake backend is not the release helper.
  await expect(page.getByText('Test helper', { exact: true })).toBeVisible()

  const threat = page.getByRole('button', { name: 'What a vault protects against' })
  await expect(threat).toHaveAttribute('aria-expanded', 'false')
  await threat.click()
  await expect(threat).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText('It protects', { exact: true })).toBeVisible()
  await expect(page.getByText('It does not protect', { exact: true })).toBeVisible()
  await expect(
    page.getByText('The clipboard. Anything you copy out of a vault chat can be read by other apps.', { exact: true })
  ).toBeVisible()
})

test('V2 a move runs every step, Delete original removes the folder, and the agent wears a safe', async ({ cinna }) => {
  test.setTimeout(MOVE_TIMEOUT + 120_000)
  const agent = await arrangeClaudeAgent(cinna)
  const page = cinna.page
  expect(existsSync(agent.path)).toBe(true)
  // A fresh kit agent comes without a lock, and moves in anyway: the vault locks it.
  expect(existsSync(join(agent.path, 'pyproject.toml'))).toBe(true)
  expect(existsSync(join(agent.path, 'uv.lock'))).toBe(false)
  await openSecurity(cinna)
  // The folder tabs exist before the move, so their absence afterwards means something.
  for (const name of FOLDER_TABS) await expect(page.getByRole('tab', { name })).toHaveCount(1)

  await page.getByRole('button', { name: 'Move to vault…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Move to vault' })
  const steps = dialog.getByRole('list', { name: 'Steps' })
  const move = dialog.getByRole('button', { name: 'Move', exact: true })
  await expect(move).toBeEnabled({ timeout: 30_000 })
  await expect(dialog.getByText(agent.path, { exact: true })).toBeVisible()
  await expect(dialog.getByText('No uv.lock: the vault resolves and locks dependencies on first install', { exact: true })).toBeVisible()
  await dialog.getByLabel('API key for the engine inside the vault').fill('sk-ant-e2e-not-a-real-key')
  await move.click()

  // Every step of the move done, then the host-copy phase.
  await expect(dialog.getByLabel(`Type ${AGENT} to delete it`)).toBeVisible({ timeout: MOVE_TIMEOUT })
  for (const step of ['precheck', 'create', 'unlock', 'approve', 'runtime', 'copy', 'rebuild', 'credentials', 'check']) {
    await expect(steps.locator(`li[data-step="${step}"]`), step).toHaveAttribute('data-status', 'done')
  }
  await expect(steps.locator('li[data-step="original"]')).toHaveAttribute('data-status', 'running')

  const remove = dialog.getByRole('button', { name: 'Delete original' })
  await expect(remove).toBeDisabled()
  await dialog.getByLabel(`Type ${AGENT} to delete it`).fill(AGENT)
  await remove.click()

  // Rotation: the last step.
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeVisible()
  await expect(steps.locator('li[data-step="original"]')).toHaveAttribute('data-status', 'done')
  await expect(
    dialog.getByText('The vault can’t take back what other apps and agents already read. Change these where they were issued.', { exact: true })
  ).toBeVisible()
  expect(existsSync(agent.path), `the original folder ${agent.path} is gone from disk`).toBe(false)
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toHaveCount(0)

  // The agent: a safe in the title and on its sidebar row, no folder tabs, no host-copy row.
  await expect(page.getByRole('heading', { level: 1, name: AGENT }).getByRole('img', { name: 'In a vault' })).toBeVisible()
  await expect(page.getByRole('button', { name: AGENT }).first().getByRole('img', { name: 'In a vault' })).toBeVisible()
  for (const name of FOLDER_TABS) await expect(page.getByRole('tab', { name })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: /^Security/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('The original folder is still on this Mac', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Lock now' })).toBeVisible()
})

test('V3 a locked vault unlocks from the composer, answers, and keeps its chat out of SQLite', async ({ cinna }) => {
  test.setTimeout(MOVE_TIMEOUT + 120_000)
  const agent = await arrangeClaudeAgent(cinna)
  await moveOverIpc(cinna, agent.id)
  const page = cinna.page
  await openSecurity(cinna)

  // Lock after: the backend's timeouts, 5 minutes for a new vault.
  const lockAfter = page.getByRole('combobox', { name: 'Lock after' })
  await expect(lockAfter).toHaveValue('300000')
  await expect(lockAfter.locator('option')).toHaveText(['30 seconds', '5 minutes', 'Until Cinna quits'])

  await page.getByRole('button', { name: 'Lock now' }).click()
  // The Security tab's own Unlock; the Runs-with line above the tabs offers another (V8).
  await expect(page.getByRole('tabpanel').getByRole('button', { name: 'Unlock', exact: true })).toBeVisible()
  await expect(page.locator('[data-vault-state="locked"]')).toHaveText('Locked')

  await page.getByRole('button', { name: 'Start chat', exact: true }).click()
  await expect(page.getByText(VAULT_LOCKED, { exact: true })).toBeVisible()
  const box = page.getByRole('combobox', { name: 'Type a message...' })
  await box.fill('Say hello in one word.')
  // Enter on a locked vault unlocks it, and the message goes once it is open.
  await box.press('Enter')
  await expect(page.getByText(VAULT_LOCKED, { exact: true })).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Say hello in one word.', { exact: true })).toHaveCount(1)
  await expect(box).toHaveValue('')
  // The router badge wears the safe and says when the vault locks.
  await page.getByRole('status', { name: 'Local agent connection' }).hover()
  await expect(page.getByTestId('vault-lock-line')).toHaveText(/^Locks in \d:\d\d$|^Kept open while the agent works$/)

  const chats = await page.evaluate(() => window.api.chat.list())
  const chat = chats.find((c) => c.agentId === agent.id)
  if (!chat) throw new Error('no chat with the vault agent')
  const stored = await sqliteMessageCount(cinna, chat.id)
  expect(stored.vaultId, 'the chat row is bound to the vault').not.toBeNull()
  expect(stored.messages, 'no message of the vault chat is in SQLite').toBe(0)

  // Locked: the transcript says where the conversation is; unlocked: it is back.
  await page.evaluate((id) => window.api.vault.lock(id), agent.id)
  const lockedCard = page.getByTestId('vault-locked-chat')
  await expect(lockedCard.getByText('This chat is in a locked vault', { exact: true })).toBeVisible()
  await expect(page.getByText(REPLY, { exact: true })).toHaveCount(0)
  await lockedCard.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Say hello in one word.', { exact: true })).toBeVisible()
  expect((await sqliteMessageCount(cinna, chat.id)).messages).toBe(0)
})

test('V4 a move that fails before the point of no return rolls back and leaves the folder byte-identical', async ({ cinna }) => {
  test.setTimeout(MOVE_TIMEOUT + 120_000)
  // A vault installs wheels only: a dependency with none (docopt ships an sdist
  // alone) fails the lock inside, after the interpreter install.
  const agent = await arrangeClaudeAgent(cinna)
  expect(existsSync(join(agent.path, 'uv.lock'))).toBe(false)
  const pyproject = join(agent.path, 'pyproject.toml')
  writeFileSync(pyproject, readFileSync(pyproject, 'utf8').replace('dependencies = []', 'dependencies = ["docopt==0.6.2"]'))
  expect(readFileSync(pyproject, 'utf8')).toContain('docopt==0.6.2')
  const page = cinna.page
  await openSecurity(cinna)
  await page.getByRole('button', { name: 'Move to vault…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Move to vault' })
  const move = dialog.getByRole('button', { name: 'Move', exact: true })
  await expect(move).toBeEnabled({ timeout: 30_000 })
  const before = treeHash(agent.path)
  await move.click()

  await expect(dialog.getByText(
    new RegExp(`^Rebuild dependencies failed: The rebuild \\(uv python install, uv sync\\) failed \\(exit \\d+\\)\\. Nothing was changed on this computer\\. The half-built vault was removed; ${AGENT} is untouched on this Mac\\.$`)
  )).toBeVisible({ timeout: MOVE_TIMEOUT })
  await expect(dialog.getByRole('list', { name: 'Steps' }).locator('li[data-step="rebuild"]')).toHaveAttribute('data-status', 'failed')
  await expect(dialog.getByText('No uv.lock: resolving and locking the dependencies (wheels only).')).toBeVisible()
  await expect(dialog.getByText(/Wheels are required for `docopt`/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()

  expect(treeHash(agent.path), 'the agent folder is byte-identical after the rollback').toBe(before)
  const vaults = await page.evaluate(() => window.api.vault.list())
  expect(vaults.ok && vaults.data.length).toBe(0)
  await expect(page.getByText('Not in a vault', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: AGENT }).getByRole('img', { name: 'In a vault' })).toHaveCount(0)
})

const OTHER_CHAT = `This chat started before ${AGENT} moved into its vault. Start a new chat to talk to it.`

/**
 * A chat with the agent from before its move — a real turn on the host, so its
 * words are in this computer's database — then the move, a restart, and that
 * chat reopened from the sidebar. The chat open on screen during the move
 * learns of it at once (the move's push refetches the agent's chats); the
 * restart then proves the refusal is main's, not a cached copy's.
 */
async function reopenPreMoveChat(cinna: CinnaApp): Promise<{ chatId: string; storedMessages: number }> {
  const agent = await arrangeClaudeAgent(cinna)
  // The agent page opens on its chat.
  await openAgent(cinna)
  const box = cinna.page.getByRole('combobox', { name: 'Type a message...' })
  await box.fill('Before the vault.')
  await box.press('Enter')
  await expect(cinna.page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 60_000 })
  const old = (await cinna.page.evaluate(() => window.api.chat.list())).find((c) => c.agentId === agent.id)
  if (!old) throw new Error('no host chat with the agent')
  const storedMessages = (await sqliteMessageCount(cinna, old.id)).messages
  expect(storedMessages, 'the pre-move chat is in SQLite').toBeGreaterThan(0)

  await moveOverIpc(cinna, agent.id)
  // Still open on screen: refused in place, without a reload.
  await expect(cinna.page.getByText(OTHER_CHAT, { exact: true })).toBeVisible({ timeout: 15_000 })
  const title = (await cinna.page.evaluate((id) => window.api.chat.get(id), old.id))?.title
  if (!title) throw new Error('the old chat has no title')
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await cinna.page.getByRole('button', { name: 'Chats', exact: true }).click()
  // A sidebar chat row is not a button; its title is its text, first in the page.
  await cinna.page.getByText(title, { exact: true }).first().click()
  await expect(cinna.page.getByText(OTHER_CHAT, { exact: true })).toBeVisible()
  return { chatId: old.id, storedMessages }
}

test('V5 a chat from before the move is refused and offers a new chat', async ({ cinna }) => {
  test.setTimeout(MOVE_TIMEOUT + 120_000)
  const old = await reopenPreMoveChat(cinna)
  await expect(cinna.page.getByRole('button', { name: 'Start new chat' })).toBeVisible()

  // Sending is blocked: Send stays disabled with text typed, and Enter keeps the draft.
  const composer = cinna.page.getByRole('combobox', { name: 'Type a message...' })
  await composer.fill('After the move.')
  await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await composer.press('Enter')
  await expect(composer).toHaveValue('After the move.')
  expect((await sqliteMessageCount(cinna, old.chatId)).messages, 'nothing was saved to the old chat').toBe(old.storedMessages)

  await cinna.page.getByRole('button', { name: 'Start new chat' }).click()
  await expect(cinna.page.getByText(OTHER_CHAT, { exact: true })).toHaveCount(0)
  await expect(cinna.page.getByRole('combobox', { name: 'Type a message...' })).toBeVisible()
})

test('V6 a chat from before the move keeps showing its own transcript while the vault is locked', async ({ cinna }) => {
  // Its words are in this computer's database, never in the vault: only a
  // chat bound to the vault (`vaultId`) is hidden while it is locked.
  test.setTimeout(MOVE_TIMEOUT + 120_000)
  await reopenPreMoveChat(cinna)
  await expect(cinna.page.getByTestId('vault-locked-chat')).toHaveCount(0)
  await expect(cinna.page.getByText(REPLY, { exact: true })).toBeVisible()
})

test('V7 a file the vault agent names links, previews from inside the vault, and downloads through the export', async ({ cinna }) => {
  test.setTimeout(MOVE_TIMEOUT + 120_000)
  const agent = await arrangeClaudeAgent(cinna, 'Saved `notes/vault-report.md` for you.')
  // Moved in with the folder, so it exists only inside the vault afterwards.
  mkdirSync(join(agent.path, 'notes'), { recursive: true })
  writeFileSync(join(agent.path, 'notes', 'vault-report.md'), '# Vault report\n\nWritten inside the vault.\n')
  await moveOverIpc(cinna, agent.id)
  const page = cinna.page
  await openSecurity(cinna)
  await page.getByRole('button', { name: 'Start chat', exact: true }).click()
  const box = page.getByRole('combobox', { name: 'Type a message...' })
  await box.fill('Write the report.')
  await box.press('Enter')

  // The span names a file in the vault's agent folder: it links, and the preview reads it from inside.
  const link = page.locator('code.file-ref', { hasText: 'notes/vault-report.md' })
  await expect(link).toBeVisible({ timeout: 60_000 })
  await link.click()
  const preview = page.locator('.app-modal-panel')
  await expect(preview.getByRole('heading', { name: 'Vault report' })).toBeVisible({ timeout: 30_000 })
  await expect(preview.getByText('Written inside the vault.')).toBeVisible()

  // Only what the vault offers: no Open, Open folder, Pin or Publish.
  await preview.getByRole('button', { name: 'More file actions' }).click()
  const menu = page.getByRole('menu', { name: 'File actions' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Download', 'Copy content'])

  // Download: the fake backend approves at once; the save dialog is answered here.
  const savedTo = join(cinna.sandbox.home, 'Downloads', 'vault-report.md')
  mkdirSync(join(cinna.sandbox.home, 'Downloads'), { recursive: true })
  await cinna.electronApp.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog
  }, savedTo)
  await menu.getByRole('menuitem', { name: 'Download' }).click()
  await expect(menu).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => (existsSync(savedTo) ? readFileSync(savedTo, 'utf8') : null), { timeout: 30_000 }).toBe('# Vault report\n\nWritten inside the vault.\n')
  await expect(preview.getByRole('alert')).toHaveCount(0)
})

/**
 * The scripted Codex app-server (`fakeCodexAppServer.mjs`, as `codex-engine.spec.ts`
 * runs it) saved as `localAgentsCodexPath`: the fake backend's runtime source
 * streams that file into the vault as the vault's `codex`. It answers any
 * plain prompt with a constant that is not the scripted Claude's.
 */
async function arrangeFakeCodex(cinna: CinnaApp): Promise<string> {
  const bin = join(cinna.sandbox.home, 'bin')
  mkdirSync(bin, { recursive: true })
  const executable = join(bin, 'codex')
  writeFileSync(executable, `#!${process.execPath}\n${readFileSync(join(process.cwd(), 'src/main/agents/drivers/acp/testSupport/fakeCodexAppServer.mjs'), 'utf8')}`, { mode: 0o755 })
  await cinna.page.evaluate((path) => window.api.settings.set('localAgentsCodexPath', path), executable)
  // Until the binary service has taken up the path just saved, Codex does not resolve to it.
  await expect
    .poll(async () => {
      const resolved = await cinna.page.evaluate(() => window.api.engine.resolveCodex())
      return resolved.state === 'ready' ? resolved.path : resolved.state
    }, { timeout: 30_000 })
    .toBe(executable)
  return executable
}

const CODEX_REPLY = 'Hello from Codex.'
const CLAUDE_HOSTS = ['api.anthropic.com', 'claude.ai', 'console.anthropic.com', 'platform.claude.com', 'statsig.anthropic.com']
const CODEX_HOSTS = ['api.openai.com', 'auth.openai.com', 'chatgpt.com']

test('V8 a vault agent switches to Codex through setup, answers on it, switches back at once, and a locked vault offers Unlock', async ({ cinna }) => {
  test.setTimeout(MOVE_TIMEOUT + 180_000)
  const agent = await arrangeClaudeAgent(cinna)
  await arrangeFakeCodex(cinna)
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  await moveOverIpc(cinna, agent.id)
  const page = cinna.page
  await openAgent(cinna)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()

  const panel = page.getByRole('region', { name: 'Runs with' })
  const runsOn = panel.getByLabel('Runs on', { exact: true })
  await expect(runsOn).toHaveValue('claude')
  await expect(runsOn.locator('option')).toHaveText(['Claude Agent', 'Codex — needs setup', 'OpenCode — needs setup', 'Antigravity — needs setup'])
  await expect(runsOn).toBeEnabled()

  // Codex is not in the vault yet: choosing it opens its setup.
  await runsOn.selectOption('codex')
  const dialog = page.getByRole('dialog', { name: 'Set up Codex in the vault' })
  await expect(dialog).toBeVisible()
  const steps = dialog.getByRole('list', { name: 'Steps' })
  await expect(steps.getByRole('listitem')).toHaveText([
    'Downloads the pinned Codex runtime into the vault',
    `Allows ${CODEX_HOSTS.join(', ')}`,
    'Stores the key (if given)',
    'Switches the agent to Codex'
  ])
  await expect(dialog.getByText('Each of the first two asks for Touch ID or your password.', { exact: true })).toBeVisible()
  // Until the switch is done the select keeps naming the engine the agent runs on.
  await expect(runsOn).toHaveValue('claude')
  await dialog.getByLabel('API key for Codex inside the vault').fill('sk-proj-e2e-not-a-real-key')
  await dialog.getByRole('button', { name: 'Set up', exact: true }).click()

  await expect(dialog).toHaveCount(0, { timeout: 60_000 })
  await expect(runsOn).toHaveValue('codex')
  await expect(runsOn.locator('option')).toHaveText(['Claude Agent', 'Codex', 'OpenCode — needs setup', 'Antigravity — needs setup'])
  // The Engine cell names the runtime inside; the line, what it runs on (no model or complexity set: Codex's own at medium).
  await expect(panel.getByText(`Codex ${RUNTIME_PINS.codex.cli}-host`, { exact: true })).toBeVisible()
  await expect(panel.getByText(/^Runs inside the vault on /)).toHaveText('Runs inside the vault on Codex’s default model, medium effort.')
  await expect(panel.getByRole('combobox', { name: 'Work complexity' })).toHaveValue('')

  // A turn on Codex, inside the vault: the scripted Codex's words, not the scripted Claude's.
  await page.getByRole('button', { name: 'Start chat', exact: true }).click()
  const box = page.getByRole('combobox', { name: 'Type a message...' })
  await box.fill('Which engine are you?')
  await box.press('Enter')
  await expect(page.getByText(CODEX_REPLY, { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(REPLY, { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  const chat = (await page.evaluate(() => window.api.chat.list())).find((c) => c.agentId === agent.id)
  if (!chat) throw new Error('no chat with the vault agent')
  const stored = await sqliteMessageCount(cinna, chat.id)
  expect(stored.vaultId, 'the Codex chat is bound to the vault').not.toBeNull()
  expect(stored.messages, 'no message of the Codex chat is in SQLite').toBe(0)

  // Back to Claude Agent: set up already, so it switches at once, with no dialog.
  await openAgent(cinna)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(runsOn).toHaveValue('codex')
  await runsOn.selectOption('claude')
  await expect(runsOn).toHaveValue('claude', { timeout: 30_000 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(runsOn.locator('option')).toHaveText(['Claude Agent', 'Codex', 'OpenCode — needs setup', 'Antigravity — needs setup'])
  await expect(panel.getByText(`Claude Code ${RUNTIME_PINS.claude.cli}-host`, { exact: true })).toBeVisible()
  await expect(panel.getByText(/^Runs inside the vault on /)).toHaveText('Runs inside the vault on Claude Code’s default model.')

  // Network access: both set-up engines' hosts.
  await page.getByRole('tab', { name: /^Security/ }).click()
  const hosts = [...CLAUDE_HOSTS, ...CODEX_HOSTS]
  await expect(page.getByText(/^\d+ hosts?: /)).toHaveText(`${hosts.length} hosts: ${hosts.join(', ')}`)

  // Locked: which engines are set up is known only to the vault.
  await page.getByRole('button', { name: 'Lock now' }).click()
  await expect(page.locator('[data-vault-state="locked"]')).toHaveText('Locked')
  await expect(runsOn).toBeDisabled()
  await expect(panel.getByText('Unlock the vault to change how it runs.', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Unlock', exact: true })).toBeEnabled()
  await expect(panel.getByRole('combobox', { name: 'Work complexity' })).toBeDisabled()
  await expect(runsOn).toHaveValue('claude')
})

/** Holds the scripted Claude's turn open on a `Bash` tool use until it is interrupted. */
const HOLD = 'HOLD-THE-TURN'
const HELD_PROMPT = `Run the long check. ${HOLD}`
const FOLLOW_UP = 'Then say PLUM-42 back.'
const HEARD = 'Heard PLUM-42.'

test('V9 Send now in a vault chat stops the turn inside the vault and sends the queued message as the next turn', async ({ cinna }) => {
  test.setTimeout(MOVE_TIMEOUT + 120_000)
  const { agent, fake } = await arrangeClaude(cinna, { reply: REPLY, holdMarker: HOLD, echoPattern: 'PLUM-\\d+' })
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  await moveOverIpc(cinna, agent.id)
  const page = cinna.page
  await openSecurity(cinna)
  await page.getByRole('button', { name: 'Start chat', exact: true }).click()
  const idle = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await idle.fill(HELD_PROMPT)
  await idle.press('Enter')

  // The Bash call in progress withdraws steering, so the follow-up is queued, not steered.
  await expect.poll(() => fake.log().filter((entry) => entry.event === 'held').length, { timeout: 60_000 }).toBe(1)
  await expect(page.getByRole('button', { name: 'Tool: Bash', exact: true })).toBeVisible()
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible()
  const running = page.getByRole('combobox', { name: 'Send a follow-up · Esc Esc to stop', exact: true })
  await running.fill(FOLLOW_UP)
  await running.press('Enter')
  await expect(running).toHaveValue('')
  const row = page.locator('[data-queued-message]')
  await expect(row.getByText('Queued', { exact: true })).toBeVisible()
  await expect(row.getByText(FOLLOW_UP, { exact: true })).toBeVisible()
  const chat = (await page.evaluate(() => window.api.chat.list())).find((c) => c.agentId === agent.id)
  if (!chat) throw new Error('no chat with the vault agent')
  expect((await page.evaluate((id) => window.api.run.queueList(id), chat.id)).items.map((item) => item.content)).toEqual([FOLLOW_UP])
  expect(fake.prompts(), 'nothing but the held prompt reached the CLI yet').toHaveLength(1)

  await row.getByRole('button', { name: 'Stop and send now', exact: true }).click()

  // The stop reached the engine inside the vault, then the queued text went as the next prompt.
  await expect.poll(() => fake.interrupted().length, { timeout: 30_000 }).toBe(1)
  await expect.poll(() => fake.prompts().length, { timeout: 30_000 }).toBe(2)
  const [first, second] = fake.prompts()
  expect(first).toContain(HELD_PROMPT)
  expect(second).toContain(FOLLOW_UP)
  expect(second).not.toContain(HOLD)

  await expect(page.getByText(HEARD, { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(REPLY, { exact: true })).toHaveCount(0)
  await expect(stop).toHaveCount(0, { timeout: 15_000 })
  await expect(idle).toHaveValue('')
  await expect(row).toHaveCount(0)
  await expect(page.getByText(FOLLOW_UP, { exact: true })).toHaveCount(1)
  expect(await page.evaluate((id) => window.api.run.queueList(id), chat.id)).toEqual({ held: false, items: [] })
  expect(fake.interrupted()).toHaveLength(1)

  // The vault's transcript: both prompts and the answer, no error row; the turn ended completed.
  const saved = await page.evaluate(async (id) => {
    const detail = await window.api.chat.get(id)
    return (detail?.messages ?? []).map((message) => ({ role: message.role, content: message.content }))
  }, chat.id)
  expect(saved.filter((m) => m.role === 'error'), JSON.stringify(saved)).toEqual([])
  expect(saved.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([HELD_PROMPT, FOLLOW_UP])
  expect(saved.at(-1)).toEqual({ role: 'assistant', content: HEARD })
  const status = await page.evaluate(async (id) => (await window.api.chat.list()).find((c) => c.id === id)?.lastRunResult?.status ?? null, chat.id)
  expect(status).toBe('completed')

  const stored = await sqliteMessageCount(cinna, chat.id)
  expect(stored.vaultId, 'the chat row is bound to the vault').not.toBeNull()
  expect(stored.messages, 'no message of the vault chat is in SQLite').toBe(0)
})
