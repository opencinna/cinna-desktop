import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installCachedEngine } from '../fixtures/engine-cache'
import { requireLiveKey, seedOpenAiDefaultMode } from '../fixtures/live'
import { askAgent } from '../fixtures/livePlugins'
import {
  test,
  expect,
  addSkillToAgent,
  buildAgent,
  catalogPins,
  openSkills,
  openWhoCanUse,
  shareSkill,
  skillItem,
  skillName,
  skillRow,
  uniqueName,
  type BuiltAgent,
  type CatalogFixture
} from '../fixtures/liveCatalog'
import { coreCall, refreshLibrary, type PersonApp, type SharingPerson } from '../fixtures/liveTeamSharing'
import { accessPicker, expectAccess, pickAccess } from '../fixtures/managedList'

/**
 * Skill co-maintainers against the real local cinna-core
 * (`e2e/fixtures/live-catalog.py`, people A, B, C):
 *
 * 1–3. A shares a skill with B and C at Can use; B and C pin it (From the
 *      catalog). B's row has no Make editable, no Who can use, no Share.
 * 4–5. A raises B to Maintainer in A's Who can use dialog; after a listing
 *      refresh (no restart) B's row offers Make editable and Who can use.
 * 6.   B makes it editable: the pin becomes a writable `skills/<name>/`
 *      linked to A's package at revision 1; then **one real OpenCode turn**
 *      (the live model) edits its `SKILL.md`.
 * 7.   B shares a new version: revision 2 of A's package (no second package),
 *      B's note, `published_by` B, `base_revision_number` 1.
 * (c)  C, still on Version 1, sees an ordinary Update to Version 2.
 * 8.   A's row offers Get Version 2 — shared by B.
 * (a)  A, still at Version 1, opens Publish a new version: the stale line names
 *      B and Version 2, Share is disabled, the dialog stays; its Get brings
 *      Version 2 (B's files, record revision 2); A's scripted edit then
 *      shares as Version 3 based on 2. B's row then gets Version 3 (the row's
 *      own Get).
 * (b)  A second agent of B's with a hand-written `skills/<same name>/` and no
 *      record: the first-share dialog asks Publish as, defaulting to the next
 *      version of A's skill.
 *
 * Also a screenshot of the Share dialog with the people list open
 * (`share-people-list.png` in the test's output folder): the list is
 * portaled, so it may reach past the dialog's bottom and is never clipped.
 *
 * The `co-maintainer extra:` tests run no model (every edit is a file write):
 * Replace on a diverged copy, a share refused as stale at publish time (not
 * in the preview), a hand-written folder shared as A's next version and as a
 * separate skill, and Make editable's `folder_exists` and `not_editor`
 * refusals. `download_mismatch` cannot be provoked against a real core (its
 * archive always hashes right); it stays unit-tested.
 *
 * Billing: exactly one OpenCode turn, in the first test only. `CINNA_E2E_COMAINTAINER_SCRIPTED_EDIT=1`
 * replaces it with a file write — for debugging later steps only; a run that
 * proves step 6 must not set it.
 */

const SCRIPTED_EDIT = process.env.CINNA_E2E_COMAINTAINER_SCRIPTED_EDIT === '1'

test.beforeEach(() => {
  requireLiveKey()
})

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function skillRecord(agentPath: string, name: string): any {
  const file = join(agentPath, 'publications.json')
  if (!existsSync(file)) return undefined
  return (readJson(file).skills ?? []).find((entry: any) => entry.name === name)
}

/** Core's package detail (revisions newest first), as `person`. */
async function packageDetail(fixture: CatalogFixture, person: SharingPerson, uuid: string): Promise<any> {
  const detail = await coreCall(fixture, person.token, `/skills/packages/${uuid}`)
  expect(detail.status, JSON.stringify(detail.body).slice(0, 500)).toBe(200)
  return detail.body
}

function revisionOf(detail: any, n: number): any {
  return (detail.revisions as any[]).find((revision) => revision.revision_number === n)
}

