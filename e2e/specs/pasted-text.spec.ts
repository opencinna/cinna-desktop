import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Locator, Page } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine, type FakeAcpEngine } from '../fixtures/fakeAcpEngine'

/**
 * Long plain-text pastes become composer chips and sent paste cards; long user
 * bubbles clamp with Show more / Show less.
 *
 * The paste is a synthetic `paste` event on the composer whose `clipboardData`
 * carries `text/plain` only — the host clipboard is never read. The chat is a
 * plain LLM chat on a keyless Ollama credential, answered by the scripted ACP
 * runtime, so what the runtime received is read straight off the fake.
 */

const MODEL = 'qwen3:8b'
const REPLY = 'Noted.'

const EMAIL_LINES = [
  'Subject: Quarterly planning offsite',
  '',
  'Hi team,',
  '',
  ...Array.from({ length: 18 }, (_, i) => `Agenda item ${i + 1}: discuss the roadmap section ${i + 1} in detail.`),
  '',
  'Best, Dana'
]
const EMAIL = EMAIL_LINES.join('\n')
const EMAIL_LABEL = 'Subject: Quarterly planning offsite'
const INSTRUCTION = 'reply politely, decline the meeting'

const LONG_TYPED = Array.from({ length: 40 }, (_, i) => `typed line ${i + 1} of the long message`).join('\n')
const SHORT_TYPED = 'first short line\nsecond short line\nthird short line'

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

async function arrange(cinna: CinnaApp): Promise<FakeAcpEngine> {
  await cinna.skipOnboarding()
  const fake = await installFakeAcpEngine(cinna, {
    prompt: {
      emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } } }],
      response: { stopReason: 'end_turn' }
    }
  })
  await cinna.page.evaluate(
    async ({ host, modelId }) => {
      await window.api.settings.set('autoChatTitles', false)
      const { id } = await window.api.providers.upsert({ type: 'ollama', name: 'Ollama', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({
        name: 'Default',
        providerId: id,
        modelId,
        engine: 'opencode',
        toolPolicy: 'none',
        isDefault: true
      })
    },
    { host, modelId: MODEL }
  )
  // Credentials and modes seeded over IPC are stale in the renderer until a restart.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  return fake
}

function composer(page: Page): Locator {
  return page.getByRole('combobox', { name: 'Type a message...', exact: true })
}

/** A `text/plain`-only paste on the focused composer. Answers whether the composer prevented the default. */
async function dispatchTextPaste(page: Page, text: string): Promise<boolean> {
  return page.evaluate((text) => {
    const target = document.activeElement
    if (!(target instanceof HTMLTextAreaElement)) throw new Error('the composer is not focused')
    const data = new DataTransfer()
    data.setData('text/plain', text)
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event.defaultPrevented
  }, text)
}

/** The user bubble (the rounded pill) whose content holds `text`. */
function userBubble(page: Page, text: string): Locator {
  // `[data-message-markdown]` is the content div; its parent is the clamp box, and that box's parent the bubble.
  return page.locator('[data-message-markdown]').filter({ hasText: text }).locator('xpath=../..')
}

async function sendTyped(page: Page, text: string): Promise<void> {
  const input = composer(page)
  await input.fill(text)
  await input.press('Enter')
  await expect(page.getByText(REPLY, { exact: true }).last()).toBeVisible({ timeout: 30_000 })
}

/** How far the bubble's scroll container is from its bottom, in px. */
async function distanceFromBottom(bubble: Locator): Promise<number> {
  return bubble.evaluate((el) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const overflowY = getComputedStyle(node).overflowY
      if (overflowY === 'auto' || overflowY === 'scroll') return node.scrollHeight - node.scrollTop - node.clientHeight
    }
    throw new Error('no scroll container')
  })
}

async function scrollTopOf(bubble: Locator): Promise<number> {
  return bubble.evaluate((el) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const overflowY = getComputedStyle(node).overflowY
      if (overflowY === 'auto' || overflowY === 'scroll') return node.scrollTop
    }
    throw new Error('no scroll container')
  })
}

