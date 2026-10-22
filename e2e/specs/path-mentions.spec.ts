import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Locator, Page } from '@playwright/test'
import type { FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'
import type { LocalAgentDto } from '../../src/shared/localAgents'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine, type FakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * "Mention in Cinna": files and folders handed to the app from outside
 * (Finder's Quick Action → macOS `open-file`) become reference chips in the
 * new-chat composer.
 *
 * ## What is real and what is not
 *
 * The delivery is the one thing simulated: a warm mention is `open-file`
 * emitted on main's `app` (exactly the event macOS raises, into the same
 * listener), a cold one the test-only `--cinna-mention-path=` argv, which
 * enters the same funnel. Validation, the buffer and its settle delay, the
 * push, `pathMention.take()`, the folder-agent match, the composer draft, the
 * chips, the send and the title are the product. The folder agent is the
 * scriptable fake ACP agent (`fakeAcpEngine`) behind a keyless Ollama row, so
 * what it was sent is read from its own log. The Finder switch really writes
 * the workflow into the sandbox `HOME`'s `~/Library/Services` and really runs
 * `/System/Library/CoreServices/pbs -update` on the host (it only rescans
 * Services).
 *
 * ## What it proves
 *
 * - A mentioned folder inside a folder agent's folder lands on the new-chat
 *   screen with that agent selected and a folder chip; the same path again
 *   adds nothing; a file adds a second chip; its X removes it.
 * - Sending typed text with a chip sends the text then a blank line and
 *   ``Referenced folder: `<realpath>` `` — on the wire and as the stored user
 *   message — the bubble links the path as a folder reference, the chips are
 *   gone from the new-chat composer, and the chat's title is the typed text.
 * - A chip alone is sendable, and the title is then the chip's name.
 * - A mention while Settings is open leaves Settings where it is, says
 *   "<name> added to a new chat", and the chip and agent are waiting in the
 *   new-chat composer after Back.
 * - A cold launch's mention survives the first-run screen and shows once the
 *   shell is up.
 * - Settings → Features → Finder → Mention in Cinna installs the workflow into
 *   `~/Library/Services` and removes it (macOS only).
 *
 * ## What it does not
 *
 * - A real Finder right-click or `automator -i` on the installed workflow —
 *   `e2e/bare-mac/specs/finder-mention.spec.ts` in a VM.
 * - Refused paths (relative, control characters, gone, over 4096 characters),
 *   the 20-path cap, nested agent folders, the most-recently-used fallback,
 *   the "older Cinna" Update row and install failures —
 *   `pathMentionIntentService.test.ts`, `pathMentionService.test.ts`,
 *   `finderQuickAction.test.ts`.
 * - A mention arriving during a profile switch or a locked profile.
 */

const AGENT = 'Field Notes'
const MODEL = 'qwen3:8b'
const TYPED = 'Summarise this folder'
const REPLY = 'Read the folder.'

const ANSWERS: FakeAcpScript = {
  newSession: { sessionId: 'ses_e2e_path_mentions' },
  prompt: {
    emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } } }]
  }
}

