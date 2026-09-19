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
 * The Contents panel of a long markdown file preview.
 *
 * ## What is real and what is not
 *
 * The agent is the scriptable fake ACP agent (`fakeAcpEngine`), answering one
 * turn that names three markdown files in inline code. The files are real, in
 * the agent's folder; everything from the file link on is the product: the
 * resolve, the read, `markdownToc`, the modal's geometry and the panel. The
 * window width is set with `page.setViewportSize` (see the guide: `setBounds`
 * does not resize the renderer under the background window).
 *
 * ## What it proves
 *
 * - A long spec (one H1, several H2 and H3, a heading text used twice, a `#`
 *   comment in a code fence) offers Contents; the panel lists the H2–H3s in
 *   order, without the lone H1 and without the fenced comment, and opens by
 *   default.
 * - At 1600px the panel sits beside the body: the card widens by the panel's
 *   240px and the body's left edge and width are the same with the panel open
 *   and closed.
 * - Clicking the second of two same-named H3 entries scrolls the body (and
 *   only the body) until that heading, not its twin, is at the top, and marks
 *   that entry `aria-current="location"`.
 * - Wheel scrolling the body by hand moves `aria-current` to the section now
 *   at the top.
 * - Closing the panel carries to the next long preview; at 1000px an open
 *   panel lies over the body and the card keeps its closed width.
 * - A short markdown file (one H1, one H2) has no Contents button.
 *
 * ## What it does not
 *
 * - The width and scroll animations themselves; all geometry is read once
 *   settled, from layout (`offsetLeft` / `offsetWidth`), which the entrance
 *   transform does not affect.
 * - The hover tooltip for cut-off entries, the slow-load overlay fallback and
 *   reduced motion (unit-tested in `FilePreviewModal.test.tsx`).
 * - Persistence across a restart (localStorage; not exercised here).
 */

const AGENT = 'Spec Writer'
const MODEL = 'qwen3:8b'
const PROMPT = 'Where did you write the spec?'

const LONG = 'docs/payments-spec.md'
const LONG_2 = 'docs/rollout-plan.md'
const SHORT = 'docs/notes.md'

const REPLY = [
  `The spec is in \`${LONG}\`, the plan in \`${LONG_2}\`.`,
  '',
  `Loose notes are in \`${SHORT}\`.`
].join('\n')

const ANSWERS_WITH_FILES: FakeAcpScript = {
  newSession: { sessionId: 'ses_e2e_preview_contents' },
  prompt: {
    emit: [
      {
        kind: 'update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } }
      }
    ]
  }
}

/** Enough prose that every section is several hundred pixels tall. */
function prose(topic: string, count = 8): string {
  const paras: string[] = []
  for (let i = 1; i <= count; i++) {
    paras.push(
      `${topic} paragraph ${i}. The service keeps the ledger consistent across retries, records every ` +
        'state change with the operator who caused it, and never charges a card twice for one order, ' +
        'even when the upstream acquirer times out and answers late.'
    )
  }
  return paras.join('\n\n')
}

const FENCED_COMMENT = '# not a heading: install the dependencies'

const LONG_SPEC = [
  '# Payments service spec',
  '',
  prose('Intro', 2),
  '',
  '## Overview',
  '',
  prose('Overview'),
  '',
  '### Goals',
  '',
  prose('Goals'),
  '',
  '### Edge cases',
  '',
  prose('Overview edge cases'),
  '',
  '## Data model',
  '',
  prose('Data model', 3),
  '',
  '```bash',
  FENCED_COMMENT,
  'npm ci',
  '```',
  '',
  '### Tables',
  '',
  prose('Tables'),
  '',
  '### Edge cases',
  '',
  prose('Data model edge cases'),
  '',
  '## Rollout',
  '',
  '### Phases',
  '',
  prose('Phases'),
  '',
  '## Open questions',
  '',
  prose('Open questions', 12),
  ''
].join('\n')

const LONG_SPEC_ENTRIES = [
  'Overview',
  'Goals',
  'Edge cases',
  'Data model',
  'Tables',
  'Edge cases',
  'Rollout',
  'Phases',
  'Open questions'
]

const LONG_PLAN = [
  '# Rollout plan',
  '',
  '## Week one',
  '',
  prose('Week one', 4),
  '',
  '## Week two',
  '',
  prose('Week two', 4),
  ''
].join('\n')

const SHORT_NOTES = ['# Notes', '', '## Loose ends', '', 'Ask finance about the refund window.', ''].join('\n')