/** Every skill package of this name `person` sees in the catalog. */
async function packagesNamed(fixture: CatalogFixture, person: SharingPerson, name: string): Promise<string[]> {
  const listed = await coreCall(fixture, person.token, '/catalog/items?kind=skill')
  expect(listed.status).toBe(200)
  return (listed.body.data as any[]).filter((item) => item.name === name).map((item) => item.uuid)
}

/** Back to a fresh Skills section of `agent`, after a fresh read of the listing. */
async function freshSkills(app: PersonApp, agent: string) {
  await refreshLibrary(app)
  return openSkills(app, agent)
}

test('skill co-maintainers: B maintains A’s skill, edits it with a real turn, shares Version 2; A gets it, shares Version 3', async ({ team }, testInfo) => {
  test.setTimeout(20 * 60_000)
  const fixture = team.fixture as CatalogFixture
  const { a: personA, b: personB, c: personC } = fixture.people
  const agentA = uniqueName(fixture, 'Comaint A')
  const agentB = uniqueName(fixture, 'Comaint B')
  const agentB2 = uniqueName(fixture, 'Comaint B fork')
  const agentC = uniqueName(fixture, 'Comaint C')
  const skill = skillName('tips')
  const marker = `Always answer in bullet points ${fixture.tag}.`
  const markerA = `Close with one line of next steps ${fixture.tag}.`
  const noteB = `B: bullet points ${fixture.tag}`
  const noteA = `A: next steps ${fixture.tag}`

  const a = await team.open('a')
  const builtA = await buildAgent(a, fixture, { name: agentA, skill: { name: skill, description: 'Tips for answering.', body: 'Be brief.\n' } })
  let uuid = ''

  await test.step('1. A shares the skill with B and C at Can use (people list screenshot)', async () => {
    await openSkills(a, agentA)
    await skillRow(a, skill, 'Authored').getByRole('button', { name: `Publish ${skill}…`, exact: true }).click()
    const dialog = a.page.getByRole('dialog', { name: `Publish ${skill}`, exact: true })
    await expect(dialog.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled({ timeout: 30_000 })
    const search = dialog.getByRole('combobox', { name: 'Find a person' })
    await search.fill(personB.name)
    const optionB = a.page.getByRole('option', { name: `${personB.name} <${personB.email}>` })
    await expect(optionB).toBeVisible({ timeout: 30_000 })
    await expect(optionB).toBeInViewport()
    // The list is portaled out of the dialog, so the dialog's scrolling body cannot clip it.
    await expect(dialog.getByRole('listbox')).toHaveCount(0)
    const listbox = a.page.getByRole('listbox', { name: 'Find a person', exact: true })
    await expect(listbox).toBeVisible()
    // The option is what a click at its centre hits: nothing (the dialog included) is drawn over it.
    const onTop = await optionB.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!hit && (hit === el || el.contains(hit))
    })
    expect(onTop, 'the people list is drawn over the dialog').toBe(true)
    const boxes = { dialog: await dialog.boundingBox(), listbox: await listbox.boundingBox() }
    testInfo.annotations.push({ type: 'people list boxes', description: JSON.stringify(boxes) })
    console.log(`comaintainer people list boxes: ${JSON.stringify(boxes)}`)
    await a.page.screenshot({ path: testInfo.outputPath('share-people-list.png'), animations: 'disabled' })
    await optionB.click()
    await search.fill(personC.name)
    await a.page.getByRole('option', { name: `${personC.name} <${personC.email}>` }).click()
    await dialog.getByRole('textbox', { name: 'Note (optional)' }).fill(`Version 1 from A ${fixture.tag}`)
    await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 60_000 })

    const item = await skillItem(fixture, personA.token, skill)
    expect(item?.latest?.revision_number).toBe(1)
    uuid = item.uuid
    expect((await skillItem(fixture, personB.token, skill))?.access).toBe('use')
    expect((await skillItem(fixture, personC.token, skill))?.access).toBe('use')
    expect(skillRecord(builtA.path, skill)).toMatchObject({ package_uuid: uuid, revision_number: 1 })
  })

  const b = await team.open('b')
  installCachedEngine(b.sandbox.userData)
  await b.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const model = await seedOpenAiDefaultMode(b)
  console.log(`live-sharing-skill-comaintainer model: ${model}`)
  testInfo.annotations.push({ type: 'model', description: model })
  const builtB = await buildAgent(b, fixture, { name: agentB })

  const c = await team.open('c')
  const builtC = await buildAgent(c, fixture, { name: agentC })

  await test.step('2–3. B and C pin it; B’s row offers no Make editable, Who can use or Share', async () => {
    await addSkillToAgent(b, skill, agentB)
    expect(catalogPins(builtB.path)).toMatchObject([{ name: skill, package_uuid: uuid, revision_number: 1 }])
    await addSkillToAgent(c, skill, agentC)
    expect(catalogPins(builtC.path)).toMatchObject([{ name: skill, package_uuid: uuid, revision_number: 1 }])

    await freshSkills(b, agentB)
    const row = skillRow(b, skill, 'From the catalog')
    await expect(row.getByRole('button', { name: `Remove ${skill} from this agent`, exact: true })).toBeVisible({ timeout: 30_000 })
    for (const name of [`Make ${skill} editable…`, `Who can use ${skill}…`, `Publish ${skill}…`, `Publish a new version of ${skill}…`]) {
      await expect(row.getByRole('button', { name, exact: true })).toHaveCount(0)
    }
  })

  await test.step('4. A raises B to Maintainer in Who can use', async () => {
    const dialog = await openWhoCanUse(a, agentA, skill)
    await expectAccess(dialog, personB.name, 'use')
    await pickAccess(dialog, personB.name, 'maintain')
    await expectAccess(dialog, personB.name, 'maintain')
    await expect(accessPicker(dialog, personB.name)).toBeEnabled({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await skillItem(fixture, personB.token, skill))?.access, { timeout: 30_000 }).toBe('maintain')
  })

  await test.step('5. after a listing refresh (no restart) B’s row offers Make editable and Who can use', async () => {
    await freshSkills(b, agentB)
    const row = skillRow(b, skill, 'From the catalog')
    await expect(row.getByRole('button', { name: `Make ${skill} editable…`, exact: true })).toBeVisible({ timeout: 30_000 })
    await row.getByRole('button', { name: `Who can use ${skill}…`, exact: true }).click()
    const people = b.page.getByRole('dialog', { name: `Who can use ${skill}`, exact: true })
    await expectAccess(people, personC.name, 'use', 30_000)
    await people.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(people).toHaveCount(0)
  })

  const folderB = join(builtB.path, 'skills', skill)
  await test.step('6a. B makes it editable: a writable linked copy at revision 1, the pin gone', async () => {
    const row = skillRow(b, skill, 'From the catalog')
    await row.getByRole('button', { name: `Make ${skill} editable…`, exact: true }).click()
    const confirm = row.getByRole('group', { name: `Make ${skill} editable…`, exact: true })
    await expect(confirm).toContainText(`Make ${skill} editable in this agent? Its files move into skills/${skill}/`)
    await confirm.getByRole('button', { name: 'Make editable', exact: true }).click()
    const authored = skillRow(b, skill, 'Authored')
    await expect(authored.getByRole('button', { name: `Publish a new version of ${skill}…`, exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(skillRow(b, skill, 'From the catalog')).toHaveCount(0)

    expect(statSync(folderB).isDirectory()).toBe(true)
    accessSync(folderB, constants.W_OK)
    accessSync(join(folderB, 'SKILL.md'), constants.W_OK)
    expect(readFileSync(join(folderB, 'SKILL.md'), 'utf8')).toContain('Be brief.')
    expect(skillRecord(builtB.path, skill)).toMatchObject({ package_uuid: uuid, revision_number: 1, platform_url: fixture.server })
    expect(catalogPins(builtB.path)).toEqual([])
  })

  await test.step(`6b. B’s agent edits skills/${skill}/SKILL.md (${SCRIPTED_EDIT ? 'SCRIPTED — debugging only' : 'one real OpenCode turn'})`, async () => {
    if (SCRIPTED_EDIT) {
      testInfo.annotations.push({ type: 'step 6', description: 'scripted edit: the OpenCode turn did not run' })
      writeFileSync(join(folderB, 'SKILL.md'), readFileSync(join(folderB, 'SKILL.md'), 'utf8') + `\n${marker}\n`)
    } else {
      const inAgent = [builtB.path, realpathSync(builtB.path)]
      const prompt = `Edit the file skills/${skill}/SKILL.md in your own folder: add this line at the end of it, exactly as it is between the backticks, final period included: \`${marker}\`. Change no other file.`
      const { turn, asks } = await askAgent(b, builtB.path, prompt, {
        agent: agentB,
        // Only asks about paths inside B's agent folder, and never its manifest.
        allow: (text) => inAgent.some((path) => text.includes(path)) && !text.includes('cinna-agent.json')
      })
      testInfo.annotations.push({ type: 'step 6 asks', description: JSON.stringify(asks) })
      expect(turn.errors).toEqual([])
    }
    expect(readFileSync(join(folderB, 'SKILL.md'), 'utf8')).toContain(marker)
    expect(catalogPins(builtB.path)).toEqual([])
    await b.page.evaluate(() => window.api.localAgents.rescan())
  })

  await test.step('7. B shares a new version: Version 2 of A’s package, B’s note, base 1', async () => {
    await shareSkill(b, agentB, skill, { newVersion: true, note: noteB })
    expect(await packagesNamed(fixture, personB, skill)).toEqual([uuid])
    expect(await packagesNamed(fixture, personA, skill)).toEqual([uuid])
    const detail = await packageDetail(fixture, personA, uuid)
    expect(detail.latest_revision_number).toBe(2)
    expect(detail.publisher_user_id).toBe(personA.id)
    const second = revisionOf(detail, 2)
    expect(second).toMatchObject({ release_notes: noteB, published_by_user_id: personB.id, base_revision_number: 1 })
    expect(second.published_by?.user_id).toBe(personB.id)
    expect(second.version).not.toBe(revisionOf(detail, 1).version)
    expect(skillRecord(builtB.path, skill)).toMatchObject({ package_uuid: uuid, revision_number: 2, content_hash: second.content_hash })
  })

  const v2 = (await skillItem(fixture, personA.token, skill)).latest
  await test.step('(c) C, on Version 1, gets an ordinary Update to Version 2', async () => {
    await freshSkills(c, agentC)
    const row = skillRow(c, skill, 'From the catalog')
    const update = row.getByRole('button', { name: `Update ${skill} to Version 2 (${v2.version})`, exact: true })
    await expect(update).toBeVisible({ timeout: 30_000 })
    await expect(row.getByRole('button', { name: `Make ${skill} editable…`, exact: true })).toHaveCount(0)
    await expect(row.getByRole('button', { name: `Who can use ${skill}…`, exact: true })).toHaveCount(0)
    await update.click()
    await expect(update).toHaveCount(0, { timeout: 60_000 })
    expect(catalogPins(builtC.path)).toMatchObject([{ name: skill, package_uuid: uuid, revision_number: 2 }])
  })

  const skillMdA = join(builtA.path, 'skills', skill, 'SKILL.md')
  await test.step('8. A’s row offers Get Version 2 — shared by B', async () => {
    await freshSkills(a, agentA)
    const row = skillRow(a, skill, 'Authored')
    await expect(row.getByRole('button', { name: `Get Version 2 of ${skill} — shared by ${personB.name}`, exact: true })).toBeVisible({ timeout: 30_000 })
    expect(readFileSync(skillMdA, 'utf8')).not.toContain(marker)
    expect(skillRecord(builtA.path, skill)?.revision_number).toBe(1)
  })

  await test.step('(a) + 9. A’s share from Version 1 is stale; the dialog’s Get brings B’s Version 2; A’s edit shares as Version 3 on base 2', async () => {
    await skillRow(a, skill, 'Authored').getByRole('button', { name: `Publish a new version of ${skill}…`, exact: true }).click()
    const dialog = a.page.getByRole('dialog', { name: `Publish a new version of ${skill}`, exact: true })
    const staleLine = dialog.getByText(`${personB.name} published Version 2 since your copy. Get it first, then publish your changes.`, { exact: true })
    await expect(staleLine).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Get Version 2', exact: true }).click()
    await expect(staleLine).toHaveCount(0, { timeout: 60_000 })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled({ timeout: 30_000 })
    // 9: A's folder holds B's files, and A's record says Version 2.
    expect(readFileSync(skillMdA, 'utf8')).toBe(readFileSync(join(folderB, 'SKILL.md'), 'utf8'))
    expect(skillRecord(builtA.path, skill)).toMatchObject({ package_uuid: uuid, revision_number: 2 })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    writeFileSync(skillMdA, readFileSync(skillMdA, 'utf8') + `\n${markerA}\n`)
    await a.page.evaluate(() => window.api.localAgents.rescan())
    await shareSkill(a, agentA, skill, { newVersion: true, note: noteA })
    const detail = await packageDetail(fixture, personA, uuid)
    expect(detail.latest_revision_number).toBe(3)
    expect(revisionOf(detail, 3)).toMatchObject({ release_notes: noteA, published_by_user_id: personA.id, base_revision_number: 2 })
    expect(revisionOf(detail, 2)).toMatchObject({ release_notes: noteB, published_by_user_id: personB.id })
    expect(skillRecord(builtA.path, skill)).toMatchObject({ package_uuid: uuid, revision_number: 3 })
    expect(await packagesNamed(fixture, personA, skill)).toEqual([uuid])
  })

  await test.step('B’s row gets Version 3 — shared by A (the row’s own Get)', async () => {
    await freshSkills(b, agentB)
    const get = skillRow(b, skill, 'Authored').getByRole('button', { name: `Get Version 3 of ${skill} — shared by ${personA.name}`, exact: true })
    await expect(get).toBeVisible({ timeout: 30_000 })
    await get.click()
    await expect(get).toHaveCount(0, { timeout: 60_000 })
    expect(readFileSync(join(folderB, 'SKILL.md'), 'utf8')).toBe(readFileSync(skillMdA, 'utf8'))
    expect(skillRecord(builtB.path, skill)).toMatchObject({ package_uuid: uuid, revision_number: 3 })
  })

  await test.step('(b) a hand-written skills/<same name>/ in B’s second agent: Publish as defaults to the next version of A’s', async () => {
    const forked = await buildAgent(b, fixture, { name: agentB2, skill: { name: skill, description: 'Tips for answering, forked.', body: 'Be brief, forked.\n' } })
    expect(skillRecord(forked.path, skill)).toBeUndefined()
    await freshSkills(b, agentB2)
    await skillRow(b, skill, 'Authored').getByRole('button', { name: `Publish ${skill}…`, exact: true }).click()
    const dialog = b.page.getByRole('dialog', { name: `Publish ${skill}`, exact: true })
    const shareAs = dialog.getByRole('radiogroup', { name: 'Publish as', exact: true })
    const nextOfA = shareAs.getByRole('radio', { name: `New version of ${personA.name}’s ${skill}`, exact: true })
    await expect(nextOfA).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 })
    await expect(shareAs.getByRole('radio', { name: 'A separate skill', exact: true })).toHaveAttribute('aria-checked', 'false')
    await expect(dialog.locator('[data-share-version]')).toHaveText('Version 4')
    await expect(dialog.getByText(`Who can use it stays as ${personA.name} set it.`, { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(await packagesNamed(fixture, personB, skill)).toEqual([uuid])
  })
})

/**
 * A's agent with `skill` shared at revision 1 (over IPC, no dialog) with B at
 * `access`; B's app open with an agent of B's own.
 */
async function arrangeShared(
  team: { fixture: unknown; open: (label: 'a' | 'b') => Promise<PersonApp> },
  access: 'use' | 'edit' | 'maintain'
): Promise<{ fixture: CatalogFixture; a: PersonApp; b: PersonApp; builtA: BuiltAgent; builtB: BuiltAgent; skill: string; uuid: string }> {
  const fixture = team.fixture as CatalogFixture
  const skill = skillName('tips')
  const a = await team.open('a')
  const builtA = await buildAgent(a, fixture, {
    name: uniqueName(fixture, 'Comaint A'),
    skill: { name: skill, description: 'Tips for answering.', body: 'Be brief.\n' }
  })
  const published = await a.page.evaluate((input) => window.api.skillPublish.publish(input), {
    agentId: builtA.id,
    name: skill,
    releaseNotes: `Version 1 from A ${fixture.tag}`,
    people: [{ userId: fixture.people.b.id, access }]
  })
  expect(published.ok, JSON.stringify(published)).toBe(true)
  const uuid = (await skillItem(fixture, fixture.people.a.token, skill)).uuid as string
  const b = await team.open('b')
  const builtB = await buildAgent(b, fixture, { name: uniqueName(fixture, 'Comaint B') })
  return { fixture, a, b, builtA, builtB, skill, uuid }
}

/** B pins the skill over IPC (Add to agent's verb); with `editable`, also Make editable's verb. */
async function pinForB(b: PersonApp, builtB: BuiltAgent, skill: string, uuid: string, editable: boolean): Promise<void> {
  const added = await b.page.evaluate((input) => window.api.catalogSkills.add(input.id, input.uuid), { id: builtB.id, uuid })
  expect(added.ok, JSON.stringify(added)).toBe(true)
  if (editable) {
    const made = await b.page.evaluate((input) => window.api.catalogSkills.makeEditable(input.id, input.name), { id: builtB.id, name: skill })
    expect(made.ok, JSON.stringify(made)).toBe(true)
    expect(skillRecord(builtB.path, skill)).toMatchObject({ package_uuid: uuid, revision_number: 1 })
  }
  await b.page.evaluate(() => window.api.localAgents.rescan())
}

function appendLine(file: string, line: string): void {
  writeFileSync(file, readFileSync(file, 'utf8') + `\n${line}\n`)
}

test('co-maintainer extra: a share refused as stale at publish time keeps the dialog and the note; Replace brings the newer version and backs up the edits', async ({ team }) => {
  test.setTimeout(10 * 60_000)
  const { fixture, a, b, builtA, builtB, skill, uuid } = await arrangeShared(team, 'maintain')
  const { a: personA } = fixture.people
  await pinForB(b, builtB, skill, uuid, true)
  const folderB = join(builtB.path, 'skills', skill)
  const skillMdA = join(builtA.path, 'skills', skill, 'SKILL.md')
  const markerB = `B's unshared line ${fixture.tag}.`
  const noteB = `B's note ${fixture.tag}`
  appendLine(join(folderB, 'SKILL.md'), markerB)
  await b.page.evaluate(() => window.api.localAgents.rescan())

  await test.step('B opens Publish a new version on a current copy; A shares Version 2 before B presses Publish', async () => {
    await freshSkills(b, builtB.name)
    await skillRow(b, skill, 'Authored').getByRole('button', { name: `Publish a new version of ${skill}…`, exact: true }).click()
    const dialog = b.page.getByRole('dialog', { name: `Publish a new version of ${skill}`, exact: true })
    const share = dialog.getByRole('button', { name: 'Publish', exact: true })
    await expect(share).toBeEnabled({ timeout: 30_000 })
    await expect(dialog.locator('[data-share-stale]')).toHaveCount(0)
    const note = dialog.getByRole('textbox', { name: 'Note (optional)' })
    await note.fill(noteB)

    appendLine(skillMdA, `A's Version 2 line ${fixture.tag}.`)
    const published = await a.page.evaluate((input) => window.api.skillPublish.publish(input), { agentId: builtA.id, name: skill, releaseNotes: 'A: Version 2' })
    expect(published.ok && published.revisionNumber, JSON.stringify(published)).toBe(2)

    await share.click()
    await expect(dialog.getByText(`${personA.name} published Version 2 since your copy. Get it first, then publish your changes.`, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByText('Your copy has changes that were never published. Replace on the skill’s row gets Version 2 and keeps your files in a backup folder.', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Get Version 2', exact: true })).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(note).toHaveValue(noteB)
    await expect(share).toBeDisabled()
    expect((await packageDetail(fixture, personA, uuid)).latest_revision_number).toBe(2)
    expect(skillRecord(builtB.path, skill)?.revision_number).toBe(1)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  await test.step('the diverged row offers Replace (no Get); Replace makes the folder Version 2 and keeps B’s edits in skill-backups', async () => {
    await freshSkills(b, builtB.name)
    const row = skillRow(b, skill, 'Authored')
    const replace = row.getByRole('button', { name: `Replace ${skill} with Version 2… — shared by ${personA.name}`, exact: true })
    await expect(replace).toBeVisible({ timeout: 30_000 })
    await expect(row.getByRole('button', { name: /^Get Version/ })).toHaveCount(0)
    await replace.click()
    const confirm = row.getByRole('group', { name: `Replace ${skill} with Version 2…`, exact: true })
    await expect(confirm).toContainText(`Replace ${skill} with Version 2? Your changes that were never published are moved to a backup folder outside this agent`)
    await confirm.getByRole('button', { name: 'Replace', exact: true }).click()
    await expect(row.getByRole('button', { name: /^(Replace|Get Version) / })).toHaveCount(0, { timeout: 60_000 })

    expect(readFileSync(join(folderB, 'SKILL.md'), 'utf8')).toBe(readFileSync(skillMdA, 'utf8'))
    const second = revisionOf(await packageDetail(fixture, personA, uuid), 2)
    expect(skillRecord(builtB.path, skill)).toMatchObject({ package_uuid: uuid, revision_number: 2, content_hash: second.content_hash })
    // Main names the folder by the agent id made path-safe (`folder:<uuid>` → `folder-<uuid>`), as `skillBackupDir` does.
    const backups = join(b.sandbox.userData, 'skill-backups', builtB.id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, ''))
    const kept = readdirSync(backups).filter((entry) => entry.startsWith(`${skill}-`) && !entry.endsWith('-set-aside'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(backups, kept[0], 'SKILL.md'), 'utf8')).toContain(markerB)
  })
})

test('co-maintainer extra: hand-written folders share as the next version of A’s skill, or as a separate skill', async ({ team }) => {
  test.setTimeout(10 * 60_000)
  const { fixture, b, skill, uuid } = await arrangeShared(team, 'maintain')
  const { a: personA, b: personB } = fixture.people
  const fork = await buildAgent(b, fixture, {
    name: uniqueName(fixture, 'Comaint B fork'),
    skill: { name: skill, description: 'Tips for answering, forked.', body: 'Be brief, forked.\n' }
  })
  const separate = await buildAgent(b, fixture, {
    name: uniqueName(fixture, 'Comaint B own'),
    skill: { name: skill, description: 'Tips for answering, my own.', body: 'Be brief, my own.\n' }
  })

  await test.step('New version of A’s (the default) → Version 2 of A’s package, shared by B on base 1', async () => {
    await freshSkills(b, fork.name)
    await skillRow(b, skill, 'Authored').getByRole('button', { name: `Publish ${skill}…`, exact: true }).click()
    const dialog = b.page.getByRole('dialog', { name: `Publish ${skill}`, exact: true })
    await expect(dialog.getByRole('radio', { name: `New version of ${personA.name}’s ${skill}`, exact: true })).toBeChecked({ timeout: 30_000 })
    await dialog.getByRole('textbox', { name: 'Note (optional)' }).fill(`B's fork ${fixture.tag}`)
    await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 60_000 })

    expect(await packagesNamed(fixture, personB, skill)).toEqual([uuid])
    const detail = await packageDetail(fixture, personA, uuid)
    expect(detail.latest_revision_number).toBe(2)
    expect(revisionOf(detail, 2)).toMatchObject({ published_by_user_id: personB.id, base_revision_number: 1, release_notes: `B's fork ${fixture.tag}` })
    expect(skillRecord(fork.path, skill)).toMatchObject({ package_uuid: uuid, revision_number: 2 })
  })

  await test.step('A separate skill → a second package, published by B, linked from that folder', async () => {
    await freshSkills(b, separate.name)
    await skillRow(b, skill, 'Authored').getByRole('button', { name: `Publish ${skill}…`, exact: true }).click()
    const dialog = b.page.getByRole('dialog', { name: `Publish ${skill}`, exact: true })
    const own = dialog.getByRole('radio', { name: 'A separate skill', exact: true })
    await expect(own).toBeEnabled({ timeout: 30_000 })
    await own.check()
    await expect(dialog.getByRole('radio', { name: `New version of ${personA.name}’s ${skill}`, exact: true })).not.toBeChecked()
    await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 60_000 })

    const named = await packagesNamed(fixture, personB, skill)
    expect(named).toHaveLength(2)
    const other = named.find((id) => id !== uuid)!
    const otherDetail = await packageDetail(fixture, personB, other)
    expect(otherDetail.publisher_user_id).toBe(personB.id)
    expect(otherDetail.latest_revision_number).toBe(1)
    expect(skillRecord(separate.path, skill)).toMatchObject({ package_uuid: other, revision_number: 1 })
    expect((await packageDetail(fixture, personA, uuid)).latest_revision_number).toBe(2)
  })
})

test('co-maintainer extra: Make editable refuses on an existing skills/<name>/ and once edit access is gone, touching nothing', async ({ team }) => {
  test.setTimeout(10 * 60_000)
  const { fixture, b, builtB, skill, uuid } = await arrangeShared(team, 'maintain')
  const { a: personA, b: personB } = fixture.people
  await pinForB(b, builtB, skill, uuid, false)
  const pinsBefore = catalogPins(builtB.path)
  const handDir = join(builtB.path, 'skills', skill)
  await freshSkills(b, builtB.name)
  const row = skillRow(b, skill, 'From the catalog')
  const pencil = row.getByRole('button', { name: `Make ${skill} editable…`, exact: true })
  const confirm = row.getByRole('group', { name: `Make ${skill} editable…`, exact: true })
  await expect(pencil).toBeVisible({ timeout: 30_000 })

  await test.step('folder_exists: a hand-written skills/<name>/ written after the pencil showed', async () => {
    const hand = `---\nname: ${skill}\ndescription: By hand.\n---\n\nHand-written.\n`
    mkdirSync(handDir, { recursive: true })
    writeFileSync(join(handDir, 'SKILL.md'), hand)
    await pencil.click()
    await confirm.getByRole('button', { name: 'Make editable', exact: true }).click()
    await expect(row.getByRole('alert')).toHaveText(`Rename or remove skills/${skill}/ first.`, { timeout: 30_000 })
    expect(readFileSync(join(handDir, 'SKILL.md'), 'utf8')).toBe(hand)
    expect(readdirSync(handDir)).toEqual(['SKILL.md'])
    expect(catalogPins(builtB.path)).toEqual(pinsBefore)
    expect(skillRecord(builtB.path, skill)).toBeUndefined()
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
    rmSync(handDir, { recursive: true })
    await b.page.evaluate(() => window.api.localAgents.rescan())
    await expect(skillRow(b, skill, 'Authored')).toHaveCount(0, { timeout: 30_000 })
  })

  await test.step('not_editor: A lowers B to Can use in core; B (no listing refresh) presses Make editable', async () => {
    const grants = await coreCall(fixture, personA.token, `/catalog/items/${uuid}/grants`)
    expect(grants.status).toBe(200)
    const body = (grants.body as { principal: { user_id?: string }; access: string }[]).map((g) => ({
      principal: g.principal,
      access: g.principal.user_id === personB.id ? 'use' : g.access
    }))
    expect((await coreCall(fixture, personA.token, `/catalog/items/${uuid}/grants`, { method: 'PUT', body })).status).toBe(200)
    expect((await skillItem(fixture, personB.token, skill))?.access).toBe('use')

    await expect(pencil).toBeVisible()
    await pencil.click()
    await confirm.getByRole('button', { name: 'Make editable', exact: true }).click()
    await expect(row.getByRole('alert')).toHaveText('Ask a maintainer of this skill for edit access, then try again.', { timeout: 30_000 })
    expect(existsSync(handDir)).toBe(false)
    expect(catalogPins(builtB.path)).toEqual(pinsBefore)
    expect(skillRecord(builtB.path, skill)).toBeUndefined()
  })
})
