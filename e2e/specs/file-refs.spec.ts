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
 * Clickable file references in a folder agent's chat.
 *
 * ## What is real and what is not
 *
 * The agent is the scriptable fake ACP agent (`fakeAcpEngine`), spawned by the
 * app through the engine path setting, answering one turn with markdown that
 * names files in inline code. Everything after that is the product: the
 * persisted message, `collectFileRefSources`, `agent-files:resolve` statting a
 * real folder on disk, the `code` override, the store, `agent-files:authorize`
 * / `:read-preview` / `:reveal`, and the modal. Two Electron APIs are stubbed
 * in main, the way the harness stubs the directory picker: `dialog.showMessageBox`
 * (the consent dialog — a real one would block the run) and
 * `shell.showItemInFolder` (a real one would open Finder on the developer's
 * machine). The stubs record what they were asked.
 *
 * ## What it proves
 *
 * - Real files and folders, a short name the base heuristic resolves, and paths
 *   outside the folder render as clickable references; a missing file stays
 *   plain, and so does a fenced block holding a real path.
 * - A csv previews as a table with Open folder / Open; `.env` is refused as a
 *   credential file and `.gz` has no preview; a double-click leaves the preview
 *   open; keyboard activation moves focus into the card, and Tab walks the
 *   header, the copyable path first, to the scrolling body, which wears the
 *   accent ring.
 * - Outside the folder, main asks first, attached to the window, in `~/` words
 *   that differ for a file and a folder; Cancel opens nothing, Show file
 *   previews, and the approval is not asked again in the same run.
 * - A folder link reveals through `shell.showItemInFolder` with no modal; a
 *   file or folder deleted after the links rendered opens the modal with its
 *   own sentence, and a gone file's Open / Open folder are disabled.
 *
 * ## What it does not
 *
 * - **The fenced block's `pre` guard is not what keeps it plain.** A fenced
 *   block's `code` text always ends in a newline, so it can never equal a
 *   resolved span's text and the ref lookup misses before the guard matters.
 *   The assertion is that the block stays plain, which is the user-visible
 *   promise, not that `InsidePreContext` is load-bearing.
 * - Whether the double-click's second press landed on the overlay (the 500 ms
 *   guard) or still on the link (the `detail > 1` skip) depends on how fast the
 *   first open lands; either way the preview must stay open.
 * - Open (the external app launch), the "don't ask again" checkbox, the entrance
 *   animation, and a symlink out of the folder (unit-tested in
 *   `agentFileService.test.ts` / `resolver.test.ts`).
 */

const AGENT = 'Report Builder'
const MODEL = 'qwen3:8b'
const PROMPT = 'Summarise the reforecast cycle.'
const SHOTS = '/tmp/cinna-e2e-file-refs'

const CSV = 'data/report/pulled/omp.csv'
const SUMMARY = 'data/report/cycle_summary.md'
const SUMMARY_SHORT = 'cycle_summary.md'
const ARCHIVE = 'data/report/archive.csv.gz'
const PULLED = 'data/report/pulled'
const ENV = '.env'
const MISSING = 'data/report/pulled/gone.csv'
const OUTSIDE_FILE = '~/shared-data/q3-notes.txt'
const OUTSIDE_DIR = '~/shared-data/exports'

/** Only the `.env` file holds this; it must never reach the screen. */
const SECRET = 'e2e-not-a-real-token'
const OUTSIDE_TEXT = 'Q3 margin held at 41 percent.'

const REPLY = [
  `The cycle is pulled into \`${CSV}\` and summarised in \`${SUMMARY}\`.`,
  '',
  `The raw export is archived as \`${ARCHIVE}\`, next to everything in \`${PULLED}\`. Keys come from \`${ENV}\`.`,
  '',
  `The headline numbers are in \`${SUMMARY_SHORT}\`. I did not write \`${MISSING}\`.`,
  '',
  `Last quarter's notes are in \`${OUTSIDE_FILE}\`; exports go to \`${OUTSIDE_DIR}\`.`,
  '',
  '```',
  CSV,
  '```'
].join('\n')

