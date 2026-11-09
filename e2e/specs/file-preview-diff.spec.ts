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
 * Diffs in the file preview, Copy content, Fill the window and the remembered
 * scroll position.
 *
 * ## What is real and what is not
 *
 * The agent is the scriptable fake ACP agent (`fakeAcpEngine`), answering one
 * turn that names the files in inline code. The files are real, in the agent's
 * folder, written from the inline fixtures below; everything from the file link
 * on is the product: the resolve, the read, `parseDiff`, the modal's geometry,
 * the scroll memory. The clipboard is the machine's own, read through Electron's
 * `clipboard` in main, and put back afterwards. The window is resized for real,
 * with `setContentSize` from main and never with `page.setViewportSize`: that is
 * emulation, and a viewport wider than the window lays the page out wider than
 * what is on screen, so a card centred in it is off centre in the window. Every
 * reading compares `window.innerWidth` with the BrowserWindow's content bounds.
 *
 * ## What it proves
 *
 * - A bare `+`/`-` diff of text fragments reads as sentences: the fragments are
 *   joined, `&mdash;` is decoded, `2 changes` shows, the replaced word is marked,
 *   and a real selection over it holds no sign.
 * - A multi-file git diff shows a card per file (a rename, a new file, a binary
 *   file) and Contents listing name first; an entry scrolls the body, and only
 *   the body, to that file.
 * - ⋯ on an agent file offers Open / Open folder / Copy content in that order,
 *   and Copy content writes the file's raw bytes, not what the preview shows.
 * - Fill the window sits left of Filter on a CSV. The card's rect equals the
 *   viewport; the header computes `-webkit-app-region: drag`, its buttons and the
 *   body `no-drag`. The choice carries to the next file. Turning it off leaves
 *   the card centred on the *window*, with the sidebar docked, on a plain card and
 *   on one widened by Contents, at 1100 and (where the display has the room) 1400
 *   wide; the plain card is also read at the window's own size before any resize
 *   or toggle. Each reading also computes
 *   the chat space's centre and requires it to be elsewhere, so the assertion can
 *   tell the two apart. The readings are logged.
 * - A long diff's scroll position survives closing by a press outside and
 *   reopening the same link; another file starts at the top; going back restores.
 *   A file left in the card and reopened filled lands at the same share, at a
 *   pixel offset far from the old one, and a live toggle keeps the share.
 *
 * ## What it does not
 *
 * - An actual window drag. Playwright's clicks bypass `-webkit-app-region`, so
 *   only the computed style is read; whether macOS moves the window is a hand
 *   check.
 * - The animations, the 500 ms press guards as such, the partial-copy and
 *   failed-copy rows, the header Copy button on an attachment, and the eviction
 *   past 200 remembered files (unit tests: `FilePreviewModal.test.tsx`,
 *   `previewViewMemory.test.ts`). Patch mails and `apply_patch` shapes are likewise
 *   left to `diffDocument.test.ts`.
 * - HTML and image cards in the filled state, and the artifact preview's Fill the
 *   window: this spec opens none of them.
 * - A report of a card that looked centred only in the chat space did not
 *   reproduce as a product fault: an earlier draft's emulated viewport wider than
 *   the window did show it. This measures geometry and paint order in the states
 *   above, in a real window with the sidebar docked. On Hover docking and Minimal
 *   view are not among them.
 * - Memory across a restart, which is by design not kept.
 */

const AGENT = 'Diff Reader'
const MODEL = 'qwen3:8b'
const PROMPT = 'Which files changed?'

const FRAGMENTS = 'docs/fragments.diff'
const MULTI = 'docs/changes.patch'
const CSV = 'docs/sellers.csv'
const LONG = 'docs/long.diff'
const OTHER = 'docs/other.diff'

const REPLY = [
  `Fragments are in \`${FRAGMENTS}\`, the release in \`${MULTI}\`.`,
  '',
  `The table is \`${CSV}\`, the long ones \`${LONG}\` and \`${OTHER}\`.`
].join('\n')

