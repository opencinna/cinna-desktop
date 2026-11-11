import { createServer, type Server } from 'node:http'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Locator, Page } from '@playwright/test'
import type { FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * Pinned files per folder agent: the card beside the transcript, the top
 * bar's chip where the card has no room, reordering, and a pin whose file is gone.
 *
 * ## What is real and what is not
 *
 * The agent is the scriptable fake ACP agent (`fakeAcpEngine`), answering
 * every turn with markdown that names two files in its folder, as in
 * `file-ref-menu.spec.ts`. Everything after that is the product: reference
 * resolution, the transcript's menu, `agent-files:pins-*`, the card, the chip,
 * the preview. The window is resized for real from main (`setContentSize`),
 * never by viewport emulation, so the card-or-chip decision is measured on
 * the laid-out chat area.
 *
 * ## What it proves
 *
 * - Pin file on a transcript reference shows the card (wide window) listing
 *   it; a new chat with the same agent shows it too; a row opens the preview;
 *   the row's menu has Unpin file first, and unpinning the last pin removes the card.
 * - At a narrow window the pins are the top bar chip `Pinned files, 1`, computed
 *   `-webkit-app-region: no-drag`; it opens the `Pinned files` popover, whose row
 *   opens the preview.
 * - Dragging the second row above the first reorders the card, and the order
 *   survives a relaunch.
 * - A pinned file deleted on disk shows `File not found` after the chat is
 *   reopened, and its menu offers only Unpin file and Copy full path.
 *
 * ## What it does not
 *
 * - A real mouse drag through the OS (Playwright's `dragTo` dispatches
 *   Chromium's drag events), the collapse toggle, keyboard focus in the
 *   popover, a pin outside the agent folder, the move's error row —
 *   `PinnedFilesCard.test.tsx`, `pinnedFileService.test.ts` and
 *   `MessageContextMenu.fileRefs.test.tsx` cover those.
 */

const AGENT = 'Pinboard Keeper'
const MODEL = 'qwen3:8b'

const SUMMARY = 'reports/weekly_summary.md'
const TODO = 'notes/todo.md'
const SUMMARY_NAME = 'weekly_summary.md'
const TODO_NAME = 'todo.md'

const REPLY = `The summary is in \`${SUMMARY}\`, the open items in \`${TODO}\`.`

const ANSWERS_WITH_PATHS: FakeAcpScript = {
  newSession: { sessionId: 'ses_e2e_pinned_files' },
  prompt: {
    emit: [
      {
        kind: 'update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } }
      }
    ]
  }
}

const WIDE = 2000
const NARROW = 1100

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

interface Arranged {
  agentId: string
  summaryPath: string
  todoPath: string
}

/**
 * A folder agent on the fake engine whose folder holds the two files, seen
 * by the composer after a relaunch. `pins` are pinned over IPC (realpaths,
 * in that order) before any chat opens.
 */
async function arrangeAgent(cinna: CinnaApp, pins: Array<'summary' | 'todo'> = []): Promise<Arranged> {
  await cinna.skipOnboarding()
  await installFakeAcpEngine(cinna, ANSWERS_WITH_PATHS)
  await cinna.page.evaluate(
    async ({ host, model }) => {
      const { id } = await window.api.providers.upsert({ type: 'ollama', name: 'Ollama', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId: model, isDefault: true })
    },
    { host: ollamaHost, model: MODEL }
  )
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, AGENT)
  mkdirSync(join(agent.path, 'reports'), { recursive: true })
  mkdirSync(join(agent.path, 'notes'), { recursive: true })
  writeFileSync(join(agent.path, SUMMARY), '# Weekly summary\n\nThree renewals closed.\n')
  writeFileSync(join(agent.path, TODO), '# To do\n\n- Call the Lisbon office.\n')
  const summaryPath = realpathSync(join(agent.path, SUMMARY))
  const todoPath = realpathSync(join(agent.path, TODO))

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  for (const pin of pins) {
    const path = pin === 'summary' ? summaryPath : todoPath
    const result = await cinna.page.evaluate(
      (input) => window.api.agentFiles.setPin({ ...input, pinned: true }),
      { agentId: agent.id, path }
    )
    expect(result).toEqual({ success: true, pinned: true })
  }
  return { agentId: agent.id, summaryPath, todoPath }
}

/** A new chat with the agent from the Agents tab, one turn sent; resolves once the reply's links render. */
async function chatWithAgent(cinna: CinnaApp, prompt: string): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(prompt)
  await input.press('Enter')
  // Links appear only once the reply is persisted and resolved.
  await expect(fileLink(page, TODO)).toBeVisible({ timeout: 30_000 })
}