const ANSWERS_WITH_PATHS: FakeAcpScript = {
  newSession: { sessionId: 'ses_e2e_file_refs' },
  prompt: {
    emit: [
      {
        kind: 'update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } }
      }
    ]
  }
}

/** Enough rows that the preview body scrolls, so it is a keyboard stop. */
function omnipartnerCsv(): string {
  const rows = ['partner,region,revenue_eur']
  for (let i = 1; i <= 60; i++) rows.push(`partner-${String(i).padStart(2, '0')},EU,${1000 + i * 17}`)
  return rows.join('\n') + '\n'
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
  mkdirSync(SHOTS, { recursive: true })
  server = fakeOllama()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  ollamaHost = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

interface Arranged {
  agentDir: string
}

/**
 * A folder agent on the fake engine whose folder holds the files the reply
 * names, a file and a folder outside it under the sandbox home, and the turn
 * sent through the composer. Resolves once the first link has rendered.
 */
async function arrange(cinna: CinnaApp): Promise<Arranged> {
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

  mkdirSync(join(agent.path, PULLED), { recursive: true })
  writeFileSync(join(agent.path, CSV), omnipartnerCsv())
  writeFileSync(join(agent.path, SUMMARY), '# Cycle summary\n\nRevenue held against plan.\n')
  writeFileSync(join(agent.path, ARCHIVE), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]))
  writeFileSync(join(agent.path, ENV), `OMP_TOKEN=${SECRET}\n`)
  const shared = join(cinna.sandbox.home, 'shared-data')
  mkdirSync(join(shared, 'exports'), { recursive: true })
  writeFileSync(join(shared, 'q3-notes.txt'), `${OUTSIDE_TEXT}\n`)

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
  // Links appear only once the reply is persisted and resolved.
  await expect(fileLink(page, CSV)).toBeVisible({ timeout: 30_000 })
  return { agentDir: agent.path }
}

function fileLink(page: Page, text: string): Locator {
  return page.getByRole('button', { name: `Preview ${text}`, exact: true })
}

function folderLink(page: Page, text: string): Locator {
  return page.getByRole('button', { name: `Show ${text} in its folder`, exact: true })
}

/** The modal's card: no dialog role, so it is the focusable box that holds Close. */
function previewCard(page: Page): Locator {
  return page
    .locator('div[tabindex="-1"]')
    .filter({ has: page.getByRole('button', { name: 'Close preview', exact: true }) })
}

/**
 * Lets whatever main has already answered reach the screen before asserting
 * that nothing opened: one IPC round trip, which queues behind any reply main
 * sent before it, then two frames for React to commit.
 */
