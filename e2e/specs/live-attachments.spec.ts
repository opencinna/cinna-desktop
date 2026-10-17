import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine, type FakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { LIVE_ENGINE, liveEngineOptions, requireLiveEngine, requireOpenCode, seedLiveModel, useLiveRuntime } from '../fixtures/liveEngine'

/**
 * **A PDF the user attaches reaches a local agent as a file it can read.**
 *
 * `buildAcpPrompt` (`src/main/services/acpAttachments.ts`) copies every
 * attachment into `<session folder>/app-data/uploads/<sanitized name>` and
 * opens the prompt with `Uploaded files:\n- <absolute path>\n---\n\n<text>`,
 * cinna-core's convention. Before it, a PDF went as an embedded `resource`
 * with a base64 `blob`: the Claude adapter dropped it and the Codex adapter
 * pasted the base64 into the prompt, so no model ever saw the document.
 *
 * Both tests attach through the composer's real flow — `Add to chat` →
 * `Attach files` → the OS picker (stubbed in main to answer one path) — on a
 * kit folder agent's page, and send with Enter. The PDF is hand-written here
 * (one page, Helvetica, an uncompressed content stream) and holds an invoice
 * number and an amount that appear in no prompt.
 *
 * 1. **Model-free** (runs in every `make e2e`): the agent is the scripted fake
 *    ACP engine. Witnesses: the copy in `app-data/uploads/` with the same
 *    bytes, and the `session/prompt` the engine received — one text block
 *    that opens `Uploaded files:\n- <that path>\n---\n\n` and ends with the
 *    prompt (the driver's `Cinna task context` preamble sits between), with
 *    no `resource` block and no base64 anywhere.
 * 2. **@live, per engine** (`CINNA_E2E_LIVE_ENGINE=opencode|claude|codex|antigravity`,
 *    `e2e/fixtures/liveEngine.ts`): a real agent turn. Witnesses: the reply
 *    holds the invoice number and the amount; a tool call or its result names
 *    the uploaded file; the copy has the same bytes; and after the test the
 *    fixture proves from the main log that the turn ran on that engine.
 *
 * 3. **@live, per engine: files sent while a turn runs.** The first turn is
 *    held open by a shell `sleep 20`; meanwhile a text file (a code) and a
 *    PNG (a number drawn on a canvas) are attached through the same menu and
 *    sent with a question. Witnesses: `Attach files` is enabled mid-turn, the
 *    message shows as a `Queued` bubble with both file badges and main's
 *    queue holds it with both files (a message with files is never steered);
 *    after the first turn it is saved as its own user row with both files, and
 *    the reply that follows it holds the code and the number, which no prompt
 *    contains. The scripted twin is `pending-messages.spec.ts` test 6.
 *
 * ## Cost
 *
 * One short turn (2–4 requests); the queued-files test two (a sleep, then the question). OpenCode bills the `.env` OpenAI key
 * (gpt-5.6-luna, about a cent); Claude, Codex and Antigravity spend the
 * developer's own subscription. Run one engine at a time:
 * `make e2e-one SPEC=e2e/specs/live-attachments.spec.ts LIVE_ENGINE=<engine>`.
 *
 * ## What it does not prove
 *
 * Images (also sent natively when the engine takes them — `composer-paste.spec.ts`
 * covers the native block), a replayed transcript after a session restart,
 * the `_1` suffix for a different file under the same name (unit-tested in
 * `acpAttachments.test.ts`), or a chat routed to a remote agent.
 */

const AGENT = 'Invoice Clerk'
/** Spaces on purpose: the copy is named by cinna-core's `sanitize_filename`. */
const PDF_NAME = 'Invoice March 2026.pdf'
const UPLOAD_NAME = 'Invoice_March_2026.pdf'

