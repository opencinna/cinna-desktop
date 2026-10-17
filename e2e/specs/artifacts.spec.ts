import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { Locator, Page } from '@playwright/test'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { linkSandboxAccount } from '../fixtures/jobRemoteService'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { scriptAcpEngine, SCRIPT_MODEL, type ScriptAcpEngine, type ScriptAcpHeld } from '../fixtures/scriptAcpEngine'

/**
 * Artifacts against a fake cinna-core: a person publishes a folder an agent
 * mentioned (A), an agent publishes through `artifacts_publish` behind the
 * approval card (B), an instance that does not keep artifacts offers no
 * Publish… at all (C), and Publish… arrives without a window focus when core's
 * discovery is unreachable at launch, and at once on the next launch (E).
 *
 * ## What is real and what is not
 *
 * Real: the profile's discovery read and its `artifacts` gate, main's
 * inspection walk and exclusions, the zip it builds and the multipart upload,
 * `published_artifacts` / `chat_artifact_cards`, the Publish dialog, the card
 * and its Share popover, main's clipboard, the session's `cinna` loopback MCP
 * server offering `artifacts_publish`, the approval registry and its card, the
 * skip rule's fresh read of core. Faked: cinna-core itself — a loopback HTTP
 * server answering the discovery document, `/artifacts/capabilities`, create,
 * revisions, detail, PATCH and links, and recording each upload's fields and
 * zip entry names — and the agent, `scriptAcpAgent.mjs`, whose turns say only
 * what the test releases. The profile is made a signed-in Cinna account by
 * `linkSandboxAccount` (a token written into the sandbox DB), so no OAuth runs.
 * No model, no network beyond loopback, nothing billed.
 *
 * ## What it does not prove
 *
 * Core's own handling (it re-applies the exclusions, decides the kind, serves
 * content sandboxed) — `live-artifacts.spec.ts` against a real core. Edit… on
 * an approval, the Inbox answering an approval, the over-limit and start-page
 * paths, the file preview's Publish… — unit-tested in
 * `PublishArtifactDialog.test.tsx`, `ArtifactPublishTool.test.tsx`,
 * `artifactToolProvider.test.ts`, `publishService.test.ts`.
 */

const AGENT = 'Quarterly Reporter'
const INSTANCE = 'Acme Labs'
const CHAT = 'Write up the third quarter.'
const FOLDER = 'reports/q3'

const SUMMARY_TEXT = '# Q3\n\nRevenue grew 12 percent.\n'
const DATA_TEXT = 'month,revenue\nJul,10\nAug,11\nSep,12\n'

interface Upload {
  path: string
  fields: Record<string, string>
  entries: string[]
  contents: Record<string, string>
}

interface FakeArtifact {
  id: string
  title: string
  kind: 'site' | 'files'
  revision: number
  visibility: 'private' | 'instance'
  links: Array<{ id: string; token: string; revoked: boolean; createdAt: string }>
}

/** The names and contents of a zip's entries, read from its central directory. */
function unzip(zip: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  const at = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (at < 0) throw new Error('not a zip: no end of central directory')
  const total = zip.readUInt16LE(at + 10)
  let entry = zip.readUInt32LE(at + 16)
  for (let i = 0; i < total; i++) {
    if (zip.readUInt32LE(entry) !== 0x02014b50) throw new Error('bad central directory entry')
    const method = zip.readUInt16LE(entry + 10)
    const compressed = zip.readUInt32LE(entry + 20)
    const nameLength = zip.readUInt16LE(entry + 28)
    const extra = zip.readUInt16LE(entry + 30)
    const comment = zip.readUInt16LE(entry + 32)
    const local = zip.readUInt32LE(entry + 42)
    const name = zip.subarray(entry + 46, entry + 46 + nameLength).toString('utf8')
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(dataAt, dataAt + compressed)
    out[name] = (method === 8 ? inflateRawSync(raw) : raw).toString('utf8')
    entry += 46 + nameLength + extra + comment
  }
  return out
}