const ANSWERS_WITH_FILES: FakeAcpScript = {
  newSession: { sessionId: 'ses_e2e_preview_diff' },
  prompt: {
    emit: [
      {
        kind: 'update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } }
      }
    ]
  }
}

/** A page's text nodes, diffed: one sentence is four fragments. No `+` or minus sign in any text. */
const FRAGMENTS_TEXT = [
  '-Sellers file refreshed weekly',
  '+Sellers file refreshed daily',
  ' Unchanged heading',
  '+Traffic in 7 days: ',
  '+/sellers.json',
  '+ 7,404 hits, ',
  '+&mdash; up from last week',
  ''
].join('\n')

const JOINED_SENTENCE = 'Traffic in 7 days: /sellers.json 7,404 hits, — up from last week'

/** `count` added lines, enough to make a file's card tall. */
function addedLines(topic: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `+${topic} line ${i + 1}`)
}

const BILLING_ADDED = 40
const RENAME_ADDED = 40
const SETUP_ADDED = 60

const MULTI_TEXT = [
  'diff --git a/src/app/core/billing.py b/src/app/core/billing.py',
  'index 1111111..2222222 100644',
  '--- a/src/app/core/billing.py',
  '+++ b/src/app/core/billing.py',
  `@@ -1,2 +1,${BILLING_ADDED + 1} @@ def charge`,
  ' def charge(order):',
  '-    return order.total',
  ...addedLines('billing', BILLING_ADDED),
  'diff --git a/src/app/old_name.py b/src/app/new_name.py',
  'similarity index 96%',
  'rename from src/app/old_name.py',
  'rename to src/app/new_name.py',
  'index 3333333..4444444 100644',
  '--- a/src/app/old_name.py',
  '+++ b/src/app/new_name.py',
  `@@ -1,1 +1,${RENAME_ADDED} @@`,
  '-renamed module',
  ...addedLines('renamed', RENAME_ADDED),
  'diff --git a/docs/setup.md b/docs/setup.md',
  'new file mode 100644',
  'index 0000000..5555555',
  '--- /dev/null',
  '+++ b/docs/setup.md',
  `@@ -0,0 +1,${SETUP_ADDED} @@`,
  ...addedLines('setup', SETUP_ADDED),
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 6666666..7777777 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  ''
].join('\n')

const MULTI_ADDITIONS = BILLING_ADDED + RENAME_ADDED + SETUP_ADDED
const MULTI_DELETIONS = 2

const CSV_TEXT = 'seller,hits\nacme.example,7404\nglobex.example,1200\n'

/**
 * A long single-file diff, so no Contents panel changes the body's width.
 * The rows are wide enough to wrap in the card and not in a filled 1200 window
 * (the size the app launches at), which makes a pixel offset wrong across the toggle.
 */
function longDiff(name: string, pairs: number): string {
  const tail = 'the ledger keeps every state change with the operator who caused it and when'
  const rows: string[] = []
  for (let i = 1; i <= pairs; i++) {
    rows.push(`-${name} row ${i} before: ${tail}`)
    rows.push(`+${name} row ${i} after: ${tail}`)
  }
  return [`--- a/${name}.txt`, `+++ b/${name}.txt`, `@@ -1,${pairs} +1,${pairs} @@`, ...rows, ''].join('\n')
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

/** A folder agent on the fake engine holding the files, and its reply on screen. */
async function arrange(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  await installFakeAcpEngine(cinna, ANSWERS_WITH_FILES)
  await cinna.page.evaluate(
    async ({ host, model }) => {
      const { id } = await window.api.providers.upsert({ type: 'ollama', name: 'Ollama', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId: model, isDefault: true })
    },
    { host: ollamaHost, model: MODEL }
  )
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, AGENT)
  mkdirSync(join(agent.path, 'docs'), { recursive: true })
  writeFileSync(join(agent.path, FRAGMENTS), FRAGMENTS_TEXT)
  writeFileSync(join(agent.path, MULTI), MULTI_TEXT)
  writeFileSync(join(agent.path, CSV), CSV_TEXT)
  writeFileSync(join(agent.path, LONG), longDiff('long', 200))
  writeFileSync(join(agent.path, OTHER), longDiff('other', 150))

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
  await expect(fileLink(page, LONG)).toBeVisible({ timeout: 30_000 })
}

