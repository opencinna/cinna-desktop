import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  addSkillToAgent,
  buildAgent,
  cachedSkillDir,
  catalogPins,
  getAgent,
  openSkills,
  shareSkill,
  skillDto,
  skillItem,
  skillName,
  skillRow,
  uniqueName,
  updateFromCatalog
} from '../fixtures/liveCatalog'
import { findAgent, finishWithWeather, refreshLibrary, shareChanges, shareWithTeam } from '../fixtures/liveTeamSharing'

/**
 * The catalog story (plan README §7), access: an agent's access carries the
 * catalog skills it pins (U7) — C, who has no grant on A's private skill,
 * Gets an agent pinning it and the skill downloads; a teammate who may only
 * use a shared agent is offered no Share, Remove or Update on its skills
 * (U9); and B shares a skill back to A, who pins it in the shared agent.
 * No model runs. Setup: `e2e/fixtures/live-catalog.py`.
 */

test('§7 7: C Gets an agent that pins A’s private skill, and the skill downloads without a grant on it', async ({ team }) => {
  test.setTimeout(420_000)
  const { fixture } = team
  const { a: personA, c: personC } = fixture.people
  const workshop = uniqueName(fixture, 'Skill workshop')
  const audit = uniqueName(fixture, 'Audit bot')
  const skill = skillName('erp-lookup')

  const a = await team.open('a')
  const source = await buildAgent(a, fixture, {
    name: workshop,
    skill: { name: skill, description: 'Look up an order in the ERP.', credentials: [{ slot: 'erp-api', type: 'api_token' }] }
  })
  const published = await a.page.evaluate(
    (input) => window.api.skillPublish.publish(input),
    { agentId: source.id, name: skill, releaseNotes: 'Private to A', people: [], everyone: false, publisherCredentials: [] }
  )
  expect(published.ok, JSON.stringify(published)).toBe(true)
  const item = await skillItem(fixture, personA.token, skill)
  expect(item.visibility).toBe('private')

  const auditBot = await buildAgent(a, fixture, { name: audit })
  await addSkillToAgent(a, skill, audit)
  expect(catalogPins(auditBot.path)).toEqual([expect.objectContaining({ name: skill, package_uuid: item.uuid, revision_number: 1 })])
  await shareWithTeam(a, audit, [{ person: personC }])

  const c = await team.open('c')
  await test.step('core: C has no grant on the skill — it is not in C’s catalog', async () => {
    expect(await skillItem(fixture, personC.token, skill)).toBeUndefined()
  })

  await test.step('7 C: Get succeeds and the pinned skill is downloaded, working, with nothing to change', async () => {
    await getAgent(c, audit)
    await expect.poll(() => cachedSkillDir(c, item.uuid, 1, skill), { timeout: 30_000 }).not.toBeNull()
    const got = await findAgent(c, audit)
    expect(catalogPins(got.path)).toEqual([expect.objectContaining({ name: skill, package_uuid: item.uuid, revision_number: 1 })])
    expect(existsSync(join(got.path, 'skills', skill))).toBe(false)
    await openSkills(c, audit)
    const row = skillRow(c, skill, 'From the catalog')
    await expect(row.getByRole('img', { name: 'Every engine of this agent gets this skill', exact: true })).toBeVisible()
    await expect(row).not.toContainText('Not on this computer yet.')
    // C has no ERP credential: the slot chip says so and offers Finish setup, the only button left.
    await expect(row.getByRole('img', { name: 'No credential for erp-api is attached yet', exact: true })).toBeVisible()
    await expect(row.getByRole('button')).toHaveText(['Finish setup'])
  })
})

