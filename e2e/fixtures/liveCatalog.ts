import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { repoRoot } from '../playwright.config'
import type { CinnaApp } from './app'
import { installFakeAcpEngine, type FakeAcpEngine } from './fakeAcpEngine'
import {
  expect,
  findAgent,
  makeTeamTest,
  openAgent,
  runCommand,
  shortHash,
  syncCredentials,
  WEATHER_SLOT,
  type PersonApp,
  type SharingPerson,
  type TeamFixtureBase
} from './liveTeamSharing'

/**
 * The catalog story (plan README §7) against the **real** local cinna-core,
 * one app per person, on the `team` fixture of `liveTeamSharing.ts`.
 *
 * Core state comes from `e2e/fixtures/live-catalog.py` (run inside the backend
 * container; see its docstring): people A, B, C and an admin credential
 * `ERP API catalog-e2e <tag>` (`api_token`, `service_uri: erp-api`, Allow local use)
 * shared with A and B. `CINNA_CATALOG_LIVE_FIXTURE` points at the JSON it
 * printed; without it every spec that uses {@link test} skips.
 *
 * Nothing here runs a model: agents and skills are files written straight
 * into the folders, and what an agent can reach is proven by a `/run:`
 * command (`slot-check`) that imports the skill runtime's `core.cinna_api`.
 */

export interface CatalogFixture extends TeamFixtureBase {
  credentials: {
    erp: { id: string; name: string; secret: string; shares: Record<'a' | 'b', string> }
    /** Two admin `api_token` credentials for one slot, both shared with B (`live-sharing-skill-credentials.spec.ts`). */
    pair?: { slot: string; items: { id: string; name: string; secret: string }[] }
    /** An admin `api_token` credential for `slot`, shared with B, local use **not** allowed. */
    noLocal?: { id: string; name: string; slot: string }
  }
  /** A public cloud agent the catalog lists to everyone, when the instance has one. Read only. */
  cloudAgent: { uuid: string; id: string; display_name: string } | null
}

const fixturePath = (process.env.CINNA_CATALOG_LIVE_FIXTURE ?? '').trim()

export function catalogFixture(): CatalogFixture | null {
  if (!fixturePath || !existsSync(fixturePath)) return null
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as CatalogFixture
}

export const test = makeTeamTest(
  catalogFixture,
  'Set CINNA_CATALOG_LIVE_FIXTURE to the JSON printed by e2e/fixtures/live-catalog.py create (a running local cinna-core)'
)
export { expect }

/** The agent-level slot `report-bot` declares: the admin's ERP API, found by service URI. */
export const ERP_SLOT = { name: 'erp', type: 'api_token', service_uri: 'erp-api', env_prefix: 'ERP_', description: 'The ERP API.' }

/**
 * `scripts/slot_check.py`: what a skill script does in cinna-core — the
 * credential for `slot` (default `erp-api`) through `core.cinna_api` — and
 * prints its type and a hash prefix of its header value, never the value.
 */
export function slotCheckScript(prefix: string, slot = 'erp-api'): string {
  return `import hashlib
import sys

from core.cinna_api import credentials

cred = credentials.by_slot("${slot}")
if cred is None:
    # Exit 0: a failed command folds its output behind Details.
    print("${prefix}: ${slot}=none")
    sys.exit(0)
value = (cred.get("credential_data") or {}).get("http_header_value", "")
print(f"${prefix}: ${slot}={cred.get('type')} {hashlib.sha256(str(value).encode()).hexdigest()[:12]}")
`
}

/** What {@link slotCheckScript} prints for an `api_token` (bearer) credential whose token is `secret`. */
export function slotLine(prefix: string, slot: string, secret: string): string {
  return `${prefix}: ${slot}=api_token ${shortHash(`Bearer ${secret}`)}`
}

const SLOT_CHECK = slotCheckScript('slot-check')

const CLI_COMMANDS = `commands:
  - name: status
    description: Refresh the agent's self-reported STATUS.md.
    command: python3 scripts/update_status.py --status ok --summary "Ready"
  - name: slot-check
    description: Which credential the erp-api slot finds, by hash.
    command: python3 scripts/slot_check.py
`

