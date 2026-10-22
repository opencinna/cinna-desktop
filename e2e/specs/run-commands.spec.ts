import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Locator, Page } from '@playwright/test'
import type { FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * Run commands from a message: the transcript's right-click menu on code in a
 * folder agent's reply, the output panel, the Commands badge and the edit
 * dialog.
 *
 * ## What is real and what is not
 *
 * The agent is the scriptable fake ACP agent (`fakeAcpEngine`), answering one
 * turn with markdown that holds an inline `ls -la`, a fenced `bash` block with
 * `rm -rf build`, an inline `bash scripts/wait.sh` (the folder's own script,
 * `sleep 60`) and enough prose to make the transcript scroll. Everything after
 * that is the product: `detectCommand` / `looksAutoRunnable` at menu open,
 * `userCommands:run` and main's own-command rule, the real `$SHELL -c` child in
 * the agent's folder, the log, the `userCommands:output` port into xterm, the
 * session-activity `command` item, `sessionActivity:stop`, `dismiss` and
 * `outputFile` into the composer's attachment path.
 *
 * ## What it proves
 *
 * - `ls -la` offers Copy text, Save to Notes, Run, Run in background, Edit and
 *   Run…; Run opens the Command output panel with the folder's real listing,
 *   which ends `Exit 0`, and the Commands badge says the last one completed.
 * - Remove takes an ended run (and its badge) away; Run in background starts
 *   one with the panel closed, the badge appears, and its popover's row reads
 *   Completed with Open output opening the panel on that run.
 * - The `rm -rf build` block offers only Edit and Run…; the dialog shows the
 *   review sentence and the command; an edited `echo edited` runs as written.
 * - Add output to message attaches `output-echo.txt` to the composer.
 * - Stop on a running `sleep 60` ends it Stopped, and what sits where Stop was
 *   is not a button.
 * - With the panel open and the transcript scrolled up, "Jump to latest" sits
 *   wholly above the panel; a screenshot is attached as `jump-pill-over-panel`.
 *
 * ## What it does not
 *
 * - Main's `needs_review` for a command the menu offered Run for (a missing
 *   script), the refusals `not_local` / `folder_missing`, the log cap, ⌘↩, a
 *   chat removed mid-run, quit killing runs — `userCommandService.test.ts`,
 *   `user_commands.ipc.test.ts`, `CommandEditDialog.test.tsx` and the menu's
 *   unit tests cover those. Nothing here checks what the agent sees: the
 *   attachment is never sent.
 */

const AGENT = 'Build Helper'
const MODEL = 'qwen3:8b'
const PROMPT = 'What should I run?'

const LS = 'ls -la'
const RM = 'rm -rf build'
const WAIT = 'bash scripts/wait.sh'
const EDITED = 'echo edited'
const MARKER = 'inventory-e2e.csv'

const FILLER = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i + 1} explains a step of the build in plain words, with nothing to run in it.`
)

const REPLY = [
  `First look at the folder with \`${LS}\`.`,
  '',
  'Then clear the old build:',
  '',
  '```bash',
  RM,
  '```',
  '',
  `The long job is \`${WAIT}\`.`,
  '',
  ...FILLER.flatMap((line) => [line, ''])
].join('\n')

const ANSWERS_WITH_COMMANDS: FakeAcpScript = {
  newSession: { sessionId: 'ses_e2e_run_commands' },
  prompt: {
    emit: [
      {
        kind: 'update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } }
      }
    ]
  }
}