test('§7 8–9: B shares a skill back; A pins it in report-bot; B, who may only use report-bot, is offered no Share, Remove or Update there', async ({ team }) => {
  test.setTimeout(480_000)
  const { fixture } = team
  const { a: personA, b: personB } = fixture.people
  const name = uniqueName(fixture, 'Report bot')
  const ledger = uniqueName(fixture, 'Ledger bot')
  const erp = skillName('erp-lookup')
  const tips = skillName('ledger-tips')

  const a = await team.open('a')
  const reportBot = await buildAgent(a, fixture, {
    name,
    slots: true,
    skill: { name: erp, description: 'Look up an order in the ERP.', credentials: [{ slot: 'erp-api', type: 'api_token' }] }
  })
  await shareWithTeam(a, name, [{ person: personB }])

  const b = await team.open('b')
  await getAgent(b, name)
  await finishWithWeather(b, name, `weather-b-${fixture.tag}`)
  const ledgerBot = await buildAgent(b, fixture, { name: ledger, skill: { name: tips, description: 'Tips for reading a ledger.' } })

  await test.step('9 B: shares ledger-tips with A from the Skills section', async () => {
    await shareSkill(b, ledger, tips, { people: [personA], note: 'For A' })
    await expect(skillRow(b, tips, 'Authored')).toContainText('Version 1')
    expect((await skillItem(fixture, personA.token, tips))?.access).toBe('use')
    expect((await skillItem(fixture, personB.token, tips))?.access).toBe('maintain')
  })

  await test.step('9 A: adds B’s skill to report-bot and shares the change', async () => {
    await refreshLibrary(a)
    await addSkillToAgent(a, tips, name)
    expect(catalogPins(reportBot.path)).toEqual([expect.objectContaining({ name: tips, revision_number: 1 })])
    await shareChanges(a, name, `Adds ${tips}`)
  })

  const got = await findAgent(b, name)
  await test.step('8 B: after the Update, report-bot’s skills offer B nothing to change', async () => {
    await refreshLibrary(b)
    await updateFromCatalog(b, name)
    expect(catalogPins(got.path)).toEqual([expect.objectContaining({ name: tips, revision_number: 1 })])
    await openSkills(b, name)
    const own = skillRow(b, erp, 'Authored')
    await expect(own).toBeVisible()
    await expect(own.getByRole('button', { name: `Share ${erp}…`, exact: true })).toHaveCount(0)
    await expect(own.getByRole('button', { name: `Reveal SKILL.md of ${erp}`, exact: true })).toBeVisible()
    const pin = skillRow(b, tips, 'From the catalog')
    await expect(pin.getByRole('img', { name: 'Every engine of this agent gets this skill', exact: true })).toBeVisible()
    await expect(pin.getByRole('button', { name: `Remove ${tips} from this agent`, exact: true })).toHaveCount(0)
  })

  await test.step('8 B: shares ledger-tips Version 2 from B’s own agent', async () => {
    appendFileSync(join(ledgerBot.path, 'skills', tips, 'SKILL.md'), '\nRead the totals first.\n')
    await shareSkill(b, ledger, tips, { note: 'Totals first', newVersion: true })
    await expect.poll(async () => (await skillItem(fixture, personA.token, tips))?.latest?.revision_number).toBe(2)
  })

  await test.step('8 A, the maintainer: the Inbox and the Skills row offer Update to Version 2', async () => {
    await refreshLibrary(a)
    await a.page.getByRole('button', { name: /^Inbox/ }).click()
    await expect(a.page.getByRole('article', { name: `Update available for ${tips} in ${name}` })).toBeVisible({ timeout: 20_000 })
    // A fresh page: an agent page read before the new version keeps its old row (the defect test below).
    await a.relaunch()
    await refreshLibrary(a)
    await openSkills(a, name)
    await expect(skillRow(a, tips, 'From the catalog').getByRole('button', { name: new RegExp(`^Update ${tips} to Version 2`) })).toBeVisible()
  })

  await test.step('8 B, who may only use report-bot: no Update, no Remove, no Inbox card; main refuses the update', async () => {
    await b.relaunch()
    await refreshLibrary(b)
    await expect.poll(async () => (await skillDto(b, got.id, tips, 'catalog'))?.latestRevision).toBe(2)
    expect((await skillDto(b, got.id, tips, 'catalog'))?.updatable).toBe(false)
    await openSkills(b, name)
    const pin = skillRow(b, tips, 'From the catalog')
    await expect(pin).toContainText('Version 1')
    await expect(pin.getByRole('button', { name: new RegExp(`^Update ${tips}`) })).toHaveCount(0)
    await expect(pin.getByRole('button', { name: `Remove ${tips} from this agent`, exact: true })).toHaveCount(0)
    await b.page.getByRole('button', { name: /^Inbox/ }).click()
    await expect(b.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
    await expect(b.page.getByRole('article', { name: `Update available for ${tips} in ${name}` })).toHaveCount(0)
    const refused = await b.page.evaluate((args) => window.api.catalogSkills.update(args.id, args.name), { id: got.id, name: tips })
    expect(refused).toMatchObject({ ok: false, code: 'read_only' })
    expect(catalogPins(got.path)).toEqual([expect.objectContaining({ name: tips, revision_number: 1 })])
  })
})

test('a skill’s new version alone reaches the Skills row of an agent page already open', async ({ team }) => {
  // `catalog:items-changed` re-reads the local agent queries too, so the open
  // page's row offers Update without anything else re-reading the agent.
  test.setTimeout(300_000)
  const { fixture } = team
  const { a: personA, b: personB } = fixture.people
  const workshop = uniqueName(fixture, 'Skill workshop')
  const mine = uniqueName(fixture, 'Ledger bot')
  const skill = skillName('erp-lookup')

  const a = await team.open('a')
  const source = await buildAgent(a, fixture, { name: workshop, skill: { name: skill, description: 'Look up an order in the ERP.' } })
  const people = [{ userId: personB.id, access: 'use' as const }]
  const first = await a.page.evaluate((input) => window.api.skillPublish.publish(input), { agentId: source.id, name: skill, releaseNotes: 'One', people })
  expect(first.ok, JSON.stringify(first)).toBe(true)
  const item = await skillItem(fixture, personA.token, skill)

  const b = await team.open('b')
  const own = await buildAgent(b, fixture, { name: mine })
  await refreshLibrary(b)
  const added = await b.page.evaluate((args) => window.api.catalogSkills.add(args.id, args.uuid), { id: own.id, uuid: item.uuid })
  expect(added.ok, JSON.stringify(added)).toBe(true)
  // A fresh window, so no folder event from the add is still on its way to the page.
  await b.relaunch()
  await refreshLibrary(b)
  await openSkills(b, mine)
  await expect(skillRow(b, skill, 'From the catalog')).toContainText('Version 1')

  appendFileSync(join(source.path, 'skills', skill, 'SKILL.md'), '\nTwo.\n')
  const second = await a.page.evaluate((input) => window.api.skillPublish.publish(input), { agentId: source.id, name: skill, releaseNotes: 'Two' })
  expect(second.ok, JSON.stringify(second)).toBe(true)
  // The page stays open, as a user's would, while the catalog is read again.
  await refreshLibrary(b)
  expect((await skillDto(b, own.id, skill, 'catalog'))?.updatable).toBe(true)
  await expect(skillRow(b, skill, 'From the catalog').getByRole('button', { name: new RegExp(`^Update ${skill} to Version 2`) })).toBeVisible({
    timeout: 10_000
  })
})