/** What `slot-check` prints when the admin's ERP API reached the agent. */
export function slotCheckLine(fixture: CatalogFixture, prefix = 'slot-check'): string {
  return `${prefix}: erp-api=api_token ${shortHash(`Bearer ${fixture.credentials.erp.secret}`)}`
}

export interface BuiltAgent {
  id: string
  name: string
  slug: string
  path: string
  manifestId: string
}

/** A unique name per test: core's desktop-agent slugs are unique server-wide. */
export function uniqueName(fixture: TeamFixtureBase, base: string): string {
  return `${base} ${fixture.tag} ${randomBytes(2).toString('hex')}`
}

/** A unique skill folder name per test (lowercase words joined by hyphens). */
export function skillName(base: string): string {
  return `${base}-${randomBytes(2).toString('hex')}`
}

/**
 * `skills/<name>/SKILL.md` in `agentPath`, with an optional `credentials:`
 * block — what an assistant writing a skill would leave there.
 */
export function writeSkill(
  agentPath: string,
  name: string,
  input: {
    description: string
    credentials?: { slot: string; type: string; description?: string }[]
    body?: string
    /** Further files of the skill, by path relative to its folder (`scripts/run.py`). */
    files?: Record<string, string>
  }
): void {
  const lines = ['---', `name: ${name}`, `description: ${input.description}`]
  if (input.credentials?.length) {
    lines.push('credentials:')
    for (const c of input.credentials) {
      lines.push(`  - slot: ${c.slot}`, `    type: ${c.type}`)
      if (c.description) lines.push(`    description: ${c.description}`)
    }
  }
  lines.push('---', '', input.body ?? `Use \`/run:slot-check\` before answering.\n`)
  mkdirSync(join(agentPath, 'skills', name), { recursive: true })
  writeFileSync(join(agentPath, 'skills', name, 'SKILL.md'), lines.join('\n'))
  for (const [rel, text] of Object.entries(input.files ?? {})) {
    mkdirSync(dirname(join(agentPath, 'skills', name, rel)), { recursive: true })
    writeFileSync(join(agentPath, 'skills', name, rel), text)
  }
}

/**
 * A kit agent in `app`'s agents home with the `slot-check` command. With
 * `slots`, it also declares `erp` (service URI `erp-api`, attached from the
 * account as its owner would) and `weather` (`.env`, saved). Ends with a
 * relaunch, so the composer and pickers see it.
 */
export async function buildAgent(
  app: PersonApp,
  fixture: CatalogFixture,
  input: { name: string; slots?: boolean; skill?: Parameters<typeof writeSkill>[2] & { name: string } }
): Promise<BuiltAgent> {
  const rootId = await app.rootId()
  const created = await app.page.evaluate((args) => window.api.localAgents.create(args), {
    rootId,
    name: input.name,
    description: 'Reports from the ERP.'
  })
  const manifestPath = join(created.path, 'cinna-agent.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  if (input.slots) manifest.credentials = [ERP_SLOT, WEATHER_SLOT]
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(join(created.path, 'scripts/slot_check.py'), SLOT_CHECK)
  writeFileSync(join(created.path, 'docs/CLI_COMMANDS.yaml'), CLI_COMMANDS)
  writeFileSync(join(created.path, 'knowledge/erp.md'), '# ERP\n\nOrders live in the ERP.\n')
  if (input.skill) writeSkill(created.path, input.skill.name, input.skill)
  await app.page.evaluate(() => window.api.localAgents.rescan())

  if (input.slots) {
    await syncCredentials(app)
    const attached = await app.page.evaluate(
      async ({ id, credentialId }) => {
        const setup = await window.api.serviceCredentials.setupState(id)
        if (!setup.ok) return setup.message
        const option = setup.value.slots.find((s) => s.name === 'erp')?.options.find((o) => o.ref === credentialId)
        if (!option) return `no ERP option: ${JSON.stringify(setup.value.slots.map((s) => [s.name, s.options.map((o) => o.credential.name)]))}`
        const result = await window.api.serviceCredentials.attach(id, option.group, option.ref)
        return result.ok ? 'ok' : result.message
      },
      { id: created.id, credentialId: fixture.credentials.erp.id }
    )
    expect(attached).toBe('ok')
    const saved = await app.page.evaluate(
      ({ id, key }) => window.api.localAgents.setEnvValues(id, { WEATHER_API_KEY: key }),
      { id: created.id, key: `weather-${app.label}-${fixture.tag}` }
    )
    expect(saved.ok).toBe(true)
  }
  await app.relaunch()
  const agent = await app.page.evaluate((id) => window.api.localAgents.get(id), created.id)
  if (!agent.ok) throw new Error(agent.message)
  return { id: created.id, name: input.name, slug: created.slug, path: created.path, manifestId: String(manifest.id) }
}

/** `/run:slot-check` on `name`'s page; resolves once its line is on screen. */
export async function expectSlotCheck(app: PersonApp, name: string, line: string): Promise<void> {
  await runCommand(app, name, 'slot-check')
  await expect(app.page.getByText(line)).toBeVisible({ timeout: 60_000 })
}

/** Agent page → Settings → Addons, and its Skills section. */
export async function openSkills(app: PersonApp, name: string) {
  await openAgent(app, name)
  await app.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await app.page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Addons/ }).click()
  return skillsSection(app)
}

