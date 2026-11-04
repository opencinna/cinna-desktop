import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * Sticky table headers (Settings → Features → Interface → "Sticky table
 * headers", on by default, localStorage `cinna-sticky-table-headers`).
 *
 * A markdown table in a chat reply keeps its header row at the top of the
 * transcript while the transcript scrolls through it, and the header leaves
 * with the table. The scroller's `--sticky-table-top` says where: 10px (its top
 * fade, `--transcript-fade`) while the sidebar is docked, 36px (`--topbar-h`,
 * under the floating top-bar buttons) when it is not. A
 * table too wide for the bubble (an unbreakable token) is marked
 * `data-table-scrolls` by `ChatTable`, keeps its own sideways scroll and its
 * header scrolls with it.
 *
 * The chat and its replies are arranged over IPC (`chat.create` / `update` /
 * `showInList` / `addMessage`): the transcript renders a stored reply through
 * the same `MessageBubble` → `chatMessageComponents` → `ChatTable` path a
 * finished turn does, and no model or engine is needed to put a table on
 * screen. What is under test is layout while scrolling, measured in the page
 * (bounding boxes against the transcript scroller, `elementFromPoint` for what
 * is drawn on the header). The frosted band above a stuck header
 * (`th::before`) is left to the screenshots.
 */

const TITLE = 'Sticky tables chat'
const LONG_ROWS = 60
const WIDE_ROWS = 40
const TOKEN = 'x'.repeat(300)
/** `--sticky-table-top`: the transcript fade with the sidebar docked, the top bar otherwise. */
const DOCKED_TOP = 10
const UNDOCKED_TOP = 36

const longTable = [
  '| Item | Owner | State |',
  '|---|---|---|',
  ...Array.from({ length: LONG_ROWS }, (_, i) => `| item-${i + 1} | ann | open |`)
].join('\n')
const LONG_REPLY = `Here is the list:\n\n${longTable}\n\nThat is every item on the list.`

const wideTable = [
  '| Key | Blob | Note |',
  '|---|---|---|',
  ...Array.from({ length: WIDE_ROWS }, (_, i) => `| key-${i + 1} | ${i === 0 ? TOKEN : 'short'} | fine |`)
].join('\n')
const WIDE_REPLY = `And the wide one:\n\n${wideTable}\n\nThat is the wide table.`

/** Where things are; `*Top`/`*Bottom` relative to the transcript scroller's top edge. */
interface Measure {
  /** `--sticky-table-top` on the scroller, computed: where a stuck header's top belongs. */
  stickyTop: number
  thTop: number
  thBottom: number
  tableTop: number
  tableBottom: number
  /** The last body row's top: a stuck header leaves as this row arrives under it. */
  lastRowTop: number
  /** `ChatTable` marks the table while its header is stuck (shadow, glow, band). */
  headStuck: boolean
  thPosition: string
  /** The `th` (or its descendant) is what is hit 3px above the header's bottom edge. */
  thOnTop: boolean
  /** Computed border widths: the stuck header keeps its frame (the table draws none in sticky mode). */
  thBorderTop: number
  firstThBorderLeft: number
  scrolls: boolean
  overflow: string
  scrollWidth: number
  clientWidth: number
  sticky: boolean
  /** Viewport coordinates: the scroller's top, and the header row's horizontal extent. */
  viewportTop: number
  headLeft: number
  headRight: number
  /** The top bar's drag strip's bottom edge, relative to the scroller top (-1 when absent). */
  stripBottom: number
}

type Where = 'middle' | 'end-at-top' | 'none'

/**
 * Scroll the transcript (the table's nearest vertically scrolling ancestor) so
 * `where` holds for the table whose first header cell reads `firstHeader`,
 * then measure it. Repeated by `expect.poll` until the layout has settled, so
 * there is no sleep.
 */