function fakeOllama(): Server {
  return createServer((req, res) => {
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
  agent: LocalAgentDto
  fake: FakeAcpEngine
  /** Realpath of `<agent>/projects/alpha`, the folder mentioned. */
  folder: string
  /** Realpath of `<home>/notes/todo.txt`, outside every agent folder. */
  file: string
}

/** A folder agent on the fake engine, relaunched so the composer can see it. */
async function arrange(cinna: CinnaApp): Promise<Arranged> {
  await cinna.skipOnboarding()
  const fake = await installFakeAcpEngine(cinna, ANSWERS)
  await cinna.page.evaluate(
    async ({ host, model }) => {
      const { id } = await window.api.providers.upsert({ type: 'ollama', name: 'Ollama', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId: model, isDefault: true })
    },
    { host: ollamaHost, model: MODEL }
  )
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, AGENT)
  const folderDir = join(agent.path, 'projects', 'alpha')
  mkdirSync(folderDir, { recursive: true })
  writeFileSync(join(folderDir, 'README.md'), '# Alpha\n')
  const notes = join(cinna.sandbox.home, 'notes')
  mkdirSync(notes, { recursive: true })
  writeFileSync(join(notes, 'todo.txt'), 'call the printer people\n')

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return { agent, fake, folder: realpathSync(folderDir), file: realpathSync(join(notes, 'todo.txt')) }
}

/** What macOS does when Finder's Quick Action runs `open` on `path`. */
async function mention(cinna: CinnaApp, path: string): Promise<void> {
  await cinna.electronApp.evaluate(({ app }, p) => {
    app.emit('open-file', { preventDefault() {} }, p)
  }, path)
}

/** A chip's tooltip: `~/…` for a path under the (real) home. */
function tilde(cinna: CinnaApp, real: string): string {
  return `~/${relative(realpathSync(cinna.sandbox.home), real)}`
}

function chips(page: Page): Locator {
  return page.getByTestId('path-ref-badge')
}

function composer(page: Page): Locator {
  return page.getByRole('combobox', { name: 'Type a message...', exact: true })
}

function newChatHeading(page: Page): Locator {
  return page.getByRole('heading', { name: 'What can I help with?', level: 1 })
}

/** The Chats list row: its title as plain text (the bubble's copy is a paragraph). */
function chatRow(page: Page, title: string): Locator {
  return page.getByText(title, { exact: true }).and(page.locator(':not(p)'))
}

async function openSettings(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  expect(user, 'onboarding activated a user').not.toBeNull()
  await page.getByRole('button', { name: user!.displayName, exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Chat Modes', level: 1 })).toBeVisible()
}

/** The one chat the send created: its row, and the stored messages. */
async function onlyChat(cinna: CinnaApp): Promise<{ id: string; title: string; userText: string }> {
  return cinna.page.evaluate(async () => {
    const list = await window.api.chat.list()
    if (list.length !== 1) throw new Error(`expected one chat, found ${list.length}`)
    const chat = await window.api.chat.get(list[0].id)
    const user = chat?.messages.find((m) => m.role === 'user')
    return { id: list[0].id, title: list[0].title, userText: user?.content ?? '' }
  })
}

/** The text of the last `session/prompt` the fake agent received, all blocks joined. */
function lastPromptText(fake: FakeAcpEngine): string {
  const prompts = fake.received('session/prompt')
  const blocks = (prompts.at(-1)?.params?.prompt ?? []) as { type: string; text?: string }[]
  return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
}

test('a mentioned folder opens a new chat on its folder agent; repeats merge, files add, X removes', async ({ cinna }) => {
  test.setTimeout(90_000)
  const { folder, file } = await arrange(cinna)
  const page = cinna.page

  await test.step('the folder lands on the new-chat screen with its agent and one folder chip', async () => {
    await mention(cinna, folder)
    await expect(newChatHeading(page)).toBeVisible()
    await expect(page.getByRole('button', { name: `Remove agent ${AGENT}`, exact: true })).toBeVisible()
    await expect(chips(page)).toHaveCount(1)
    await expect(chips(page)).toHaveText('alpha')
    await expect(chips(page)).toHaveAttribute('title', tilde(cinna, folder))
    await expect(composer(page)).toHaveValue('')
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  })

  await test.step('the same folder again adds nothing; a file adds a second chip after it', async () => {
    // Delivered in order: once the file's chip is there, the repeat was handled too.
    await mention(cinna, folder)
    await mention(cinna, file)
    await expect(chips(page)).toHaveText(['alpha', 'todo.txt'])
    await expect(chips(page).nth(1)).toHaveAttribute('title', tilde(cinna, file))
    // Still the first item's agent, and only one.
    await expect(page.getByRole('button', { name: /^Remove agent / })).toHaveCount(1)
  })

  await test.step('X removes that chip and only that one', async () => {
    await page.getByRole('button', { name: 'Remove alpha', exact: true }).click()
    await expect(chips(page)).toHaveText(['todo.txt'])
  })
})

test('typed text with a chip sends the text then the reference line, links it, clears the chips, titles by the text', async ({
  cinna
}) => {
  test.setTimeout(90_000)
  const { fake, folder } = await arrange(cinna)
  const page = cinna.page
  const line = `Referenced folder: \`${folder}\``

  await mention(cinna, folder)
  await expect(chips(page)).toHaveText(['alpha'])
  await composer(page).fill(TYPED)
  await composer(page).press('Enter')

  await test.step('the agent answers, and was sent the text, a blank line, then the reference line', async () => {
    await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 30_000 })
    // A kit agent's first text block opens with the driver's task context; the message ends it.
    expect(lastPromptText(fake).endsWith(`${TYPED}\n\n${line}`)).toBe(true)
  })

  await test.step('stored as sent; the bubble links the folder; the title is the typed text', async () => {
    const chat = await onlyChat(cinna)
    expect(chat.userText).toBe(`${TYPED}\n\n${line}`)
    expect(chat.title).toBe(TYPED)
    await expect(page.getByRole('button', { name: `Show ${folder} in its folder`, exact: true })).toBeVisible()
    await expect(chatRow(page, TYPED)).toBeVisible()
  })

  await test.step('the new-chat composer no longer holds the chip', async () => {
    await expect(chips(page)).toHaveCount(0)
    await page.getByRole('button', { name: 'New chat', exact: true }).click()
    await expect(newChatHeading(page)).toBeVisible()
    await expect(chips(page)).toHaveCount(0)
  })
})

test('a chip alone is sendable and names the chat', async ({ cinna }) => {
  test.setTimeout(90_000)
  const { fake, folder } = await arrange(cinna)
  const page = cinna.page
  const line = `Referenced folder: \`${folder}\``

  await mention(cinna, folder)
  await expect(chips(page)).toHaveText(['alpha'])
  await expect(composer(page)).toHaveValue('')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  await expect(page.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 30_000 })
  expect(lastPromptText(fake).endsWith(line)).toBe(true)
  const chat = await onlyChat(cinna)
  expect(chat.userText).toBe(line)
  expect(chat.title).toBe('alpha')
  await expect(chatRow(page, 'alpha')).toBeVisible()
  await expect(chips(page)).toHaveCount(0)
})

