import { appendFileSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  addSkillToAgent,
  buildAgent,
  cachedSkillDir,
  catalogPins,
  expectSkillListed,
  expectSkillNotListed,
  getAgent,
  openSkills,
  shareSkill,
  skillItem,
  skillLocalInstalls,
  skillName,
  skillRow,
  uniqueName,
  writeSkill
} from '../fixtures/liveCatalog'
import { catalogGrants, coreCall, findAgent, refreshLibrary, shareWithTeam, type SharingPerson } from '../fixtures/liveTeamSharing'

/**
 * Who a shared skill reaches, against the real local cinna-core, with four
 * people: A shares four skills from one agent through the Share dialog —
 * to B alone, to B and C, to everyone on the server (the dialog's
 * `Everyone on this server can use it`), and to nobody — and each of B, C and
 * D finds in the catalog exactly the ones meant for them, which core's
 * `/catalog/items` as that person agrees with, and adds them to an agent of
 * their own. B's add is followed to the pin, the cached copy and core's
 * record of the local install against B's agent's manifest id.
 *
 * Then an editor who is not the publisher (S11): B, with Can edit on A's
 * agent, shares a new skill from it (B is that skill's publisher), is offered
 * no new version of A's skill while B may only use it — and main refuses one —
 * and, once A gives B edit on the skill, shares Version 2 of it.
 *
 * No model runs. Setup: `e2e/fixtures/live-catalog.py` (which makes D).
 */

/** D is required here; an older fixture JSON has no D. */
function personD(fixture: { people: { d?: SharingPerson } }): SharingPerson {
  const d = fixture.people.d
  if (!d) throw new Error('the catalog fixture has no person D: re-run live-catalog.py create')
  return d
}

const NOT_PUBLISHER = 'Ask a maintainer for edit access — you can use this skill but not share new versions of it.'