function fileLink(page: Page, text: string): Locator {
  return page.getByRole('button', { name: `Preview ${text}`, exact: true })
}

/** The modal's card: no dialog role, so it is the focusable box that holds Close. */
function previewCard(page: Page): Locator {
  return page
    .locator('div[tabindex="-1"]')
    .filter({ has: page.getByRole('button', { name: 'Close preview', exact: true }) })
}

/** The scrolling body: the card's first `overflow-auto` div (the panel is a `nav`). */
function previewBody(card: Locator): Locator {
  return card.locator('div.overflow-auto').first()
}

/** The header row: the card's first child, which turns into the drag strip when filled. */
function previewHeader(card: Locator): Locator {
  return card.locator(':scope > div').first()
}

function fillButton(card: Locator): Locator {
  return card.getByRole('button', { name: 'Fill the window', exact: true })
}

async function contentBounds(cinna: CinnaApp): Promise<{ x: number; y: number; width: number; height: number }> {
  const handle = await cinna.electronApp.browserWindow(cinna.page)
  return handle.evaluate((browserWindow) => browserWindow.getContentBounds())
}

/** Really resize the window from main, and wait for the renderer to be that wide. */
async function setWindow(cinna: CinnaApp, width: number): Promise<void> {
  const handle = await cinna.electronApp.browserWindow(cinna.page)
  await handle.evaluate((browserWindow, target) => {
    const [, height] = browserWindow.getContentSize()
    browserWindow.setContentSize(target, height)
  }, width)
  await expect.poll(() => cinna.page.evaluate(() => window.innerWidth), { message: `the window is ${width}px wide` }).toBe(width)
  expect((await contentBounds(cinna)).width).toBe(width)
}

async function closeWithEscape(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(previewCard(page)).toHaveCount(0)
}

/**
 * A press on the backdrop. A press in the first 500 ms after an open or a toggle
 * is deliberately ignored, so it is repeated until the card goes; the fade is
 * waited out inside the attempt, so no press falls through to the app beneath.
 */
async function closeByPressingOutside(page: Page): Promise<void> {
  const card = previewCard(page)
  await expect(async () => {
    if ((await card.count()) > 0) await page.mouse.click(6, await page.evaluate(() => window.innerHeight - 6))
    await expect(card).toHaveCount(0, { timeout: 1_000 })
  }).toPass()
}

function scrollTop(body: Locator): Promise<number> {
  return body.evaluate((el) => el.scrollTop)
}