async function settleRenderer(cinna: CinnaApp): Promise<void> {
  await cinna.page.evaluate(async () => {
    await window.api.localAgents.rootsList()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
}

/** Record `shell.showItemInFolder` instead of opening Finder. */
async function stubReveal(cinna: CinnaApp): Promise<void> {
  await cinna.electronApp.evaluate(({ shell }) => {
    const store = globalThis as unknown as { __e2eRevealed: string[] }
    store.__e2eRevealed = []
    shell.showItemInFolder = (path: string): void => {
      store.__e2eRevealed.push(path)
    }
  })
}

function revealed(cinna: CinnaApp): Promise<string[]> {
  return cinna.electronApp.evaluate(() => (globalThis as unknown as { __e2eRevealed: string[] }).__e2eRevealed)
}

interface ConsentAsk {
  /** Whether it was attached to a window (`showMessageBox(win, options)`). */
  attached: boolean
  options: Record<string, unknown>
}

/** Record the consent dialog and answer it from `responses`, in order (0 = show, 1 = cancel). */
async function stubConsent(cinna: CinnaApp, responses: number[]): Promise<void> {
  await cinna.electronApp.evaluate(({ dialog }, queue) => {
    const store = globalThis as unknown as { __e2eConsent: { asks: ConsentAsk[]; queue: number[] } }
    store.__e2eConsent = { asks: [], queue: [...queue] }
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const attached = args.length > 1
      const options = (attached ? args[1] : args[0]) as Record<string, unknown>
      store.__e2eConsent.asks.push({ attached, options })
      return { response: store.__e2eConsent.queue.shift() ?? 1, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  }, responses)
}

function consentAsks(cinna: CinnaApp): Promise<ConsentAsk[]> {
  return cinna.electronApp.evaluate(
    () => (globalThis as unknown as { __e2eConsent: { asks: ConsentAsk[] } }).__e2eConsent.asks
  )
}

test('a folder agent’s file references link, preview, refuse credentials and work from the keyboard', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  const page = cinna.page
  const card = previewCard(page)

  await test.step('real paths are links; a missing file and a fenced block stay plain', async () => {
    await expect(fileLink(page, CSV)).toHaveAttribute('title', CSV)
    await expect(fileLink(page, SUMMARY)).toHaveAttribute('title', SUMMARY)
    // Resolved through the folder of an earlier reference, not the agent root.
    await expect(fileLink(page, SUMMARY_SHORT)).toHaveAttribute('title', SUMMARY)
    await expect(fileLink(page, ARCHIVE)).toHaveAttribute('title', ARCHIVE)
    await expect(fileLink(page, ENV)).toHaveAttribute('title', ENV)
    await expect(folderLink(page, PULLED)).toHaveAttribute('title', `${PULLED}/`)
    await expect(fileLink(page, OUTSIDE_FILE)).toHaveAttribute('title', OUTSIDE_FILE)
    await expect(folderLink(page, OUTSIDE_DIR)).toHaveAttribute('title', `${OUTSIDE_DIR}/`)
    await expect(page.locator('code.file-ref')).toHaveCount(8)

    const missing = page.locator('code').filter({ hasText: new RegExp(`^${MISSING.replace(/\./g, '\\.')}$`) })
    await expect(missing).toHaveCount(1)
    await expect(missing).not.toHaveAttribute('role', 'button')
    const fenced = page.locator('pre code').filter({ hasText: CSV })
    await expect(fenced).toHaveCount(1)
    await expect(fenced).not.toHaveAttribute('role', 'button')
    await expect(page.locator('pre [role="button"]')).toHaveCount(0)
    await page.screenshot({ path: join(SHOTS, '1-reply-with-links.png'), animations: 'disabled' })
  })

  await test.step('the csv opens as a table with Open folder and Open; Escape closes it', async () => {
    await fileLink(page, CSV).click()
    await expect(card.getByRole('table')).toBeVisible()
    await expect(card.getByRole('row').first().getByRole('columnheader')).toHaveText(['partner', 'region', 'revenue_eur'])
    await expect(card.getByRole('cell', { name: 'partner-01', exact: true })).toBeVisible()
    await expect(card.getByText('omp.csv', { exact: true })).toBeVisible()
    await expect(card.getByText(CSV, { exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Open folder', exact: true })).toBeEnabled()
    await expect(card.getByRole('button', { name: 'Open', exact: true })).toBeEnabled()
    await page.screenshot({ path: join(SHOTS, '2-csv-preview.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
  })

  await test.step('.env is refused as a credential file, and .gz has no preview', async () => {
    await fileLink(page, ENV).click()
    await expect(card.getByText('Preview is off for credential files.', { exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Open', exact: true })).toBeEnabled()
    await expect(card.getByRole('button', { name: 'Open folder', exact: true })).toBeEnabled()
    await expect(page.locator('body')).not.toContainText(SECRET)
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)

    await fileLink(page, ARCHIVE).click()
    await expect(card.getByText('No preview for this file type.', { exact: true })).toBeVisible()
    await expect(card.getByText('archive.csv.gz', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
  })

  await test.step('a double-click leaves the preview open, and so does a slower second press on the backdrop', async () => {
    const heading = card.getByRole('heading', { name: 'Cycle summary', exact: true })
    // Playwright's double-click is faster than the first open's IPC, so both
    // presses land on the link and the second is skipped as `detail > 1`.
    await fileLink(page, SUMMARY).dblclick()
    // Every press has been dispatched by now, so a close it caused has happened.
    await expect(heading).toBeVisible()
    await expect(card).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)

    // A slower double-click: the second press lands on the backdrop the first
    // one opened, which is what the modal's 500 ms press guard is for. Pressed
    // at the link's right end, outside the card; the recorded targets prove it.
    await page.evaluate(() => {
      const record = window as unknown as { __e2ePresses: { target: string; at: number }[] }
      record.__e2ePresses = []
      window.addEventListener(
        'mousedown',
        (event) => {
          const element = event.target as Element
          const target = element.closest('div[tabindex="-1"]')
            ? 'card'
            : element.closest('code.file-ref')
              ? 'link'
              : element.closest('div.fixed.inset-0')
                ? 'backdrop'
                : 'elsewhere'
          record.__e2ePresses.push({ target, at: performance.now() })
        },
        true
      )
    })
    const box = await fileLink(page, SUMMARY).boundingBox()
    if (!box) throw new Error('the summary link has no box')
    const point = { x: box.x + box.width - 4, y: box.y + box.height / 2 }
    await page.mouse.click(point.x, point.y)
    await expect(card).toBeVisible()
    await page.mouse.click(point.x, point.y)
    await expect(heading).toBeVisible()
    await expect(card).toBeVisible()
    const presses = await page.evaluate(
      () => (window as unknown as { __e2ePresses: { target: string; at: number }[] }).__e2ePresses
    )
    expect(presses.map((press) => press.target)).toEqual(['link', 'backdrop'])
    // Inside `OPEN_PRESS_GUARD_MS` (500) of the first press, so of the open too.
    expect(presses[1].at - presses[0].at).toBeLessThan(500)
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
  })

  await test.step('Tab to a link, Enter, and focus is in the card; Tab walks to the ringed body', async () => {
    // A press on the paragraph's first letter sets where Tab starts from.
    await page.getByRole('paragraph').filter({ hasText: 'The cycle is pulled into' }).click({ position: { x: 2, y: 4 } })
    await page.keyboard.press('Tab')
    await expect(fileLink(page, CSV)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(card.getByRole('table')).toBeVisible()
    await expect(card).toBeFocused()

    // The header path copies on click, so it is the first stop, and says so.
    await page.keyboard.press('Tab')
    await expect(card.getByRole('button', { name: CSV, exact: true })).toBeFocused()
    await expect(card.getByRole('status')).toHaveText('Click to copy')
    await expect(card.getByRole('status')).toHaveCSS('opacity', '1')
    await page.keyboard.press('Tab')
    await expect(card.getByRole('button', { name: 'Toggle column filters and sorting', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(card.getByRole('button', { name: 'Open folder', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(card.getByRole('button', { name: 'Open', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(card.getByRole('button', { name: 'Close preview', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    const body = card.locator('div.overflow-auto')
    await expect(body).toBeFocused()
    const accent = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.color = 'var(--color-accent)'
      document.body.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    })
    await expect(body).toHaveCSS('outline-width', '2px')
    await expect(body).toHaveCSS('outline-color', accent)
    await page.screenshot({ path: join(SHOTS, '4-body-focus-ring.png'), animations: 'disabled' })

    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
    // Opened from the keyboard, so focus goes back to the link.
    await expect(fileLink(page, CSV)).toBeFocused()
  })
})

test('a path outside the agent folder is asked about in main first; Cancel opens nothing, Show file previews', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  const page = cinna.page
  const card = previewCard(page)
  // Cancel the folder, cancel the file, then show the file.
  await stubConsent(cinna, [1, 1, 0])
  await stubReveal(cinna)
  const showFolder = process.platform === 'darwin' ? 'Show in Finder' : 'Show in folder'

  await test.step('an outside folder is asked about in folder words; Cancel reveals nothing', async () => {
    await folderLink(page, OUTSIDE_DIR).click()
    await expect.poll(async () => (await consentAsks(cinna)).length).toBe(1)
    await settleRenderer(cinna)
    await expect(card).toHaveCount(0)
    expect(await revealed(cinna)).toEqual([])
    expect((await consentAsks(cinna))[0]).toEqual({
      attached: true,
      options: {
        type: 'question',
        buttons: [showFolder, 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `Show a folder outside ${AGENT}'s folder?`,
        detail: OUTSIDE_DIR,
        checkboxLabel: 'Don\'t ask again for anything inside “exports” until Cinna restarts',
        checkboxChecked: false
      }
    })
  })

  await test.step('an outside file is asked about in file words; Cancel opens nothing', async () => {
    await fileLink(page, OUTSIDE_FILE).click()
    await expect.poll(async () => (await consentAsks(cinna)).length).toBe(2)
    await settleRenderer(cinna)
    await expect(card).toHaveCount(0)
    expect((await consentAsks(cinna))[1]).toEqual({
      attached: true,
      options: {
        type: 'question',
        buttons: ['Show file', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `Show a file outside ${AGENT}'s folder?`,
        detail: `${OUTSIDE_FILE}\n\nCinna reads it to preview it here.\n\nFolder: ~/shared-data`,
        checkboxLabel: 'Don\'t ask again for anything inside “shared-data” until Cinna restarts',
        checkboxChecked: false
      }
    })
  })

  await test.step('Show file opens the preview, and the approval holds for the rest of the run', async () => {
    await fileLink(page, OUTSIDE_FILE).click()
    await expect(card.getByText(OUTSIDE_TEXT, { exact: true })).toBeVisible()
    await expect(card.getByText('q3-notes.txt', { exact: true })).toBeVisible()
    await expect(card.getByText(OUTSIDE_FILE, { exact: true })).toBeVisible()
    expect(await consentAsks(cinna)).toHaveLength(3)
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)

    await fileLink(page, OUTSIDE_FILE).click()
    await expect(card.getByText(OUTSIDE_TEXT, { exact: true })).toBeVisible()
    expect(await consentAsks(cinna)).toHaveLength(3)
  })
})

test('a folder link reveals the folder; a file or folder deleted after the links rendered says so', async ({ cinna }) => {
  test.setTimeout(120_000)
  const { agentDir } = await arrange(cinna)
  const page = cinna.page
  const card = previewCard(page)
  await stubReveal(cinna)
  const pulledReal = realpathSync(join(agentDir, PULLED))

  await test.step('the folder link reveals it in the file manager, with no modal', async () => {
    await folderLink(page, PULLED).click()
    await expect.poll(() => revealed(cinna)).toEqual([pulledReal])
    await settleRenderer(cinna)
    await expect(card).toHaveCount(0)
  })

  await test.step('a file deleted after resolve opens a card whose Open and Open folder are disabled', async () => {
    rmSync(join(agentDir, CSV))
    await fileLink(page, CSV).click()
    await expect(card.getByText('That file is no longer there.', { exact: true })).toBeVisible()
    await expect(card.getByText('omp.csv', { exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Open folder', exact: true })).toBeDisabled()
    await expect(card.getByRole('button', { name: 'Open', exact: true })).toBeDisabled()
    await page.screenshot({ path: join(SHOTS, '3-missing-file-card.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
  })

  await test.step('a folder deleted after resolve opens the modal saying so, and reveals nothing', async () => {
    rmSync(join(agentDir, PULLED), { recursive: true, force: true })
    await folderLink(page, PULLED).click()
    await expect(card.getByText('That folder is no longer there.', { exact: true })).toBeVisible()
    await expect(card.getByText('pulled', { exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Open folder', exact: true })).toHaveCount(0)
    expect(await revealed(cinna)).toEqual([pulledReal])
  })
})