export function skillsSection(app: PersonApp) {
  return app.page
    .getByRole('tabpanel')
    .locator('section')
    .filter({ has: app.page.getByRole('heading', { level: 2, name: 'Skills', exact: true }) })
}

/** One row of the Skills section, by the name it shows and its source badge. */
export function skillRow(app: PersonApp, title: string, source: 'Authored' | 'From the catalog') {
  return skillsSection(app).getByRole('listitem').filter({ hasText: title }).filter({ hasText: source })
}

/**
 * The Skills row's Share button → the Share dialog → (first share) each of
 * `people` at Can use, and Everyone on this server when `everyone` → Share.
 * Waits until the dialog closed.
 */
export async function shareSkill(
  app: PersonApp,
  agent: string,
  skill: string,
  input: {
    people?: SharingPerson[]
    note?: string
    newVersion?: boolean
    everyone?: boolean
    /** Per slot, the option to pick in `What people need for <slot>`: a credential's name, or `Each person connects their own`. */
    provide?: Record<string, string>
  }
): Promise<void> {
  await openSkills(app, agent)
  const verb = input.newVersion ? `Share a new version of ${skill}…` : `Share ${skill}…`
  await skillRow(app, skill, 'Authored').getByRole('button', { name: verb, exact: true }).click()
  const dialog = app.page.getByRole('dialog', { name: input.newVersion ? `Share a new version of ${skill}` : `Share ${skill}` })
  await expect(dialog.getByRole('button', { name: 'Share', exact: true })).toBeEnabled({ timeout: 30_000 })
  for (const person of input.people ?? []) {
    await dialog.getByRole('combobox', { name: 'Find a person' }).fill(person.name)
    await dialog.getByRole('option', { name: `${person.name} <${person.email}>` }).click()
  }
  if (input.everyone) await dialog.getByRole('checkbox', { name: 'Everyone on this server can use it', exact: true }).check()
  for (const [slot, label] of Object.entries(input.provide ?? {})) {
    await dialog.getByRole('combobox', { name: `What people need for ${slot}`, exact: true }).selectOption({ label })
  }
  if (input.note) await dialog.getByRole('textbox', { name: 'Note (optional)' }).fill(input.note)
  await dialog.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 60_000 })
}

/** Agents → + → Install from catalog → the one catalog, showing `filter`. */
export async function openCatalog(app: PersonApp, filter: 'All' | 'Agents' | 'Skills') {
  await app.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await app.page.getByRole('button', { name: 'Add an agent' }).click()
  await app.page.getByRole('dialog', { name: 'Add an agent' }).getByRole('button', { name: /Install from catalog/ }).click()
  const catalog = app.page.getByRole('dialog', { name: 'Catalog' })
  await catalog.getByRole('radiogroup', { name: 'Show' }).getByRole('radio', { name: filter, exact: true }).click()
  return catalog
}

/** The catalog's Skills → the skill's Add to agent… → the agent. Waits for the menu to close (success). */
export async function addSkillToAgent(app: PersonApp, skill: string, agent: string): Promise<void> {
  const catalog = await openCatalog(app, 'Skills')
  const tile = catalog.getByRole('group', { name: skill, exact: true })
  await tile.getByRole('button', { name: 'Add to agent…' }).click()
  const menu = app.page.getByRole('menu', { name: `Add ${skill} to an agent` })
  await menu.getByRole('menuitem', { name: new RegExp(`^${agent}`) }).click()
  await expect(menu).toHaveCount(0, { timeout: 60_000 })
  await expect(tile).toContainText('In 1 agent')
  await app.page.keyboard.press('Escape')
  await expect(catalog).toHaveCount(0)
}