/** Wheel over the body by hand, and answer the position once it has stopped moving. */
async function wheelBody(page: Page, body: Locator, delta: number): Promise<number> {
  const before = await scrollTop(body)
  const box = await body.boundingBox()
  if (!box) throw new Error('preview body has no box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, delta)
  await expect.poll(() => scrollTop(body)).not.toBe(before)
  let last = -1
  await expect
    .poll(async () => {
      const now = await scrollTop(body)
      const stopped = now === last
      last = now
      return stopped
    })
    .toBe(true)
  return last
}

interface ScrollState {
  top: number
  range: number
  share: number
}

function scrollState(body: Locator): Promise<ScrollState> {
  return body.evaluate((el) => {
    const range = el.scrollHeight - el.clientHeight
    return { top: el.scrollTop, range, share: range > 0 ? el.scrollTop / range : 0 }
  })
}

/** The card's rect once its entrance has finished: the scale would otherwise move it. */
async function settledRect(card: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect.poll(() => card.evaluate((el) => el.getAnimations().length)).toBe(0)
  return card.evaluate((el) => {
    const { x, y, width, height } = el.getBoundingClientRect()
    return { x, y, width, height }
  })
}

function appRegion(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
}

/** How far the file's card header sits below the top of the scrolling body, in px. */
async function offsetFromBodyTop(body: Locator, header: Locator): Promise<number> {
  const [headerBox, bodyBox] = await Promise.all([header.boundingBox(), body.boundingBox()])
  if (!headerBox || !bodyBox) throw new Error('file header or preview body has no box')
  return Math.round(headerBox.y - bodyBox.y)
}

/**
 * The card's centre against the window's and against the chat space beside the
 * sidebar, with what is painted on top at the card's edge and over the sidebar.
 * Asserted, and logged, because the numbers themselves are wanted.
 */
async function expectCentredOnWindow(cinna: CinnaApp, card: Locator, label: string): Promise<void> {
  await settledRect(card)
  const reading = await card.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const wrap = document.querySelector('.app-sidebar-wrap')
    if (!wrap) throw new Error('no sidebar in the document')
    const sidebar = wrap.getBoundingClientRect()
    const middle = window.innerHeight / 2
    const atCardEdge = document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2)
    const atSidebarLeft = document.elementFromPoint(sidebar.left + 2, middle)
    return {
      windowWidth: window.innerWidth,
      sidebarLeft: sidebar.left,
      sidebarWidth: sidebar.width,
      sidebarCollapsed: wrap.classList.contains('is-collapsed'),
      cardLeft: rect.left,
      cardRight: rect.right,
      cardWidth: rect.width,
      cardCentre: rect.left + rect.width / 2,
      windowCentre: window.innerWidth / 2,
      chatSpaceCentre: (sidebar.right + window.innerWidth) / 2,
      cardOnTopAtItsEdge: atCardEdge !== null && el.contains(atCardEdge),
      sidebarUnderTheScrim: atSidebarLeft !== null && !wrap.contains(atSidebarLeft)
    }
  })
  const content = await contentBounds(cinna)
  console.log(`centre ${label}: ${JSON.stringify({ ...reading, contentBounds: content })}`)
  // The page is laid out at the window's real width: nothing is clipped.
  expect(reading.windowWidth).toBe(content.width)
  expect(reading.sidebarCollapsed).toBe(false)
  expect(reading.sidebarWidth).toBeGreaterThan(100)
  // Far enough apart that a card centred on the wrong one could not pass.
  expect(Math.abs(reading.chatSpaceCentre - reading.windowCentre)).toBeGreaterThan(50)
  expect(Math.abs(reading.cardCentre - reading.windowCentre)).toBeLessThanOrEqual(0.5)
  expect(reading.cardOnTopAtItsEdge).toBe(true)
  expect(reading.sidebarUnderTheScrim).toBe(true)
}

test('1 a bare diff of text fragments reads as sentences, with its changes counted and no sign in a selection', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  const page = cinna.page
  const card = previewCard(page)
  await fileLink(page, FRAGMENTS).click()
  const diff = card.getByTestId('diff-preview')
  await expect(diff).toBeVisible()

  await test.step('the fragments are one sentence and the entity is decoded', async () => {
    const added = diff.locator('[data-diff-row="add"]')
    await expect(added).toHaveCount(2)
    await expect(added.nth(1).locator(':scope > span').last()).toHaveText(JOINED_SENTENCE, { useInnerText: true })
    await expect(card.getByText('&mdash;')).toHaveCount(0)
    await expect(card.getByText('—', { exact: false })).toHaveCount(1)
  })

  await test.step('the changes are counted, and the replaced word is the one marked', async () => {
    await expect(diff.getByText('2 changes', { exact: true })).toBeVisible()
    await expect(diff.locator('[data-diff-row="del"] mark')).toHaveText('weekly')
    await expect(diff.locator('[data-diff-row="add"] mark')).toHaveText('daily')
    await expect(diff.locator('[data-diff-row="context"]')).toHaveText('Unchanged heading')
  })

  await test.step('nameless and fileless: no card, no Contents', async () => {
    await expect(diff.locator('header')).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Contents', exact: true })).toHaveCount(0)
  })

  await test.step('the sign is shown and cannot be selected', async () => {
    const delRow = diff.locator('[data-diff-row="del"]')
    const addRow = diff.locator('[data-diff-row="add"]').first()
    const delSign = delRow.locator(':scope > span').first()
    const addSign = addRow.locator(':scope > span').first()
    await expect(delSign).toHaveText('−')
    await expect(addSign).toHaveText('+')
    expect(await delSign.evaluate((el) => getComputedStyle(el).userSelect)).toBe('none')
    expect(await addSign.evaluate((el) => getComputedStyle(el).userSelect)).toBe('none')

    // A real selection over the whole diff: what a copy would take.
    const selected = await diff.evaluate((el) => {
      const selection = window.getSelection()
      if (!selection) throw new Error('no selection')
      selection.selectAllChildren(el)
      const text = selection.toString()
      selection.removeAllRanges()
      return text
    })
    expect(selected).toContain(JOINED_SENTENCE)
    expect(selected).toContain('Sellers file refreshed weekly')
    expect(selected).not.toContain('+')
    expect(selected).not.toContain('−')
  })
})