/** One page, two lines of Helvetica, an uncompressed stream; byte offsets in the xref are exact. */
function invoicePdf(lines: readonly string[]): Buffer {
  const text = lines.map((line, i) => `${i === 0 ? '' : '0 -28 Td '}(${line.replace(/[()\\]/g, '\\$&')}) Tj`).join('\n')
  const content = `BT\n/F1 18 Tf\n72 720 Td\n${text}\nET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  ]
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** A fresh invoice per run, so no answer can come from anywhere but this file. */
function makeInvoice(): { number: string; amount: string; bytes: Buffer } {
  const code = randomBytes(2).toString('hex').toUpperCase()
  const number = `INV-${code}-ZEBRA`
  const amount = `${1000 + Math.floor(Math.random() * 8999)}.${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`
  return { number, amount, bytes: invoicePdf(['ACME Supplies - Invoice', `Invoice number: ${number}`, `Amount due: EUR ${amount}`]) }
}

/** `pdftotext` when this machine has it: the hand-written PDF must read back as text, not only parse. */
function checkReadable(path: string, invoice: { number: string; amount: string }): void {
  const out = spawnSync('pdftotext', [path, '-'], { encoding: 'utf8' })
  if (out.error) {
    test.info().annotations.push({ type: 'pdf check', description: 'pdftotext is not installed; the PDF was not read back' })
    return
  }
  expect(out.status, `pdftotext reads the PDF: ${out.stderr}`).toBe(0)
  expect(out.stdout).toContain(`Invoice number: ${invoice.number}`)
  expect(out.stdout).toContain(`Amount due: EUR ${invoice.amount}`)
}

/** Make the next OS file picker answer `path`. Main-process only, so after any relaunch. */
async function stubFilePicker(cinna: CinnaApp, path: string): Promise<void> {
  await cinna.electronApp.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, path)
}

/**
 * Attach through `Add to chat` → `Attach files`, type, Enter: on the agent
 * page's composer, or with `agent` null on the new-chat screen a launch opens
 * on (a plain chat, answered by its chat runtime).
 */
async function attachAndSend(cinna: CinnaApp, prompt: string, agent: string | null = AGENT): Promise<void> {
  const page = cinna.page
  if (agent !== null) {
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: agent, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(agent)
  }
  await page.getByRole('button', { name: 'Add to chat', exact: true }).click()
  await page.getByRole('menu', { name: 'Add to chat' }).getByRole('menuitem', { name: 'Attach files' }).click()
  await expect(page.getByRole('button', { name: `Remove ${PDF_NAME}`, exact: true })).toBeVisible()
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(prompt)
  await input.press('Enter')
  // Sent: the pending badge leaves the composer with the message.
  await expect(page.getByRole('button', { name: `Remove ${PDF_NAME}`, exact: true })).toHaveCount(0, { timeout: 30_000 })
}

/** The kit agent, its runtime (live) and a relaunch so the agent page and composer see it. */
async function arrangeAgent(cinna: CinnaApp, live: boolean, name = AGENT, description = 'Reads the invoices the user sends.'): Promise<{ agentPath: string; pdfPath: string }> {
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, name, description)
  if (live) await useLiveRuntime(cinna, agent.id)
  const downloads = join(cinna.sandbox.home, 'Downloads')
  mkdirSync(downloads, { recursive: true })
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return { agentPath: agent.path, pdfPath: join(downloads, PDF_NAME) }
}

test.describe('model-free', () => {
  const MODEL = 'qwen3:8b'
  const PROMPT = 'Read the attached PDF and tell me the invoice number.'
  const REPLY = 'I have the invoice open.'
  let server: Server
  let host = ''

  test.beforeAll(async () => {
    server = createServer((req, res) => {
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  test.afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /** The fake engine, a keyless Ollama default mode on OpenCode for it to launch under, and the kit agent. */
  async function arrangeFake(cinna: CinnaApp): Promise<{ fake: FakeAcpEngine; agentPath: string; pdfPath: string }> {
    await cinna.skipOnboarding()
    const fake = await installFakeAcpEngine(cinna, {
      prompt: {
        emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } } }],
        response: { stopReason: 'end_turn' }
      }
    })
    await cinna.page.evaluate(async ({ host, model }) => {
      await window.api.settings.set('autoChatTitles', false)
      const { id } = await window.api.providers.upsert({ type: 'ollama', name: 'Ollama', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId: model, engine: 'opencode', isDefault: true })
    }, { host, model: MODEL })
    return { fake, ...await arrangeAgent(cinna, false) }
  }

  test('an attached PDF is copied into app-data/uploads and the engine is sent its path, not its bytes', async ({ cinna }) => {
    test.setTimeout(120_000)
    const { fake, agentPath, pdfPath } = await arrangeFake(cinna)
    const invoice = makeInvoice()
    writeFileSync(pdfPath, invoice.bytes)
    checkReadable(pdfPath, invoice)
    await stubFilePicker(cinna, pdfPath)

    await attachAndSend(cinna, PROMPT)
    await expect(cinna.page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 30_000 })

    const upload = join(agentPath, 'app-data', 'uploads', UPLOAD_NAME)
    await test.step('the copy is in the agent folder’s app-data/uploads, byte for byte', async () => {
      // The kit scaffolds the folder with a `.gitkeep`; no `.partial` temp may be left beside the copy.
      expect(readdirSync(join(agentPath, 'app-data', 'uploads')).filter((name) => name !== '.gitkeep')).toEqual([UPLOAD_NAME])
      expect(readFileSync(upload).equals(invoice.bytes)).toBe(true)
    })

    await test.step('the engine got one text block naming that path, and no blob', async () => {
      const prompts = fake.received('session/prompt')
      expect(prompts).toHaveLength(1)
      const blocks = prompts[0].params?.prompt as Array<{ type: string; text?: string }>
      // The user's text follows the driver's own `Cinna task context` preamble, which is not this test's subject.
      expect(blocks.map((block) => block.type)).toEqual(['text'])
      expect(blocks[0].text?.startsWith(`Uploaded files:\n- ${upload}\n---\n\n`), blocks[0].text).toBe(true)
      expect(blocks[0].text?.endsWith(`\n${PROMPT}`), blocks[0].text).toBe(true)
      expect(JSON.stringify(prompts[0].params)).not.toContain(invoice.bytes.toString('base64').slice(0, 40))
    })
  })

  test('in a plain chat the PDF goes to the chat runtime as its extracted text, and nothing is copied', async ({ cinna }) => {
    test.setTimeout(120_000)
    const { fake, agentPath, pdfPath } = await arrangeFake(cinna)
    const invoice = makeInvoice()
    writeFileSync(pdfPath, invoice.bytes)
    await stubFilePicker(cinna, pdfPath)

    await attachAndSend(cinna, PROMPT, null)
    await expect(cinna.page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 30_000 })

    await test.step('the runtime got the prompt, then the attachment as text under its name', async () => {
      const prompts = fake.received('session/prompt')
      expect(prompts).toHaveLength(1)
      const blocks = prompts[0].params?.prompt as Array<{ type: string; text?: string }>
      expect(blocks.map((block) => block.type)).toEqual(['text', 'text'])
      expect(blocks[0].text?.endsWith(PROMPT), blocks[0].text).toBe(true)
      expect(blocks[0].text).not.toContain('Uploaded files:')
      expect(blocks[1].text?.startsWith(`[Attachment: ${PDF_NAME}]\n`), blocks[1].text).toBe(true)
      expect(blocks[1].text).toContain(invoice.number)
      expect(blocks[1].text).toContain(invoice.amount)
      expect(JSON.stringify(prompts[0].params)).not.toContain(invoice.bytes.toString('base64').slice(0, 40))
    })

    await test.step('no copy anywhere: not in the kit agent, not in a desktop uploads folder, not in the chat runtime’s folder', async () => {
      expect(readdirSync(join(agentPath, 'app-data', 'uploads'))).toEqual(['.gitkeep'])
      expect(existsSync(join(cinna.sandbox.userData, 'agent-uploads'))).toBe(false)
      const conductors = join(cinna.sandbox.userData, 'chat-conductors')
      const chats = readdirSync(conductors)
      expect(chats).toHaveLength(1)
      expect(existsSync(join(conductors, chats[0], 'app-data'))).toBe(false)
    })
  })
})

interface Turn {
  reply: string
  errors: string[]
  tools: Array<{ toolName?: string; toolInput?: unknown; text: string }>
  results: string[]
}

/** The chat whose first user message is `prompt`, as main stores it. */
async function turnOf(cinna: CinnaApp, prompt: string): Promise<Turn | null> {
  return cinna.page.evaluate(async (first) => {
    for (const row of await window.api.chat.list()) {
      const chat = await window.api.chat.get(row.id)
      if (chat?.messages.find((message) => message.role === 'user')?.content !== first) continue
      const assistant = chat.messages.filter((message) => message.role === 'assistant')
      const parts = assistant.flatMap((message) => message.parts ?? [])
      return {
        reply: assistant.map((message) => message.content).join('\n'),
        errors: chat.messages.filter((message) => message.role === 'error').map((message) => message.content.slice(0, 500)),
        tools: parts.filter((part) => part.kind === 'tool').map((part) => ({ toolName: part.toolName, toolInput: part.toolInput, text: part.text })),
        results: parts.filter((part) => part.kind === 'tool_result').map((part) => part.text)
      }
    }
    return null
  }, prompt)
}

/**
 * Wait for the turn to end with an answer. Antigravity runs on *Ask* approval,
 * so an ask (a shell command to read the PDF) is answered Allow once, at most
 * four times; the claim is that the file was readable, not that nothing asked.
 */
async function settle(cinna: CinnaApp, prompt: string): Promise<{ turn: Turn; asks: string[] }> {
  const asks: string[] = []
  let turn: Turn | null = null
  await test.step('the turn ends with an answer', async () => {
    const page = cinna.page
    await expect.poll(async () => {
      const ask = page.getByText(/^The agent is asking to /)
      if ((await ask.count()) > 0) {
        if (asks.length >= 4) return 'too many asks'
        asks.push(await ask.first().innerText())
        await page.getByRole('button', { name: 'Allow once', exact: true }).first().click()
        return 'answered an ask'
      }
      turn = await turnOf(cinna, prompt)
      if (turn && turn.errors.length > 0) return `error: ${turn.errors[0]}`
      const busy = (await page.getByRole('button', { name: 'Stop', exact: true }).count()) > 0
      return !busy && turn !== null && turn.reply.trim() !== '' ? 'done' : 'running'
    }, { message: 'the turn ends', timeout: 4 * 60_000, intervals: [1000] }).toBe('done')
  })
  return { turn: turn as unknown as Turn, asks }
}

test.describe('@live', () => {
  test.use(liveEngineOptions())
  test.beforeEach(() => requireLiveEngine())

  test(`@live a folder agent reads a PDF the user attached (${LIVE_ENGINE.name})`, async ({ cinna }) => {
    test.setTimeout(6 * 60_000)
    await cinna.skipOnboarding()
    const model = await seedLiveModel(cinna)
    await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
    const { agentPath, pdfPath } = await arrangeAgent(cinna, true)
    if (LIVE_ENGINE.name === 'antigravity') {
      // The login probe answers after launch; a send before it is refused as logged out.
      await expect.poll(() => cinna.page.evaluate(() => window.api.localTools.antigravityAuth()), { timeout: 30_000 })
        .toEqual({ state: 'logged_in' })
    }
    const invoice = makeInvoice()
    writeFileSync(pdfPath, invoice.bytes)
    checkReadable(pdfPath, invoice)
    await stubFilePicker(cinna, pdfPath)

    const prompt = 'Read the attached PDF and tell me its invoice number and the amount due. Reply in one short sentence.'
    await attachAndSend(cinna, prompt)

    const { turn: settled, asks } = await settle(cinna, prompt)
    test.info().annotations.push(
      { type: 'model', description: model },
      { type: 'asks', description: JSON.stringify(asks) },
      { type: 'tool calls', description: JSON.stringify(settled.tools.map((tool) => ({ name: tool.toolName, input: tool.toolInput, text: tool.text.slice(0, 200) }))).slice(0, 3000) },
      { type: 'reply', description: settled.reply.slice(0, 500) }
    )

    console.log(`live-attachments ${model}: tools ${JSON.stringify(settled.tools.map((tool) => tool.toolName))}, ${asks.length} asks, reply ${JSON.stringify(settled.reply.slice(0, 200))}`)

    const upload = join(agentPath, 'app-data', 'uploads', UPLOAD_NAME)
    await test.step('the copy is in the agent folder’s app-data/uploads, byte for byte', async () => {
      expect(existsSync(upload), upload).toBe(true)
      expect(readFileSync(upload).equals(invoice.bytes)).toBe(true)
    })

    await test.step('the agent opened the uploaded file with a tool', async () => {
      const touched = settled.tools.filter((tool) => JSON.stringify(tool).includes(UPLOAD_NAME))
      expect(touched.length, `a tool call names ${UPLOAD_NAME}`).toBeGreaterThan(0)
    })

    await test.step('the reply carries the invoice number and the amount, which only the PDF holds', async () => {
      expect(settled.errors).toEqual([])
      expect(settled.reply).toContain(invoice.number)
      expect(settled.reply.replace(/,/g, '')).toContain(invoice.amount)
      await expect(cinna.page.getByText(invoice.number).first()).toBeVisible()
    })
  })

  test('@live a plain chat answers from a PDF the user attached (opencode)', async ({ cinna }) => {
    requireOpenCode('a plain chat runs on the chat runtime, OpenCode on the .env key; on the other engines its default mode would name an OpenAI model')
    test.setTimeout(4 * 60_000)
    await cinna.skipOnboarding()
    const model = await seedLiveModel(cinna)
    await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
    // The mode seeded over IPC reaches the new-chat composer after a restart.
    await cinna.relaunch()
    await cinna.skipOnboarding()
    const pdfPath = join(homeDir(cinna, 'Downloads'), PDF_NAME)
    const invoice = makeInvoice()
    writeFileSync(pdfPath, invoice.bytes)
    await stubFilePicker(cinna, pdfPath)

    const prompt = 'What is the invoice number and the amount due in the attached PDF? Reply in one short sentence.'
    await attachAndSend(cinna, prompt, null)
    const { turn, asks } = await settle(cinna, prompt)
    console.log(`live-attachments plain chat ${model}: tools ${JSON.stringify(turn.tools.map((tool) => tool.toolName))}, ${asks.length} asks, reply ${JSON.stringify(turn.reply.slice(0, 200))}`)

    expect(turn.errors).toEqual([])
    expect(asks).toEqual([])
    expect(turn.reply).toContain(invoice.number)
    expect(turn.reply.replace(/,/g, '')).toContain(invoice.amount)
    // The text went in the prompt: nothing was copied for the chat runtime to open.
    expect(existsSync(join(cinna.sandbox.userData, 'agent-uploads'))).toBe(false)
  })
})

test.describe('@live files queued behind a running turn', () => {
  test.use(liveEngineOptions())
  test.beforeEach(() => requireLiveEngine())

  const HOLD = 'Use your shell tool to run the command `sleep 20`, wait for it to finish, then reply with the single word done.'
  const QUESTION = 'What code is in the attached text file, and what number is written in the attached image? Reply with the code and the number only.'
  const HELPER = 'Desk Helper'
  const TEXT_NAME = 'vault-note.txt'
  const IMAGE_NAME = 'badge-number.png'

  interface Transcript { users: Array<{ content: string; files: string[] }>; after: string; errors: string[] }

  /** The user rows of the one chat, and what the assistant said after the last of them. */
  async function transcript(cinna: CinnaApp): Promise<Transcript | null> {
    return cinna.page.evaluate(async () => {
      const [row] = await window.api.chat.list()
      if (!row) return null
      const messages = (await window.api.chat.get(row.id))?.messages ?? []
      const lastUser = messages.map((message) => message.role).lastIndexOf('user')
      return {
        users: messages.filter((message) => message.role === 'user')
          .map((message) => ({ content: message.content, files: (message.attachments ?? []).map((file) => file.filename) })),
        after: messages.slice(lastUser + 1).filter((message) => message.role === 'assistant').map((message) => message.content).join('\n'),
        errors: messages.filter((message) => message.role === 'error').map((message) => message.content.slice(0, 500))
      }
    })
  }

  test(`@live a file sent mid-turn queues, then goes as its own turn (${LIVE_ENGINE.name})`, async ({ cinna }) => {
    test.setTimeout(6 * 60_000)
    await cinna.skipOnboarding()
    const model = await seedLiveModel(cinna)
    await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
    // A general persona: the invoice clerk turns down a shell command and a vault code as off-topic.
    await arrangeAgent(cinna, true, HELPER, 'A general assistant: runs the shell commands the user asks for and reads the files the user sends.')
    if (LIVE_ENGINE.name === 'antigravity') {
      await expect.poll(() => cinna.page.evaluate(() => window.api.localTools.antigravityAuth()), { timeout: 30_000 })
        .toEqual({ state: 'logged_in' })
    }
    const page = cinna.page
    const downloads = homeDir(cinna, 'Downloads')
    const code = `KESTREL-${randomBytes(2).toString('hex').toUpperCase()}`
    const number = String(1000 + Math.floor(Math.random() * 8999))
    const textPath = join(downloads, TEXT_NAME)
    const imagePath = join(downloads, IMAGE_NAME)
    writeFileSync(textPath, `The vault code is ${code}.\n`)
    // The number drawn black on white, large, by the renderer's own canvas.
    const png = await page.evaluate((digits) => {
      const canvas = document.createElement('canvas')
      canvas.width = 480
      canvas.height = 200
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, 480, 200)
      ctx.fillStyle = '#000000'
      ctx.font = 'bold 120px Helvetica, Arial, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillText(digits, 40, 105)
      return canvas.toDataURL('image/png').split(',')[1]
    }, number)
    writeFileSync(imagePath, Buffer.from(png, 'base64'))
    await cinna.electronApp.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: picked })) as typeof dialog.showOpenDialog
    }, [textPath, imagePath])

    await test.step('the first turn starts and stays running', async () => {
      await page.getByRole('button', { name: 'Agents', exact: true }).click()
      await page.getByRole('button', { name: HELPER, exact: true }).click()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(HELPER)
      const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
      await input.fill(HOLD)
      await input.press('Enter')
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 30_000 })
    })

    const queued = page.locator('[data-queued-message]')
    await test.step('mid-turn, both files attach and the message queues with its badges', async () => {
      const running = page.getByRole('combobox', { name: 'Send a follow-up · Esc Esc to stop', exact: true })
      await expect(running).toBeVisible()
      await page.getByRole('button', { name: 'Add to chat', exact: true }).click()
      const attach = page.getByRole('menu', { name: 'Add to chat' }).getByRole('menuitem', { name: 'Attach files' })
      await expect(attach).toBeEnabled()
      await attach.click()
      await expect(page.getByRole('button', { name: `Remove ${TEXT_NAME}`, exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: `Remove ${IMAGE_NAME}`, exact: true })).toBeVisible()
      await running.fill(QUESTION)
      await running.press('Enter')
      await expect(running).toHaveValue('')
      await expect(queued).toHaveCount(1)
      await expect(queued.getByText(QUESTION, { exact: true })).toBeVisible()
      await expect(queued.getByText('Queued', { exact: true })).toBeVisible()
      await expect(queued.getByRole('button', { name: `Preview ${TEXT_NAME}`, exact: true })).toBeVisible()
      await expect(queued.getByRole('button', { name: `Preview ${IMAGE_NAME}`, exact: true })).toBeVisible()
      const view = await page.evaluate(async () => window.api.run.queueList((await window.api.chat.list())[0].id))
      expect(view.items.map((item) => [item.content, (item.attachments ?? []).map((file) => file.filename)]))
        .toEqual([[QUESTION, [TEXT_NAME, IMAGE_NAME]]])
      // Still the first turn: nothing has been sent but the hold prompt.
      expect((await transcript(cinna))?.users).toEqual([{ content: HOLD, files: [] }])
    })

    const asks: string[] = []
    let last: Transcript | null = null
    await test.step('after the first turn the queued message runs as its own turn', async () => {
      await expect.poll(async () => {
        const ask = page.getByText(/^The agent is asking to /)
        if ((await ask.count()) > 0) {
          if (asks.length >= 4) return 'too many asks'
          asks.push(await ask.first().innerText())
          await page.getByRole('button', { name: 'Allow once', exact: true }).first().click()
          return 'answered an ask'
        }
        last = await transcript(cinna)
        if (last && last.errors.length > 0) return `error: ${last.errors[0]}`
        const busy = (await page.getByRole('button', { name: 'Stop', exact: true }).count()) > 0
        return !busy && (await queued.count()) === 0 && last !== null && last.users.length === 2 && last.after.trim() !== '' ? 'done' : 'running'
      }, { message: 'both turns end', timeout: 5 * 60_000, intervals: [1000] }).toBe('done')
    })

    const settled = last as unknown as Transcript
    console.log(`live-attachments queued ${model}: ${asks.length} asks, reply ${JSON.stringify(settled.after.slice(0, 200))}`)
    test.info().annotations.push({ type: 'model', description: model }, { type: 'asks', description: JSON.stringify(asks) }, { type: 'reply', description: settled.after.slice(0, 500) })

    await test.step('the saved user row carries both files, and the reply holds the code and the number', async () => {
      expect(settled.errors).toEqual([])
      expect(settled.users).toEqual([{ content: HOLD, files: [] }, { content: QUESTION, files: [TEXT_NAME, IMAGE_NAME] }])
      expect(settled.after).toContain(code)
      expect(settled.after.replace(/[,\s]/g, '')).toContain(number)
      await expect(page.getByText(code).first()).toBeVisible()
    })
  })
})