/** The manifest's `catalog_skills[]` of the agent at `path`. */
export function catalogPins(path: string): { name: string; package_uuid: string; revision_number: number; package_id: string }[] {
  return (JSON.parse(readFileSync(join(path, 'cinna-agent.json'), 'utf8')).catalog_skills ?? []) as never
}

/** The skill item `name` as the bearer of `token` sees it in core's catalog, or undefined. */
export async function skillItem(fixture: TeamFixtureBase, token: string, name: string): Promise<any> {
  const response = await fetch(`${fixture.server}/api/v1/catalog/items?kind=skill`, { headers: { Authorization: `Bearer ${token}` } })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { data: any[] }
  return body.data.find((item) => item.name === name)
}

/** The cached copy of a pinned revision under `userData`, as main lays it out. */
export function cachedSkillDir(app: PersonApp, packageUuid: string, revision: number, name: string): string | null {
  const root = join(app.sandbox.userData, 'catalog-skills')
  if (!existsSync(root)) return null
  for (const instance of readdirSync(root)) {
    const dir = join(root, instance, packageUuid, String(revision), name)
    if (existsSync(join(dir, 'SKILL.md'))) return dir
  }
  return null
}

export { findAgent }

/**
 * The catalog's Skills searched for `skill`, after a fresh read of the
 * listing; answers the dialog and the skill's tile (which may be absent).
 */
export async function searchSkills(app: PersonApp, skill: string) {
  const listed = await app.page.evaluate(() => window.api.sharing.library(true))
  expect(listed.success).toBe(true)
  const catalog = await openCatalog(app, 'Skills')
  await catalog.getByRole('textbox', { name: 'Search the catalog' }).fill(skill)
  return { catalog, tile: catalog.getByRole('group', { name: skill, exact: true }) }
}

/** `skill` is in `app`'s catalog with Add to agent…; closes the catalog again. */
export async function expectSkillListed(app: PersonApp, skill: string, publisher: SharingPerson): Promise<void> {
  const { catalog, tile } = await searchSkills(app, skill)
  await expect(tile).toContainText('Skill')
  await expect(tile).toContainText(`by ${publisher.name}`)
  await expect(tile.getByRole('button', { name: 'Add to agent…' })).toBeEnabled()
  await app.page.keyboard.press('Escape')
  await expect(catalog).toHaveCount(0)
}

/**
 * `skill` is not in `app`'s catalog: the search over a loaded listing ends
 * in its empty line, not in a tile. Closes the catalog again.
 */
export async function expectSkillNotListed(app: PersonApp, skill: string): Promise<void> {
  const { catalog, tile } = await searchSkills(app, skill)
  await expect(
    catalog.getByText('Nothing matches your search.', { exact: true }).or(catalog.getByText('No skills are in the catalog for you yet.', { exact: true }))
  ).toBeVisible()
  await expect(tile).toHaveCount(0)
  await app.page.keyboard.press('Escape')
  await expect(catalog).toHaveCount(0)
}

/** The local installs core lists for the bearer of `token` on skill `name`, as `<host_manifest_id>@<revision>`. */
export async function skillLocalInstalls(fixture: TeamFixtureBase, token: string, name: string): Promise<string[]> {
  const item = await skillItem(fixture, token, name)
  return ((item?.my_installs ?? []) as { where: string; host_manifest_id: string | null; revision_number: number | null }[])
    .filter((install) => install.where === 'local')
    .map((install) => `${String(install.host_manifest_id).toLowerCase()}@${install.revision_number}`)
    .sort()
}

/** The catalog's Agents → the agent's Get, landing on its page. */
export async function getAgent(app: PersonApp, name: string): Promise<void> {
  const catalog = await openCatalog(app, 'Agents')
  await catalog.getByRole('group', { name, exact: true }).getByRole('button', { name: 'Get', exact: true }).click()
  await expect(catalog).toHaveCount(0, { timeout: 60_000 })
  await expect(app.page.getByRole('heading', { level: 1 })).toHaveText(name)
}

