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
 * Run commands from a message: a click on a command in a folder agent's
 * reply, the transcript's right-click menu, the Run Script window and the
 * Commands badge.
 *
 * ## What is real and what is not
 *
 * The agent is the scriptable fake ACP agent (`fakeAcpEngine`), answering one
 * turn with markdown that holds an inline `ls -la`, a fenced `bash` block with
 * `rm -rf build`, an inline `bash scripts/wait.sh` (the folder's own script,
 * `sleep 60`) and enough prose to make the transcript scroll. Everything after
 * that is the product: `detectCommand` / `looksAutoRunnable` at render and at
 * menu open, `userCommands:run` and main's own-command rule, the real
 * `$SHELL -c` child in the agent's folder, the log, the `userCommands:output`
 * port into xterm, the session-activity `command` item,
 * `sessionActivity:stop`, `dismiss` and `outputFile` into the composer's
 * attachment path.
 *
 * ## What it proves
 *
 * - `ls -la` offers Copy text, Save to Notes, Run, Run in background, Edit and
 *   Run…; Run opens the Run Script window on the run, showing the folder's real
 *   listing, which ends Completed, and the Commands badge says so. A
 *   screenshot is attached as `run-script-window`.
 * - Escape closes the window and keeps the run; Remove takes an ended run (and
 *   its badge) away; Run in background starts one with the window closed, and
 *   the badge's Open output opens the window on that run.
 * - The `rm -rf build` block offers only Edit and Run… on a right-click; a
 *   click on it opens the window with the guard's sentence and the command, and
 *   an edited `echo edited` runs as written.
 * - The window's ⋯ Add output to message attaches `output-echo.txt` to the
 *   composer.
 * - A click on `bash scripts/wait.sh` and Enter runs it; Collapse leaves it
 *   running; Open output brings it back, Stop ends it Stopped, and Run again
 *   takes Stop's place exactly.
 *
 * ## What it does not
 *
 * - Main's `needs_review` for a command the menu offered Run for (a missing
 *   script), the refusals `not_local` / `folder_missing`, the log cap, ⌘↩ and
 *   ⇧⌘↩, history, a rerun's separator, a chat removed mid-run, quit killing
 *   runs — `userCommandService.test.ts`, `user_commands.ipc.test.ts`,
 *   `RunScriptModal.test.tsx`, `fileRefs.commands.test.tsx` and the menu's
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

/** The Run Script window. */
function runWindow(page: Page): Locator {
  return page.getByRole('dialog', { name: /^Run / })
}

/** The window's terminal text (xterm's DOM renderer rows). */
function terminal(page: Page): Locator {
  return runWindow(page).getByTestId('command-output-terminal').locator('.xterm-rows')
}

/** The run's state and time, in the window's header. */
function stateSlot(page: Page): Locator {
  return runWindow(page).locator('[data-slot="state"]')
}

function commandLine(page: Page): Locator {
  return runWindow(page).getByRole('textbox', { name: 'Command', exact: true })
}

function commandsBadge(page: Page): Locator {
  return page.getByRole('button', { name: /^(\d+ commands? running|Commands: the last one \w+)$/ })
}

function commandsPopover(page: Page): Locator {
  return page.getByLabel('Commands', { exact: true })
}

/** Close the window with Escape; the run, if any, keeps going. */
async function closeWindow(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(runWindow(page)).toHaveCount(0)
}

const RUNNABLE_ITEMS = ['Copy text', 'Save to Notes', 'Run', 'Run in background', 'Edit and Run…']

