import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  addScriptCommand,
  addSkillToAgent,
  buildAgent,
  cachedSkillDir,
  catalogPins,
  closeSettings,
  cloudCatalogItem,
  openCatalog,
  openSettingsCatalog,
  publishCloudVersion,
  skillItem,
  skillLocalInstalls,
  slotLine,
  titledSection,
  uniqueName,
  type CatalogFixture
} from '../fixtures/liveCatalog'
import { coreCall, runCommand, type PersonApp } from '../fixtures/liveTeamSharing'

/**
 * The cloud side of the one catalog (plan README §7, T6), against the real
 * local cinna-core: a skill authored in a **cloud** agent's workspace and
 * published to the catalog reaches a desktop agent, and the cloud agent itself,
 * published as a bundle, is installed, updated and uninstalled from the desktop.
 *
 * Setup: `live-catalog.py create cloud` (A is made an agent-developer, creates
 * `Catalog cloud e2e <tag>` with a running environment, writes
 * `skills/cloud-check-<tag>/` into its workspace, publishes the skill to B and
 * the agent as a bundle B may use). Without its `cloud` key every test skips.
 *
 * No model runs (0 turns). The environments' AI key is a placeholder nothing
 * calls. Two containers come and go per run: A's agent (made by the fixture)
 * and B's install (made by Get here, removed by Uninstall); cleanup deletes
 * both through core.
 */

const SHOTS = '/tmp/cinna-live/shots'

function cloudOf(fixture: CatalogFixture) {
  test.skip(!fixture.cloud, 'run e2e/fixtures/live-catalog.py with `create cloud` for the cloud agent, its skill and its bundle')
  return fixture.cloud!
}

async function shot(app: PersonApp, file: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await app.page.screenshot({ path: join(SHOTS, file), animations: 'disabled' })
}

test('T6 a: a skill published from a cloud agent’s workspace is listed beside it, added to B’s desktop agent, and its script reads B’s ERP API', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const cloud = cloudOf(fixture)
  const { a: personA, b: personB } = fixture.people
  const skill = cloud.skill.name

  const b = await team.open('b')
  const mine = uniqueName(fixture, 'Order desk')
  const built = await buildAgent(b, fixture, { name: mine })

  await test.step('B’s catalog: the cloud agent reads Runs in Cinna, Version 1, by A; its skill reads Skill, by A', async () => {
    const catalog = await openCatalog(b, 'All')
    const agentTile = catalog.getByRole('group', { name: cloud.name, exact: true })
    await expect(agentTile).toContainText('Runs in Cinna')
    await expect(agentTile).not.toContainText('Runs on your computer')
    await expect(agentTile).toContainText('Version 1')
    await expect(agentTile).toContainText(`by ${personA.name}`)
    await expect(agentTile.getByRole('button', { name: 'Get', exact: true })).toBeEnabled()
    const skillTile = catalog.getByRole('group', { name: skill, exact: true })
    await expect(skillTile).toContainText('Skill')
    await expect(skillTile).toContainText(`by ${personA.name}`)
    await expect(skillTile.getByRole('button', { name: 'Add to agent…' })).toBeEnabled()
    await b.page.keyboard.press('Escape')
    await expect(catalog).toHaveCount(0)
  })

  let cached = ''
  await test.step('Add to agent…: B’s agent pins Version 1, the revision is cached, core records the local install, the ERP API is connected by slot', async () => {
    const item = await skillItem(fixture, personB.token, skill)
    expect(item.uuid).toBe(cloud.skill.packageId)
    expect(item.publisher?.user_id).toBe(personA.id)
    await addSkillToAgent(b, skill, mine)
    expect(catalogPins(built.path)).toEqual([expect.objectContaining({ name: skill, package_uuid: item.uuid, revision_number: 1 })])
    await expect.poll(() => cachedSkillDir(b, item.uuid, 1, skill), { timeout: 30_000 }).not.toBeNull()
    cached = cachedSkillDir(b, item.uuid, 1, skill)!
    await expect
      .poll(() => skillLocalInstalls(fixture, personB.token, skill), { timeout: 30_000 })
      .toEqual([`${built.manifestId.toLowerCase()}@1`])
    await expect
      .poll(async () => {
        const setup = await b.page.evaluate((id) => window.api.serviceCredentials.setupState(id), built.id)
        if (!setup.ok) return setup.message
        return setup.value.skillSlots.map((slot) => `${slot.slot}:${slot.type}:${slot.state}:${slot.attached?.credential.name ?? ''}`)
      }, { timeout: 30_000 })
      .toEqual([`erp-api:api_token:connected:${fixture.credentials.erp.name}`])
  })

  await test.step('/run:cloud-check — the cloud-authored script, run from B’s cache, reads the admin’s ERP API through core.cinna_api', async () => {
    await addScriptCommand(b, built.path, 'cloud-check', join(cached, 'scripts/cloud_check'))
    await runCommand(b, mine, 'cloud-check')
    await expect(b.page.getByText(slotLine('cloud-skill', 'erp-api', fixture.credentials.erp.secret))).toBeVisible({ timeout: 60_000 })
  })
})