/** The catalog's Agents → the agent's Update; resolves once only Open is left on its tile. */
export async function updateFromCatalog(app: PersonApp, name: string): Promise<void> {
  const catalog = await openCatalog(app, 'Agents')
  const tile = catalog.getByRole('group', { name, exact: true })
  await tile.getByRole('button', { name: 'Update', exact: true }).click()
  // The button reads Updating… while it runs.
  await expect(tile.getByRole('button', { name: /^(Update|Updating…)$/ })).toHaveCount(0, { timeout: 60_000 })
  await expect(tile.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
  await app.page.keyboard.press('Escape')
  await expect(catalog).toHaveCount(0)
}

/** One skill row of agent `agentId` as main reads it now. */
export async function skillDto(app: PersonApp, agentId: string, name: string, source: 'authored' | 'catalog') {
  const agent = await app.page.evaluate((id) => window.api.localAgents.get(id), agentId)
  if (!agent.ok) throw new Error(agent.message)
  return agent.value.skills?.find((row) => row.name === name && row.source === source)
}

/** The `catalog_skills[]` pin core's listing item `item` would be added as (its latest version). */
export function catalogPinOf(item: any): { package_id: string; package_uuid: string; name: string; revision_number: number; version?: string; archive_sha256: string } {
  return {
    package_id: item.id,
    package_uuid: item.uuid,
    name: item.name,
    revision_number: item.latest.revision_number,
    ...(item.latest.version ? { version: item.latest.version } : {}),
    archive_sha256: String(item.skill.archive_sha256).toLowerCase()
  }
}

/** Append `pins` to the agent's `catalog_skills[]` by hand, as a `git pull` or an editor would leave them. */
export function writeCatalogPins(path: string, pins: ReturnType<typeof catalogPinOf>[]): void {
  const file = join(path, 'cinna-agent.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  manifest.catalog_skills = [...((manifest.catalog_skills as unknown[]) ?? []), ...pins]
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
}

/** `<userData>/cinna-plugins/agents/<key>`: the agent's skills plugin; its `skills/` is the links folder. */
export function skillsPluginDir(app: PersonApp, agentId: string): string {
  return join(app.sandbox.userData, 'cinna-plugins', 'agents', createHash('sha256').update(agentId).digest('hex').slice(0, 16))
}

/** The OpenCode config the launcher last wrote for `agentId`, and that agent's entry in it; null before its first turn. */
export function openCodeConfigOf(app: PersonApp, agentId: string): { config: any; entry: any } | null {
  const file = join(app.sandbox.userData, 'acp', 'opencode', createHash('sha256').update(agentId).digest('hex').slice(0, 16), 'opencode.json')
  if (!existsSync(file)) return null
  const config = JSON.parse(readFileSync(file, 'utf8'))
  const entry = Object.values(config.agent ?? {}).find((agent: any) => String(agent.prompt ?? '').includes(`\`${agentId}\``))
  return entry ? { config, entry } : null
}

/**
 * Run `app`'s OpenCode agents on the scripted fake ACP agent (`fakeAcpEngine.ts`),
 * over a keyless Ollama credential at `ollamaHost` as the default chat mode —
 * the launcher then writes each agent's real `opencode.json`, and no model runs.
 */
export async function useFakeOpenCode(app: PersonApp, ollamaHost: string, model: string): Promise<FakeAcpEngine> {
  const fake = await installFakeAcpEngine(app as unknown as CinnaApp)
  await app.page.evaluate(
    async ({ host, model }) => {
      const { id } = await window.api.providers.upsert({ type: 'ollama', name: 'Ollama', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId: model, isDefault: true })
    },
    { host: ollamaHost, model }
  )
  return fake
}

/**
 * Run Codex on the scripted app-server (`fakeCodexAppServer.mjs`) through the
 * explicit Codex path, as `codex-engine.spec.ts` does; it records every request
 * in `<home>/codex-requests.jsonl`. Takes effect after the next relaunch.
 */
export function installFakeCodex(app: PersonApp): string {
  const bin = join(app.sandbox.home, 'bin')
  mkdirSync(bin, { recursive: true })
  const executable = join(bin, 'codex')
  const source = readFileSync(join(repoRoot, 'src/main/agents/drivers/acp/testSupport/fakeCodexAppServer.mjs'), 'utf8')
  writeFileSync(executable, `#!${process.execPath}\n${source}`, { mode: 0o755 })
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  for (const profile of ['.zprofile', '.zshrc', '.bash_profile', '.profile']) {
    appendFileSync(join(app.sandbox.home, profile), `\nexport PATH=${quote(bin)}:$PATH\nexport CODEX_HOME=${quote(app.sandbox.home)}\n`)
  }
  return executable
}

/** What the scripted Codex was asked to start, newest last. */
export function codexThreadStarts(app: PersonApp): any[] {
  const file = join(app.sandbox.home, 'codex-requests.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((request) => request.method === 'thread/start' && !request.params?.ephemeral)
}

/** `text` sent from the composer of the agent's page, which starts a new chat with it. */
export async function startAgentChat(app: PersonApp, name: string, text: string): Promise<void> {
  await openAgent(app, name)
  const input = app.page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(text)
  await input.press('Enter')
}

/** The chat whose first user message is `text`, as main stores it; null until it exists. */
export async function chatStartedWith(app: PersonApp, text: string): Promise<any | null> {
  return app.page.evaluate(async (first) => {
    for (const row of await window.api.chat.list()) {
      const chat = await window.api.chat.get(row.id)
      if (chat?.messages.find((message) => message.role === 'user')?.content === first) return chat
    }
    return null
  }, text)
}

/** Share `name`, an own skill of agent `agentId`, over main's publish (the Share dialog's call); answers core's item as the publisher sees it. */
export async function publishSkill(
  app: PersonApp,
  agentId: string,
  name: string,
  input: { people?: SharingPerson[]; releaseNotes?: string } = {}
): Promise<any> {
  const people = input.people?.map((person) => ({ userId: person.id, access: 'use' as const }))
  const published = await app.page.evaluate((args) => window.api.skillPublish.publish(args), {
    agentId,
    name,
    releaseNotes: input.releaseNotes ?? 'From the lifecycle spec',
    ...(people ? { people } : {})
  })
  expect(published.ok, JSON.stringify(published)).toBe(true)
  return skillItem(app.fixtureRef, app.person.token, name)
}

/** Delete one cached revision (`<instance>/<uuid>/<revision>/`) as a disk clean-up or another machine would leave it; the cache is read-only by design. */
export function dropCachedRevision(app: PersonApp, packageUuid: string, revision: number, name: string): void {
  const dir = cachedSkillDir(app, packageUuid, revision, name)
  if (!dir) throw new Error(`${app.label} has no cached ${name} revision ${revision}`)
  const revisionDir = dirname(dir)
  execFileSync('chmod', ['-R', 'u+w', revisionDir])
  rmSync(revisionDir, { recursive: true, force: true })
}

/** Core's answer to the bearer of `token` downloading revision `revision` of the skill package (the U7 route). */
export async function skillDownloadStatus(fixture: TeamFixtureBase, token: string, packageUuid: string, revision: number): Promise<number> {
  const response = await fetch(`${fixture.server}/api/v1/skills/packages/${packageUuid}/revisions/${revision}/download`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  await response.arrayBuffer()
  return response.status
}

/**
 * The agent's credential attachments as Desktop State stores them
 * (`<agent>/app-data/desktop.json` `serviceCredentials`), one
 * `<group>:<ref>[ auto:<slot>]` string each, sorted.
 */
export function storedAttachments(agentPath: string): string[] {
  const file = join(agentPath, 'app-data', 'desktop.json')
  if (!existsSync(file)) return []
  const state = JSON.parse(readFileSync(file, 'utf8')) as {
    serviceCredentials?: { local?: { ref: string; auto?: { slot: string } }[]; accounts?: Record<string, { ref: string; auto?: { slot: string } }[]> }
  }
  const groups: [string, { ref: string; auto?: { slot: string } }[]][] = [
    ['local', state.serviceCredentials?.local ?? []],
    ...Object.entries(state.serviceCredentials?.accounts ?? {}).map(([key, refs]) => ['account', refs] as [string, typeof refs])
  ]
  return groups.flatMap(([group, refs]) => refs.map((entry) => `${group}:${entry.ref}${entry.auto ? ` auto:${entry.auto.slot}` : ''}`)).sort()
}

/** The skill-slot rows of main's setup read: `<slot>:<type>:<state>:<attached record name>`. */
export async function skillSlotStates(app: PersonApp, agentId: string): Promise<string[] | string> {
  const setup = await app.page.evaluate((id) => window.api.serviceCredentials.setupState(id), agentId)
  if (!setup.ok) return setup.message
  return setup.value.skillSlots.map((slot) => `${slot.slot}:${slot.type}:${slot.state}:${slot.attached?.credential.name ?? ''}`)
}

/** The Skills row's Remove → the confirm's Remove skill; resolves once the row is gone. */
export async function removeSkillFromAgent(app: PersonApp, agent: string, skill: string): Promise<void> {
  await openSkills(app, agent)
  const row = skillRow(app, skill, 'From the catalog')
  await row.getByRole('button', { name: `Remove ${skill} from this agent`, exact: true }).click()
  await row.getByRole('group', { name: `Remove ${skill} from this agent` }).getByRole('button', { name: 'Remove skill', exact: true }).click()
  await expect(row).toHaveCount(0, { timeout: 60_000 })
}

/**
 * Just enough of Ollama on loopback for a keyless credential to list `model`
 * ({@link useFakeOpenCode}); answers the host and a close.
 */
export async function startOllamaStub(model: string): Promise<{ host: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: model, model, details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' } }] }))
      return
    }
    if (req.url === '/api/version') {
      res.end(JSON.stringify({ version: '0.6.2' }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/**
 * A credential owned by the bearer of `token`, made over core's REST as the
 * web UI would: `api_token` (bearer) unless `type` says otherwise. Deleted
 * with its owner, so a fixture person's credentials need no cleanup of their own.
 */
export async function createCoreCredential(
  fixture: TeamFixtureBase,
  token: string,
  input: { name: string; serviceUri: string; allowSharing?: boolean; allowLocalUse?: boolean; type?: 'api_token' | 'odoo' }
): Promise<{ id: string; name: string; secret: string }> {
  const secret = `${input.serviceUri}-${randomBytes(6).toString('hex')}`
  const type = input.type ?? 'api_token'
  const response = await fetch(`${fixture.server}/api/v1/credentials/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      type,
      service_uri: input.serviceUri,
      allow_sharing: input.allowSharing ?? false,
      allow_local_use: input.allowLocalUse ?? true,
      credential_data:
        type === 'odoo'
          ? { url: 'https://odoo.example.com', database_name: 'e2e', login: 'e2e@example.com', api_token: secret }
          : { api_token_type: 'bearer', api_token: secret }
    })
  })
  const body = (await response.json()) as { id?: string; detail?: unknown }
  expect(response.status, JSON.stringify(body.detail ?? '')).toBe(200)
  return { id: String(body.id), name: input.name, secret }
}

/**
 * A command `command` on the agent at `agentPath` that runs `file` (a script
 * of a cached catalog skill, by absolute path). `uv run python <file>`, not
 * `python3 <file>`: the runner turns `python …` into `uv run …`, which runs
 * only a `.py` file as a script.
 */
export async function addScriptCommand(app: PersonApp, agentPath: string, command: string, file: string): Promise<void> {
  const yaml = join(agentPath, 'docs/CLI_COMMANDS.yaml')
  writeFileSync(
    yaml,
    `${readFileSync(yaml, 'utf8')}  - name: ${command}\n    description: A catalog skill's own script.\n    command: uv run python ${JSON.stringify(file)}\n`
  )
  await app.page.evaluate(() => window.api.localAgents.rescan())
}

/** Each skill slot of main's setup read, with the last `provision-local` outcome, the offered records and a wrong-type attachment. */
export async function skillSlotDetails(
  app: PersonApp,
  agentId: string
): Promise<{ slot: string; type: string; state: string; attached: string | null; provision: string | null; options: string[]; typeMismatch: string | null }[]> {
  const setup = await app.page.evaluate((id) => window.api.serviceCredentials.setupState(id), agentId)
  if (!setup.ok) throw new Error(setup.message)
  return setup.value.skillSlots.map((slot) => ({
    slot: slot.slot,
    type: slot.type,
    state: slot.state,
    attached: slot.attached?.credential.name ?? null,
    provision: slot.provision,
    options: slot.options.map((option) => option.credential.name),
    typeMismatch: slot.typeMismatch?.name ?? null
  }))
}

/** A `section` of the page whose `h2` is `title` (a SettingsSection). */
export function titledSection(app: PersonApp, title: string) {
  return app.page.locator('section').filter({ has: app.page.getByRole('heading', { level: 2, name: title, exact: true }) })
}

/** The footer's user menu → Settings, unless Settings is already open (the item toggles). */
export async function openSettings(app: PersonApp): Promise<void> {
  const page = app.page
  if (await page.getByRole('button', { name: 'MCP Providers', exact: true }).isVisible()) return
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByTitle(user?.cinnaFullName ?? user?.displayName ?? 'User', { exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('button', { name: 'MCP Providers', exact: true })).toBeVisible()
}

/** Settings → Profile → Catalog; answers its one section, `Agents and skills`. */
export async function openSettingsCatalog(app: PersonApp) {
  await openSettings(app)
  await app.page.getByRole('button', { name: 'Catalog', exact: true }).click()
  await expect(app.page.getByRole('heading', { level: 1 })).toHaveText('Catalog')
  return titledSection(app, 'Agents and skills')
}

/** Agent page → Settings → Sharing. */
export async function openSharingTab(app: PersonApp, name: string): Promise<void> {
  await openAgent(app, name)
  await app.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await app.page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: 'Sharing', exact: true }).click()
  await expect(titledSection(app, 'Where it’s shared')).toBeVisible()
}

/**
 * `name` is not among `app`'s catalog agents: after a fresh listing, the
 * dialog's Agents search ends in its empty line, not in a tile. Closes the catalog again.
 */
export async function expectAgentNotListed(app: PersonApp, name: string): Promise<void> {
  const listed = await app.page.evaluate(() => window.api.sharing.library(true))
  expect(listed.success).toBe(true)
  const catalog = await openCatalog(app, 'Agents')
  await catalog.getByRole('textbox', { name: 'Search the catalog' }).fill(name)
  await expect(
    catalog.getByText('Nothing matches your search.', { exact: true }).or(catalog.getByText('No agents are in the catalog for you yet.', { exact: true }))
  ).toBeVisible()
  await expect(catalog.getByRole('group', { name, exact: true })).toHaveCount(0)
  await app.page.keyboard.press('Escape')
  await expect(catalog).toHaveCount(0)
}

/** The display names of every item main's cached catalog listing holds for the active profile; null for a profile that is not a Cinna one. */
export async function catalogNames(app: PersonApp, refresh = true): Promise<string[] | null> {
  const listed = await app.page.evaluate((r) => window.api.catalog.items(r), refresh)
  if (!listed.success) throw new Error(listed.message)
  return listed.value === null ? null : listed.value.items.map((item) => item.display_name ?? item.name).sort()
}

/**
 * A second profile in `app` named by `person`'s email, holding `person`'s
 * desktop tokens — two Cinna accounts on one computer. Not activated.
 */
export async function addCinnaProfile(app: PersonApp, person: SharingPerson): Promise<void> {
  const registered = await app.page.evaluate(
    (p) => window.api.auth.register({ accountType: 'local', username: p.email, displayName: p.name }),
    person
  )
  if (!registered.success) throw new Error(`could not add ${person.email}'s profile`)
  await app.writeTokens(person)
}

/** The footer's user menu → the Profiles row named `name`; waits until main has switched. */
export async function switchProfile(app: PersonApp, name: string, username: string): Promise<void> {
  const page = app.page
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByTitle(user?.cinnaFullName ?? user?.displayName ?? 'User', { exact: true }).click()
  await page.getByRole('button').filter({ hasText: name }).first().click()
  await expect.poll(async () => (await page.evaluate(() => window.api.auth.getCurrent()))?.username).toBe(username)
}

/** Out of Settings through its sidebar's Back, when Settings is open. */
export async function closeSettings(app: PersonApp): Promise<void> {
  const page = app.page
  if (!(await page.getByRole('button', { name: 'MCP Providers', exact: true }).isVisible())) return
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByRole('button', { name: 'MCP Providers', exact: true })).toHaveCount(0)
}