test('2 a multi-file git diff shows a card per file and Contents, name first, scrolls to one', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  const page = cinna.page
  const card = previewCard(page)
  await fileLink(page, MULTI).click()
  const diff = card.getByTestId('diff-preview')
  await expect(diff).toBeVisible()
  const body = previewBody(card)
  const fileHeader = (label: string): Locator =>
    diff.locator('header').filter({ has: page.getByText(label, { exact: true }) })

  await test.step('a summary, then a card per file saying what happened to it', async () => {
    await expect(diff.getByText('4 files changed', { exact: true })).toBeVisible()
    await expect(diff.getByText(`+${MULTI_ADDITIONS}`, { exact: true }).first()).toBeVisible()
    await expect(diff.getByText(`−${MULTI_DELETIONS}`, { exact: true }).first()).toBeVisible()

    const titles = diff.locator('header > span:first-child')
    await expect(titles).toHaveText([
      'src/app/core/billing.py',
      'src/app/old_name.py → src/app/new_name.py',
      'docs/setup.md',
      'assets/logo.png'
    ])
    await expect(fileHeader('src/app/old_name.py → src/app/new_name.py').getByText('Renamed', { exact: true })).toBeVisible()
    await expect(fileHeader('docs/setup.md').getByText('New file', { exact: true })).toBeVisible()
    await expect(fileHeader('src/app/core/billing.py').getByText('def charge')).toHaveCount(0)
    await expect(
      diff
        .locator('section')
        .filter({ has: page.locator('header').filter({ has: page.getByText('assets/logo.png', { exact: true }) }) })
        .getByText('Binary file, not shown.', { exact: true })
    ).toBeVisible()
    await expect(diff.getByText('def charge', { exact: true })).toBeVisible()
  })

  const panel = card.getByRole('navigation', { name: 'Contents', exact: true })
  await test.step('Contents lists every file, the name before its folder', async () => {
    await expect(card.getByRole('button', { name: 'Contents', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await expect(panel.getByRole('button')).toHaveText([
      'billing.py · src/app/core',
      'new_name.py · src/app',
      'setup.md · docs',
      'logo.png · assets'
    ])
    expect(await scrollTop(body)).toBe(0)
  })

  await test.step('an entry scrolls the body, and only the body, to that file', async () => {
    const setup = fileHeader('docs/setup.md')
    expect(await offsetFromBodyTop(body, setup)).toBeGreaterThan(200)
    const entry = panel.getByRole('button', { name: 'setup.md · docs', exact: true })
    await entry.click()
    await expect.poll(() => offsetFromBodyTop(body, setup)).toBeLessThanOrEqual(24)
    await expect.poll(() => offsetFromBodyTop(body, setup)).toBeGreaterThanOrEqual(0)
    expect(await offsetFromBodyTop(body, fileHeader('src/app/core/billing.py'))).toBeLessThan(-200)
    await expect(entry).toHaveAttribute('aria-current', 'location')
    await expect(panel.locator('[aria-current]')).toHaveCount(1)
    expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0])
  })

  await test.step('another entry goes back up to its file', async () => {
    const renamed = fileHeader('src/app/old_name.py → src/app/new_name.py')
    await panel.getByRole('button', { name: 'new_name.py · src/app', exact: true }).click()
    await expect.poll(() => offsetFromBodyTop(body, renamed)).toBeLessThanOrEqual(24)
    await expect.poll(() => offsetFromBodyTop(body, renamed)).toBeGreaterThanOrEqual(0)
  })
})