/** Back to a chat in the Chats list by its first message. */
async function openChat(page: Page, prompt: string): Promise<void> {
  await page.getByRole('button', { name: 'Chats', exact: true }).click()
  await page.getByText(prompt, { exact: true }).first().click()
  await expect(fileLink(page, TODO)).toBeVisible({ timeout: 15_000 })
}

/** Really resize the window from main, and wait for the renderer to be that wide. */
async function setWindow(cinna: CinnaApp, width: number): Promise<void> {
  const handle = await cinna.electronApp.browserWindow(cinna.page)
  await handle.evaluate((browserWindow, target) => {
    const [, height] = browserWindow.getContentSize()
    browserWindow.setContentSize(target, height)
  }, width)
  await expect
    .poll(() => cinna.page.evaluate(() => window.innerWidth), { message: `the window is ${width}px wide` })
    .toBe(width)
}

function fileLink(page: Page, text: string): Locator {
  return page.getByRole('button', { name: `Preview ${text}`, exact: true })
}

function card(page: Page): Locator {
  return page.locator('[data-pinned-files-card]')
}

function cardRows(page: Page): Locator {
  return card(page).getByRole('list', { name: 'Pinned files', exact: true }).getByRole('button')
}

function chip(page: Page, count: number): Locator {
  return page.getByRole('button', { name: `Pinned files, ${count}`, exact: true })
}

function messageMenu(page: Page): Locator {
  return page.getByRole('menu', { name: 'Message actions', exact: true })
}

function previewCard(page: Page): Locator {
  return page.locator('div[tabindex="-1"]').filter({ has: page.getByRole('button', { name: 'Close preview' }) })
}

async function closePreview(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close preview', exact: true }).click()
  await expect(previewCard(page)).toHaveCount(0)
}

/** Right-click a transcript reference and Pin file (the item waits for the agent's pins to load). */
async function pinFromTranscript(page: Page, text: string): Promise<void> {
  await fileLink(page, text).click({ button: 'right' })
  const menu = messageMenu(page)
  const first = menu.getByRole('menuitem').first()
  await expect(first).toHaveText('Pin file')
  await expect(first).not.toHaveAttribute('aria-disabled', 'true')
  await first.click()
  await expect(menu).toHaveCount(0)
}

test('pin a referenced file, see it in another chat with the agent, open it, unpin it', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrangeAgent(cinna)
  await chatWithAgent(cinna, 'Write up the week.')
  await setWindow(cinna, WIDE)

  await test.step('Pin file on a reference shows the card listing it', async () => {
    const page = cinna.page
    await expect(page.locator('.app-sidebar-wrap')).not.toHaveClass(/is-collapsed/)
    await expect(card(page)).toHaveCount(0)
    await pinFromTranscript(page, SUMMARY)
    await expect(card(page)).toBeVisible()
    await expect(cardRows(page)).toHaveText([SUMMARY_NAME])
    await expect(cardRows(page).first()).toHaveAttribute('title', SUMMARY)
    await expect(chip(page, 1)).toHaveCount(0)
    await card(page).screenshot({ path: test.info().outputPath('pinned-files-card-wide.png'), animations: 'disabled' })
  })

  await test.step('a new chat with the same agent lists it too', async () => {
    const page = cinna.page
    await chatWithAgent(cinna, 'And the open items?')
    await expect(cardRows(page)).toHaveText([SUMMARY_NAME])
  })

  await test.step('clicking the row opens the preview', async () => {
    const page = cinna.page
    await cardRows(page).first().click()
    await expect(previewCard(page)).toBeVisible()
    await expect(previewCard(page).getByText(SUMMARY_NAME, { exact: true })).toBeVisible()
    await closePreview(page)
  })

  await test.step("the row's menu has Unpin file first; it removes the card", async () => {
    const page = cinna.page
    await cardRows(page).first().click({ button: 'right' })
    const menu = messageMenu(page)
    await expect(menu).toBeVisible()
    const first = menu.getByRole('menuitem').first()
    await expect(first).toHaveText('Unpin file')
    await first.click()
    await expect(card(page)).toHaveCount(0)
    await expect(menu).toHaveCount(0)
  })
})