async function scrollAndMeasure(cinna: CinnaApp, firstHeader: string, where: Where): Promise<Measure> {
  return cinna.page.evaluate(({ firstHeader, where }) => {
    const table = Array.from(document.querySelectorAll<HTMLTableElement>('[data-message-markdown] table'))
      .find((t) => t.querySelector('th')?.textContent?.trim() === firstHeader)
    if (!table) throw new Error(`no table headed ${firstHeader}`)
    let scroller: HTMLElement | null = table.parentElement
    while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement
    if (!scroller) throw new Error('no transcript scroller')
    const stickyTop = parseFloat(getComputedStyle(scroller).getPropertyValue('--sticky-table-top'))
    const rows = table.querySelectorAll('tbody tr')
    const mid = rows[Math.floor(rows.length / 2)] as HTMLElement
    const origin = (): number => scroller!.getBoundingClientRect().top
    if (where === 'middle') {
      scroller.scrollTop += mid.getBoundingClientRect().top - origin() - scroller.clientHeight / 2
    } else if (where === 'end-at-top') {
      // The last row's top 10px under the stuck place: inside where the header would sit.
      const last = rows[rows.length - 1] as HTMLElement
      scroller.scrollTop += last.getBoundingClientRect().top - origin() - stickyTop - 10
    }
    const ths = table.querySelectorAll('th')
    const th = ths[0] as HTMLElement
    const thBox = th.getBoundingClientRect()
    const tableBox = table.getBoundingClientRect()
    // Probed near the header's bottom: its top part lies under the top bar's
    // transparent drag strip (`.app-drag-strip`, z-30), which hit-testing finds first.
    const hit = document.elementFromPoint(thBox.left + thBox.width / 2, thBox.bottom - 3)
    const strip = document.querySelector('.app-drag-strip')?.getBoundingClientRect()
    const o = origin()
    return {
      stickyTop,
      thTop: thBox.top - o,
      thBottom: thBox.bottom - o,
      tableTop: tableBox.top - o,
      tableBottom: tableBox.bottom - o,
      lastRowTop: (rows[rows.length - 1] as HTMLElement).getBoundingClientRect().top - o,
      headStuck: table.hasAttribute('data-head-stuck'),
      thPosition: getComputedStyle(th).position,
      thOnTop: hit !== null && (hit === th || th.contains(hit)),
      thBorderTop: parseFloat(getComputedStyle(th).borderTopWidth),
      firstThBorderLeft: parseFloat(getComputedStyle(th).borderLeftWidth),
      scrolls: table.hasAttribute('data-table-scrolls'),
      overflow: getComputedStyle(table).overflowX,
      scrollWidth: table.scrollWidth,
      clientWidth: table.clientWidth,
      sticky: scroller.hasAttribute('data-sticky-tables'),
      viewportTop: o,
      headLeft: thBox.left,
      headRight: (ths[ths.length - 1] as HTMLElement).getBoundingClientRect().right,
      stripBottom: strip ? strip.bottom - o : -1
    }
  }, { firstHeader, where })
}

async function arrange(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(async ({ title, long, wide }) => {
    await window.api.settings.set('autoChatTitles', false)
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { title })
    await window.api.chat.showInList(chat.id)
    await window.api.chat.addMessage(chat.id, { role: 'user', content: 'Show me the list.' })
    await window.api.chat.addMessage(chat.id, { role: 'assistant', content: long })
    await window.api.chat.addMessage(chat.id, { role: 'user', content: 'And the wide one?' })
    await window.api.chat.addMessage(chat.id, { role: 'assistant', content: wide })
  }, { title: TITLE, long: LONG_REPLY, wide: WIDE_REPLY })
}

async function openChat(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByText(TITLE, { exact: true }).click()
  await expect(cinna.page.getByText('That is every item on the list.', { exact: true })).toBeAttached()
  await expect(cinna.page.getByRole('cell', { name: `item-${LONG_ROWS}`, exact: true })).toBeAttached()
}

async function openFeatures(cinna: CinnaApp): Promise<void> {
  const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  if (!user) throw new Error('no current profile')
  await cinna.page.getByTitle(user.displayName, { exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Features', exact: true }).click()
}

async function backToChat(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Back', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Chats', exact: true }).click()
  await openChat(cinna)
}

/** Footer `Interface` menu → `Switch to dark` / `Switch to light`. */
async function useTheme(cinna: CinnaApp, theme: 'light' | 'dark'): Promise<void> {
  const html = cinna.page.locator('html')
  if ((await html.getAttribute('data-theme')) === theme) return
  const trigger = cinna.page.getByRole('button', { name: 'Interface', exact: true })
  await trigger.click()
  await cinna.page.getByRole('button', { name: `Switch to ${theme}`, exact: true }).click()
  await expect(html).toHaveAttribute('data-theme', theme)
  // Escape does not close this menu; its trigger does.
  await trigger.click()
  await expect(cinna.page.getByRole('button', { name: /^Switch to (light|dark)$/ })).toHaveCount(0)
}

const stickySwitch = (cinna: CinnaApp) => cinna.page.getByRole('switch', { name: 'Sticky table headers', exact: true })

/**
 * Mid-table: the scroller's `--sticky-table-top` is `expected` (10 docked, 36
 * not), the header's top is there (±2px) and it is drawn over the rows.
 */
async function expectStuck(cinna: CinnaApp, expected = DOCKED_TOP): Promise<Measure> {
  await expect.poll(async () => {
    const m = await scrollAndMeasure(cinna, 'Item', 'middle')
    return m.sticky && m.thPosition === 'sticky' && m.tableTop < -200 && m.stickyTop === expected &&
      Math.abs(m.thTop - expected) <= 2 && m.thOnTop && m.headStuck
  }, { message: `long table header stuck ${expected}px under the transcript top` }).toBe(true)
  return scrollAndMeasure(cinna, 'Item', 'middle')
}