test('3 Copy content in the ⋯ menu copies the raw bytes of the file', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  const page = cinna.page
  const readClipboard = (): Promise<string> => cinna.electronApp.evaluate(({ clipboard }) => clipboard.readText())
  const saved = await readClipboard()
  try {
    await cinna.electronApp.evaluate(({ clipboard }) => clipboard.writeText('e2e clipboard sentinel'))
    const card = previewCard(page)
    await fileLink(page, FRAGMENTS).click()
    await expect(card.getByTestId('diff-preview')).toBeVisible()

    await card.getByRole('button', { name: 'More file actions', exact: true }).click()
    const menu = page.getByRole('menu', { name: 'File actions', exact: true })
    await expect(menu.getByRole('menuitem')).toHaveText(['Open', 'Open folder', 'Copy content'])
    await menu.getByRole('menuitem', { name: 'Copy content', exact: true }).click()
    await expect(menu).toHaveCount(0)

    // As written: the split rows, the signs and the entity the preview decoded.
    await expect.poll(readClipboard).toBe(FRAGMENTS_TEXT)
    // The answer for a screen reader; the menu has closed, so the preview is still open.
    await expect(card.locator('span.sr-only[aria-live="polite"]')).toHaveText('Copied')
    await expect(card.getByTestId('diff-preview')).toBeVisible()
  } finally {
    await cinna.electronApp.evaluate(({ clipboard }, value) => clipboard.writeText(value), saved)
  }
})

test('4 Fill the window covers the window, carves the drag strip, carries over, and comes back centred on the window', async ({
  cinna
}) => {
  test.setTimeout(180_000)
  await arrange(cinna)
  const page = cinna.page
  const card = previewCard(page)
  const fill = fillButton(card)
  const openCsv = async (): Promise<void> => {
    await fileLink(page, CSV).click()
    await expect(card.getByRole('cell', { name: 'acme.example', exact: true })).toBeVisible()
  }
  const openMulti = async (): Promise<void> => {
    await fileLink(page, MULTI).click()
    await expect(card.getByTestId('diff-preview')).toBeVisible()
  }
  const expectFilled = async (): Promise<void> => {
    await expect(fill).toHaveAttribute('aria-pressed', 'true')
    const { width, height } = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    expect(await settledRect(card)).toEqual({ x: 0, y: 0, width, height })
    const content = await contentBounds(cinna)
    expect({ width, height }).toEqual({ width: content.width, height: content.height })
  }

  await test.step('the card is centred on the window at the real window size', async () => {
    await openCsv()
    await expect(fill).toHaveAttribute('aria-pressed', 'false')
    await expectCentredOnWindow(cinna, card, 'the window as launched, csv')
    await closeWithEscape(page)
  })

  await test.step('on a CSV the button is left of Filter', async () => {
    await openCsv()
    const labels = await previewHeader(card)
      .locator(':scope > div:last-child > button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
    expect(labels).toEqual([
      'Fill the window',
      'Toggle column filters and sorting',
      'More file actions',
      'Close preview'
    ])
    const filter = card.getByRole('button', { name: 'Toggle column filters and sorting', exact: true })
    const [fillBox, filterBox] = await Promise.all([fill.boundingBox(), filter.boundingBox()])
    if (!fillBox || !filterBox) throw new Error('a header button has no box')
    expect(fillBox.x + fillBox.width).toBeLessThanOrEqual(filterBox.x)
    // Not filled: the header is no drag strip.
    expect(await appRegion(previewHeader(card))).not.toBe('drag')
  })

  await test.step('clicking it makes the card the window', async () => {
    await fill.click()
    await expectFilled()
  })

  await test.step('the header drags the window; its buttons and the body do not', async () => {
    const header = previewHeader(card)
    expect(await appRegion(header)).toBe('drag')
    const buttons = await header
      .getByRole('button')
      .evaluateAll((all) =>
        all.map((el) => [el.getAttribute('aria-label') ?? el.textContent, getComputedStyle(el).getPropertyValue('-webkit-app-region')])
      )
    expect(buttons).toEqual([
      [CSV, 'no-drag'],
      ['Fill the window', 'no-drag'],
      ['Toggle column filters and sorting', 'no-drag'],
      ['More file actions', 'no-drag'],
      ['Close preview', 'no-drag']
    ])
    expect(await appRegion(previewBody(card))).toBe('no-drag')
  })

  await test.step('the next file opens filled too', async () => {
    await closeWithEscape(page)
    await openMulti()
    await expectFilled()
  })

  await test.step('turning it off returns the card centred on the window, with Contents and without', async () => {
    await closeWithEscape(page)
    const room = await cinna.electronApp.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize)
    console.log(`display work area ${JSON.stringify(room)}`)
    for (const width of [1100, ...(room.width >= 1400 ? [1400] : [])]) {
      await setWindow(cinna, width)
      for (const [kind, open] of [['csv', openCsv], ['patch with Contents', openMulti]] as const) {
        await open()
        await expectFilled()
        await fill.click()
        await expect(fill).toHaveAttribute('aria-pressed', 'false')
        await expectCentredOnWindow(cinna, card, `${width}, ${kind}`)
        // Left on for the next open.
        await fill.click()
        await expect(fill).toHaveAttribute('aria-pressed', 'true')
        await closeWithEscape(page)
      }
    }
  })
})

