import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { linkSandboxAccount } from '../fixtures/jobRemoteService'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { scriptAcpEngine, SCRIPT_MODEL, type ScriptAcpEngine } from '../fixtures/scriptAcpEngine'

/**
 * Marketplace skills against a fake cinna-core: a kit agent's Addons → Skills
 * → Add, the modal's Marketplaces source (search, marketplace filter, an
 * unsupported entry), Add (Adding… → Added, the `marketplace_skills[]` pin, the
 * read-only cache), what a scripted OpenCode session is handed, Update when
 * the entry moves to a new snapshot, "No longer available to you" when the
 * entry leaves the person's view, and Remove (A). A pin written into
 * `cinna-agent.json` by hand is fetched on its own at launch, with nothing
 * clicked (B).
 *
 * ## What is real and what is not
 *
 * Real: main's `marketplaceSkillService` (discover paging, the batch lookup,
 * the download with both digest checks, the archive reader, the cache and its
 * read-only modes, the manifest write through its stamp guard, status), the
 * startup auto-fetch (`pinnedSkillAutoFetch`), the skills plugin's links
 * folder and the OpenCode config the launcher writes for the session, the
 * Addons tab and the Add skill modal. Faked: cinna-core — a loopback server
 * answering discovery, `/llm-plugins/discover`, `/llm-plugins/plugins?ids=`
 * and `/llm-plugins/plugins/{id}/skill-archive` with a gzip tar it builds
 * itself — and the engine, `scriptAcpAgent.mjs` behind the OpenCode launcher.
 * The profile is made a signed-in Cinna account by `linkSandboxAccount`. No
 * model, nothing billed.
 *
 * ## What it does not prove
 *
 * That a real engine opens the skill (OpenCode reading `skills.paths`, Claude
 * loading the plugin) — the live catalog-skill specs do that for catalog pins,
 * which share the plugin path. Core's own snapshotting and visibility rules.
 * Codex's prompt listing. The refusal paths (hash mismatch, `snapshot_missing`,
 * `not_a_skill`), which are unit-tested in `marketplaceSkillService.test.ts`.
 */

const AGENT = 'Release Writer'
const CHAT = 'Draft the release notes for 2.4.'
const REPLY = 'Release notes drafted.'

const ACME = { id: randomUUID(), name: 'Acme Skills', owner: 'Acme Labs', repository: 'https://git.example.test/acme/skills' }
const TEAM = { id: randomUUID(), name: 'Team Tools', owner: null, repository: null }

/* ------------------------------------------------------------- archives */