function fakeOllama(): Server {
  return createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/tags') {
      res.end(
        JSON.stringify({
          models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B' } }]
        })
      )
      return
    }
    if (req.url === '/api/version') {
      res.end(JSON.stringify({ version: '0.6.2' }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
}

let server: Server
let ollamaHost = ''

test.beforeAll(async () => {
  server = fakeOllama()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  ollamaHost = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** A folder agent on the fake engine with a marker file and its own `sleep 60` script; the turn sent. */
async function arrange(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  await installFakeAcpEngine(cinna, ANSWERS_WITH_COMMANDS)
  await cinna.page.evaluate(
    async ({ host, model }) => {
      const { id } = await window.api.providers.upsert({ type: 'ollama', name: 'Ollama', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId: model, isDefault: true })
    },
    { host: ollamaHost, model: MODEL }
  )
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, AGENT)
  writeFileSync(join(agent.path, MARKER), 'sku,count\n')
  mkdirSync(join(agent.path, 'scripts'), { recursive: true })
  writeFileSync(join(agent.path, 'scripts', 'wait.sh'), 'sleep 60\n')

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(PROMPT)
  await input.press('Enter')
  // `data-message-id` is on a persisted, non-streaming body only: the menu can decide from then on.
  await expect(inlineCode(page, LS)).toBeVisible({ timeout: 30_000 })
}

function inlineCode(page: Page, text: string): Locator {
  return page.locator('[data-message-id] code').filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
}

function fencedBlock(page: Page, text: string): Locator {
  return page.locator('[data-message-id] pre').filter({ hasText: text })
}

async function openMenuOn(page: Page, target: Locator): Promise<Locator> {
  await target.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Message actions', exact: true })
  await expect(menu).toBeVisible()
  return menu
}

function panel(page: Page): Locator {
  return page.getByRole('region', { name: 'Command output', exact: true })
}

/** The panel's terminal text (xterm's DOM renderer rows). */
function terminal(page: Page): Locator {
  return panel(page).getByTestId('command-output-terminal').locator('.xterm-rows')
}

/** How the run ended, in Stop's slot. */
function endSlot(page: Page): Locator {
  return panel(page).locator('[data-slot="stop"] > span:not([aria-hidden])')
}

function commandsBadge(page: Page): Locator {
  return page.getByRole('button', { name: /^(\d+ commands? running|Commands: the last one \w+)$/ })
}

function commandsPopover(page: Page): Locator {
  return page.getByLabel('Commands', { exact: true })
}

const RUNNABLE_ITEMS = ['Copy text', 'Save to Notes', 'Run', 'Run in background', 'Edit and Run…']

test('commands in a reply run in the agent folder, in the panel or the background, edited, stopped and attached', async ({
  cinna
}, testInfo) => {
  test.setTimeout(180_000)
  await arrange(cinna)

  await test.step('right-click ls -la: Run, Run in background, Edit and Run…; Run shows the folder listing, ending Exit 0', async () => {
    const page = cinna.page
    await expect(panel(page)).toHaveCount(0)
    const menu = await openMenuOn(page, inlineCode(page, LS))
    await expect(menu.getByRole('menuitem')).toHaveText(RUNNABLE_ITEMS)
    await menu.getByRole('menuitem', { name: 'Run', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await expect(panel(page)).toBeVisible()
    await expect(panel(page).getByTitle(LS, { exact: true })).toHaveText(LS)
    await expect(terminal(page)).toContainText(MARKER)
    await expect(terminal(page)).toContainText('scripts')
    await expect(endSlot(page)).toHaveText('Exit 0')
    await expect(commandsBadge(page)).toHaveAccessibleName('Commands: the last one completed')
  })

  await test.step('Remove takes the ended run and the badge away', async () => {
    const page = cinna.page
    await commandsBadge(page).hover()
    const popover = commandsPopover(page)
    await expect(popover).toBeVisible()
    await expect(popover.getByRole('listitem')).toHaveCount(1)
    await popover.getByRole('button', { name: `Remove ${LS}`, exact: true }).click()
    await expect(commandsBadge(page)).toHaveCount(0)
    await expect(panel(page)).toHaveCount(0)
  })

  await test.step('Run in background on ls -la: the panel stays closed, the badge appears, Open output opens it', async () => {
    const page = cinna.page
    const menu = await openMenuOn(page, inlineCode(page, LS))
    await expect(menu.getByRole('menuitem')).toHaveText(RUNNABLE_ITEMS)
    await menu.getByRole('menuitem', { name: 'Run in background', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await expect(commandsBadge(page)).toHaveAccessibleName('Commands: the last one completed')
    await expect(panel(page)).toHaveCount(0)

    await commandsBadge(page).hover()
    const popover = commandsPopover(page)
    await expect(popover).toBeVisible()
    const row = popover.getByRole('listitem')
    await expect(row).toHaveCount(1)
    await expect(row.getByText('Completed', { exact: true })).toBeVisible()
    await row.getByRole('button', { name: `Open output of ${LS}`, exact: true }).click()
    await expect(panel(page)).toBeVisible()
    await expect(terminal(page)).toContainText(MARKER)
    await expect(endSlot(page)).toHaveText('Exit 0')
  })

  await test.step('the rm -rf build block offers only Edit and Run…; the edited command runs as written', async () => {
    const page = cinna.page
    // Focus is inside the popover after Open output, which keeps it open; Escape is how it shuts.
    await page.keyboard.press('Escape')
    await expect(commandsPopover(page)).toHaveCount(0)
    const menu = await openMenuOn(page, fencedBlock(page, RM))
    await expect(menu.getByRole('menuitem')).toHaveText(['Copy text', 'Save to Notes', 'Edit and Run…'])
    await menu.getByRole('menuitem', { name: 'Edit and Run…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit and Run', exact: true })
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByText('This command can change or delete files, so it runs after you check it.', { exact: true })
    ).toBeVisible()
    const field = dialog.getByRole('textbox', { name: 'Command', exact: true })
    await expect(field).toHaveValue(RM)
    await field.fill(EDITED)
    await dialog.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(panel(page).getByTitle(EDITED, { exact: true })).toHaveText(EDITED)
    await expect(terminal(page)).toContainText('edited')
    await expect(endSlot(page)).toHaveText('Exit 0')
  })

  await test.step('Add output to message attaches output-echo.txt to the composer', async () => {
    const page = cinna.page
    await expect(page.getByRole('button', { name: /^Remove output-/ })).toHaveCount(0)
    await panel(page).getByRole('button', { name: 'Add output to message', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Remove output-echo.txt', exact: true })).toBeVisible()
  })

  await test.step('Stop on a running sleep 60 ends it Stopped; nothing clickable is left where Stop was', async () => {
    const page = cinna.page
    const menu = await openMenuOn(page, inlineCode(page, WAIT))
    await expect(menu.getByRole('menuitem')).toHaveText(RUNNABLE_ITEMS)
    await menu.getByRole('menuitem', { name: 'Run', exact: true }).click()
    await expect(panel(page).getByTitle(WAIT, { exact: true })).toHaveText(WAIT)
    await expect(panel(page).getByText('Running', { exact: true })).toBeVisible()
    await expect(commandsBadge(page)).toHaveAccessibleName('1 command running')
    const stop = panel(page).getByRole('button', { name: `Stop ${WAIT}`, exact: true })
    await expect(stop).toBeVisible()
    const box = await stop.boundingBox()
    if (!box) throw new Error('Stop has no box')
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await stop.click()
    await expect(endSlot(page)).toHaveText('Stopped')
    await expect(stop).toHaveCount(0)
    const hit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y)
      return { tag: element?.tagName ?? null, text: element?.textContent ?? null, inButton: !!element?.closest('button') }
    }, at)
    expect(hit).toEqual({ tag: 'SPAN', text: 'Stopped', inButton: false })
    await expect(commandsBadge(page)).toHaveAccessibleName('Commands: the last one stopped')
  })

  await test.step('scrolled up with the panel open, Jump to latest sits above the panel, not over its header', async () => {
    const page = cinna.page
    await expect(panel(page)).toBeVisible()
    const jump = page.getByRole('button', { name: 'Jump to latest', exact: true })
    // Over the transcript, clear of the composer and panel docked at the bottom.
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    await page.mouse.move(size.width / 2, size.height / 3)
    // Scroll until the view stops following; the pill is the UI's own signal for that.
    await expect(async () => {
      await page.mouse.wheel(0, -2000)
      await expect(jump).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
    const pill = await jump.boundingBox()
    const dock = await panel(page).boundingBox()
    if (!pill || !dock) throw new Error('the pill or the panel has no box')
    const shot = testInfo.outputPath('jump-pill-over-panel.png')
    await page.screenshot({ path: shot })
    await testInfo.attach('jump-pill-over-panel', { path: shot, contentType: 'image/png' })
    expect(pill.y + pill.height).toBeLessThanOrEqual(dock.y)
  })
})