test('a long paste becomes a chip, is sent before the typed text, and shows as a card that previews the raw text', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await arrange(cinna)
  const page = cinna.page
  const input = composer(page)
  await expect(input).toBeVisible()

  await test.step('pasting a 24-line email makes a chip and leaves the textarea empty', async () => {
    await input.focus()
    expect(await dispatchTextPaste(page, EMAIL)).toBe(true)
    const chip = page.getByTestId('paste-badge')
    await expect(chip).toHaveCount(1)
    await expect(chip).toHaveAccessibleName(`Preview pasted text ${EMAIL_LABEL}`)
    await expect(chip).toHaveText(`${EMAIL_LABEL}· ${EMAIL_LINES.length} lines`)
    await expect(input).toHaveValue('')
  })

  await test.step('sent with an instruction, the runtime gets the block before the typed text', async () => {
    await input.fill(INSTRUCTION)
    await input.press('Enter')
    await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('paste-badge')).toHaveCount(0)
    const expected = `<pasted_text lines="${EMAIL_LINES.length}">\n${EMAIL}\n</pasted_text>\n\n${INSTRUCTION}`
    const prompts = fake.received('session/prompt')
    expect(prompts).toHaveLength(1)
    const blocks = prompts[0].params?.prompt as { type: string; text?: string }[]
    const sentText = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
    expect(sentText).toContain(expected)
    const stored = await page.evaluate(async () => {
      const [chat] = await window.api.chat.list()
      const detail = chat && (await window.api.chat.get(chat.id))
      return (detail?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content)
    })
    expect(stored).toEqual([expected])
  })

  await test.step('the user bubble shows a paste card above the typed text, and no raw tag', async () => {
    const card = page.getByTestId('paste-card')
    await expect(card).toHaveCount(1)
    await expect(card).toHaveAccessibleName(`Open pasted text ${EMAIL_LABEL}`)
    await expect(card).toHaveText(`${EMAIL_LABEL}· ${EMAIL_LINES.length} lines`)
    const bubble = userBubble(page, INSTRUCTION)
    await expect(bubble).toHaveCount(1)
    await expect(bubble).not.toContainText('pasted_text')
    await expect(bubble).not.toContainText('Agenda item 1:')
    await expect(page.getByText('<pasted_text', { exact: false })).toHaveCount(0)
    const typed = bubble.getByText(INSTRUCTION, { exact: true })
    await expect(typed).toBeVisible()
    const cardBox = await card.boundingBox()
    const typedBox = await typed.boundingBox()
    expect(cardBox && typedBox && cardBox.y + cardBox.height <= typedBox.y).toBe(true)
    // A card and one line of text is short: no clamp.
    await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0)
  })

  await test.step('the card opens the preview with the raw text and Copy', async () => {
    await page.getByTestId('paste-card').click()
    const dialog = page.getByRole('dialog', { name: 'Pasted text', exact: true })
    await expect(dialog).toBeVisible()
    expect(await dialog.locator('pre').evaluate((el) => el.textContent)).toBe(EMAIL)
    await expect(dialog.getByRole('button', { name: 'Copy', exact: true })).toBeVisible()
    // The sent card is read-only: no composer actions.
    await expect(dialog.getByRole('button', { name: 'Insert as text', exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close pasted text preview', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })
})

test('a long typed message clamps, Show more grows it downward from a pinned transcript, Show less clamps it back on screen', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  const page = cinna.page
  await expect(composer(page)).toBeVisible()
  // Earlier turns, so the transcript scrolls and the long bubble lands at the pinned bottom, not the top.
  for (const n of [1, 2, 3]) {
    await sendTyped(page, Array.from({ length: 8 }, (_, i) => `filler ${n} line ${i + 1}`).join('\n'))
  }
  await sendTyped(page, LONG_TYPED)

  const bubble = userBubble(page, 'typed line 1 of the long message')
  const box = page.locator('[data-message-markdown]').filter({ hasText: 'typed line 1 of' }).locator('xpath=..')
  const toggle = bubble.getByRole('button', { name: /^Show (more|less)$/ })

  await test.step('the bubble is clamped to 300 px with a collapsed Show more', async () => {
    await expect(toggle).toHaveText('Show more')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(box).toHaveCSS('max-height', '300px')
    await expect(page.getByText('typed line 40 of the long message', { exact: true })).not.toBeInViewport()
  })

  let topBefore = 0
  await test.step('Show more from the pinned bottom keeps the bubble top where it was', async () => {
    await expect.poll(() => distanceFromBottom(bubble)).toBeLessThanOrEqual(2)
    // The transcript really is scrolled: following the growth would move the top.
    expect(await scrollTopOf(bubble)).toBeGreaterThan(100)
    await expect(bubble).toBeInViewport()
    topBefore = (await bubble.boundingBox())!.y
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveText('Show less')
    // The transition is over once the limit is dropped.
    await expect(box).toHaveCSS('max-height', 'none')
    const after = (await bubble.boundingBox())!
    expect(after.height).toBeGreaterThan(380)
    expect(Math.abs(after.y - topBefore)).toBeLessThanOrEqual(4)
  })

  await test.step('Show less clamps it again with the toggle in the viewport', async () => {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toHaveText('Show more')
    await expect(box).toHaveCSS('max-height', '300px')
    await expect(toggle).toBeInViewport()
  })
})

test('a short typed message has no Show more', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  const page = cinna.page
  await expect(composer(page)).toBeVisible()
  await sendTyped(page, SHORT_TYPED)
  const bubble = userBubble(page, 'first short line')
  await expect(bubble).toBeVisible()
  await expect(bubble).toContainText('third short line')
  await expect(page.getByRole('button', { name: /^Show (more|less)$/ })).toHaveCount(0)
})