test('5 a long diff comes back where it was left, another file starts at the top, and a toggle keeps the share', async ({
  cinna
}) => {
  test.setTimeout(180_000)
  await arrange(cinna)
  const page = cinna.page
  const card = previewCard(page)
  const body = previewBody(card)
  const openLong = async (): Promise<void> => {
    await fileLink(page, LONG).click()
    await expect(card.getByText('long row 1 before:').first()).toBeAttached()
  }
  const openOther = async (): Promise<void> => {
    await fileLink(page, OTHER).click()
    await expect(card.getByText('other row 1 before:').first()).toBeAttached()
  }

  let left = 0
  await test.step('scrolled, closed by a press outside, reopened: the same scrollTop', async () => {
    await openLong()
    left = await wheelBody(page, body, 6_000)
    expect(left).toBeGreaterThan(1_000)
    await closeByPressingOutside(page)

    await openLong()
    await expect.poll(() => scrollTop(body)).toBe(left)
  })

  await test.step('another file starts at the top; going back restores', async () => {
    await closeByPressingOutside(page)
    await openOther()
    const other = await scrollState(body)
    expect(other.range).toBeGreaterThan(1_000)
    expect(other.top).toBe(0)
    await closeByPressingOutside(page)

    await openLong()
    await expect.poll(() => scrollTop(body)).toBe(left)
  })

  await test.step('left in the card, reopened filled: about the same share, at another offset', async () => {
    const inCard = await scrollState(body)
    await closeWithEscape(page)

    // Fill the window on a file other than the one under test.
    await openOther()
    await fillButton(card).click()
    await expect(fillButton(card)).toHaveAttribute('aria-pressed', 'true')
    await closeWithEscape(page)

    await openLong()
    await expect(fillButton(card)).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await scrollState(body)).top).not.toBe(0)
    const filled = await scrollState(body)
    console.log(`share in the card ${JSON.stringify(inCard)}, reopened filled ${JSON.stringify(filled)}`)
    expect(Math.abs(filled.share - inCard.share)).toBeLessThan(0.02)
    // The text rewrapped: the old pixel offset would have landed somewhere else.
    expect(Math.abs(filled.top - inCard.top)).toBeGreaterThan(200)
  })

  await test.step('toggling with the file open keeps the share as well', async () => {
    const filled = await scrollState(body)
    await fillButton(card).click()
    await expect(fillButton(card)).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => Math.abs((await scrollState(body)).share - filled.share)).toBeLessThan(0.02)
  })
})