/** One ustar header block. */
function tarHeader(path: string, type: '0' | '5', size: number, mode: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(path, 0, 100, 'utf8')
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

/** A skill archive as core serves it: a gzip tar with every member under `skills/<name>/`. */
function skillArchive(name: string, files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [tarHeader('skills/', '5', 0, 0o755), tarHeader(`skills/${name}/`, '5', 0, 0o755)]
  for (const [path, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8')
    blocks.push(tarHeader(`skills/${name}/${path}`, '0', data.length, 0o644), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

function skillMd(name: string, description: string, version: string): string {
  return ['---', `name: ${name}`, `description: ${description}`, `version: ${version}`, '---', '', `# ${name}`, '', 'Write release notes from the merged changes.', ''].join('\n')
}

/* ------------------------------------------------------------ fake core */

interface FakeEntry {
  id: string
  name: string
  description: string
  marketplace: { id: string; name: string; owner: string | null; repository: string | null }
  supported: boolean
  unsupportedReason: string | null
  hasScripts: boolean
  version: string | null
  /** The current snapshot, or null for an unsupported entry. */
  current: { sha: string; bytes: Buffer; commit: string } | null
  /** Every snapshot core still keeps for it, by digest. */
  snapshots: Map<string, Buffer>
  /** Gone from discover and the batch lookup: removed, or no longer visible to this person. */
  hidden: boolean
}

function entry(input: {
  name: string
  description: string
  marketplace: { id: string; name: string; owner: string | null; repository: string | null }
  version?: string
  unsupportedReason?: string
  hasScripts?: boolean
}): FakeEntry {
  const supported = !input.unsupportedReason
  const bytes = supported ? skillArchive(input.name, { 'SKILL.md': skillMd(input.name, input.description, input.version ?? '1.0.0') }) : null
  const current = bytes ? { sha: sha256(bytes), bytes, commit: randomUUID().replaceAll('-', '').slice(0, 12) } : null
  return {
    id: randomUUID(),
    name: input.name,
    description: input.description,
    marketplace: input.marketplace,
    supported,
    unsupportedReason: input.unsupportedReason ?? null,
    hasScripts: input.hasScripts ?? false,
    version: supported ? (input.version ?? '1.0.0') : null,
    current,
    snapshots: new Map(current ? [[current.sha, current.bytes]] : []),
    hidden: false
  }
}

/** A loopback cinna-core with the discovery document and the skills-marketplace routes. */
async function fakeCore(entries: FakeEntry[]) {
  let host = ''
  const requests: string[] = []
  /** Archive downloads waiting for the test; see `holdArchives`. */
  const held: Array<() => void> = []
  let holdArchives = false
  const row = (e: FakeEntry) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    marketplace_id: e.marketplace.id,
    marketplace_name: e.marketplace.name,
    marketplace_owner: e.marketplace.owner,
    repository_url: e.marketplace.repository,
    supported: e.supported,
    unsupported_reason: e.unsupportedReason,
    skill_archive_sha256: e.current?.sha ?? null,
    skill_archive_size: e.current?.bytes.length ?? null,
    skill_summary: { name: e.name, description: e.description, has_scripts: e.hasScripts },
    commit_hash: e.current?.commit ?? null,
    version: e.version
  })

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push(`${req.method} ${url.pathname}${url.search}`)
    const send = (value: unknown, status = 200): void => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(value))
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/cinna-desktop') {
      send({
        authorization_endpoint: `${host}/oauth/authorize`,
        token_endpoint: `${host}/oauth/token`,
        userinfo_endpoint: `${host}/oauth/userinfo`,
        instance_name: 'Acme Labs'
      })
      return
    }
    const visible = entries.filter((e) => !e.hidden)
    if (req.method === 'GET' && url.pathname === '/api/v1/llm-plugins/discover') {
      if (url.searchParams.get('plugin_type') !== 'skills') return send({ detail: 'plugin_type must be skills here' }, 422)
      const skip = Number(url.searchParams.get('skip') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 100)
      // Supported entries first, as core orders them.
      const ordered = [...visible.filter((e) => e.supported), ...visible.filter((e) => !e.supported)]
      return send({ data: ordered.slice(skip, skip + limit).map(row), count: ordered.length })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/llm-plugins/plugins') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').map((id) => id.toLowerCase())
      const found = visible.filter((e) => ids.includes(e.id.toLowerCase()))
      return send({ data: found.map(row), count: found.length })
    }
    const archive = /^\/api\/v1\/llm-plugins\/plugins\/([0-9a-f-]{36})\/skill-archive$/.exec(url.pathname)
    if (req.method === 'GET' && archive) {
      const target = entries.find((e) => e.id === archive[1])
      if (!target || target.hidden) return send({ detail: { code: 'not_found' } }, 404)
      if (!target.supported) return send({ detail: { code: 'not_a_skill' } }, 409)
      const bytes = target.snapshots.get(url.searchParams.get('sha256') ?? '')
      if (!bytes) return send({ detail: { code: 'snapshot_missing' } }, 404)
      const answer = (): void => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/gzip')
        res.setHeader('x-archive-sha256', sha256(bytes))
        res.end(bytes)
      }
      if (holdArchives) held.push(answer)
      else answer()
      return
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
    requests,
    held,
    /** Hold every archive download until `held[i]()` answers it. */
    holdArchives(on: boolean): void {
      holdArchives = on
    },
    /** How many times main asked for one entry's archive. */
    archiveRequests(e: FakeEntry): number {
      return requests.filter((line) => line.startsWith(`GET /api/v1/llm-plugins/plugins/${e.id}/skill-archive`)).length
    },
    /** The marketplace syncs a new copy of the skill: a new snapshot becomes the entry's current one. */
    publish(e: FakeEntry, version: string, description: string): void {
      const bytes = skillArchive(e.name, { 'SKILL.md': skillMd(e.name, description, version) })
      e.current = { sha: sha256(bytes), bytes, commit: randomUUID().replaceAll('-', '').slice(0, 12) }
      e.snapshots.set(e.current.sha, bytes)
      e.version = version
      e.description = description
    },
    async close(): Promise<void> {
      held.forEach((answer) => answer())
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
type FakeCore = Awaited<ReturnType<typeof fakeCore>>

/* -------------------------------------------------------------- helpers */

interface Pin {
  entry_uuid: string
  marketplace_uuid: string
  marketplace_name: string
  name: string
  archive_sha256: string
  commit_hash: string | null
  version: string | null
}

function readManifest(agentPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentPath, 'cinna-agent.json'), 'utf8')) as Record<string, unknown>
}

