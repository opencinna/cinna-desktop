import { createServer, type Server } from 'node:http'
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Locator, Page } from '@playwright/test'
import type { FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * The XML and HTML file previews, and Open in browser, on files a folder
 * agent named.
 *
 * ## What is real and what is not
 *
 * The agent is the scriptable fake ACP agent (`fakeAcpEngine`), answering one
 * turn that names four files in inline code; the files are real, in the
 * agent's folder. Everything from the file link on is the product: resolve,
 * read, `parseXml` / `xmlOutline`, the tree, the Contents panel, main's
 * `cinna-preview:` scheme serving the page and the files beside it, the frame's
 * sandbox, the ⋯ menu and the transcript's right-click menu, and main's
 * `agent-files:open-in-browser` down to the `execFile('open', …)` step.
 * What is stubbed, in main only, for the Open in browser test: the default
 * browser lookup (`app.getApplicationInfoForProtocol` answers a fixed
 * `E2E Browser.app`), `open` on main's `PATH` (a shell script that logs its
 * argv and exits 0) and `shell.openPath` (records, so the fallback cannot
 * launch anything real). No browser opens. Nothing touches the network: the
 * page's stylesheet and data are local files served over the scheme.
 *
 * ## What it proves
 *
 * - XML: a well-formed file opens as a tree; collapsing an element removes its
 *   children's rows and shows its child count; the Contents panel lists the
 *   nested elements that hold elements (tag · id), in document order;
 *   clicking an entry inside a folded branch unfolds it and scrolls the
 *   element into view. A malformed file shows "This XML could not be parsed,
 *   so it is shown as source." above its source, and offers no Contents.
 * - HTML: the Rendered view runs the page's script (it rewrites the heading),
 *   applies the relative `style.css`, and the script's `fetch('data.json')`
 *   succeeds. The frame's `sandbox` is exactly the expected token string. The
 *   page's own probe reports no `window.api` and a parent it cannot read.
 *   Source shows the markup highlighted; back on Rendered the same frame
 *   element is there and the page did not reload (its per-load nonce is
 *   unchanged). Close removes the card and the frame.
 * - Open in browser: offered first in the right-click menu of an `.html`
 *   reference (not on an `.xml` one), and between Open and Open folder in the
 *   preview's ⋯ menu; each one launches `open -a <default browser> <realpath>`.
 *
 * ## What it does not
 *
 * - Links and navigation inside the frame (the external-link gate), assets
 *   outside the page's folder, the 25 MB cap, attachments (the header's globe
 *   button and `files:open-in-browser`), the truncated-XML note, Alt-click
 *   branch folding and paging — unit tests cover those
 *   (`htmlPreviewGuards.test.ts`, `htmlPreviewServer.test.ts`,
 *   `agentFileService.test.ts`, `openInBrowserCopies.test.ts`,
 *   `XmlTree.test.tsx`, `FilePreviewModal.html.test.tsx`).
 * - That the real default browser would open the file: the launch is stopped
 *   at the `open` executable.
 */

const AGENT = 'Site Builder'
const MODEL = 'qwen3:8b'
const PROMPT = 'Build the catalogue site.'

const CATALOG = 'data/catalog.xml'
const BROKEN = 'data/broken.xml'
const PAGE = 'site/index.html'
const STYLE = 'site/style.css'
const DATA = 'site/data.json'

const REPLY = [
  `The catalogue is in \`${CATALOG}\`; \`${BROKEN}\` did not validate.`,
  '',
  `The page is \`${PAGE}\`.`
].join('\n')

const ANSWERS_WITH_FILES: FakeAcpScript = {
  newSession: { sessionId: 'ses_e2e_preview_formats' },
  prompt: {
    emit: [
      {
        kind: 'update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } }
      }
    ]
  }
}