test('a long table keeps its header at the top of the transcript, slides it up with the last row, and the switch turns it off and on', async ({ cinna }, testInfo) => {
  await arrange(cinna)
  await openChat(cinna)

  await test.step('mid-table, sidebar docked: the header sticks 10px down and keeps its frame', async () => {
    for (const theme of ['light', 'dark'] as const) {
      await useTheme(cinna, theme)
      const m = await expectStuck(cinna)
      expect(m.scrolls).toBe(false)
      expect(m.overflow).toBe('visible')
      // The table draws no border in sticky mode; the cells carry the frame.
      expect(m.thBorderTop).toBeGreaterThan(0)
      expect(m.firstThBorderLeft).toBeGreaterThan(0)
      await cinna.page.screenshot({ path: testInfo.outputPath(`1-stuck-mid-table-${theme}.png`), animations: 'disabled' })
      await cinna.page.screenshot({
        path: testInfo.outputPath(`1-stuck-header-closeup-${theme}.png`),
        animations: 'disabled',
        clip: { x: Math.max(0, m.headLeft - 60), y: 0, width: m.headRight - m.headLeft + 120, height: m.viewportTop + m.thBottom + 60 }
      })
    }
    await useTheme(cinna, 'light')
  })

  await test.step('as the last row arrives, the header slides up with it and never covers it', async () => {
    await expect.poll(async () => {
      const m = await scrollAndMeasure(cinna, 'Item', 'end-at-top')
      return Math.abs(m.lastRowTop - (m.stickyTop + 10)) <= 1
    }).toBe(true)
    const m = await expect.poll(async () => {
      const r = await scrollAndMeasure(cinna, 'Item', 'none')
      return Math.abs(r.thBottom - r.lastRowTop) <= 1
    }, { message: 'header bottom rides the last row top' }).toBe(true).then(() => scrollAndMeasure(cinna, 'Item', 'none'))
    // The header has moved up past its stuck place, ahead of the table's end…
    expect(m.thTop).toBeLessThan(m.stickyTop - 0.5)
    expect(m.thBottom).toBeLessThan(m.tableBottom - 10)
    // …and is still drawn as stuck while it slides.
    expect(m.headStuck).toBe(true)
    await cinna.page.screenshot({ path: testInfo.outputPath('1b-released-at-end.png'), animations: 'disabled' })
  })

  await test.step('switched off in Settings, the header scrolls away', async () => {
    await openFeatures(cinna)
    await expect(stickySwitch(cinna)).toHaveAttribute('aria-checked', 'true')
    await stickySwitch(cinna).click()
    await expect(stickySwitch(cinna)).toHaveAttribute('aria-checked', 'false')
    expect(await cinna.page.evaluate(() => localStorage.getItem('cinna-sticky-table-headers'))).toBe('0')
    await backToChat(cinna)
    await expect.poll(async () => {
      const m = await scrollAndMeasure(cinna, 'Item', 'middle')
      return !m.sticky && m.thPosition === 'static' && m.thTop < 0 && m.overflow === 'auto'
    }, { message: 'long table header scrolled away' }).toBe(true)
  })

  await test.step('switched back on, it sticks again', async () => {
    await openFeatures(cinna)
    await stickySwitch(cinna).click()
    await expect(stickySwitch(cinna)).toHaveAttribute('aria-checked', 'true')
    expect(await cinna.page.evaluate(() => localStorage.getItem('cinna-sticky-table-headers'))).toBe('1')
    await backToChat(cinna)
    await expectStuck(cinna)
  })

  await test.step('sidebar On Hover: the header sticks under the top bar, 36px down', async () => {
    const page = cinna.page
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Sidebar docking', exact: true })
    const onHover = menu.getByRole('menuitemcheckbox', { name: 'Show sidebar on hover', exact: true })
    await onHover.click()
    await expect(onHover).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Dock sidebar', exact: true })).toBeVisible()
    const m = await expectStuck(cinna, UNDOCKED_TOP)
    expect(m.thBorderTop).toBeGreaterThan(0)
    expect(m.firstThBorderLeft).toBeGreaterThan(0)
    await page.screenshot({ path: testInfo.outputPath('1c-stuck-on-hover-light.png'), animations: 'disabled' })
  })
})

test('a table too wide for the bubble keeps its sideways scroll and its header scrolls away', async ({ cinna }, testInfo) => {
  await arrange(cinna)
  await openChat(cinna)
  await expect(cinna.page.getByRole('cell', { name: TOKEN, exact: true })).toBeAttached()

  await expect.poll(async () => {
    const m = await scrollAndMeasure(cinna, 'Key', 'middle')
    return m.sticky && m.scrolls && m.tableTop < -200
  }, { message: 'wide table marked data-table-scrolls and scrolled past its top' }).toBe(true)
  const m = await scrollAndMeasure(cinna, 'Key', 'middle')
  expect(m.overflow).toBe('auto')
  expect(m.scrollWidth).toBeGreaterThan(m.clientWidth)
  expect(m.thPosition).toBe('static')
  expect(m.thTop).toBeLessThan(0)
  await cinna.page.screenshot({ path: testInfo.outputPath('3-wide-table-scrolls.png'), animations: 'disabled' })

  // The long table in the same transcript still sticks: the mark is per table.
  await expectStuck(cinna)
})