test('commands in a reply open the Run Script window, run in the agent folder or the background, edited, stopped and attached', async ({
  cinna
}, testInfo) => {
  test.setTimeout(180_000)
  await arrange(cinna)

  await test.step('right-click ls -la: Run opens the window on the run, showing the folder listing, Completed', async () => {
    const page = cinna.page
    await expect(runWindow(page)).toHaveCount(0)
    const menu = await openMenuOn(page, inlineCode(page, LS))
    await expect(menu.getByRole('menuitem')).toHaveText(RUNNABLE_ITEMS)
    await menu.getByRole('menuitem', { name: 'Run', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await expect(runWindow(page)).toHaveAccessibleName('Run ls')
    await expect(commandLine(page)).toHaveValue(LS)
    await expect(terminal(page)).toContainText(MARKER)
    await expect(terminal(page)).toContainText('scripts')
    await expect(stateSlot(page)).toContainText('Completed')
    await expect(runWindow(page).getByRole('button', { name: 'Run again', exact: true })).toBeVisible()
    await expect.poll(() => runWindow(page).evaluate((card) => card.getAnimations().length)).toBe(0)
    const shot = testInfo.outputPath('run-script-window.png')
    await page.screenshot({ path: shot })
    await testInfo.attach('run-script-window', { path: shot, contentType: 'image/png' })
    await closeWindow(page)
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
  })

  await test.step('Run in background on ls -la: the window stays closed, the badge appears, Open output opens it', async () => {
    const page = cinna.page
    const menu = await openMenuOn(page, inlineCode(page, LS))
    await expect(menu.getByRole('menuitem')).toHaveText(RUNNABLE_ITEMS)
    await menu.getByRole('menuitem', { name: 'Run in background', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await expect(commandsBadge(page)).toHaveAccessibleName('Commands: the last one completed')
    await expect(runWindow(page)).toHaveCount(0)

    await commandsBadge(page).hover()
    const popover = commandsPopover(page)
    await expect(popover).toBeVisible()
    const row = popover.getByRole('listitem')
    await expect(row).toHaveCount(1)
    await expect(row.getByText('Completed', { exact: true })).toBeVisible()
    await row.getByRole('button', { name: `Open output of ${LS}`, exact: true }).click()
    await expect(runWindow(page)).toBeVisible()
    await expect(terminal(page)).toContainText(MARKER)
    await expect(stateSlot(page)).toContainText('Completed')
    await closeWindow(page)
  })

  await test.step('the rm -rf build block offers only Edit and Run…; a click opens the window with the guard, and the edit runs as written', async () => {
    const page = cinna.page
    await expect(commandsPopover(page)).toHaveCount(0)
    const menu = await openMenuOn(page, fencedBlock(page, RM))
    await expect(menu.getByRole('menuitem')).toHaveText(['Copy text', 'Save to Notes', 'Edit and Run…'])
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    await fencedBlock(page, RM).click()
    await expect(runWindow(page)).toBeVisible()
    await expect(
      runWindow(page).getByText('This command isn\'t known to be read-only — check it before you run it.', { exact: true })
    ).toBeVisible()
    await expect(commandLine(page)).toHaveValue(RM)
    await commandLine(page).fill(EDITED)
    await runWindow(page).getByRole('button', { name: 'Run', exact: true }).click()
    await expect(terminal(page)).toContainText('edited')
    await expect(stateSlot(page)).toContainText('Completed')
  })

  await test.step('⋯ Add output to message attaches output-echo.txt to the composer', async () => {
    const page = cinna.page
    await expect(page.getByRole('button', { name: /^Remove output-/ })).toHaveCount(0)
    await runWindow(page).getByRole('button', { name: 'More run actions', exact: true }).click()
    await page.getByRole('menu', { name: 'Run actions', exact: true }).getByRole('menuitem', { name: 'Add output to message', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Remove output-echo.txt', exact: true })).toBeVisible()
    await closeWindow(page)
  })

  await test.step('click and Enter run sleep 60; Collapse keeps it running; Stop ends it, and Run again takes its place', async () => {
    const page = cinna.page
    await inlineCode(page, WAIT).click()
    await expect(runWindow(page)).toHaveAccessibleName('Run wait.sh')
    await expect(commandLine(page)).toBeFocused()
    await commandLine(page).press('Enter')
    await expect(stateSlot(page)).toContainText('Running')
    await expect(commandsBadge(page)).toHaveAccessibleName('1 command running')

    await runWindow(page).getByRole('button', { name: 'Collapse', exact: true }).click()
    await expect(runWindow(page)).toHaveCount(0)
    await expect(commandsBadge(page)).toHaveAccessibleName('1 command running')

    await commandsBadge(page).hover()
    const popover = commandsPopover(page)
    await expect(popover).toBeVisible()
    await popover.getByRole('button', { name: `Open output of ${WAIT}`, exact: true }).click()
    await expect(runWindow(page)).toBeVisible()
    await expect(stateSlot(page)).toContainText('Running')
    const stop = runWindow(page).getByRole('button', { name: 'Stop', exact: true })
    await expect(stop).toBeVisible()
    // Measured once the entrance has finished scaling the card.
    await expect.poll(() => runWindow(page).evaluate((card) => card.getAnimations().length)).toBe(0)
    const before = await stop.boundingBox()
    await stop.click()
    await expect(stateSlot(page)).toContainText('Stopped')
    const again = runWindow(page).getByRole('button', { name: 'Run again', exact: true })
    await expect(again).toBeVisible()
    const after = await again.boundingBox()
    expect(after).toEqual(before)
    await closeWindow(page)
    await expect(commandsBadge(page)).toHaveAccessibleName('Commands: the last one stopped')
  })
})