/** The Contents panel's width, in px (`CONTENTS_PANEL_WIDTH`). */
const PANEL_WIDTH = 240

/**
 * The card's closed width: `max-w-3xl` (48rem) or the window less the
 * overlay's `px-4`, whichever is less. In rem because the app's root font
 * size is not 16px.
 */
function closedCardWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
    return Math.min(48 * rem, window.innerWidth - 2 * rem)
  })
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

/** A folder agent on the fake engine holding the three files, and its reply on screen. */
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
  writeFileSync(join(agent.path, LONG), LONG_SPEC)
  writeFileSync(join(agent.path, LONG_2), LONG_PLAN)
  writeFileSync(join(agent.path, SHORT), SHORT_NOTES)

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

/** The scrolling body: the card's `overflow-auto` div that holds the rendered headings. */
function previewBody(page: Page, card: Locator): Locator {
  return card.locator('div.overflow-auto').filter({ has: page.getByRole('heading') })
}

interface Box {
  left: number
  width: number
}

/**
 * Layout position and width, summed up the offsetParent chain: unaffected by
 * the entrance's `scale()` transform, so it reads where the box really is.
 */
function layoutBox(locator: Locator): Promise<Box> {
  return locator.evaluate((el) => {
    let left = 0
    for (let node: HTMLElement | null = el as HTMLElement; node; node = node.offsetParent as HTMLElement | null) {
      left += node.offsetLeft
    }
    return { left, width: (el as HTMLElement).offsetWidth }
  })
}

/** Where `heading` sits below the top of the scrolling `body`, in px. */
async function offsetFromBodyTop(body: Locator, heading: Locator): Promise<number> {
  const [headingBox, bodyBox] = await Promise.all([heading.boundingBox(), body.boundingBox()])
  if (!headingBox || !bodyBox) throw new Error('heading or preview body has no box')
  return Math.round(headingBox.y - bodyBox.y)
}

