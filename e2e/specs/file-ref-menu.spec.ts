import { createServer, type Server } from 'node:http'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Locator, Page } from '@playwright/test'
import type { FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * The transcript's right-click menu on a file reference in a folder agent's chat.
 *
 * ## What is real and what is not
 *
 * The agent is the scriptable fake ACP agent (`fakeAcpEngine`), answering one
 * turn with markdown that names three files in inline code; the same
 * arrangement as `file-refs.spec.ts`. Everything after that is the product:
 * resolution against the real folder, the menu, `agent-files:authorize` /
 * `:read-text`, main's `clipboard:write-text`, `fileNoteFromContents`,
 * `note:create` and the new-chat draft. The clipboard is the machine's real
 * one, read in main; the spec saves what was on it first and puts it back.
 * `dialog.showMessageBox` is stubbed only to record: every file is inside the
 * agent folder, so nothing may be asked.
 *
 * ## What it proves
 *
 * - A markdown reference offers Copy contents, Save to Notes, Copy full path
 *   and Reference in a new chat, in that order; Copy contents puts the whole
 *   file on the clipboard.
 * - Save to Notes on it opens a note titled by the file's H1 whose body is the
 *   file as written; on a `.json` the body is the file in a `json` fence and the
 *   title is the file name.
 * - A `.env` reference offers only the path items; Copy full path copies the
 *   realpath; Reference in a new chat lands on the new-chat screen with the
 *   agent selected and "The file `<realpath>` " in the composer.
 *
 * ## What it does not
 *
 * - A file outside the agent folder (the consent dialog before a read), the
 *   in-menu failures (over 4 MB, not text, gone), a folder reference, a
 *   selection inside a path winning over the reference items, a switched-off
 *   agent's toast, and text already in the new-chat composer being kept —
 *   `MessageContextMenu.fileRefs.test.tsx`, `fileNote.test.ts` and
 *   `agentFileService.test.ts` cover those.
 */

const AGENT = 'Weekly Reporter'
const MODEL = 'qwen3:8b'
const PROMPT = 'Write up the week.'

const SUMMARY = 'reports/weekly_summary.md'
const SETTINGS = 'config/settings.json'
const ENV = '.env'

const SUMMARY_TEXT = '# Weekly summary\n\nThree renewals closed; churn held flat at 2 percent.\n'
const SETTINGS_TEXT = '{\n  "region": "EU",\n  "target": 1200\n}\n'
const SECRET = 'e2e-not-a-real-token'

const REPLY = [
  `The summary is in \`${SUMMARY}\`, driven by \`${SETTINGS}\`.`,
  '',
  `Keys come from \`${ENV}\`.`
].join('\n')

const ANSWERS_WITH_PATHS: FakeAcpScript = {
  newSession: { sessionId: 'ses_e2e_file_ref_menu' },
  prompt: {
    emit: [
      {
        kind: 'update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } }
      }
    ]
  }
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

/**
 * A folder agent on the fake engine whose folder holds the three files, and
 * the turn sent through the composer. Resolves once the links have rendered.
 */
async function arrange(cinna: CinnaApp): Promise<{ agentDir: string }> {
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
  mkdirSync(join(agent.path, 'config'), { recursive: true })
  writeFileSync(join(agent.path, SUMMARY), SUMMARY_TEXT)
  writeFileSync(join(agent.path, SETTINGS), SETTINGS_TEXT)
  writeFileSync(join(agent.path, ENV), `REPORT_TOKEN=${SECRET}\n`)

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
  await expect(fileLink(page, ENV)).toBeVisible({ timeout: 30_000 })
  return { agentDir: agent.path }
}

function fileLink(page: Page, text: string): Locator {
  return page.getByRole('button', { name: `Preview ${text}`, exact: true })
}

function messageMenu(page: Page): Locator {
  return page.getByRole('menu', { name: 'Message actions', exact: true })
}

async function openMenuOn(page: Page, text: string): Promise<Locator> {
  await fileLink(page, text).click({ button: 'right' })
  const menu = messageMenu(page)
  await expect(menu).toBeVisible()
  return menu
}

/** Record the consent dialog instead of showing it; nothing here should ask. */
async function recordConsent(cinna: CinnaApp): Promise<void> {
  await cinna.electronApp.evaluate(({ dialog }) => {
    const store = globalThis as unknown as { __e2eAsks: number }
    store.__e2eAsks = 0
    dialog.showMessageBox = (async () => {
      store.__e2eAsks++
      return { response: 1, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
}

function readClipboard(cinna: CinnaApp): Promise<string> {
  return cinna.electronApp.evaluate(({ clipboard }) => clipboard.readText())
}

function writeClipboard(cinna: CinnaApp, text: string): Promise<void> {
  return cinna.electronApp.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
}

/** Back from a note to the chat the links live in. */
async function backToChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Chats', exact: true }).click()
  await page.getByText(PROMPT, { exact: true }).first().click()
  await expect(fileLink(page, ENV)).toBeVisible()
}

/** The saved note: its title field, its stored body, and that it is the note on screen. */
async function expectNote(cinna: CinnaApp, title: string, body: string): Promise<void> {
  const page = cinna.page
  await expect(page.getByPlaceholder('Untitled note', { exact: true })).toHaveValue(title)
  const notes = await page.evaluate(() => window.api.notes.list())
  const matching = notes.filter((n) => n.title === title)
  expect(matching).toHaveLength(1)
  expect(matching[0].body).toBe(body)
}

test('right-clicking a file reference copies, saves, copies the path and starts a chat that points at it', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  const { agentDir } = await arrange(cinna)
  const envPath = realpathSync(join(agentDir, ENV))
  await recordConsent(cinna)
  const saved = await readClipboard(cinna)

  try {
    await test.step('a markdown reference offers all four items; Copy contents copies the file', async () => {
      const page = cinna.page
      await writeClipboard(cinna, 'e2e clipboard sentinel')
      const menu = await openMenuOn(page, SUMMARY)
      await expect(menu.getByRole('menuitem')).toHaveText([
        'Copy contents',
        'Save to Notes',
        'Copy full path',
        'Reference in a new chat'
      ])
      await expect(menu.getByRole('separator')).toHaveCount(1)
      await menu.getByRole('menuitem', { name: 'Copy contents', exact: true }).click()
      await expect(menu).toHaveCount(0)
      await expect.poll(() => readClipboard(cinna)).toBe(SUMMARY_TEXT)
    })

    await test.step('Save to Notes on it opens a note titled by its heading, the file as written', async () => {
      const page = cinna.page
      const menu = await openMenuOn(page, SUMMARY)
      await menu.getByRole('menuitem', { name: 'Save to Notes', exact: true }).click()
      await expectNote(cinna, 'Weekly summary', SUMMARY_TEXT)
      await expect(page.getByRole('heading', { name: 'Weekly summary', level: 1 })).toBeVisible()
      await expect(page.getByText('Three renewals closed; churn held flat at 2 percent.', { exact: true })).toBeVisible()
    })

    await test.step('Save to Notes on a .json fences it with the language tag', async () => {
      const page = cinna.page
      await backToChat(page)
      const menu = await openMenuOn(page, SETTINGS)
      await expect(menu.getByRole('menuitem')).toHaveText([
        'Copy contents',
        'Save to Notes',
        'Copy full path',
        'Reference in a new chat'
      ])
      await menu.getByRole('menuitem', { name: 'Save to Notes', exact: true }).click()
      await expectNote(cinna, 'settings.json', '```json\n' + SETTINGS_TEXT + '```')
      await expect(page.locator('pre code.language-json')).toHaveText(SETTINGS_TEXT)
    })

    await test.step('a .env reference offers only the path items; Copy full path copies the realpath', async () => {
      const page = cinna.page
      await backToChat(page)
      await writeClipboard(cinna, 'e2e clipboard sentinel')
      const menu = await openMenuOn(page, ENV)
      await expect(menu.getByRole('menuitem')).toHaveText(['Copy full path', 'Reference in a new chat'])
      await expect(menu.getByRole('separator')).toHaveCount(0)
      await menu.getByRole('menuitem', { name: 'Copy full path', exact: true }).click()
      await expect(menu).toHaveCount(0)
      await expect.poll(() => readClipboard(cinna)).toBe(envPath)
    })

    await test.step('Reference in a new chat: the new-chat screen, the agent selected, the path typed', async () => {
      const page = cinna.page
      const menu = await openMenuOn(page, ENV)
      await menu.getByRole('menuitem', { name: 'Reference in a new chat', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'What can I help with?', level: 1 })).toBeVisible()
      await expect(page.getByRole('button', { name: `Remove agent ${AGENT}`, exact: true })).toBeVisible()
      const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
      await expect(input).toHaveValue(`The file \`${envPath}\` `)
      await expect(input).toBeFocused()
    })

    // Every file is inside the agent folder: nothing was asked, and the secret never showed.
    const asks = await cinna.electronApp.evaluate(() => (globalThis as unknown as { __e2eAsks: number }).__e2eAsks)
    expect(asks).toBe(0)
    await expect(cinna.page.getByText(SECRET)).toHaveCount(0)
  } finally {
    await writeClipboard(cinna, saved)
  }
})