/** Twelve sections of three books: well over a screen, well under the tree's expand-all limit. */
const SECTIONS = Array.from({ length: 12 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`)
const BOOKS = [1, 2, 3]

const CATALOG_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<catalog>',
  ...SECTIONS.flatMap((s) => [
    `  <section id="${s}">`,
    ...BOOKS.map(
      (b) => `    <book id="${s}-b${b}"><title>Title ${s}-${b}</title><author>Author ${s}-${b}</author></book>`
    ),
    '  </section>'
  ]),
  '</catalog>',
  ''
].join('\n')

/** Every element that holds elements, under the root, as the panel labels it. */
const CATALOG_ENTRIES = SECTIONS.flatMap((s) => [`section · ${s}`, ...BOOKS.map((b) => `book · ${s}-b${b}`)])

const BROKEN_XML = '<catalog>\n  <section id="x">\n    <book>Unclosed\n  </section>\n</catalog>\n'

const PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="style.css">
<title>Catalogue</title>
</head>
<body>
<h1 id="heading">Static heading</h1>
<p id="rows">No data yet</p>
<p id="probe">Probe did not run</p>
<p id="nonce"></p>
<script>
document.getElementById('heading').textContent = 'Written by the script'
document.getElementById('nonce').textContent = String(Math.random())
fetch('data.json')
  .then((r) => r.json())
  .then((d) => { document.getElementById('rows').textContent = 'Loaded ' + d.rows.length + ' rows' })
  .catch((e) => { document.getElementById('rows').textContent = 'Fetch failed: ' + e })
function reach(read) { try { return String(read()) } catch (e) { return 'blocked' } }
document.getElementById('probe').textContent =
  'api: ' + typeof window.api +
  '; parent document: ' + reach(() => window.parent.document.title) +
  '; parent api: ' + reach(() => typeof window.parent.api)
</script>
</body>
</html>
`
const STYLE_CSS = '#heading { color: rgb(1, 128, 2); }\n'
const DATA_JSON = JSON.stringify({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] })

const SANDBOX = 'allow-scripts allow-forms allow-modals allow-top-navigation-by-user-activation'
const FAKE_BROWSER = '/Applications/E2E Browser.app'

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
async function arrange(cinna: CinnaApp): Promise<{ agentDir: string }> {
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
  mkdirSync(join(agent.path, 'data'), { recursive: true })
  mkdirSync(join(agent.path, 'site'), { recursive: true })
  writeFileSync(join(agent.path, CATALOG), CATALOG_XML)
  writeFileSync(join(agent.path, BROKEN), BROKEN_XML)
  writeFileSync(join(agent.path, PAGE), PAGE_HTML)
  writeFileSync(join(agent.path, STYLE), STYLE_CSS)
  writeFileSync(join(agent.path, DATA), DATA_JSON)

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  const page = cinna.page
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(PROMPT)
  await input.press('Enter')
  await expect(fileLink(page, PAGE)).toBeVisible({ timeout: 30_000 })
  return { agentDir: agent.path }
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

/** One line of the XML tree: an element's own first row, found by its start tag. */
function xmlRow(card: Locator, startTag: string): Locator {
  return card.locator('[data-heading-line]').filter({ hasText: startTag })
}

async function closePreview(page: Page): Promise<void> {
  const card = previewCard(page)
  await card.getByRole('button', { name: 'Close preview', exact: true }).click()
  await expect(card).toHaveCount(0)
}

test('an XML file previews as a foldable tree with Contents, and a malformed one as source under a note', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  const page = cinna.page
  const card = previewCard(page)
  const panel = card.getByRole('navigation', { name: 'Contents', exact: true })
  const body = card.locator('div.overflow-auto').filter({ has: page.locator('[data-xml-row]') })

  await test.step('the catalogue opens as a tree, every element unfolded', async () => {
    await fileLink(page, CATALOG).click()
    await expect(xmlRow(card, '<section id="s01">')).toHaveText('<section id="s01">')
    await expect(xmlRow(card, '<title>Title s01-1</title>')).toHaveText('<title>Title s01-1</title>')
    await expect(xmlRow(card, '<book id="s12-b3">')).toHaveCount(1)
    await expect(card.getByText('This XML could not be parsed, so it is shown as source.')).toHaveCount(0)
  })

  await test.step('collapsing a section hides its books and says how many children it has', async () => {
    const s01 = xmlRow(card, '<section id="s01">')
    const chevron = s01.getByRole('button', { name: 'Collapse section', exact: true })
    await expect(chevron).toHaveAttribute('aria-expanded', 'true')
    await chevron.click()
    const expand = s01.getByRole('button', { name: 'Expand section', exact: true })
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    await expect(s01).toHaveText('<section id="s01">…</section>3 children')
    for (const b of BOOKS) await expect(xmlRow(card, `<book id="s01-b${b}">`)).toHaveCount(0)
    await expect(xmlRow(card, '<title>Title s01-1</title>')).toHaveCount(0)
    // Its sibling is untouched.
    await expect(xmlRow(card, '<book id="s02-b1">')).toHaveCount(1)
  })

  await test.step('the Contents panel lists every section and book, in document order', async () => {
    await expect(card.getByRole('button', { name: 'Contents', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await expect(panel.getByRole('button')).toHaveText(CATALOG_ENTRIES)
  })

  await test.step('an entry inside a folded section unfolds it and scrolls the book into view', async () => {
    const s11 = xmlRow(card, '<section id="s11">')
    await s11.getByRole('button', { name: 'Collapse section', exact: true }).click()
    await expect(s11.getByRole('button', { name: 'Expand section', exact: true })).toBeVisible()
    await expect(xmlRow(card, '<book id="s11-b2">')).toHaveCount(0)
    await body.evaluate((el) => (el.scrollTop = 0))
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(0)

    const target = xmlRow(card, '<book id="s11-b2">')
    await panel.getByRole('button', { name: 'book · s11-b2', exact: true }).click()
    await expect(s11.getByRole('button', { name: 'Collapse section', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    await expect(target).toHaveCount(1)
    await expect(target).toBeInViewport()
    await expect(xmlRow(card, '<title>Title s11-2</title>')).toBeVisible()
    expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(500)
    await expect(panel.getByRole('button', { name: 'book · s11-b2', exact: true })).toHaveAttribute(
      'aria-current',
      'location'
    )
    // The section the user folded by hand stays folded.
    await expect(xmlRow(card, '<section id="s01">').getByRole('button', { name: 'Expand section', exact: true })).toHaveCount(1)
    await closePreview(page)
  })

  await test.step('a malformed file says it could not be parsed, above its source, with no Contents', async () => {
    await fileLink(page, BROKEN).click()
    const note = card.getByText('This XML could not be parsed, so it is shown as source.', { exact: true })
    await expect(note).toBeVisible()
    const source = card.getByTestId('code-preview')
    await expect(source).toHaveText(BROKEN_XML.trimEnd())
    const [noteBox, sourceBox] = await Promise.all([note.boundingBox(), source.boundingBox()])
    if (!noteBox || !sourceBox) throw new Error('note or source has no box')
    expect(noteBox.y + noteBox.height).toBeLessThanOrEqual(sourceBox.y)
    await expect(card.locator('[data-xml-row]')).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Contents', exact: true })).toHaveCount(0)
    await closePreview(page)
  })
})

test('an HTML file renders in a sandboxed frame with its local CSS, data and script, and toggles to source', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  const page = cinna.page
  const card = previewCard(page)
  const iframe = card.locator('iframe')
  const frame = page.frameLocator('iframe')
  const view = card.getByRole('group', { name: 'View', exact: true })
  const rendered = view.getByRole('button', { name: 'Rendered', exact: true })
  const sourceButton = view.getByRole('button', { name: 'Source', exact: true })
  let nonce = ''

  await test.step('Rendered runs the script, applies style.css and loads data.json', async () => {
    await fileLink(page, PAGE).click()
    await expect(rendered).toHaveAttribute('aria-pressed', 'true')
    await expect(sourceButton).toHaveAttribute('aria-pressed', 'false')
    await expect(iframe).toHaveCount(1)
    const heading = frame.locator('#heading')
    await expect(heading).toHaveText('Written by the script')
    await expect(heading).toHaveCSS('color', 'rgb(1, 128, 2)')
    await expect(frame.locator('#rows')).toHaveText('Loaded 3 rows')
    nonce = (await frame.locator('#nonce').textContent()) ?? ''
    expect(nonce).toMatch(/^0\.\d+$/)
  })

  await test.step('the frame is sandboxed with exactly the expected tokens', async () => {
    await expect(iframe).toHaveAttribute('sandbox', SANDBOX)
    await expect(iframe).toHaveAttribute('src', /^cinna-preview:\/\//)
  })

  await test.step('the page reaches neither window.api nor its parent', async () => {
    await expect(frame.locator('#probe')).toHaveText('api: undefined; parent document: blocked; parent api: blocked')
  })

  await test.step('Source shows the markup highlighted; Rendered again is the same page, not reloaded', async () => {
    await iframe.evaluate((el) => el.setAttribute('data-e2e-same-frame', 'yes'))
    await sourceButton.click()
    await expect(sourceButton).toHaveAttribute('aria-pressed', 'true')
    const source = card.getByTestId('code-preview')
    await expect(source).toBeVisible()
    await expect(source).toContainText("document.getElementById('heading').textContent = 'Written by the script'")
    await expect(source.locator('.hljs-name').filter({ hasText: /^script$/ })).toHaveCount(2)
    await expect(source.locator('.hljs-attr').filter({ hasText: /^href$/ })).toHaveCount(1)
    await expect(iframe).toBeHidden()

    await rendered.click()
    await expect(rendered).toHaveAttribute('aria-pressed', 'true')
    await expect(source).toHaveCount(0)
    await expect(iframe).toBeVisible()
    await expect(iframe).toHaveAttribute('data-e2e-same-frame', 'yes')
    await expect(frame.locator('#nonce')).toHaveText(nonce)
    await expect(frame.locator('#heading')).toHaveText('Written by the script')
  })

  await test.step('Close removes the preview and its frame', async () => {
    await closePreview(page)
    await expect(page.locator('iframe')).toHaveCount(0)
  })
})

/** Main's launch stubs: a fixed default browser, a logging `open`, a recording `openPath`. */
async function stubBrowserLaunch(cinna: CinnaApp): Promise<{ log: string }> {
  const dir = join(cinna.sandbox.root, 'open-shim')
  const log = join(dir, 'open.log')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'open'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nprintf -- '--\\n' >> '${log}'\nexit 0\n`)
  chmodSync(join(dir, 'open'), 0o755)
  await cinna.electronApp.evaluate(
    ({ app, shell }, { shimDir, browser }) => {
      const store = globalThis as unknown as { __e2eOpenPath: string[] }
      store.__e2eOpenPath = []
      app.getApplicationInfoForProtocol = (async () => ({
        name: 'E2E Browser',
        path: browser,
        icon: null
      })) as unknown as typeof app.getApplicationInfoForProtocol
      shell.openPath = async (p: string) => {
        store.__e2eOpenPath.push(p)
        return ''
      }
      process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`
    },
    { shimDir: dir, browser: FAKE_BROWSER }
  )
  return { log }
}

function launches(log: string): string[][] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('--\n')
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.trimEnd().split('\n'))
}

test('Open in browser, from the right-click menu and the preview menu, hands the page to the default browser', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  const { agentDir } = await arrange(cinna)
  const pagePath = realpathSync(join(agentDir, PAGE))
  const { log } = await stubBrowserLaunch(cinna)
  const expected = ['-a', FAKE_BROWSER, pagePath]
  const page = cinna.page
  const messageMenu = page.getByRole('menu', { name: 'Message actions', exact: true })

  await test.step('an .xml reference does not offer it', async () => {
    await fileLink(page, CATALOG).click({ button: 'right' })
    await expect(messageMenu.getByRole('menuitem')).toHaveText([
      'Copy contents',
      'Save to Notes',
      'Copy full path',
      'Reference in a new chat'
    ])
    await page.keyboard.press('Escape')
    await expect(messageMenu).toHaveCount(0)
  })

  await test.step('an .html reference offers it first, and it launches the browser on the file', async () => {
    await fileLink(page, PAGE).click({ button: 'right' })
    await expect(messageMenu.getByRole('menuitem')).toHaveText([
      'Open in browser',
      'Copy contents',
      'Save to Notes',
      'Copy full path',
      'Reference in a new chat'
    ])
    await expect(messageMenu.getByRole('separator')).toHaveCount(2)
    await messageMenu.getByRole('menuitem', { name: 'Open in browser', exact: true }).click()
    await expect(messageMenu).toHaveCount(0)
    await expect.poll(() => launches(log)).toEqual([expected])
  })

  await test.step('the preview’s ⋯ menu offers it between Open and Open folder, and it launches the browser', async () => {
    const card = previewCard(page)
    await fileLink(page, PAGE).click()
    await expect(page.frameLocator('iframe').locator('#heading')).toHaveText('Written by the script')
    await card.getByRole('button', { name: 'More file actions', exact: true }).click()
    const fileMenu = page.getByRole('menu', { name: 'File actions', exact: true })
    await expect(fileMenu.getByRole('menuitem')).toHaveText(['Open', 'Open in browser', 'Open folder'])
    await fileMenu.getByRole('menuitem', { name: 'Open in browser', exact: true }).click()
    await expect(fileMenu).toHaveCount(0)
    await expect.poll(() => launches(log)).toEqual([expected, expected])
    // The preview stays open, with no error line.
    await expect(card.getByText('No browser could open this file.')).toHaveCount(0)
    await expect(card.locator('iframe')).toBeVisible()
    await closePreview(page)
  })

  // The launch went through `open -a`; the OS-default fallback never ran.
  const fallbacks = await cinna.electronApp.evaluate(
    () => (globalThis as unknown as { __e2eOpenPath: string[] }).__e2eOpenPath
  )
  expect(fallbacks).toEqual([])
})