function marketplacePins(agentPath: string): Pin[] {
  return (readManifest(agentPath).marketplace_skills ?? []) as Pin[]
}

/** `<userData>/marketplace-skills/<instance>/<entry>/<sha>/<name>/`, when its SKILL.md is there. */
function cachedSnapshotDir(cinna: CinnaApp, entryUuid: string, sha: string, name: string): string | null {
  const root = join(cinna.sandbox.userData, 'marketplace-skills')
  if (!existsSync(root)) return null
  for (const instance of readdirSync(root)) {
    const dir = join(root, instance, entryUuid, sha, name)
    if (existsSync(join(dir, 'SKILL.md'))) return dir
  }
  return null
}

const agentKey = (agentId: string): string => createHash('sha256').update(agentId).digest('hex').slice(0, 16)

/** The OpenCode config the launcher last wrote for `agentId`, and that agent's entry in it. */
function openCodeConfigOf(cinna: CinnaApp, agentId: string): { config: any; entry: any } | null {
  const file = join(cinna.sandbox.userData, 'acp', 'opencode', agentKey(agentId), 'opencode.json')
  if (!existsSync(file)) return null
  const config = JSON.parse(readFileSync(file, 'utf8'))
  const entry = Object.values(config.agent ?? {}).find((agent: any) => String(agent.prompt ?? '').includes(`\`${agentId}\``))
  return entry ? { config, entry } : null
}

/**
 * A kit agent on the scripted engine, the profile linked to the fake core,
 * relaunched so the renderer carries the account. `beforeLink` runs on the
 * agent's folder before the relaunch (a hand-written pin).
 */
async function arrange(
  cinna: CinnaApp,
  fake: ScriptAcpEngine,
  core: FakeCore,
  beforeLink?: (agentPath: string) => void
): Promise<{ agentId: string; agentPath: string }> {
  await cinna.skipOnboarding()
  await fake.install(cinna)
  await cinna.page.evaluate(async ({ host, model }) => {
    await window.api.settings.set('autoChatTitles', false)
    const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Marketplace fixture', baseUrl: host, enabled: true })
    await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
  }, { host: fake.host, model: SCRIPT_MODEL })
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, 'Writes release notes from merged changes.')
  beforeLink?.(agent.path)
  await linkSandboxAccount(cinna, core.host)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  return { agentId: agent.id, agentPath: agent.path }
}

/** Agents → the agent → Settings → Addons, and its Skills section. */
async function openSkillsSection(cinna: CinnaApp): Promise<Locator> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Addons/ }).click()
  return page
    .getByRole('tabpanel')
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'Skills', exact: true }) })
}

/** The names of the tiles the Marketplaces source shows, in order. */
function tileNames(list: Locator): Promise<string[]> {
  return list.locator('[data-marketplace-skill]').evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('aria-label') ?? ''))
}

/* ---------------------------------------------------------------- tests */

