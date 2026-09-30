import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine, type FakeAcpEngine } from '../fixtures/fakeAcpEngine'

/**
 * Paste an image into the chat composer, preview it, and send it.
 *
 * **The host clipboard is never read or written.** Main's `clipboard.read` and
 * `clipboard.readImage` are replaced inside the sandboxed app, so
 * `files:paste-from-clipboard` sees an image and no file references whatever
 * the developer has copied. The paste itself is a synthetic `paste` event on
 * the composer whose `clipboardData` carries the same types a screenshot paste
 * does (`Files`, no `text/plain`) — a real ⌘V would make Chromium read the
 * machine's clipboard.
 *
 * The text paste is the same synthetic event with `text/plain` only. What it
 * proves is that the composer lets the paste through (the event is not
 * prevented) and attaches nothing; the text is then inserted the way the
 * browser's default action inserts it, since a synthetic event has none.
 *
 * The chat is a plain LLM chat on a keyless Ollama credential (the new-chat
 * screen accepts files as soon as a provider exists), answered by the scripted
 * ACP runtime — no model API and no key.
 */

const MODEL = 'qwen3:8b'
const PROMPT = 'What is in this picture?'
const REPLY = 'A small red square.'
const PASTED_TEXT = 'plain words from the clipboard'
const PASTED_NAME = /^Pasted image \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.png$/

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
    // A runtime that advertises image prompts, so the paste reaches it as an image block.
    initialize: {
      response: { agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true, image: true } } }
    },
    prompt: {
      emit: [
        { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } } }
      ],
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
  await stubClipboardImage(cinna)
  return fake
}

/**
 * Main's clipboard answers with a 40×30 red image and no file references. In
 * the app process only, so it is re-installed after any relaunch.
 */
async function stubClipboardImage(cinna: CinnaApp): Promise<void> {
  await cinna.electronApp.evaluate(({ clipboard, nativeImage }) => {
    const width = 40
    const height = 30
    const bgra = Buffer.alloc(width * height * 4)
    for (let i = 0; i < bgra.length; i += 4) {
      bgra[i] = 0x20
      bgra[i + 1] = 0x20
      bgra[i + 2] = 0xe0
      bgra[i + 3] = 0xff
    }
    const image = nativeImage.createFromBitmap(bgra, { width, height })
    const g = globalThis as typeof globalThis & { __cinnaClipboardReads?: number }
    g.__cinnaClipboardReads = 0
    clipboard.read = () => ''
    clipboard.readBuffer = () => Buffer.alloc(0)
    clipboard.readImage = () => {
      g.__cinnaClipboardReads = (g.__cinnaClipboardReads ?? 0) + 1
      return image
    }
  })
}

async function clipboardImageReads(cinna: CinnaApp): Promise<number> {
  return cinna.electronApp.evaluate(
    () => (globalThis as typeof globalThis & { __cinnaClipboardReads?: number }).__cinnaClipboardReads ?? 0
  )
}

/**
 * A paste event on the focused composer, carrying `kind`'s clipboard types.
 * Answers whether the composer prevented the browser's default action.
 */
async function dispatchPaste(page: Page, kind: 'image' | 'text'): Promise<boolean> {
  return page.evaluate(
    ({ kind, text }) => {
      const target = document.activeElement
      if (!(target instanceof HTMLTextAreaElement)) throw new Error('the composer is not focused')
      const data = new DataTransfer()
      if (kind === 'image') {
        data.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', { type: 'image/png' }))
      } else {
        data.setData('text/plain', text)
      }
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      return event.defaultPrevented
    },
    { kind, text: PASTED_TEXT }
  )
}

/** The preview's card: no dialog role, so it is the focusable box that holds Close. */
function previewCard(page: Page): Locator {
  return page.locator('div[tabindex="-1"]').filter({ has: page.getByRole('button', { name: 'Close preview', exact: true }) })
}