test('T6 b: B Gets the cloud bundle, sees Uninstall and Open in Cinna in Settings → Catalog, gets A’s Version 2 as an Inbox card, and Uninstalls', async ({ team }) => {
  test.setTimeout(420_000)
  const { fixture } = team
  const cloud = cloudOf(fixture)
  const { b: personB } = fixture.people
  const name = cloud.name
  const b = await team.open('b')
  const myInstalls = async (): Promise<string[]> =>
    (((await cloudCatalogItem(fixture, personB.token, cloud.bundleId))?.my_installs ?? []) as any[]).map((r) => `${r.where}:${r.revision_number}`)

  await test.step('Get on the Runs in Cinna tile lands on the installed agent; core lists B’s cloud install at Version 1', async () => {
    const catalog = await openCatalog(b, 'Agents')
    await catalog.getByRole('group', { name, exact: true }).getByRole('button', { name: 'Get', exact: true }).click()
    await expect(catalog).toHaveCount(0, { timeout: 120_000 })
    await expect(b.page.getByRole('heading', { level: 1 })).toHaveText(name)
    await expect.poll(myInstalls, { timeout: 30_000 }).toEqual(['cloud:1'])
  })

  await test.step('core: B’s install gets an environment of its own, which builds and runs', async () => {
    // Also keeps Uninstall off core's build: an uninstall while the build copies its template leaves the instance folder behind.
    const installId = ((await cloudCatalogItem(fixture, personB.token, cloud.bundleId)).my_installs as any[])[0].install_id as string
    await expect
      .poll(async () => {
        const agent = await coreCall(fixture, personB.token, `/agents/${installId}`)
        const envId = agent.body?.active_environment_id
        if (!envId) return 'no environment yet'
        return (await coreCall(fixture, personB.token, `/environments/${envId}`)).body?.status
      }, { timeout: 180_000, intervals: [2_000] })
      .toBe('running')
  })

  const tile = () => titledSection(b, 'Agents and skills').getByRole('group', { name, exact: true })
  await test.step('Settings → Catalog: the tile offers Open; its detail has Open in Cinna and Uninstall', async () => {
    const section = await openSettingsCatalog(b)
    await expect(tile()).toContainText('Runs in Cinna')
    await expect(tile().getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    await tile().getByRole('button', { name, exact: true }).click()
    await expect(section.getByRole('heading', { level: 3, name, exact: true })).toBeVisible()
    await expect(section.getByRole('button', { name: `Open ${name} in Cinna` })).toBeVisible()
    await expect(section.getByRole('button', { name: `Uninstall ${name}` })).toBeVisible()
    await shot(b, 'cloud-detail-installed.png')
    await closeSettings(b)
  })

  await test.step('A publishes Version 2; after B’s next sync the Inbox card names it Runs in Cinna at Version 2', async () => {
    await publishCloudVersion(fixture, '2.0', 'Version 2 from live-sharing-cloud.spec')
    // The cloud card is drawn from the remote agents' sync, which runs at start and every five minutes.
    await b.relaunch()
    await b.page.getByRole('button', { name: /^Inbox/ }).click()
    const card = b.page.getByRole('article', { name: `Update available for ${name}` })
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card).toContainText('Version 2')
    await expect(card).toContainText('Runs in Cinna')
    await expect(card.getByRole('button', { name: 'Update', exact: true })).toBeVisible()
  })

  await test.step('Uninstall from the detail: the confirm closes, core lists no install, the tile offers Get again', async () => {
    const section = await openSettingsCatalog(b)
    await tile().getByRole('button', { name, exact: true }).click()
    await section.getByRole('button', { name: `Uninstall ${name}` }).click()
    const confirm = b.page.getByRole('dialog', { name: `Uninstall ${name}` })
    await expect(confirm.getByText(`Uninstall ${name}?`, { exact: true })).toBeVisible()
    await confirm.getByRole('button', { name: 'Uninstall', exact: true }).click()
    await expect(confirm).toHaveCount(0, { timeout: 120_000 })
    await expect.poll(myInstalls, { timeout: 30_000 }).toEqual([])
    await expect(section.getByRole('button', { name: `Uninstall ${name}` })).toHaveCount(0, { timeout: 30_000 })
    await section.getByRole('button', { name: 'Back to catalog' }).click()
    await expect(tile().getByRole('button', { name: 'Get', exact: true })).toBeVisible({ timeout: 30_000 })
  })
})
