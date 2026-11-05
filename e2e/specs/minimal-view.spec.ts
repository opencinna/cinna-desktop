import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine } from '../fixtures/fakeAcpEngine'

/**
 * Minimal view: an open chat with only its transcript on screen. Entered by
 * the wipe gesture across the composer's input (a recorded real wipe replayed, no button held) or
 * the Interface menu's `Minimal view` toggle; left by the corner button
 * `Exit minimal view`.
 *
 * The chat is a plain chat on a keyless Ollama credential answered by the
 * scripted ACP runtime (as in `composer-paste.spec.ts`) — no model, no key.
 *
 * The file drop uses a real file: a synthetic `File` has no path, so
 * `webUtils.getPathForFile` answers `''` and the composer refuses it. The
 * file is set on a throwaway `<input type=file>` with `setInputFiles` (which
 * gives the `File` its path) and carried in the drag events' DataTransfer.
 */

const MODEL = 'qwen3:8b'
const FIRST_PROMPT = 'First question'
const SECOND_PROMPT = 'Second question'
const REPLY = 'Scripted answer from the fake runtime.'
const DRAFT = 'kept draft'
const FILE_NAME = 'minimal-notes.txt'

function fakeOllama(): Server {
  return createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B' } }] }))
        return
      }
      if (req.url === '/api/version') {
        res.end(JSON.stringify({ version: '0.6.2' }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
}

let server: Server
let host = ''

test.beforeAll(async () => {
  server = fakeOllama()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** A scripted runtime and a default mode, then one exchange in a new chat, which stays open. */
async function arrangeOpenChat(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  await installFakeAcpEngine(cinna, {
    prompt: {
      emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } } }],
      response: { stopReason: 'end_turn' }
    }
  })
  await cinna.page.evaluate(
    async ({ host, modelId }) => {
      await window.api.settings.set('autoChatTitles', false)
      const { id } = await window.api.providers.upsert({ type: 'ollama', name: 'Ollama', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId, engine: 'opencode', toolPolicy: 'none', isDefault: true })
    },
    { host, modelId: MODEL }
  )
  // Credentials and modes seeded over IPC are stale in the renderer until a restart.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  const input = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(FIRST_PROMPT)
  await input.press('Enter')
  await expect(cinna.page.getByText(REPLY, { exact: true })).toHaveCount(1, { timeout: 30_000 })
}

const shell = (page: Page): Locator => page.locator('div:has(> div > .app-sidebar-wrap)')
const sidebar = (page: Page): Locator => page.locator('.app-sidebar-wrap')
const topControls = (page: Page): Locator => page.locator('.app-topbar-controls')
const restoreButton = (page: Page): Locator => page.getByTestId('minimal-restore-button')
const cloud = (page: Page): Locator => page.getByTestId('minimal-cloud')
const composer = (page: Page): Locator => page.getByRole('combobox', { name: 'Type a message...', exact: true })

interface RecordedWipe {
  card: { x: number; y: number; w: number; h: number }
  moves: { x: number; y: number }[]
}

/** A recorded real wipe (take_b0 of the gesture's unit-test fixture): its pointer moves and the input card it crossed, in window pixels. */
function recordedWipe(): RecordedWipe {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), 'src/renderer/src/hooks/useWipeGesture.traces.json'), 'utf8')) as {
    takes: { name: string; card: RecordedWipe['card']; events: { k: string; x: number; y: number }[] }[]
  }
  const take = fixture.takes.find((entry) => entry.name === 'take_b0')
  if (!take) throw new Error('take_b0 is missing from the wipe fixture')
  return { card: take.card, moves: take.events.filter((event) => event.k === 'm').map(({ x, y }) => ({ x, y })) }
}

/**
 * Replays the recorded wipe, hover only, moved so the card it crossed lands
 * on the composer's input card (every counted stroke must cross it), and
 * clipped to the viewport (Playwright cannot move outside it; a real wipe
 * leaves the window's bottom edge). `upTo` cuts it short.
 */
async function wipe(page: Page, upTo?: number): Promise<void> {
  const box = await composer(page).locator('..').boundingBox()
  if (!box) throw new Error('the composer has no box')
  // An Electron window has no Playwright viewport; its inner size is the bound.
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const { card, moves } = recordedWipe()
  const dx = box.x + box.width / 2 - (card.x + card.w / 2)
  const dy = box.y + box.height / 2 - (card.y + card.h / 2)
  const clip = (value: number, max: number): number => Math.min(Math.max(value, 0), max - 1)
  for (const point of moves.slice(0, upTo)) await page.mouse.move(clip(point.x + dx, viewport.width), clip(point.y + dy, viewport.height))
}

/**
 * How many moves of the recorded wipe come before its sixth stroke: the
 * third rightward run of 55 px or more (it starts with a down-left stroke).
 */
function movesBeforeSixthStroke(): number {
  const points = recordedWipe().moves
  let runStart = 0
  let rightward = 0
  for (let i = 1; i <= points.length; i++) {
    const turns = i === points.length || (i - runStart > 1 && Math.sign(points[i].x - points[i - 1].x) !== Math.sign(points[runStart + 1].x - points[runStart].x) && points[i].x !== points[i - 1].x)
    if (!turns) continue
    const dx = points[i - 1].x - points[runStart].x
    if (dx >= 55 && ++rightward === 3) return runStart
    runStart = i - 1
  }
  throw new Error('the recorded wipe has no sixth stroke')
}