function pastedFiles(cinna: CinnaApp): string[] {
  try {
    return readdirSync(join(cinna.sandbox.userData, 'tmp', 'pasted'))
  } catch {
    return []
  }
}

test('a pasted image becomes a composer thumbnail that previews, text pastes as text, and the sent image previews with Download', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  const fake = await arrange(cinna)
  const page = cinna.page
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  // The [+] button is the composer's own signal that it takes files here.
  await expect(page.getByRole('button', { name: 'Add to chat' })).toBeVisible()

  let filename = ''

  await test.step('⌘V with an image on the clipboard attaches a 64×64 thumbnail named "Pasted image …"', async () => {
    await input.focus()
    expect(await dispatchPaste(page, 'image')).toBe(true)
    await expect.poll(() => pastedFiles(cinna).length).toBe(1)
    filename = pastedFiles(cinna)[0]
    expect(filename).toMatch(PASTED_NAME)
    expect(await clipboardImageReads(cinna)).toBe(1)

    const remove = page.getByRole('button', { name: `Remove ${filename}`, exact: true })
    const thumb = page.getByRole('button', { name: `Preview ${filename}`, exact: true })
    await expect(remove).toBeVisible()
    await expect(thumb).toBeVisible()
    await expect(thumb.locator('img')).toBeVisible()
    const box = await thumb.boundingBox()
    expect(box && { width: Math.round(box.width), height: Math.round(box.height) }).toEqual({ width: 64, height: 64 })
    await expect(input).toHaveValue('')
  })

  await test.step('the thumbnail opens the preview: the image, and no Download', async () => {
    await page.getByRole('button', { name: `Preview ${filename}`, exact: true }).click()
    const card = previewCard(page)
    await expect(card.getByRole('img', { name: filename, exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: `Download ${filename}`, exact: true })).toHaveCount(0)
    await card.getByRole('button', { name: 'Close preview', exact: true }).click()
    await expect(previewCard(page)).toHaveCount(0)
  })

  await test.step('a text paste is let through and attaches nothing', async () => {
    await input.focus()
    const prevented = await dispatchPaste(page, 'text')
    expect(prevented).toBe(false)
    // The browser's default action for the paste the composer let through.
    await page.evaluate((text) => document.execCommand('insertText', false, text), PASTED_TEXT)
    await expect(input).toHaveValue(PASTED_TEXT)
    await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(1)
    expect(pastedFiles(cinna)).toEqual([filename])
    expect(await clipboardImageReads(cinna)).toBe(1)
  })

  await test.step('sent, the image shows under the user bubble and previews with Download', async () => {
    await input.fill(PROMPT)
    await input.press('Enter')
    await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 30_000 })
    expect(fake.received('session/prompt')).toHaveLength(1)
    // The runtime got the pasted bytes as a native image block, not a note.
    const blocks = fake.received('session/prompt')[0].params?.prompt as { type: string; mimeType?: string; data?: string }[]
    const images = blocks.filter((b) => b.type === 'image')
    expect(images.map((b) => b.mimeType)).toEqual(['image/png'])
    expect(Buffer.from(images[0].data ?? '', 'base64').subarray(1, 4).toString('latin1')).toBe('PNG')
    await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0)

    const sent = page.getByRole('button', { name: `Preview ${filename}`, exact: true })
    await expect(sent).toBeVisible()
    await expect(sent.locator('img')).toBeVisible()
    const box = await sent.boundingBox()
    expect(box && { width: Math.round(box.width), height: Math.round(box.height) }).toEqual({ width: 64, height: 64 })

    await sent.click()
    const card = previewCard(page)
    await expect(card.getByRole('img', { name: filename, exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: `Download ${filename}`, exact: true })).toBeVisible()
    await card.getByRole('button', { name: 'Close preview', exact: true }).click()
    await expect(previewCard(page)).toHaveCount(0)
  })
})