test('S1–S4 audiences: one person, the team, everyone, nobody — each skill reaches exactly its people, and B’s add is recorded against B’s agent', async ({ team }) => {
  test.setTimeout(480_000)
  const { fixture } = team
  const { a: personA, b: personB, c: personC } = fixture.people
  const personD_ = personD(fixture)
  const workshop = uniqueName(fixture, 'Skill workshop')
  const skills = {
    onlyB: skillName('for-b'),
    team: skillName('for-team'),
    everyone: skillName('for-all'),
    nobody: skillName('for-none')
  }
  const tokens = { a: personA.token, b: personB.token, c: personC.token, d: personD_.token }
  const ids = { a: personA.id, b: personB.id, c: personC.id }

  const a = await team.open('a')
  const source = await buildAgent(a, fixture, { name: workshop })
  for (const name of Object.values(skills)) writeSkill(source.path, name, { description: `The ${name} skill.`, body: 'Say hello.\n' })
  await a.page.evaluate(() => window.api.localAgents.rescan())

  await test.step('A shares each skill through the Share dialog', async () => {
    await shareSkill(a, workshop, skills.onlyB, { people: [personB], note: 'For B' })
    await shareSkill(a, workshop, skills.team, { people: [personB, personC], note: 'For the team' })
    await shareSkill(a, workshop, skills.everyone, { everyone: true, note: 'For everyone' })
    await shareSkill(a, workshop, skills.nobody, { note: 'For me' })
    for (const name of Object.values(skills)) await expect(skillRow(a, name, 'Authored')).toContainText('Version 1')
  })

  const items: Record<keyof typeof skills, { uuid: string }> = {} as never
  await test.step('core: visibility and grants of each skill, as A', async () => {
    for (const [key, name] of Object.entries(skills) as [keyof typeof skills, string][]) {
      const item = await skillItem(fixture, tokens.a, name)
      expect(item?.access, name).toBe('maintain')
      expect(item.publisher?.user_id).toBe(ids.a)
      items[key] = item
    }
    expect((await skillItem(fixture, tokens.a, skills.onlyB)).visibility).toBe('users')
    expect(await catalogGrants(fixture, tokens.a, items.onlyB.uuid)).toEqual([`user:${ids.a}:maintain`, `user:${ids.b}:use`].sort())
    expect((await skillItem(fixture, tokens.a, skills.team)).visibility).toBe('users')
    expect(await catalogGrants(fixture, tokens.a, items.team.uuid)).toEqual([`user:${ids.a}:maintain`, `user:${ids.b}:use`, `user:${ids.c}:use`].sort())
    expect((await skillItem(fixture, tokens.a, skills.everyone)).visibility).toBe('public')
    expect(await catalogGrants(fixture, tokens.a, items.everyone.uuid)).toEqual([`user:${ids.a}:maintain`])
    expect((await skillItem(fixture, tokens.a, skills.nobody)).visibility).toBe('private')
    expect(await catalogGrants(fixture, tokens.a, items.nobody.uuid)).toEqual([`user:${ids.a}:maintain`])
  })

  /** Which of the four each person may see, and core's access for them. */
  const audience: Record<'b' | 'c' | 'd', Record<keyof typeof skills, boolean>> = {
    b: { onlyB: true, team: true, everyone: true, nobody: false },
    c: { onlyB: false, team: true, everyone: true, nobody: false },
    d: { onlyB: false, team: false, everyone: true, nobody: false }
  }

  await test.step('core: /catalog/items as B, C and D lists exactly their skills, at use', async () => {
    for (const label of ['b', 'c', 'd'] as const) {
      for (const [key, name] of Object.entries(skills) as [keyof typeof skills, string][]) {
        const item = await skillItem(fixture, tokens[label], name)
        if (audience[label][key]) expect(item?.access, `${label} ${name}`).toBe('use')
        else expect(item, `${label} must not list ${name}`).toBeUndefined()
      }
    }
  })

  const symlinked = skillName('linked')
  await test.step('A: a skill holding a symlink is refused at Share, before anything reaches core', async () => {
    writeSkill(source.path, symlinked, { description: 'Carries a link.' })
    symlinkSync('../../knowledge/erp.md', join(source.path, 'skills', symlinked, 'notes.md'))
    await a.page.evaluate(() => window.api.localAgents.rescan())
    await openSkills(a, workshop)
    await skillRow(a, symlinked, 'Authored').getByRole('button', { name: `Share ${symlinked}…`, exact: true }).click()
    const dialog = a.page.getByRole('dialog', { name: `Share ${symlinked}` })
    await expect(dialog.getByRole('button', { name: 'Share', exact: true })).toBeEnabled({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText('Replace notes.md with the file itself — a link can’t be shared. Nothing was sent.')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(await skillItem(fixture, tokens.a, symlinked)).toBeUndefined()
  })

  await test.step('A, the publisher, sees all four in the catalog', async () => {
    for (const name of Object.values(skills)) await expectSkillListed(a, name, personA)
  })

  for (const label of ['b', 'c', 'd'] as const) {
    await test.step(`${label.toUpperCase()}: the catalog shows exactly their skills; each one shown is added to their own agent`, async () => {
      const app = await team.open(label)
      const mine = await buildAgent(app, fixture, { name: uniqueName(fixture, `Desk ${label.toUpperCase()}`) })
      const added: string[] = []
      for (const [key, name] of Object.entries(skills) as [keyof typeof skills, string][]) {
        if (!audience[label][key]) {
          await expectSkillNotListed(app, name)
          continue
        }
        await expectSkillListed(app, name, personA)
        await addSkillToAgent(app, name, mine.name)
        added.push(name)
      }
      expect(catalogPins(mine.path).map((pin) => pin.name).sort()).toEqual([...added].sort())
      for (const name of added) {
        const key = (Object.keys(skills) as (keyof typeof skills)[]).find((k) => skills[k] === name)!
        await expect.poll(() => cachedSkillDir(app, items[key].uuid, 1, name), { timeout: 30_000 }).not.toBeNull()
        expect(existsSync(join(mine.path, 'skills', name))).toBe(false)
        // Core recorded this person's local install against their agent's manifest id.
        await expect
          .poll(() => skillLocalInstalls(fixture, tokens[label], name), { timeout: 20_000 })
          .toEqual([`${mine.manifestId.toLowerCase()}@1`])
      }
      if (label === 'b') {
        // S4: B's pin of the one-person skill, exactly, and A's view of the count.
        expect(catalogPins(mine.path).find((pin) => pin.name === skills.onlyB)).toEqual(
          expect.objectContaining({ name: skills.onlyB, package_uuid: items.onlyB.uuid, revision_number: 1 })
        )
        expect((await skillItem(fixture, tokens.a, skills.onlyB)).install_count).toBe(1)
      }
      await app.close()
    })
  }

  await test.step('core: install counts as A — one-person 1, team 2, everyone 3, nobody 0', async () => {
    expect((await skillItem(fixture, tokens.a, skills.onlyB)).install_count).toBe(1)
    expect((await skillItem(fixture, tokens.a, skills.team)).install_count).toBe(2)
    expect((await skillItem(fixture, tokens.a, skills.everyone)).install_count).toBe(3)
    expect((await skillItem(fixture, tokens.a, skills.nobody)).install_count).toBe(0)
  })
})

test('S11 an editor who is not the publisher: B shares a new skill from A’s agent; a new version of A’s skill needs edit on the skill', async ({ team }) => {
  test.setTimeout(420_000)
  const { fixture } = team
  const { a: personA, b: personB } = fixture.people
  const name = uniqueName(fixture, 'Shared workshop')
  const aSkill = skillName('a-tips')
  const bSkill = skillName('b-notes')

  const a = await team.open('a')
  await buildAgent(a, fixture, { name, skill: { name: aSkill, description: 'Tips from A.', body: 'Be brief.\n' } })
  await shareSkill(a, name, aSkill, { people: [personB], note: 'From A' })
  const aItem = await skillItem(fixture, personA.token, aSkill)
  expect((await skillItem(fixture, personB.token, aSkill))?.access).toBe('use')
  await shareWithTeam(a, name, [{ person: personB, access: 'Can edit' }])

  const b = await team.open('b')
  await getAgent(b, name)
  const got = await findAgent(b, name)

  await test.step('B, an editor of the agent, writes a new skill in it and shares it: B is its publisher', async () => {
    writeSkill(got.path, bSkill, { description: 'Notes from B.', body: 'Be kind.\n' })
    await b.page.evaluate(() => window.api.localAgents.rescan())
    await shareSkill(b, name, bSkill, { people: [personA], note: 'From B' })
    await expect(skillRow(b, bSkill, 'Authored')).toContainText('Version 1')
    const asB = await skillItem(fixture, personB.token, bSkill)
    expect(asB?.access).toBe('maintain')
    expect(asB.publisher?.user_id).toBe(personB.id)
    expect((await skillItem(fixture, personA.token, bSkill))?.access).toBe('use')
  })

  await test.step('B, who may only use A’s skill: no Share a new version on its row, and main’s publish is refused by core', async () => {
    await refreshLibrary(b)
    await openSkills(b, name)
    const row = skillRow(b, aSkill, 'Authored')
    await expect(row).toContainText('Version 1')
    await expect(row.getByRole('button', { name: `Reveal SKILL.md of ${aSkill}`, exact: true })).toBeVisible()
    await expect(row.getByRole('button', { name: new RegExp(`^Share (a new version of )?${aSkill}`) })).toHaveCount(0)
    appendFileSync(join(got.path, 'skills', aSkill, 'SKILL.md'), '\nAlso be precise.\n')
    const refused = await b.page.evaluate(
      (input) => window.api.skillPublish.publish(input),
      { agentId: got.id, name: aSkill, releaseNotes: 'B tries' }
    )
    expect(refused).toEqual({ ok: false, code: 'not_publisher', message: NOT_PUBLISHER })
    expect((await skillItem(fixture, personA.token, aSkill)).latest.revision_number).toBe(1)
  })

  await test.step('A gives B edit on the skill; B shares Version 2 of A’s skill from A’s agent', async () => {
    const grants = await coreCall(fixture, personA.token, `/catalog/items/${aItem.uuid}/grants`)
    const body = (grants.body as { principal: { user_id?: string }; access: string }[]).map((g) => ({
      principal: g.principal,
      access: g.principal.user_id === personB.id ? 'edit' : g.access
    }))
    const put = await coreCall(fixture, personA.token, `/catalog/items/${aItem.uuid}/grants`, { method: 'PUT', body })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    await expect.poll(async () => (await skillItem(fixture, personB.token, aSkill))?.access).toBe('edit')
    await refreshLibrary(b)
    await shareSkill(b, name, aSkill, { note: 'B’s edit', newVersion: true })
    const after = await skillItem(fixture, personA.token, aSkill)
    expect(after.latest.revision_number).toBe(2)
    expect(after.latest.published_by?.user_id).toBe(personB.id)
    expect(after.publisher?.user_id).toBe(personA.id)
    await expect(skillRow(b, aSkill, 'Authored')).toContainText('Version 2')
  })
})