test('A a marketplace skill is added, reaches the session, updates, goes unavailable and is removed', async ({ cinna }) => {
  test.setTimeout(240_000)
  const releaseNotes = entry({ name: 'release-notes', description: 'Writes release notes from merged pull requests.', marketplace: ACME })
  const csvCleaner = entry({ name: 'csv-cleaner', description: 'Cleans and normalises CSV exports.', marketplace: TEAM, hasScripts: true })
  const broken = entry({ name: 'broken-skill', description: 'A folder with no usable SKILL.md.', marketplace: ACME, unsupportedReason: 'no_skill_md' })
  const core = await fakeCore([releaseNotes, csvCleaner, broken])
  const fake = await scriptAcpEngine()
  try {
    const { agentId, agentPath } = await arrange(cinna, fake, core)
    const v1 = releaseNotes.current!.sha

    let section = await openSkillsSection(cinna)
    const page = cinna.page
    const dialog = page.getByRole('dialog', { name: 'Add skill' })
    const list = dialog.locator('[data-marketplace-skills-list]')
    const tile = (name: string): Locator => list.getByRole('group', { name, exact: true })

    await test.step('Skills → Add → Marketplaces lists what the marketplaces offer', async () => {
      await expect(section.getByText('No skills yet.', { exact: true })).toBeVisible()
      const add = section.getByRole('button', { name: 'Add', exact: true })
      await expect(add).toBeEnabled()
      await add.click()
      await expect(dialog).toBeVisible()
      const sources = dialog.getByRole('radiogroup', { name: 'Where skills come from' })
      await expect(sources.getByRole('radio')).toHaveText(['Catalog', 'Marketplaces'])
      await sources.getByRole('radio', { name: 'Marketplaces', exact: true }).click()
      await expect(sources.getByRole('radio', { name: 'Marketplaces', exact: true })).toHaveAttribute('aria-checked', 'true')
      await expect.poll(() => tileNames(list)).toEqual(['release-notes', 'csv-cleaner', 'broken-skill'])
      // The catalog tile's shape: the marketplace as the badge, the version chip, "by" its owner.
      await expect(tile('release-notes').getByTitle('From the Acme Skills marketplace')).toHaveText('Acme Skills')
      await expect(tile('release-notes').getByText('1.0.0', { exact: true })).toBeVisible()
      await expect(tile('release-notes').getByText('by Acme Labs', { exact: true })).toBeVisible()
      await expect(tile('release-notes').getByRole('button', { name: 'Open the source of release-notes', exact: true })).toBeVisible()
      await expect(tile('csv-cleaner').getByTitle('From the Team Tools marketplace')).toHaveText('Team Tools')
      await expect(tile('csv-cleaner').getByRole('button', { name: /^Open the source/ })).toHaveCount(0)
      await expect(tile('csv-cleaner').getByRole('img', { name: 'Ships scripts: this skill can run code, not only give instructions.' })).toBeVisible()
      expect(core.requests).toContain('GET /api/v1/llm-plugins/discover?plugin_type=skills&skip=0&limit=100')
    })

    await test.step('a tile opens its detail over the grid; Escape returns to the grid', async () => {
      await tile('release-notes').getByRole('button', { name: 'release-notes', exact: true }).click()
      const detail = dialog.locator(`[data-marketplace-skill-detail="${releaseNotes.id}"]`)
      await expect(detail.getByRole('heading', { name: 'release-notes', exact: true })).toBeVisible()
      await expect(detail).toContainText('Acme Labs')
      await expect(detail.getByRole('button', { name: 'Add release-notes to this agent', exact: true })).toBeEnabled()
      await expect(detail.getByRole('button', { name: 'Open the source of release-notes', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(detail).toHaveCount(0)
      await expect(dialog).toBeVisible()
    })

    await test.step('search and the Marketplace filter narrow the list locally', async () => {
      const search = dialog.getByRole('textbox', { name: 'Search marketplace skills' })
      const discoverReads = core.requests.filter((line) => line.startsWith('GET /api/v1/llm-plugins/discover')).length
      await search.fill('csv')
      await expect.poll(() => tileNames(list)).toEqual(['csv-cleaner'])
      await search.fill('zzz-nothing')
      await expect(list).toHaveText('Nothing matches your search.')
      await search.fill('')
      await expect.poll(() => tileNames(list)).toEqual(['release-notes', 'csv-cleaner', 'broken-skill'])
      const filter = dialog.getByRole('combobox', { name: 'Marketplace' })
      await expect(filter.locator('option')).toHaveText(['All marketplaces', 'Acme Skills', 'Team Tools'])
      await expect(filter).toHaveValue('')
      await filter.selectOption({ label: 'Acme Skills' })
      await expect.poll(() => tileNames(list)).toEqual(['release-notes', 'broken-skill'])
      await filter.selectOption({ label: 'Team Tools' })
      await expect.poll(() => tileNames(list)).toEqual(['csv-cleaner'])
      await filter.selectOption({ label: 'All marketplaces' })
      await expect.poll(() => tileNames(list)).toEqual(['release-notes', 'csv-cleaner', 'broken-skill'])
      // Filtering asked core nothing.
      expect(core.requests.filter((line) => line.startsWith('GET /api/v1/llm-plugins/discover')).length).toBe(discoverReads)
    })

    await test.step('an unsupported entry offers a disabled Add and says why', async () => {
      const reason = 'This skill has no valid SKILL.md, so there is nothing to add.'
      await expect(tile('broken-skill')).toHaveAttribute('data-marketplace-skill-state', 'unsupported')
      await expect(tile('broken-skill')).toHaveAttribute('data-marketplace-skill', broken.id)
      await expect(tile('broken-skill').getByText(reason, { exact: true })).toBeVisible()
      const add = tile('broken-skill').getByRole('button', { name: 'Add broken-skill to this agent', exact: true })
      await expect(add).toBeDisabled()
      await expect(add).toHaveAttribute('title', reason)
    })

    await test.step('Add goes Adding… → Added and pins the snapshot into cinna-agent.json', async () => {
      core.holdArchives(true)
      await expect(tile('release-notes')).toHaveAttribute('data-marketplace-skill-state', 'addable')
      await tile('release-notes').getByRole('button', { name: 'Add release-notes to this agent', exact: true }).click()
      await expect(tile('release-notes')).toHaveAttribute('data-marketplace-skill-state', 'adding')
      await expect(tile('release-notes').getByRole('button', { name: 'Adding release-notes…', exact: true })).toBeDisabled()
      await expect.poll(() => core.held.length).toBe(1)
      // Nothing is pinned before the download is checked.
      expect(marketplacePins(agentPath)).toEqual([])
      core.holdArchives(false)
      core.held.shift()!()
      await expect(tile('release-notes')).toHaveAttribute('data-marketplace-skill-state', 'added')
      await expect(tile('release-notes').getByRole('button', { name: 'release-notes added', exact: true })).toBeDisabled()
      expect(core.requests).toContain(`GET /api/v1/llm-plugins/plugins?ids=${releaseNotes.id}`)
      expect(core.requests).toContain(`GET /api/v1/llm-plugins/plugins/${releaseNotes.id}/skill-archive?sha256=${v1}`)
      expect(marketplacePins(agentPath)).toEqual([
        {
          entry_uuid: releaseNotes.id,
          marketplace_uuid: ACME.id,
          marketplace_name: 'Acme Skills',
          name: 'release-notes',
          archive_sha256: v1,
          commit_hash: releaseNotes.current!.commit,
          version: '1.0.0'
        }
      ])
      expect(v1).toBe(sha256(releaseNotes.snapshots.get(v1)!))
    })

    let cacheV1 = ''
    await test.step('the snapshot is in the read-only cache and the Skills row reads From Acme Skills', async () => {
      cacheV1 = cachedSnapshotDir(cinna, releaseNotes.id, v1, 'release-notes') ?? ''
      expect(cacheV1, 'the v1 snapshot is cached').not.toBe('')
      expect(readFileSync(join(cacheV1, 'SKILL.md'), 'utf8')).toContain('description: Writes release notes from merged pull requests.')
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      const row = section.locator('[data-skill-row="release-notes"]')
      await expect(row).toHaveAttribute('data-skill-source', 'marketplace')
      await expect(row).toHaveAttribute('data-marketplace-skill', releaseNotes.id)
      await expect(row).toHaveAttribute('data-marketplace-skill-state', 'current')
      await expect(row.getByText('From Acme Skills', { exact: true })).toBeVisible()
      await expect(row.getByText('Version 1.0.0', { exact: true })).toBeVisible()
      await expect(row).toContainText('Writes release notes from merged pull requests.')
      // The pin names no URL; the status lookup brings its entry's source.
      await expect(row.getByRole('button', { name: 'Open the source of release-notes', exact: true })).toBeVisible()
      await expect(row.getByRole('button', { name: /^Update release-notes/ })).toHaveCount(0)
      await expect(row.getByRole('button', { name: 'Download release-notes again', exact: true })).toHaveCount(0)
      await expect(row.getByRole('button', { name: 'Remove release-notes from this agent', exact: true })).toBeVisible()
    })

    await test.step('a scripted OpenCode session is handed the cached skill', async () => {
      await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
      const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
      await input.fill(CHAT)
      await input.press('Enter')
      await expect.poll(() => fake.calls.length, { timeout: 60_000 }).toBe(1)
      const written = openCodeConfigOf(cinna, agentId)
      expect(written, 'the launcher wrote this agent’s opencode.json').not.toBeNull()
      const pluginSkills = join(cinna.sandbox.userData, 'cinna-plugins', 'agents', agentKey(agentId), 'skills')
      const paths = (written!.config.skills?.paths ?? []) as string[]
      expect(paths.map((path) => realpathSync(path))).toContain(realpathSync(pluginSkills))
      // The links folder points the engine at the read-only cached snapshot.
      expect(realpathSync(join(pluginSkills, 'release-notes'))).toBe(realpathSync(cacheV1))
      expect(written!.entry.permission?.skill?.['release-notes']).toBe('allow')
      expect(String(written!.entry.prompt)).toContain('the marketplace skills this agent pins are available through the skill tool by name')
      fake.calls[0].release(REPLY)
      await expect(page.getByText(REPLY, { exact: true })).toBeVisible()
    })

    const v2 = await test.step('the marketplace moves the entry to a new snapshot: the row offers Update, which moves the pin', async () => {
      core.publish(releaseNotes, '1.1.0', 'Writes release notes from merged pull requests, grouped by area.')
      const next = releaseNotes.current!.sha
      expect(next).not.toBe(v1)
      // The status read is cached for a minute per agent page; a restart reads it again.
      await cinna.relaunch()
      await cinna.skipOnboarding()
      section = await openSkillsSection(cinna)
      const row = section.locator('[data-skill-row="release-notes"]')
      await expect(row).toHaveAttribute('data-marketplace-skill-state', 'update_available')
      const update = row.getByRole('button', { name: 'Update release-notes to version 1.1.0', exact: true })
      await expect(update).toBeEnabled()
      await update.click()
      await expect.poll(() => marketplacePins(agentPath).map((pin) => [pin.archive_sha256, pin.version])).toEqual([[next, '1.1.0']])
      await expect(row).toHaveAttribute('data-marketplace-skill-state', 'current')
      await expect(row.getByText('Version 1.1.0', { exact: true })).toBeVisible()
      await expect(row.getByRole('button', { name: /^Update release-notes/ })).toHaveCount(0)
      expect(core.requests).toContain(`GET /api/v1/llm-plugins/plugins/${releaseNotes.id}/skill-archive?sha256=${next}`)
      expect(cachedSnapshotDir(cinna, releaseNotes.id, next, 'release-notes')).not.toBeNull()
      expect(marketplacePins(agentPath)[0].entry_uuid).toBe(releaseNotes.id)
      return next
    })

    await test.step('the entry leaves the person’s view: No longer available to you, Remove still offered', async () => {
      releaseNotes.hidden = true
      await cinna.relaunch()
      await cinna.skipOnboarding()
      section = await openSkillsSection(cinna)
      const row = section.locator('[data-skill-row="release-notes"]')
      await expect(row).toHaveAttribute('data-marketplace-skill-state', 'unavailable')
      await expect(row.getByRole('listitem')).toHaveText(['No longer available to you'])
      await expect(row.getByRole('button', { name: /^Update release-notes/ })).toHaveCount(0)
      await expect(row.getByRole('button', { name: 'Remove release-notes from this agent', exact: true })).toBeEnabled()
      // The copy on this computer keeps being delivered.
      expect(cachedSnapshotDir(cinna, releaseNotes.id, v2, 'release-notes')).not.toBeNull()
      const agent = await cinna.page.evaluate((id) => window.api.localAgents.get(id), agentId)
      expect(agent.ok && agent.value.skills?.find((skill) => skill.name === 'release-notes')?.deliverable).toBe(true)
    })

    await test.step('Remove with its confirm drops the pin from cinna-agent.json', async () => {
      const row = section.locator('[data-skill-row="release-notes"]')
      await row.getByRole('button', { name: 'Remove release-notes from this agent', exact: true }).click()
      const confirm = row.getByRole('group', { name: 'Remove release-notes from this agent', exact: true })
      await expect(confirm).toContainText(
        'Remove release-notes from this agent? It stays in its marketplace; you can add it again. release-notes stops being available to this agent in new chats.'
      )
      await confirm.getByRole('button', { name: 'Remove skill', exact: true }).click()
      await expect.poll(() => marketplacePins(agentPath)).toEqual([])
      await expect(section.locator('[data-skill-row="release-notes"]')).toHaveCount(0)
      await expect(section.getByText('No skills yet.', { exact: true })).toBeVisible()
    })
  } finally {
    await fake.close()
    await core.close()
  }
})

test('B a pin written into cinna-agent.json by hand is downloaded at launch with nothing clicked', async ({ cinna }) => {
  test.setTimeout(120_000)
  const releaseNotes = entry({ name: 'release-notes', description: 'Writes release notes from merged pull requests.', marketplace: ACME })
  const core = await fakeCore([releaseNotes])
  const fake = await scriptAcpEngine()
  try {
    const sha = releaseNotes.current!.sha
    const { agentPath } = await arrange(cinna, fake, core, (path) => {
      const manifest = readManifest(path)
      const pin: Pin = {
        entry_uuid: releaseNotes.id,
        marketplace_uuid: ACME.id,
        marketplace_name: ACME.name,
        name: 'release-notes',
        archive_sha256: sha,
        commit_hash: releaseNotes.current!.commit,
        version: '1.0.0'
      }
      writeFileSync(join(path, 'cinna-agent.json'), `${JSON.stringify({ ...manifest, marketplace_skills: [pin] }, null, 2)}\n`)
    })

    await test.step('the launch fetches the missing snapshot by itself', async () => {
      // Nothing in the UI has been touched since the relaunch.
      await expect.poll(() => cachedSnapshotDir(cinna, releaseNotes.id, sha, 'release-notes'), { timeout: 30_000 }).not.toBeNull()
      expect(core.archiveRequests(releaseNotes)).toBe(1)
      expect(marketplacePins(agentPath).map((pin) => pin.archive_sha256)).toEqual([sha])
    })

    await test.step('the Skills row reads ready, with no Download again', async () => {
      const section = await openSkillsSection(cinna)
      const row = section.locator('[data-skill-row="release-notes"]')
      await expect(row).toHaveAttribute('data-skill-source', 'marketplace')
      await expect(row).toHaveAttribute('data-marketplace-skill-state', 'current')
      await expect(row).toContainText('Writes release notes from merged pull requests.')
      await expect(row.getByRole('button', { name: 'Download release-notes again', exact: true })).toHaveCount(0)
      await expect(row.getByRole('listitem')).toHaveCount(0)
      expect(core.archiveRequests(releaseNotes)).toBe(1)
    })
  } finally {
    await fake.close()
    await core.close()
  }
})