/** Text fields and the `archive` file of a `multipart/form-data` body. */
function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; archive: Buffer | null } {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1]
  if (!boundary) throw new Error(`no boundary in ${contentType}`)
  const delimiter = Buffer.from(`--${boundary}`)
  const fields: Record<string, string> = {}
  let archive: Buffer | null = null
  let start = body.indexOf(delimiter)
  while (start >= 0) {
    const next = body.indexOf(delimiter, start + delimiter.length)
    if (next < 0) break
    const part = body.subarray(start + delimiter.length + 2, next - 2)
    const split = part.indexOf('\r\n\r\n')
    const headers = part.subarray(0, split).toString('utf8')
    const content = part.subarray(split + 4)
    const name = /name="([^"]+)"/.exec(headers)?.[1] ?? ''
    if (name === 'archive') archive = Buffer.from(content)
    else fields[name] = content.toString('utf8')
    start = next
  }
  return { fields, archive }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/** A loopback cinna-core with just the artifact routes; `artifacts: false` drops the capability from discovery. */
async function fakeCore(options: { artifacts: boolean }) {
  let host = ''
  const artifacts = new Map<string, FakeArtifact>()
  const uploads: Upload[] = []
  const requests: string[] = []
  const patches: Array<{ id: string; body: unknown }> = []
  /** Discovery answers 503 until this time (an instance not reachable yet); see `discoveryDown`. */
  let discoveryDownUntil = 0
  const discovery = { failed: 0, served: 0 }
  const pageUrl = (id: string): string => `${host}/artifact/${id}`
  const summary = (a: FakeArtifact) => ({
    id: a.id,
    title: a.title,
    kind: a.kind,
    revision_number: a.revision,
    current_revision_number: a.revision,
    visibility: a.visibility,
    live_link_count: a.links.filter((link) => !link.revoked).length,
    url: pageUrl(a.id)
  })
  const detail = (a: FakeArtifact) => ({
    ...summary(a),
    is_owner: true,
    owner_name: 'E2E Owner',
    grant_count: 0,
    links: a.links.map((link) => ({
      id: link.id,
      token_prefix: link.token.slice(0, 6),
      label: null,
      created_at: link.createdAt,
      expires_at: null,
      revoked_at: link.revoked ? new Date().toISOString() : null,
      expired: false,
      blocked: false,
      needs_code: false
    }))
  })

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const body = await readBody(req)
    requests.push(`${req.method} ${url.pathname}`)
    res.setHeader('content-type', 'application/json')
    const send = (value: unknown, status = 200): void => {
      res.statusCode = status
      res.end(JSON.stringify(value))
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/cinna-desktop') {
      if (Date.now() < discoveryDownUntil) {
        discovery.failed += 1
        send({ detail: 'Starting up.' }, 503)
        return
      }
      discovery.served += 1
      send({
        authorization_endpoint: `${host}/oauth/authorize`,
        token_endpoint: `${host}/oauth/token`,
        userinfo_endpoint: `${host}/oauth/userinfo`,
        instance_name: INSTANCE,
        ...(options.artifacts ? { artifacts: 1 } : {})
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/artifacts/capabilities') {
      send({ limits: { max_revision_bytes: 10 * 1024 * 1024, max_revision_files: 500, max_file_bytes: 5 * 1024 * 1024 } })
      return
    }
    const upload = (path: string): Upload | null => {
      const { fields, archive } = parseMultipart(body, String(req.headers['content-type'] ?? ''))
      if (!archive) return null
      const contents = unzip(archive)
      const entry: Upload = { path, fields, entries: Object.keys(contents).sort(), contents }
      uploads.push(entry)
      return entry
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/artifacts') {
      const entry = upload(url.pathname)
      if (!entry) return send({ detail: 'No archive.' }, 422)
      const artifact: FakeArtifact = {
        id: randomUUID(),
        title: entry.fields.title,
        kind: entry.fields.entry_path ? 'site' : 'files',
        revision: 1,
        visibility: 'private',
        links: []
      }
      artifacts.set(artifact.id, artifact)
      send({ ...summary(artifact), excluded: [] }, 201)
      return
    }
    const match = /^\/api\/v1\/artifacts\/([0-9a-f-]{36})(\/revisions|\/links(?:\/([0-9a-f-]{36}))?)?$/.exec(url.pathname)
    const artifact = match ? artifacts.get(match[1]) : undefined
    if (match && !artifact) return send({ detail: 'Not found.' }, 404)
    if (artifact && match) {
      const [, , sub, linkId] = match
      if (req.method === 'POST' && sub === '/revisions') {
        const entry = upload(url.pathname)
        if (!entry) return send({ detail: 'No archive.' }, 422)
        artifact.revision += 1
        artifact.title = entry.fields.title || artifact.title
        send({ ...summary(artifact), excluded: [] }, 201)
        return
      }
      if (req.method === 'GET' && !sub) return send(detail(artifact))
      if (req.method === 'PATCH' && !sub) {
        const patch = JSON.parse(body.toString('utf8')) as { visibility?: 'private' | 'instance' }
        patches.push({ id: artifact.id, body: patch })
        if (patch.visibility) artifact.visibility = patch.visibility
        return send(summary(artifact))
      }
      if (req.method === 'POST' && sub === '/links') {
        const link = { id: randomUUID(), token: randomUUID().replaceAll('-', ''), revoked: false, createdAt: new Date().toISOString() }
        artifact.links.push(link)
        return send({ id: link.id, url: `${host}/a/${link.token}`, token_prefix: link.token.slice(0, 6) }, 201)
      }
      if (req.method === 'DELETE' && linkId) {
        const link = artifact.links.find((candidate) => candidate.id === linkId)
        if (!link) return send({ detail: 'No such link.' }, 404)
        link.revoked = true
        res.statusCode = 204
        res.end()
        return
      }
    }
    send({ detail: 'No fixture route for this request' }, 404)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    host,
    artifacts,
    uploads,
    requests,
    patches,
    pageUrl,
    discovery,
    /** Answer discovery with 503 for the next `ms` (0 ends an outage). */
    discoveryDown(ms: number): void {
      discoveryDownUntil = Date.now() + ms
    },
    async close(): Promise<void> {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
type FakeCore = Awaited<ReturnType<typeof fakeCore>>

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
}

/**
 * A folder agent on the scripted engine, its files on disk, the profile
 * linked to the fake core, and a chat opened through the agent's own
 * composer with the first prompt waiting in `fake.calls[0]`.
 */
async function arrange(
  cinna: CinnaApp,
  fake: ScriptAcpEngine,
  core: FakeCore,
  files: Record<string, string>,
  options: { discoveryOutageMs?: number } = {}
): Promise<{ agentId: string; agentDir: string; chatId: string }> {
  await cinna.skipOnboarding()
  await fake.install(cinna)
  await cinna.page.evaluate(async ({ host, model }) => {
    await window.api.settings.set('autoChatTitles', false)
    const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Artifacts fixture', baseUrl: host, enabled: true })
    await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
  }, { host: fake.host, model: SCRIPT_MODEL })
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, AGENT)
  writeFiles(agent.path, files)
  await linkSandboxAccount(cinna, core.host)

  // The launch that first reads the linked account finds core not answering yet.
  if (options.discoveryOutageMs) core.discoveryDown(options.discoveryOutageMs)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(CHAT)
  await input.press('Enter')
  await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(1)
  const chats = await page.evaluate(() => window.api.chat.list())
  const chat = chats.find((row) => row.title === CHAT) ?? chats[0]
  expect(chat, JSON.stringify(chats)).toBeTruthy()
  return { agentId: agent.id, agentDir: agent.path, chatId: chat.id }
}

function folderLink(page: Page, text: string): Locator {
  return page.getByRole('button', { name: `Show ${text} in its folder`, exact: true })
}

async function openMenuOn(page: Page, link: Locator): Promise<Locator> {
  await link.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Message actions', exact: true })
  await expect(menu).toBeVisible()
  return menu
}

function publishDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Publish to Cinna', exact: true })
}

function card(page: Page, title: string): Locator {
  return page.getByRole('group', { name: `Artifact ${title}`, exact: true })
}

/** A card's action: it fades in beside the card on hover, so point at the card first. */
async function cardAction(page: Page, title: string, name: string): Promise<Locator> {
  await card(page, title).locator('[data-artifact-card-body]').hover()
  const action = card(page, title).getByRole('button', { name, exact: true })
  await expect(card(page, title).locator('[data-artifact-card-drawer="out"]')).toBeVisible()
  return action
}

function readClipboard(cinna: CinnaApp): Promise<string> {
  return cinna.electronApp.evaluate(({ clipboard }) => clipboard.readText())
}

function writeClipboard(cinna: CinnaApp, text: string): Promise<void> {
  return cinna.electronApp.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
}

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] }