test('at a narrow window the pins are a top bar chip whose popover opens the preview', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrangeAgent(cinna)
  await chatWithAgent(cinna, 'Write up the week.')
  await setWindow(cinna, NARROW)
  const page = cinna.page
  await pinFromTranscript(page, SUMMARY)

  const button = chip(page, 1)
  await expect(button).toBeVisible()
  await expect(card(page)).toHaveCount(0)
  expect(await button.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
  await expect(button).toHaveAttribute('aria-expanded', 'false')

  await button.click()
  const popover = page.getByRole('dialog', { name: 'Pinned files', exact: true })
  await expect(popover).toBeVisible()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  const rows = popover.getByRole('button')
  await expect(rows).toHaveText([SUMMARY_NAME])
  await page.screenshot({ path: test.info().outputPath('pinned-files-chip-popover-narrow.png'), animations: 'disabled' })

  await rows.first().click()
  await expect(previewCard(page)).toBeVisible()
  await expect(previewCard(page).getByText(SUMMARY_NAME, { exact: true })).toBeVisible()
  await expect(popover).toHaveCount(0)
})

test('dragging the second pin above the first reorders the card, and the order survives a relaunch', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  const { agentId } = await arrangeAgent(cinna, ['summary', 'todo'])
  const prompt = 'Write up the week.'
  await chatWithAgent(cinna, prompt)
  await setWindow(cinna, WIDE)

  await test.step('drag todo.md onto the top half of weekly_summary.md', async () => {
    const page = cinna.page
    await expect(cardRows(page)).toHaveText([SUMMARY_NAME, TODO_NAME])
    const [from, to] = [cardRows(page).nth(1), cardRows(page).nth(0)]
    await from.dragTo(to, { targetPosition: { x: 20, y: 2 } })
    await expect(cardRows(page)).toHaveText([TODO_NAME, SUMMARY_NAME])
    // Main stored it, not just the optimistic cache.
    await expect
      .poll(async () => {
        const result = await page.evaluate((id) => window.api.agentFiles.listPins({ agentId: id }), agentId)
        return result.success ? result.pins.map((pin) => pin.displayPath) : result
      })
      .toEqual([TODO, SUMMARY])
  })

  await test.step('after a relaunch the chat shows the new order', async () => {
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await setWindow(cinna, WIDE)
    await openChat(cinna.page, prompt)
    await expect(cardRows(cinna.page)).toHaveText([TODO_NAME, SUMMARY_NAME])
  })
})

test('a pinned file deleted on disk is marked File not found and offers only Unpin file and Copy full path', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  const { summaryPath } = await arrangeAgent(cinna, ['summary'])
  const prompt = 'Write up the week.'
  await chatWithAgent(cinna, prompt)
  await setWindow(cinna, WIDE)
  await expect(cardRows(cinna.page)).toHaveText([SUMMARY_NAME])
  await expect(cardRows(cinna.page).first().getByRole('img', { name: 'File not found' })).toHaveCount(0)

  rmSync(summaryPath)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  await setWindow(cinna, WIDE)
  await openChat(cinna.page, prompt)

  const page = cinna.page
  const row = cardRows(page).first()
  await expect(cardRows(page)).toHaveText([SUMMARY_NAME])
  await expect(row.getByRole('img', { name: 'File not found', exact: true })).toBeVisible()

  await row.click({ button: 'right' })
  const menu = messageMenu(page)
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveText(['Unpin file', 'Copy full path'])
})
