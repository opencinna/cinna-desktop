import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  credentials: { erp: { id: string; name: string; secret: string; shares: Record<'a' | 'b', string> } }
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
 * credential for slot `erp-api` through `core.cinna_api` — and prints its type
 * and a hash prefix of its header value, never the value.
 */
const SLOT_CHECK = `import hashlib
import sys

from core.cinna_api import credentials

cred = credentials.by_slot("erp-api")
if cred is None:
    # Exit 0: a failed command folds its output behind Details.
    print("slot-check: erp-api=none")
    sys.exit(0)
value = (cred.get("credential_data") or {}).get("http_header_value", "")
print(f"slot-check: erp-api={cred.get('type')} {hashlib.sha256(str(value).encode()).hexdigest()[:12]}")
`

const CLI_COMMANDS = `commands:
  - name: status
    description: Refresh the agent's self-reported STATUS.md.
    command: python3 scripts/update_status.py --status ok --summary "Ready"
  - name: slot-check
    description: Which credential the erp-api slot finds, by hash.
    command: python3 scripts/slot_check.py
`

/** What `slot-check` prints when the admin's ERP API reached the agent. */
export function slotCheckLine(fixture: CatalogFixture): string {
  return `slot-check: erp-api=api_token ${shortHash(`Bearer ${fixture.credentials.erp.secret}`)}`
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
  input: { description: string; credentials?: { slot: string; type: string; description?: string }[]; body?: string }
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
 * `people` at Can use → Share. Waits until the dialog closed.
 */
export async function shareSkill(
  app: PersonApp,
  agent: string,
  skill: string,
  input: { people?: SharingPerson[]; note?: string; newVersion?: boolean }
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
  if (input.note) await dialog.getByRole('textbox').fill(input.note)
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