function toolResult(held: ScriptAcpHeld): ToolResult {
  return (held.params.results as { result: ToolResult }[])[0].result
}

function toolText(result: ToolResult): string {
  return result.content.find((item) => item.type === 'text')?.text ?? ''
}

test('A a person publishes a folder the agent named, copies its link, shares it, and updates it as rev 2', async ({ cinna }) => {
  test.setTimeout(180_000)
  const fake = await scriptAcpEngine()
  const core = await fakeCore({ artifacts: true })
  const saved = await readClipboard(cinna)
  try {
    const { chatId } = await arrange(cinna, fake, core, {
      [`${FOLDER}/summary.md`]: SUMMARY_TEXT,
      [`${FOLDER}/data.csv`]: DATA_TEXT,
      [`${FOLDER}/.env`]: 'REPORT_TOKEN=e2e-not-a-real-token\n',
      [`${FOLDER}/.draft.md`]: '# draft\n',
      [`${FOLDER}/node_modules/x.js`]: 'module.exports = 1\n'
    })
    fake.calls[0].release(`The quarter is written up in \`${FOLDER}\`.`)
    await expect(folderLink(cinna.page, FOLDER)).toBeVisible({ timeout: 30_000 })
    let artifactId = ''

    await test.step('Publish… on the folder reference shows what is sent and what is left out', async () => {
      const page = cinna.page
      const menu = await openMenuOn(page, folderLink(page, FOLDER))
      await expect(menu.getByRole('menuitem')).toHaveText(['Copy full path', 'Show in the folder', 'Reference in a new chat', 'Publish…'])
      await menu.getByRole('menuitem', { name: 'Publish…', exact: true }).click()
      const dialog = publishDialog(page)
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('q3')
      const rows = dialog.getByRole('list', { name: 'Files to publish' }).getByRole('listitem')
      await expect(rows).toHaveText([
        '.draft.mdhidden file',
        '.envsecret file',
        `data.csv${DATA_TEXT.length} B`,
        'node_modules/dependencies',
        `summary.md${SUMMARY_TEXT.length} B`
      ])
      // Left out is struck through and says why; what is sent is not.
      await expect(dialog.getByTitle('.draft.md — left out: hidden file', { exact: true }).locator('span').first()).toHaveClass(/line-through/)
      await expect(dialog.getByTitle('.env — left out: secret file', { exact: true }).locator('span').first()).toHaveClass(/line-through/)
      await expect(dialog.getByTitle('node_modules/ — left out: dependencies', { exact: true }).locator('span').first()).toHaveClass(/line-through/)
      await expect(dialog.getByTitle('summary.md', { exact: true }).locator('span').first()).not.toHaveClass(/line-through/)
      await expect(dialog.locator('[data-artifact-kind]')).toHaveText('2 files')
      await expect(dialog.locator('[data-artifact-total]')).toHaveText(`${SUMMARY_TEXT.length + DATA_TEXT.length} B of 10 MB`)
      await expect(dialog.getByText(`A new artifact on ${INSTANCE}`, { exact: true })).toBeVisible()
      const who = dialog.getByRole('group', { name: 'Who can see it' })
      await expect(who.getByRole('radio')).toHaveCount(3)
      await expect(who.getByRole('radio', { name: 'Only me', exact: true })).toBeChecked()
      await expect(who.getByRole('radio', { name: `Everyone on ${INSTANCE}`, exact: true })).not.toBeChecked()
      await expect(who.getByRole('radio', { name: 'Anyone with a link', exact: true })).not.toBeChecked()
    })

    await test.step('Publish uploads only the kept files and anchors a card after the message', async () => {
      const page = cinna.page
      const dialog = publishDialog(page)
      await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(card(page, 'q3')).toBeVisible()
      await expect(card(page, 'q3')).toContainText('rev 1 · only you')
      expect(core.uploads).toHaveLength(1)
      const [upload] = core.uploads
      expect(upload.path).toBe('/api/v1/artifacts')
      expect(upload.entries).toEqual(['data.csv', 'summary.md'])
      expect(upload.contents['summary.md']).toBe(SUMMARY_TEXT)
      expect(upload.fields).toMatchObject({ title: 'q3', source_kind: 'desktop', source_label: `${AGENT} · ${FOLDER}` })
      // "Only me" is core's default: no PATCH follows the upload.
      expect(core.patches).toEqual([])
      artifactId = [...core.artifacts.keys()][0]
      const cards = await page.evaluate((id) => window.api.artifacts.cards(id), chatId)
      expect(cards.map((row) => row.artifact)).toEqual([expect.objectContaining({ id: artifactId, revision: 1, visibility: 'private', url: core.pageUrl(artifactId) })])
    })

    await test.step('Copy link puts the core page on the clipboard', async () => {
      const page = cinna.page
      await writeClipboard(cinna, 'e2e clipboard sentinel')
      await (await cardAction(page, 'q3', 'Copy link to q3')).click()
      await expect.poll(() => readClipboard(cinna)).toBe(core.pageUrl(artifactId))
      await expect(card(page, 'q3').getByText('Copied', { exact: true })).toBeVisible()
    })

    await test.step('Share… changes who can see it, and creates and revokes a public link', async () => {
      const page = cinna.page
      await (await cardAction(page, 'q3', 'Share q3')).click()
      const share = page.getByRole('dialog', { name: 'Share q3', exact: true })
      await expect(share.getByText('Anyone with a link can open it. None yet.', { exact: true })).toBeVisible()
      await share.getByRole('radio', { name: `Everyone on ${INSTANCE}`, exact: true }).click()
      await expect.poll(() => core.patches).toEqual([{ id: artifactId, body: { visibility: 'instance' } }])
      await expect(share.getByRole('radio', { name: `Everyone on ${INSTANCE}`, exact: true })).toBeChecked()
      await expect(card(page, 'q3')).toContainText(`rev 1 · everyone on ${INSTANCE}`)

      await share.getByRole('button', { name: 'Create link', exact: true }).click()
      const link = core.artifacts.get(artifactId)!.links[0]
      const fresh = share.locator('[data-artifact-fresh-link]')
      await expect(fresh.locator('code')).toHaveText(`${core.host}/a/${link.token}`)
      await expect(fresh).toContainText('Shown once — copy it now.')
      await expect(card(page, 'q3')).toContainText(`rev 1 · everyone on ${INSTANCE} · 1 public link`)

      const prefix = link.token.slice(0, 6)
      await share.getByRole('button', { name: `Revoke link ${prefix}`, exact: true }).click()
      await expect(share.getByText('Revoke?', { exact: true })).toBeVisible()
      await share.getByRole('button', { name: 'Revoke', exact: true }).click()
      await expect(share.locator('[data-artifact-link="revoked"]')).toContainText('Revoked')
      expect(core.artifacts.get(artifactId)!.links[0].revoked).toBe(true)
      await page.keyboard.press('Escape')
      await expect(share).toHaveCount(0)
      await expect(card(page, 'q3')).toContainText(`rev 1 · everyone on ${INSTANCE}`)
      await expect(card(page, 'q3')).not.toContainText('public link')
      // Back to Only me for the update below.
      await (await cardAction(page, 'q3', 'Share q3')).click()
      await share.getByRole('radio', { name: 'Only me', exact: true }).click()
      await expect(share.getByRole('radio', { name: 'Only me', exact: true })).toBeChecked()
      await expect(card(page, 'q3')).toContainText('rev 1 · only you')
      await page.keyboard.press('Escape')
    })

    await test.step('the card survives a restart', async () => {
      await cinna.relaunch()
      await cinna.skipOnboarding()
      const page = cinna.page
      await page.getByText(CHAT, { exact: true }).first().click()
      await expect(folderLink(page, FOLDER)).toBeVisible({ timeout: 30_000 })
      await expect(card(page, 'q3')).toHaveCount(1)
      await expect(card(page, 'q3')).toContainText('rev 1 · only you')
    })

    await test.step('Publish… again preselects Update, and the result is rev 2 of the same artifact', async () => {
      const page = cinna.page
      writeFileSync(join((await page.evaluate(() => window.api.localAgents.list())).agents.find((a) => a.name === AGENT)!.path!, FOLDER, 'summary.md'), `${SUMMARY_TEXT}\nUpdated.\n`)
      const menu = await openMenuOn(page, folderLink(page, FOLDER))
      await menu.getByRole('menuitem', { name: 'Publish…', exact: true }).click()
      const dialog = publishDialog(page)
      const as = dialog.getByRole('radiogroup', { name: 'Publish as' })
      await expect(as.getByRole('radio', { name: 'Update “q3” (rev 1)', exact: true })).toBeChecked()
      await expect(as.getByRole('radio', { name: 'Publish as new', exact: true })).not.toBeChecked()
      await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(card(page, 'q3')).toHaveCount(1)
      await expect(card(page, 'q3')).toContainText('rev 2 · only you')
      expect(core.uploads).toHaveLength(2)
      expect(core.uploads[1].path).toBe(`/api/v1/artifacts/${artifactId}/revisions`)
      expect(core.uploads[1].entries).toEqual(['data.csv', 'summary.md'])
      expect(core.uploads[1].contents['summary.md']).toBe(`${SUMMARY_TEXT}\nUpdated.\n`)
      expect(core.artifacts.size).toBe(1)
      expect(core.artifacts.get(artifactId)!.revision).toBe(2)
    })
    expect(fake.unexpected).toEqual([])
  } finally {
    await writeClipboard(cinna, saved).catch(() => undefined)
    await fake.close()
    await core.close()
  }
})