test('a mention while Settings is open stays in Settings, says so, and waits in the new-chat composer', async ({ cinna }) => {
  test.setTimeout(90_000)
  const { folder } = await arrange(cinna)
  const page = cinna.page
  await expect(newChatHeading(page)).toBeVisible()
  await openSettings(cinna)

  await mention(cinna, folder)
  await expect(page.getByRole('status').filter({ hasText: 'alpha added to a new chat' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Chat Modes', level: 1 })).toBeVisible()
  await expect(newChatHeading(page)).toHaveCount(0)

  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(newChatHeading(page)).toBeVisible()
  await expect(page.getByRole('button', { name: `Remove agent ${AGENT}`, exact: true })).toBeVisible()
  await expect(chips(page)).toHaveText(['alpha'])
  await expect(chips(page)).toHaveAttribute('title', tilde(cinna, folder))
})

test.describe('a cold launch', () => {
  // Made before the fixture launches: the argv is read at startup and the path
  // must exist then, so it cannot live in the sandbox the fixture creates.
  const launchArgs: string[] = []
  let outside = ''
  test.use({ launchArgs })

  test.beforeAll(() => {
    outside = mkdtempSync(join(tmpdir(), 'cinna-e2e-mention-'))
    mkdirSync(join(outside, 'Quarterly Report'))
    launchArgs.push(`--cinna-mention-path=${join(outside, 'Quarterly Report')}`)
  })

  test.afterAll(() => {
    rmSync(outside, { recursive: true, force: true })
  })

  test('a mention on the command line survives the first-run screen and shows once the shell is up', async ({ cinna }) => {
    const page = cinna.page
    await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible()
    await expect(chips(page)).toHaveCount(0)
    await cinna.skipOnboarding()
    await expect(newChatHeading(page)).toBeVisible()
    await expect(chips(page)).toHaveText(['Quarterly Report'])
    // Outside the sandbox home: shown absolute.
    await expect(chips(page)).toHaveAttribute('title', realpathSync(join(outside, 'Quarterly Report')))
  })
})

test('Settings → Features → Mention in Cinna installs the Quick Action into ~/Library/Services and removes it', async ({ cinna }) => {
  test.skip(process.platform !== 'darwin', 'The Finder Quick Action exists on macOS only')
  await cinna.skipOnboarding()
  const workflow = join(cinna.sandbox.home, 'Library', 'Services', 'Mention in Cinna.workflow')
  expect(existsSync(workflow)).toBe(false)

  await openSettings(cinna)
  const page = cinna.page
  await page.getByRole('button', { name: 'Features', exact: true }).click()
  const toggle = page.getByRole('switch', { name: 'Mention in Cinna', exact: true })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(toggle).toBeEnabled()
  const doc = readFileSync(join(workflow, 'Contents', 'document.wflow'), 'utf8')
  expect(doc).not.toContain('__CINNA_COMMAND__')
  // A dev build opens the running Electron.app by path; the command is XML-escaped.
  expect(doc).toMatch(/<key>COMMAND_STRING<\/key>\s*<string>open -a &apos;[^<]*\/Electron\.app&apos; &quot;\$@&quot;<\/string>/)
  expect(existsSync(join(workflow, 'Contents', 'Info.plist'))).toBe(true)
  await expect(page.getByText('Installed from an older Cinna.', { exact: true })).toHaveCount(0)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(toggle).toBeEnabled()
  expect(existsSync(workflow)).toBe(false)
})