async function expectMinimal(page: Page): Promise<void> {
  await expect(shell(page)).toHaveAttribute('data-minimal', 'true')
  await expect(sidebar(page)).toHaveAttribute('inert', '')
  await expect(sidebar(page)).toHaveClass(/is-collapsed/)
  await expect(topControls(page)).toHaveAttribute('inert', '')
  await expect(topControls(page)).toHaveCSS('opacity', '0')
  await expect(restoreButton(page)).toHaveAttribute('data-shown', 'true')
  await expect(cloud(page)).toBeAttached()
}

async function expectFull(page: Page): Promise<void> {
  await expect(shell(page)).not.toHaveAttribute('data-minimal')
  await expect(sidebar(page)).not.toHaveAttribute('inert')
  await expect(sidebar(page)).not.toHaveClass(/is-collapsed/)
  await expect(topControls(page)).not.toHaveAttribute('inert')
  await expect(restoreButton(page)).toHaveCount(0)
  await expect(cloud(page)).toHaveCount(0)
  // Clickable again: a trial click runs every actionability check, hit-testing included.
  await page.getByRole('button', { name: 'New Chat', exact: true }).click({ trial: true, timeout: 5_000 })
}

test('the wipe enters minimal view; typing, sending and a file drop go through the cloud; restore keeps the draft', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrangeOpenChat(cinna)
  const page = cinna.page
  // Docked and open before minimal view, so "its prior state" is open.
  await expect(sidebar(page)).not.toHaveClass(/is-collapsed/)
  const lastReply = page.getByText(REPLY, { exact: true }).last()
  const topBefore = (await lastReply.boundingBox())?.y

  await test.step('the recorded wipe cut before its sixth stroke does nothing', async () => {
    await wipe(page, movesBeforeSixthStroke())
    await page.waitForTimeout(400)
    await expect(shell(page)).not.toHaveAttribute('data-minimal')
    // Longer than the gesture's pause limit, so the full replay starts afresh.
    await page.waitForTimeout(700)
  })

  await test.step('a recorded real wipe across the composer starts minimal view', async () => {
    await wipe(page)
    await expectMinimal(page)
    await expect(cloud(page)).toHaveAttribute('data-cloud-empty', 'true')
  })

  await test.step('nothing in the transcript moves on enter', async () => {
    expect(topBefore).toBeDefined()
    const topAfter = (await lastReply.boundingBox())?.y
    expect(Math.abs((topAfter ?? NaN) - (topBefore ?? NaN))).toBeLessThanOrEqual(1)
  })

  await test.step('keys typed with the transcript focused land in the cloud', async () => {
    await lastReply.click()
    await page.keyboard.type(SECOND_PROMPT)
    await expect(cloud(page).locator('textarea')).toHaveValue(SECOND_PROMPT)
    await expect(cloud(page)).not.toHaveAttribute('data-cloud-empty')
  })

  await test.step('Enter sends: the cloud empties and the reply renders', async () => {
    await page.keyboard.press('Enter')
    await expect(page.getByText(REPLY, { exact: true })).toHaveCount(2, { timeout: 30_000 })
    await expect(cloud(page).locator('textarea')).toHaveValue('')
    await expect(cloud(page)).toHaveAttribute('data-cloud-empty', 'true')
    await expect(shell(page)).toHaveAttribute('data-minimal', 'true')
  })

  await test.step('a file dropped on the transcript shows the overlay and attaches to the cloud', async () => {
    const file = join(cinna.sandbox.root, FILE_NAME)
    writeFileSync(file, 'notes for the minimal view drop\n')
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'file'
      input.id = 'e2e-minimal-drop-input'
      input.style.display = 'none'
      document.body.appendChild(input)
    })
    await page.setInputFiles('#e2e-minimal-drop-input', file)
    const target = page.getByText(REPLY, { exact: true }).first()
    await target.evaluate((el) => {
      const input = document.getElementById('e2e-minimal-drop-input') as HTMLInputElement
      const data = new DataTransfer()
      data.items.add(input.files![0])
      ;(window as unknown as { __e2eDrop: DataTransfer }).__e2eDrop = data
      el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }))
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }))
    })
    await expect(page.getByTestId('minimal-drop-overlay')).toHaveText('Drop to attach')
    await target.evaluate((el) => {
      const data = (window as unknown as { __e2eDrop: DataTransfer }).__e2eDrop
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
      document.getElementById('e2e-minimal-drop-input')?.remove()
    })
    await expect(page.getByTestId('minimal-drop-overlay')).toHaveCount(0)
    await expect(cloud(page).getByRole('button', { name: `Remove ${FILE_NAME}`, exact: true })).toBeAttached()
    await expect(cloud(page)).not.toHaveAttribute('data-cloud-empty')
    await cloud(page).locator('textarea').focus()
    await page.keyboard.type(DRAFT)
    await expect(cloud(page).locator('textarea')).toHaveValue(DRAFT)
  })

  await test.step('Exit minimal view brings everything back with the draft and chip intact', async () => {
    await restoreButton(page).click()
    await expectFull(page)
    await expect(composer(page)).toBeFocused()
    await expect(composer(page)).toHaveValue(DRAFT)
    await expect(page.getByRole('button', { name: `Remove ${FILE_NAME}`, exact: true })).toBeVisible()
  })
})

test('the Interface menu toggle starts minimal view and reads unpressed after restore', async ({ cinna }) => {
  test.setTimeout(90_000)
  await arrangeOpenChat(cinna)
  const page = cinna.page
  const trigger = page.getByRole('button', { name: 'Interface', exact: true })
  const toggle = page.getByRole('button', { name: 'Minimal view', exact: true })

  await trigger.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expectMinimal(page)
  await expect(toggle).toHaveCount(0)

  await restoreButton(page).click()
  await expectFull(page)
  await expect(composer(page)).toBeFocused()

  await trigger.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})