test('B an agent’s artifacts_publish waits on the card, skips it on a private republish, and hears a Deny', async ({ cinna }) => {
  test.setTimeout(180_000)
  const fake = await scriptAcpEngine()
  const core = await fakeCore({ artifacts: true })
  try {
    const { chatId } = await arrange(cinna, fake, core, {
      'out/summary.md': SUMMARY_TEXT,
      'out/other.md': '# Other\n'
    })

    await test.step('the call raises an approval card; Publish returns the artifact to the agent', async () => {
      const page = cinna.page
      expect(fake.calls[0].text).toContain(CHAT)
      fake.calls[0].release({ tools: [{ name: 'artifacts_publish', args: { path: 'out/summary.md', title: 'Q3 summary' } }] })
      const approval = page.getByRole('group', { name: 'Publish request: Q3 summary', exact: true })
      await expect(approval).toBeVisible({ timeout: 30_000 })
      await expect(approval).toContainText(`${AGENT} wants to publish “Q3 summary”`)
      await expect(approval).toContainText('Markdown document · out/summary.md')
      await expect(approval).toContainText('new artifact · visible to only you')
      await expect(approval.getByRole('button')).toHaveText(['Deny', 'Edit…', 'Publish'])
      // The same request is an Inbox row while it waits.
      await expect.poll(async () => (await page.evaluate(() => window.api.inbox.list())).entries.map((entry) => entry.requestId), { timeout: 20_000 })
        .toContainEqual(expect.stringMatching(/^art_/))
      expect(core.uploads).toEqual([])

      await approval.getByRole('button', { name: 'Publish', exact: true }).click()
      await expect.poll(() => fake.tools.length, { timeout: 30_000 }).toBe(1)
      const result = toolResult(fake.tools[0])
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      const published = JSON.parse(toolText(result))
      const id = [...core.artifacts.keys()][0]
      expect(published).toEqual({ artifact_id: id, revision: 1, url: core.pageUrl(id), kind: 'files', file_count: 1, size_bytes: SUMMARY_TEXT.length, excluded: [] })
      expect(core.uploads[0].entries).toEqual(['summary.md'])
      expect(core.uploads[0].fields).toMatchObject({ title: 'Q3 summary', source_kind: 'desktop' })
      await expect(approval).toHaveCount(0)
      await expect(card(page, 'Q3 summary')).toBeVisible()
    })

    await test.step('a second call for the same private path publishes rev 2 with no card', async () => {
      fake.tools[0].release({ tools: [{ name: 'artifacts_publish', args: { path: 'out/summary.md', title: 'Q3 summary' } }] })
      // Nothing is clicked: the result arriving is the proof that nothing waited on a card.
      await expect.poll(() => fake.tools.length, { timeout: 30_000 }).toBe(2)
      const result = toolResult(fake.tools[1])
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      const id = [...core.artifacts.keys()][0]
      expect(JSON.parse(toolText(result))).toMatchObject({ artifact_id: id, revision: 2, url: core.pageUrl(id) })
      expect(core.uploads.map((upload) => upload.path)).toEqual(['/api/v1/artifacts', `/api/v1/artifacts/${id}/revisions`])
      expect(await cinna.page.evaluate((chat) => window.api.artifacts.approvals(chat), chatId)).toEqual([])
    })

    await test.step('a call for another path, denied, comes back to the agent as a refusal', async () => {
      const page = cinna.page
      fake.tools[1].release({ tools: [{ name: 'artifacts_publish', args: { path: 'out/other.md', title: 'Other notes' } }] })
      const approval = page.getByRole('group', { name: 'Publish request: Other notes', exact: true })
      await expect(approval).toBeVisible({ timeout: 30_000 })
      await approval.getByRole('button', { name: 'Deny', exact: true }).click()
      await expect.poll(() => fake.tools.length, { timeout: 30_000 }).toBe(3)
      const result = toolResult(fake.tools[2])
      expect(result.isError).toBe(true)
      expect(toolText(result)).toBe('The user declined to publish out/other.md; do not retry unless they ask.')
      expect(core.uploads).toHaveLength(2)
      expect(core.artifacts.size).toBe(1)
      fake.tools[2].release({ text: 'Published the summary; left the other notes alone.' })
      await expect(page.getByText('Published the summary; left the other notes alone.', { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(approval).toHaveCount(0)
      await expect(page.getByText('Not published — you declined', { exact: true })).toBeVisible()
    })
    expect(fake.unexpected).toEqual([])
  } finally {
    await fake.close()
    await core.close()
  }
})

test('D an approval answered from the Inbox publishes; Edit… publishes under the title the person chose', async ({ cinna }) => {
  test.setTimeout(180_000)
  const fake = await scriptAcpEngine()
  const core = await fakeCore({ artifacts: true })
  try {
    await arrange(cinna, fake, core, {
      'out/summary.md': SUMMARY_TEXT,
      'out/other.md': '# Other\n'
    })

    await test.step('Publish from the Inbox reaches the agent, and the transcript card settles', async () => {
      const page = cinna.page
      fake.calls[0].release({ tools: [{ name: 'artifacts_publish', args: { path: 'out/summary.md', title: 'Inbox summary' } }] })
      const approval = page.getByRole('group', { name: 'Publish request: Inbox summary', exact: true })
      await expect(approval).toBeVisible({ timeout: 30_000 })

      await page.getByRole('button', { name: /^Inbox/ }).click()
      await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
      const row = page.getByRole('article').filter({ hasText: `${AGENT} wants to publish “Inbox summary”` })
      await expect(row).toHaveCount(1, { timeout: 20_000 })
      await expect(row).toContainText(`${AGENT} wants to publish “Inbox summary” — 1 file, ${SUMMARY_TEXT.length} B, visible to only you.`)
      await row.getByRole('button', { name: 'Answer', exact: true }).click()
      const modal = page.getByLabel('Question', { exact: true })
      await modal.getByRole('button', { name: /^Publish/ }).click()
      await modal.getByRole('button', { name: 'Send answer', exact: true }).click()

      await expect.poll(() => fake.tools.length, { timeout: 30_000 }).toBe(1)
      const result = toolResult(fake.tools[0])
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      const id = [...core.artifacts.keys()][0]
      expect(JSON.parse(toolText(result))).toEqual({ artifact_id: id, revision: 1, url: core.pageUrl(id), kind: 'files', file_count: 1, size_bytes: SUMMARY_TEXT.length, excluded: [] })
      expect(core.uploads.map((upload) => upload.fields.title)).toEqual(['Inbox summary'])
      expect(await page.evaluate((chat) => window.api.artifacts.approvals(chat), (await page.evaluate(() => window.api.chat.list()))[0].id)).toEqual([])

      // Back in the chat: the request became the artifact's card.
      await page.getByRole('button', { name: 'Chats', exact: true }).click()
      await expect(page.getByRole('group', { name: 'Publish request: Inbox summary', exact: true })).toHaveCount(0)
      await expect(card(page, 'Inbox summary')).toBeVisible({ timeout: 15_000 })
    })

    await test.step('Edit… opens the dialog for the agent; the edited title is what is published and returned', async () => {
      const page = cinna.page
      fake.tools[0].release({ tools: [{ name: 'artifacts_publish', args: { path: 'out/other.md', title: 'Agent title' } }] })
      const approval = page.getByRole('group', { name: 'Publish request: Agent title', exact: true })
      await expect(approval).toBeVisible({ timeout: 30_000 })
      await approval.getByRole('button', { name: 'Edit…', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: `Publish for ${AGENT}`, exact: true })
      await expect(dialog).toBeVisible()
      const title = dialog.getByLabel('Title', { exact: true })
      await expect(title).toHaveValue('Agent title')
      await expect(dialog.getByRole('list', { name: 'Files to publish' }).getByRole('listitem')).toHaveText(['other.md8 B'])
      await title.fill('Edited by me')
      await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
      await expect(dialog).toHaveCount(0)

      await expect.poll(() => fake.tools.length, { timeout: 30_000 }).toBe(2)
      const result = toolResult(fake.tools[1])
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      const published = JSON.parse(toolText(result))
      const edited = [...core.artifacts.values()].find((artifact) => artifact.title === 'Edited by me')
      expect(edited, JSON.stringify([...core.artifacts.values()])).toBeTruthy()
      // The schema's result has no title: it names the artifact that was uploaded under the edited one.
      expect(published).toMatchObject({ artifact_id: edited!.id, revision: 1, url: core.pageUrl(edited!.id), file_count: 1 })
      expect(core.uploads.map((upload) => upload.fields.title)).toEqual(['Inbox summary', 'Edited by me'])
      expect(core.uploads[1].entries).toEqual(['other.md'])
      await expect(approval).toHaveCount(0)
      await expect(card(page, 'Edited by me')).toBeVisible()
      await expect(card(page, 'Agent title')).toHaveCount(0)
      fake.tools[1].release({ text: 'Both are published.' })
      await expect(page.getByText('Both are published.', { exact: true })).toBeVisible({ timeout: 30_000 })
    })
    expect(fake.unexpected).toEqual([])
  } finally {
    await fake.close()
    await core.close()
  }
})

test('C an instance whose discovery lacks artifacts offers no Publish…', async ({ cinna }) => {
  test.setTimeout(120_000)
  const fake = await scriptAcpEngine()
  const core = await fakeCore({ artifacts: false })
  try {
    await arrange(cinna, fake, core, { [`${FOLDER}/summary.md`]: SUMMARY_TEXT })
    fake.calls[0].release(`The quarter is written up in \`${FOLDER}\`.`)
    const page = cinna.page
    await expect(folderLink(page, FOLDER)).toBeVisible({ timeout: 30_000 })
    // The gate was really asked, and said no.
    expect(core.requests).toContain('GET /.well-known/cinna-desktop')
    expect((await page.evaluate(() => window.api.artifacts.support())).supported).toBe(false)
    const menu = await openMenuOn(page, folderLink(page, FOLDER))
    await expect(menu.getByRole('menuitem')).toHaveText(['Copy full path', 'Show in the folder', 'Reference in a new chat'])
    await page.keyboard.press('Escape')
    expect(core.requests.filter((request) => request.startsWith('POST'))).toEqual([])
    expect(fake.unexpected).toEqual([])
  } finally {
    await fake.close()
    await core.close()
  }
})

test('E Publish… arrives without a window focus when discovery fails at launch, and at once on the next launch', async ({ cinna }) => {
  test.setTimeout(150_000)
  const fake = await scriptAcpEngine()
  const core = await fakeCore({ artifacts: true })
  try {
    // About three seconds of 503s from discovery after the launch that links the account.
    await arrange(cinna, fake, core, { [`${FOLDER}/summary.md`]: SUMMARY_TEXT }, { discoveryOutageMs: 3_000 })
    fake.calls[0].release(`The quarter is written up in \`${FOLDER}\`.`)
    const page = cinna.page

    await test.step('main retries the unreachable core on its own and pushes the answer; a menu opened after it has Publish…', async () => {
      await expect(folderLink(page, FOLDER)).toBeVisible({ timeout: 30_000 })
      // The outage was real: main asked during it and was refused.
      expect(core.discovery.failed).toBeGreaterThan(0)
      // Main's retry reaches core (the window never gets focus under the harness)…
      await expect.poll(() => core.discovery.served, { timeout: 30_000 }).toBeGreaterThan(0)
      // …and main says yes. This asks main directly; the renderer's store moves only on main's push.
      await expect.poll(() => page.evaluate(() => window.api.artifacts.support()).then((s) => s.supported), { timeout: 30_000 }).toBe(true)
      const menu = await openMenuOn(page, folderLink(page, FOLDER))
      await expect(menu.getByRole('menuitem')).toHaveText(['Copy full path', 'Show in the folder', 'Reference in a new chat', 'Publish…'])
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
    })

    await test.step('the next launch offers Publish… from the kept answer while discovery is still down', async () => {
      core.discoveryDown(120_000)
      const failedBefore = core.discovery.failed
      const servedBefore = core.discovery.served
      await cinna.relaunch()
      await cinna.skipOnboarding()
      await cinna.page.getByText(CHAT, { exact: true }).first().click()
      await expect(folderLink(cinna.page, FOLDER)).toBeVisible({ timeout: 30_000 })
      const menu = await openMenuOn(cinna.page, folderLink(cinna.page, FOLDER))
      await expect(menu.getByRole('menuitem')).toHaveText(['Copy full path', 'Show in the folder', 'Reference in a new chat', 'Publish…'])
      // Core has not answered this launch: the item came from the kept answer.
      expect(core.discovery.served).toBe(servedBefore)
      await expect.poll(() => core.discovery.failed, { timeout: 10_000 }).toBeGreaterThan(failedBefore)
      await cinna.page.keyboard.press('Escape')
    })
    expect(fake.unexpected).toEqual([])
  } finally {
    await fake.close()
    await core.close()
  }
})