test('a long markdown preview offers Contents beside the body, navigates by heading, and remembers the choice', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  const page = cinna.page
  await page.setViewportSize({ width: 1600, height: 1000 })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1600)
  let CLOSED_WIDTH = await closedCardWidth(page)

  const card = previewCard(page)
  const contents = card.getByRole('button', { name: 'Contents', exact: true })
  const panel = card.getByRole('navigation', { name: 'Contents', exact: true })
  const entries = panel.getByRole('button')
  const body = previewBody(page, card)

  await test.step('a long spec opens with its Contents panel listing H2 and H3, not the title or the fenced comment', async () => {
    await fileLink(page, LONG).click()
    await expect(card.getByRole('heading', { name: 'Payments service spec', level: 1 })).toBeVisible()
    await expect(contents).toHaveAttribute('aria-expanded', 'true')
    await expect(panel).toBeVisible()
    await expect(entries).toHaveText(LONG_SPEC_ENTRIES)
    // The fenced comment is rendered as code, and is not an entry.
    await expect(card.getByText(FENCED_COMMENT)).toBeVisible()
    await expect(entries.filter({ hasText: 'not a heading' })).toHaveCount(0)
    await expect(entries.first()).toHaveAttribute('aria-current', 'location')
  })

  await test.step('at 1600px the panel sits beside the body; toggling it moves neither the body nor its width', async () => {
    await expect.poll(async () => (await layoutBox(card)).width).toBe(CLOSED_WIDTH + PANEL_WIDTH)
    const openBody = await layoutBox(body)
    const panelBox = await layoutBox(panel)
    expect(panelBox.width).toBe(PANEL_WIDTH)
    // Beside, not over: the panel starts where the body ends.
    expect(panelBox.left).toBeGreaterThanOrEqual(openBody.left + openBody.width)

    await contents.click()
    await expect(contents).toHaveAttribute('aria-expanded', 'false')
    await expect(panel).toHaveCount(0)
    await expect.poll(async () => (await layoutBox(card)).width).toBe(CLOSED_WIDTH)
    expect(await layoutBox(body)).toEqual(openBody)

    await contents.click()
    await expect(contents).toHaveAttribute('aria-expanded', 'true')
    await expect(panel).toBeVisible()
    await expect.poll(async () => (await layoutBox(card)).width).toBe(CLOSED_WIDTH + PANEL_WIDTH)
    expect(await layoutBox(body)).toEqual(openBody)
    // The card stays inside the window.
    const cardBox = await layoutBox(card)
    expect(cardBox.left + cardBox.width).toBeLessThanOrEqual(1600)
  })

  await test.step('clicking the second “Edge cases” scrolls the body to that heading and marks the entry current', async () => {
    const edgeEntries = panel.getByRole('button', { name: 'Edge cases', exact: true })
    const edgeHeadings = body.getByRole('heading', { name: 'Edge cases', level: 3, exact: true })
    await expect(edgeEntries).toHaveCount(2)
    await expect(edgeHeadings).toHaveCount(2)

    await edgeEntries.nth(1).click()
    await expect
      .poll(() => offsetFromBodyTop(body, edgeHeadings.nth(1)))
      .toBeGreaterThanOrEqual(0)
    await expect.poll(() => offsetFromBodyTop(body, edgeHeadings.nth(1))).toBeLessThanOrEqual(24)
    // The twin is far above, so it was the second heading the click went to.
    expect(await offsetFromBodyTop(body, edgeHeadings.nth(0))).toBeLessThan(-200)
    await expect(edgeEntries.nth(1)).toHaveAttribute('aria-current', 'location')
    await expect(edgeEntries.nth(0)).not.toHaveAttribute('aria-current')
    await expect(panel.locator('[aria-current]')).toHaveCount(1)
    // Only the body scrolled: the page itself did not.
    expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0])
  })

  await test.step('scrolling the body by hand moves the current entry with it', async () => {
    const bodyBox = await body.boundingBox()
    if (!bodyBox) throw new Error('preview body has no box')
    await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2)

    await page.mouse.wheel(0, -100_000)
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(0)
    await expect(panel.getByRole('button', { name: 'Overview', exact: true })).toHaveAttribute('aria-current', 'location')
    await expect(panel.locator('[aria-current]')).toHaveCount(1)

    // Bring "Tables" 100px above the body's top edge: its section is current.
    const tables = body.getByRole('heading', { name: 'Tables', level: 3, exact: true })
    const down = (await offsetFromBodyTop(body, tables)) + 100
    await page.mouse.wheel(0, down)
    await expect.poll(() => offsetFromBodyTop(body, tables)).toBeLessThan(-50)
    await expect(panel.getByRole('button', { name: 'Tables', exact: true })).toHaveAttribute('aria-current', 'location')
    await expect(panel.locator('[aria-current]')).toHaveCount(1)
  })

  await test.step('a closed panel stays closed on the next long preview', async () => {
    await contents.click()
    await expect(contents).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)

    await fileLink(page, LONG_2).click()
    await expect(card.getByRole('heading', { name: 'Rollout plan', level: 1 })).toBeVisible()
    await expect(contents).toHaveAttribute('aria-expanded', 'false')
    await expect(panel).toHaveCount(0)
    await expect.poll(async () => (await layoutBox(card)).width).toBe(CLOSED_WIDTH)

    await contents.click()
    await expect(entries).toHaveText(['Week one', 'Week two'])
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
  })

  await test.step('at 1000px the open panel lies over the body and the card keeps its width', async () => {
    await page.setViewportSize({ width: 1000, height: 1000 })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1000)
    CLOSED_WIDTH = await closedCardWidth(page)

    await fileLink(page, LONG).click()
    await expect(card.getByRole('heading', { name: 'Payments service spec', level: 1 })).toBeVisible()
    await expect(contents).toHaveAttribute('aria-expanded', 'true')
    await expect(panel).toBeVisible()
    await expect(entries).toHaveText(LONG_SPEC_ENTRIES)
    await expect.poll(async () => (await layoutBox(card)).width).toBe(CLOSED_WIDTH)

    const bodyBox = await layoutBox(body)
    const panelBox = await layoutBox(panel)
    // Over the body's right side, inside the card.
    expect(panelBox.left).toBeLessThan(bodyBox.left + bodyBox.width)
    expect(panelBox.left + panelBox.width).toBeLessThanOrEqual(bodyBox.left + bodyBox.width + 2)

    await contents.click()
    await expect(panel).toHaveCount(0)
    expect((await layoutBox(card)).width).toBe(CLOSED_WIDTH)
    expect(await layoutBox(body)).toEqual(bodyBox)
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
  })

  await test.step('a short markdown file has no Contents button', async () => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await fileLink(page, SHORT).click()
    await expect(card.getByRole('heading', { name: 'Loose ends', level: 2 })).toBeVisible()
    await expect(card.getByText('Ask finance about the refund window.', { exact: true })).toBeVisible()
    await expect(contents).toHaveCount(0)
    await expect(panel).toHaveCount(0)
  })
})
