import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  addScriptCommand,
  addSkillToAgent,
  buildAgent,
  cachedSkillDir,
  catalogPins,
  createCoreCredential,
  openSkills,
  shareSkill,
  skillItem,
  skillName,
  skillRow,
  skillDto,
  skillSlotDetails,
  slotCheckScript,
  slotLine,
  storedAttachments,
  uniqueName,
  type CatalogFixture
} from '../fixtures/liveCatalog'
import { coreCall, refreshLibrary, runCommand, syncCredentials, type PersonApp } from '../fixtures/liveTeamSharing'

/**
 * T4 — a catalog skill's credentials, against the real local cinna-core
 * (`e2e/fixtures/live-catalog.py`, people A–D, plus the admin's `pair 1/2`
 * and `no local` credentials shared with B):
 *
 * - T4.1 the publisher provides their own credential for a slot in the Share
 *   dialog (`meta.publisher_credentials`); B's Add to agent… runs
 *   `provision-local` (outcome `shared`), attaches it by slot without asking,
 *   and the skill's own script reads it.
 * - T4.7 later versions keeping (V2) and dropping (V3) that provider.
 * - T4.2 a slot each person fills themselves (`user_provides`) on a public
 *   skill: B is told nothing fits, connects their own and Finish setup attaches
 *   it; D connects a different one first; each script reads its own.
 * - T4.4 / T4.5 slots nothing is attached for, and the sentence that says why:
 *   publisher-provided without local use (`not_allowed_locally`), provided
 *   then no longer shareable (`not_shareable`), an admin share without local
 *   use, and a record of the wrong type (before and after attaching it by hand).
 * - T4.6 two eligible credentials: nothing is attached, Finish setup offers
 *   both, and the one chosen is the one the script reads.
 *
 * T4.3 (an admin credential with Allow local use, attached by slot without
 * asking) is covered by `live-catalog-skills.spec.ts` §7 and
 * `live-sharing-skill-lifecycle.spec.ts` T3.5 (`account:<erp> auto:erp-api`),
 * not repeated here.
 *
 * Credentials A, B and D own are made over core's REST with their web tokens
 * (`createCoreCredential`) and go when cleanup deletes those people (core's
 * `credential.owner_id` is `ON DELETE CASCADE`).
 *
 * No model runs (0 OpenCode, 0 Claude turns): what reached an agent is shown
 * by a `/run:` command that runs the cached skill's own script, which reads
 * the slot through `core.cinna_api` and prints a hash of the header value.
 * Published scripts carry no `.py` suffix: core's dev server watches its skill
 * store and restarts on a `.py` file (see `live-sharing-skill-lifecycle.spec.ts`).
 */

const NOT_LOCAL = 'The publisher provides it, but not for use on this computer.'
const NOT_SHAREABLE = 'The publisher provides it, but cannot share it with you.'
const nothingFits = (slot: string, type = 'api_token'): string =>
  `Nothing in your account fits it: it needs a credential of type ${type} whose Service URI is ${slot}.`
const EACH_OWN = 'Each person connects their own'

/** A slot no other test or fixture credential carries. */
function slotName(fixture: CatalogFixture, base: string): string {
  return `${base}-${fixture.tag}-${randomBytes(2).toString('hex')}`
}

/** The name of a credential a fixture person owns. */
function personCredentialName(fixture: CatalogFixture, label: string): string {
  return `Ledger ${label.toUpperCase()} catalog-e2e ${fixture.tag} ${randomBytes(2).toString('hex')}`
}

/** A skill declaring `slots` (all `api_token`), whose `scripts/skill_check` reads the first. */
function ledgerSkill(slots: string[]) {
  return {
    description: 'Check which ledger credential this agent can reach.',
    credentials: slots.map((slot) => ({ slot, type: 'api_token', description: 'The ledger API token.' })),
    body: 'Run `scripts/skill_check` with python3 and reply with its line.\n',
    files: { 'scripts/skill_check': slotCheckScript('skill-check', slots[0]) }
  }
}

/** The Skills row's Finish setup → the dialog; answers it and a skill slot's row in it. */
async function openSkillFinishSetup(app: PersonApp, agent: string, skill: string) {
  await openSkills(app, agent)
  await skillRow(app, skill, 'From the catalog').getByRole('button', { name: 'Finish setup', exact: true }).click()
  const dialog = app.page.getByRole('dialog', { name: `Finish setting up ${agent}` })
  await expect(dialog).toBeVisible()
  return { dialog, row: (slot: string) => dialog.getByTestId(`finish-setup-skill-slot-${slot}`) }
}

/** Core's `provision-local` for `revision` as the bearer of `token`: `<slot>:<provided_by>:<outcome>:<credential id|->` each. */
async function provisionLocal(fixture: CatalogFixture, token: string, packageUuid: string, revision: number): Promise<string[]> {
  const answer = await coreCall(fixture, token, `/skills/packages/${packageUuid}/revisions/${revision}/provision-local`, { method: 'POST' })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return (answer.body.slots as { slot: string; provided_by: string; outcome: string; credential_id: string | null }[]).map(
    (slot) => `${slot.slot}:${slot.provided_by}:${slot.outcome}:${slot.credential_id ?? '-'}`
  )
}

/** How core's latest revision of `skill` says each slot is provided: `<slot>:<provided_by>`. */
async function providedBy(fixture: CatalogFixture, token: string, skill: string): Promise<string[]> {
  const item = await skillItem(fixture, token, skill)
  return ((item?.required_credential_specs ?? []) as { slot?: string; service_uri?: string; provided_by?: string }[]).map(
    (spec) => `${spec.slot ?? spec.service_uri}:${spec.provided_by}`
  )
}

/** `/run:<command>` on the agent's page; resolves once `line` is on screen. */
async function expectRunLine(app: PersonApp, agent: string, command: string, line: string): Promise<void> {
  await runCommand(app, agent, command)
  await expect(app.page.getByText(line)).toBeVisible({ timeout: 60_000 })
}

test('T4.1 / T4.7 A provides their own credential for the slot: B’s Add to agent… attaches it by itself and the skill reads it; V2 keeps the provider, V3 drops it', async ({ team }) => {
  test.setTimeout(720_000)
  const { fixture } = team
  const { a: personA, b: personB } = fixture.people
  const skill = skillName('ledger-provided')
  const slot = slotName(fixture, 'ledger-pub')
  const workshopName = uniqueName(fixture, 'Skill workshop')
  const mine = uniqueName(fixture, 'Ledger bot')

  const a = await team.open('a')
  const provided = await createCoreCredential(fixture, personA.token, {
    name: personCredentialName(fixture, 'a'),
    serviceUri: slot,
    allowSharing: true,
    allowLocalUse: true
  })
  const workshop = await buildAgent(a, fixture, { name: workshopName, skill: { name: skill, ...ledgerSkill([slot]) } })

  await test.step('A shares the skill with B and, in the Share dialog, provides their credential for the slot', async () => {
    await shareSkill(a, workshopName, skill, { people: [personB], provide: { [slot]: provided.name } })
    expect(await providedBy(fixture, personA.token, skill)).toEqual([`${slot}:publisher`])
  })
  const item = await skillItem(fixture, personA.token, skill)

  const b = await team.open('b')
  const agent = await buildAgent(b, fixture, { name: mine })

  await test.step('B adds it to B’s agent: provision-local shares A’s credential, which is attached by slot without asking', async () => {
    await addSkillToAgent(b, skill, mine)
    await expect.poll(() => storedAttachments(agent.path), { timeout: 30_000 }).toEqual([`account:${provided.id} auto:${slot}`])
    await expect
      .poll(() => skillSlotDetails(b, agent.id), { timeout: 30_000 })
      .toEqual([{ slot, type: 'api_token', state: 'connected', attached: provided.name, provision: 'shared', options: [], typeMismatch: null }])
    // Idempotent: asked again, core says it is already shared, and names the same credential.
    expect(await provisionLocal(fixture, personB.token, item.uuid, 1)).toEqual([`${slot}:publisher:already_shared:${provided.id}`])
    await openSkills(b, mine)
    await expect(skillRow(b, skill, 'From the catalog').getByRole('img', { name: `A credential for ${slot} is attached`, exact: true })).toBeVisible()
  })

  await test.step('B runs the skill’s own script: it reads A’s credential by slot', async () => {
    await expect.poll(() => cachedSkillDir(b, item.uuid, 1, skill), { timeout: 30_000 }).not.toBeNull()
    await addScriptCommand(b, agent.path, 'skill-check-v1', join(cachedSkillDir(b, item.uuid, 1, skill)!, 'scripts/skill_check'))
    await expectRunLine(b, mine, 'skill-check-v1', slotLine('skill-check', slot, provided.secret))
  })

  await test.step('T4.7 A shares Version 2: the dialog starts at the credential provided last time; B’s Update keeps it attached', async () => {
    appendFileSync(join(workshop.path, 'skills', skill, 'SKILL.md'), '\nVersion two.\n')
    await openSkills(a, workshopName)
    await skillRow(a, skill, 'Authored').getByRole('button', { name: `Share a new version of ${skill}…`, exact: true }).click()
    const dialog = a.page.getByRole('dialog', { name: `Share a new version of ${skill}` })
    await expect(dialog.getByRole('button', { name: 'Share', exact: true })).toBeEnabled({ timeout: 30_000 })
    await expect(dialog.getByRole('combobox', { name: `What people need for ${slot}`, exact: true }).locator('option:checked')).toHaveText(provided.name)
    await dialog.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 60_000 })
    await expect.poll(async () => (await skillItem(fixture, personA.token, skill))?.latest?.revision_number, { timeout: 20_000 }).toBe(2)
    expect(await providedBy(fixture, personA.token, skill)).toEqual([`${slot}:publisher`])

    await refreshLibrary(b)
    await openSkills(b, mine)
    await skillRow(b, skill, 'From the catalog').getByRole('button', { name: new RegExp(`^Update ${skill} to Version 2`) }).click()
    await expect.poll(() => catalogPins(agent.path)[0]?.revision_number, { timeout: 60_000 }).toBe(2)
    await expect.poll(() => cachedSkillDir(b, item.uuid, 2, skill), { timeout: 60_000 }).not.toBeNull()
    expect(storedAttachments(agent.path)).toEqual([`account:${provided.id} auto:${slot}`])
    await expect
      .poll(async () => (await skillSlotDetails(b, agent.id)).map((s) => `${s.slot}:${s.state}:${s.attached}`), { timeout: 30_000 })
      .toEqual([`${slot}:connected:${provided.name}`])
    await addScriptCommand(b, agent.path, 'skill-check-v2', join(cachedSkillDir(b, item.uuid, 2, skill)!, 'scripts/skill_check'))
    await expectRunLine(b, mine, 'skill-check-v2', slotLine('skill-check', slot, provided.secret))
  })

  await test.step('T4.7 A shares Version 3 with “Each person connects their own”: on B’s Update the self-attached credential stays (the slot is still declared) and still reads A’s', async () => {
    appendFileSync(join(workshop.path, 'skills', skill, 'SKILL.md'), '\nVersion three.\n')
    await shareSkill(a, workshopName, skill, { newVersion: true, provide: { [slot]: EACH_OWN } })
    await expect.poll(async () => (await skillItem(fixture, personA.token, skill))?.latest?.revision_number, { timeout: 20_000 }).toBe(3)
    expect(await providedBy(fixture, personA.token, skill)).toEqual([`${slot}:user`])
    // Core no longer provides it for Version 3, and takes nothing back: B's share of A's credential stays.
    expect(await provisionLocal(fixture, personB.token, item.uuid, 3)).toEqual([`${slot}:user:user_provides:-`])

    await refreshLibrary(b)
    await openSkills(b, mine)
    await skillRow(b, skill, 'From the catalog').getByRole('button', { name: new RegExp(`^Update ${skill} to Version 3`) }).click()
    await expect.poll(() => catalogPins(agent.path)[0]?.revision_number, { timeout: 60_000 }).toBe(3)
    await expect.poll(() => cachedSkillDir(b, item.uuid, 3, skill), { timeout: 60_000 }).not.toBeNull()
    expect(storedAttachments(agent.path)).toEqual([`account:${provided.id} auto:${slot}`])
    await expect
      .poll(async () => (await skillSlotDetails(b, agent.id)).map((s) => `${s.slot}:${s.state}:${s.attached}`), { timeout: 30_000 })
      .toEqual([`${slot}:connected:${provided.name}`])
    test.info().annotations.push({ type: 'B after the V3 update', description: JSON.stringify(await skillSlotDetails(b, agent.id)) })
    await addScriptCommand(b, agent.path, 'skill-check-v3', join(cachedSkillDir(b, item.uuid, 3, skill)!, 'scripts/skill_check'))
    await expectRunLine(b, mine, 'skill-check-v3', slotLine('skill-check', slot, provided.secret))
  })
})

test('T4.2 a slot each person fills themselves, on a public skill: B is told nothing fits, connects their own; D connects a different one; each script reads its own', async ({ team }) => {
  test.setTimeout(720_000)
  const { fixture } = team
  const { b: personB, d: personD } = fixture.people
  test.skip(!personD, 'needs person D (re-run live-catalog.py create)')
  const skill = skillName('ledger-own')
  const slot = slotName(fixture, 'ledger-own')
  const mineB = uniqueName(fixture, 'Ledger bot')
  const mineD = uniqueName(fixture, 'Ledger bot')

  const workshopName = uniqueName(fixture, 'Skill workshop')
  const a = await team.open('a')
  await buildAgent(a, fixture, { name: workshopName, skill: { name: skill, ...ledgerSkill([slot]) } })
  await shareSkill(a, workshopName, skill, { everyone: true })
  expect(await providedBy(fixture, fixture.people.a.token, skill)).toEqual([`${slot}:user`])
  const item = await skillItem(fixture, personB.token, skill)
  expect(item?.visibility).toBe('public')

  const b = await team.open('b')
  const agentB = await buildAgent(b, fixture, { name: mineB })

  await test.step('B adds it with nothing of their own: nothing is attached, and Finish setup says what it needs', async () => {
    await addSkillToAgent(b, skill, mineB)
    await expect.poll(async () => (await skillSlotDetails(b, agentB.id))[0]?.provision, { timeout: 30_000 }).toBe('user_provides')
    expect(await skillSlotDetails(b, agentB.id)).toEqual([
      { slot, type: 'api_token', state: 'missing', attached: null, provision: 'user_provides', options: [], typeMismatch: null }
    ])
    expect(storedAttachments(agentB.path)).toEqual([])
    await openSkills(b, mineB)
    await expect(skillRow(b, skill, 'From the catalog').getByRole('img', { name: `No credential for ${slot} is attached yet`, exact: true })).toBeVisible()
    const { dialog, row } = await openSkillFinishSetup(b, mineB, skill)
    await expect(row(slot).getByText(nothingFits(slot), { exact: true })).toBeVisible()
    await expect(row(slot).getByText('Missing', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Finish later', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    // Settle the fills Add and the opening started (provision-local, then a shared account sync)
    // before B makes a credential, so only the next opening can find it.
    expect(await b.page.evaluate((id) => window.api.serviceCredentials.setupSkills(id), agentB.id)).toEqual({ ok: true, value: [] })
    expect(storedAttachments(agentB.path)).toEqual([])
  })

  const ownB = await createCoreCredential(fixture, personB.token, { name: personCredentialName(fixture, 'b'), serviceUri: slot })

  await test.step('B makes their own on the server, then opens Finish setup again: it is attached without asking', async () => {
    const { dialog, row } = await openSkillFinishSetup(b, mineB, skill)
    await expect(row(slot).getByText('Connected automatically', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(row(slot)).toContainText(ownB.name)
    expect(storedAttachments(agentB.path)).toEqual([`account:${ownB.id} auto:${slot}`])
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  const d = await team.open('d')
  const ownD = await createCoreCredential(fixture, personD!.token, { name: personCredentialName(fixture, 'd'), serviceUri: slot })
  const agentD = await buildAgent(d, fixture, { name: mineD })

  await test.step('D, with their own credential already there, adds the public skill: D’s is attached by itself', async () => {
    await addSkillToAgent(d, skill, mineD)
    await expect.poll(() => storedAttachments(agentD.path), { timeout: 30_000 }).toEqual([`account:${ownD.id} auto:${slot}`])
    // Attached first, then ready once its values arrive.
    await expect
      .poll(async () => (await skillSlotDetails(d, agentD.id)).map((s) => `${s.state}:${s.attached}:${s.provision}`), { timeout: 30_000 })
      .toEqual([`connected:${ownD.name}:user_provides`])
  })

  await test.step('each runs the skill’s script and reads their own credential (different hashes)', async () => {
    const lineB = slotLine('skill-check', slot, ownB.secret)
    const lineD = slotLine('skill-check', slot, ownD.secret)
    expect(lineB).not.toBe(lineD)
    await expect.poll(() => cachedSkillDir(b, item.uuid, 1, skill), { timeout: 30_000 }).not.toBeNull()
    await addScriptCommand(b, agentB.path, 'skill-check', join(cachedSkillDir(b, item.uuid, 1, skill)!, 'scripts/skill_check'))
    await expectRunLine(b, mineB, 'skill-check', lineB)
    await expect.poll(() => cachedSkillDir(d, item.uuid, 1, skill), { timeout: 30_000 }).not.toBeNull()
    await addScriptCommand(d, agentD.path, 'skill-check', join(cachedSkillDir(d, item.uuid, 1, skill)!, 'scripts/skill_check'))
    await expectRunLine(d, mineD, 'skill-check', lineD)
  })
})

test('T4.4 / T4.5 slots nothing is attached for: not for this computer, no longer shareable, an admin share without local use, a record of the wrong type — and what Finish setup says for each', async ({ team }) => {
  test.setTimeout(600_000)
  const { fixture } = team
  const { a: personA, b: personB } = fixture.people
  const noLocal = fixture.credentials.noLocal
  test.skip(!noLocal, 'needs credentials.noLocal (re-run live-catalog.py create)')
  const skill = skillName('ledger-refused')
  const local = slotName(fixture, 'ledger-local')
  const shareable = slotName(fixture, 'ledger-shareable')
  const adminNoLocal = noLocal!.slot
  const wrongType = slotName(fixture, 'ledger-type')
  const workshopName = uniqueName(fixture, 'Skill workshop')
  const mine = uniqueName(fixture, 'Ledger bot')

  const a = await team.open('a')
  const notLocal = await createCoreCredential(fixture, personA.token, {
    name: personCredentialName(fixture, 'a'),
    serviceUri: local,
    allowSharing: true,
    allowLocalUse: false
  })
  const laterPrivate = await createCoreCredential(fixture, personA.token, {
    name: personCredentialName(fixture, 'a'),
    serviceUri: shareable,
    allowSharing: true,
    allowLocalUse: true
  })
  await buildAgent(a, fixture, { name: workshopName, skill: { name: skill, ...ledgerSkill([local, shareable, adminNoLocal, wrongType]) } })

  await test.step('A provides a credential without local use for one slot and one that is shareable for another, then stops sharing that one', async () => {
    await shareSkill(a, workshopName, skill, { people: [personB], provide: { [local]: notLocal.name, [shareable]: laterPrivate.name } })
    expect(await providedBy(fixture, personA.token, skill)).toEqual([
      `${local}:publisher`,
      `${shareable}:publisher`,
      `${adminNoLocal}:user`,
      `${wrongType}:user`
    ])
    const put = await coreCall(fixture, personA.token, `/credentials/${laterPrivate.id}`, { method: 'PUT', body: { allow_sharing: false } })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
  })
  const item = await skillItem(fixture, personA.token, skill)

  const b = await team.open('b')
  const odoo = await createCoreCredential(fixture, personB.token, { name: personCredentialName(fixture, 'b'), serviceUri: wrongType, type: 'odoo' })
  const agent = await buildAgent(b, fixture, { name: mine })

  await test.step('core’s provision-local for B: not_allowed_locally, not_shareable, and user_provides twice', async () => {
    expect(await provisionLocal(fixture, personB.token, item.uuid, 1)).toEqual([
      `${local}:publisher:not_allowed_locally:-`,
      `${shareable}:publisher:not_shareable:-`,
      `${adminNoLocal}:user:user_provides:-`,
      `${wrongType}:user:user_provides:-`
    ])
  })

  await test.step('B adds the skill: nothing is attached, every slot is missing and nothing is offered', async () => {
    await addSkillToAgent(b, skill, mine)
    await expect.poll(async () => (await skillSlotDetails(b, agent.id)).map((s) => s.provision), { timeout: 30_000 }).toEqual([
      'not_allowed_locally',
      'not_shareable',
      'user_provides',
      'user_provides'
    ])
    expect((await skillSlotDetails(b, agent.id)).map((s) => `${s.slot}:${s.state}:${s.attached}:${s.options.join(',')}:${s.typeMismatch}`)).toEqual([
      `${local}:missing:null::null`,
      `${shareable}:missing:null::null`,
      `${adminNoLocal}:missing:null::null`,
      `${wrongType}:missing:null::null`
    ])
    expect(storedAttachments(agent.path)).toEqual([])
    await openSkills(b, mine)
    const row = skillRow(b, skill, 'From the catalog')
    // The Needs line draws two slot chips, then folds the rest into +N.
    for (const slot of [local, shareable]) {
      await expect(row.getByRole('img', { name: `No credential for ${slot} is attached yet`, exact: true })).toBeVisible()
    }
    await expect(row).toContainText('+2')
    await expect(row.getByRole('button', { name: 'Finish setup', exact: true })).toBeVisible()
  })

  await test.step('Finish setup says why for each slot', async () => {
    const { dialog, row } = await openSkillFinishSetup(b, mine, skill)
    await expect(row(local).getByText(NOT_LOCAL, { exact: true })).toBeVisible()
    await expect(row(shareable).getByText(NOT_SHAREABLE, { exact: true })).toBeVisible()
    // B holds the admin's record for this slot, listed without local use; the row names it.
    await expect(row(adminNoLocal).getByText(`${noLocal!.name} is shared with you, but not for use on this computer.`)).toBeVisible()
    // …and names the owner who can turn on Allow local use (the admin shared it).
    await expect(row(adminNoLocal).getByText(/ can turn on Allow local use\.$/)).toBeVisible()
    await expect(row(wrongType).getByText(nothingFits(wrongType), { exact: true })).toBeVisible()
    for (const slot of [local, shareable, adminNoLocal, wrongType]) {
      await expect(row(slot).getByText('Missing', { exact: true })).toBeVisible()
      await expect(row(slot).getByRole('button', { name: 'Use this' })).toHaveCount(0)
    }
    await dialog.getByRole('button', { name: 'Finish later', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(storedAttachments(agent.path)).toEqual([])
  })

  await test.step('T4.5 B attaches the odoo record by hand: the slot stays unfilled, and Finish setup names the type mismatch', async () => {
    const attached = await b.page.evaluate(
      async ({ id, cloudId }) => {
        const options = await window.api.serviceCredentials.attachOptions(id)
        if (!options.ok) return options.message
        for (const group of options.value.groups) {
          const found = group.items.find((record) => record.cloudId === cloudId)
          if (found) {
            const result = await window.api.serviceCredentials.attach(id, group.key, found.cloudId!)
            return result.ok ? 'ok' : result.message
          }
        }
        return 'no odoo record offered'
      },
      { id: agent.id, cloudId: odoo.id }
    )
    expect(attached).toBe('ok')
    expect(storedAttachments(agent.path)).toEqual([`account:${odoo.id}`])
    const details = (await skillSlotDetails(b, agent.id)).find((s) => s.slot === wrongType)
    expect(details).toMatchObject({ state: 'missing', attached: null, typeMismatch: odoo.name })
    const { dialog, row } = await openSkillFinishSetup(b, mine, skill)
    await expect(row(wrongType).getByText(`${odoo.name} has this Service URI but is a odoo credential, not api_token.`, { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Finish later', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    // The scan's judgement behind the Skills row's mark (its chip is folded into +2): not filled, no strict attachment.
    const judged = await skillDto(b, agent.id, skill, 'catalog')
    expect(judged?.credentials.find((c) => c.slot === wrongType)).toMatchObject({ filled: false, attachment: null })
  })
})

test('T4.6 two eligible credentials for the slot: nothing is attached by itself, Finish setup offers both, and the one B picks is the one the skill reads', async ({ team }) => {
  test.setTimeout(600_000)
  const { fixture } = team
  const pair = fixture.credentials.pair
  test.skip(!pair, 'needs credentials.pair (re-run live-catalog.py create)')
  const [first, second] = pair!.items
  const slot = pair!.slot
  const skill = skillName('ledger-pair')
  const workshopName = uniqueName(fixture, 'Skill workshop')
  const mine = uniqueName(fixture, 'Ledger bot')

  const a = await team.open('a')
  await buildAgent(a, fixture, { name: workshopName, skill: { name: skill, ...ledgerSkill([slot]) } })
  await shareSkill(a, workshopName, skill, { people: [fixture.people.b] })
  const item = await skillItem(fixture, fixture.people.a.token, skill)

  const b = await team.open('b')
  const agent = await buildAgent(b, fixture, { name: mine })

  await test.step('B adds it: two of B’s records fit, so nothing is attached', async () => {
    await addSkillToAgent(b, skill, mine)
    await expect.poll(async () => (await skillSlotDetails(b, agent.id))[0]?.provision, { timeout: 30_000 }).toBe('user_provides')
    const [details] = await skillSlotDetails(b, agent.id)
    expect({ ...details, options: [...details.options].sort() }).toEqual({
      slot,
      type: 'api_token',
      state: 'missing',
      attached: null,
      provision: 'user_provides',
      options: [first.name, second.name].sort(),
      typeMismatch: null
    })
    expect(storedAttachments(agent.path)).toEqual([])
  })

  await test.step('Finish setup offers both; B uses the second, which is attached as B’s own choice', async () => {
    const { dialog, row } = await openSkillFinishSetup(b, mine, skill)
    await expect(row(slot).getByText('Missing', { exact: true })).toBeVisible()
    await expect(row(slot).getByRole('button', { name: 'Use this' })).toHaveCount(2)
    await expect(row(slot).getByTitle(`Use ${first.name}`, { exact: true })).toBeVisible()
    await row(slot).getByTitle(`Use ${second.name}`, { exact: true }).click()
    await expect(row(slot).getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(row(slot).getByRole('button', { name: 'Use this' })).toHaveCount(0)
    expect(storedAttachments(agent.path)).toEqual([`account:${second.id}`])
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  await test.step('the skill’s script reads the one B picked', async () => {
    await expect.poll(() => cachedSkillDir(b, item.uuid, 1, skill), { timeout: 30_000 }).not.toBeNull()
    await addScriptCommand(b, agent.path, 'skill-check', join(cachedSkillDir(b, item.uuid, 1, skill)!, 'scripts/skill_check'))
    await expectRunLine(b, mine, 'skill-check', slotLine('skill-check', slot, second.secret))
  })
})

/**
 * T4.8 arrange: A provides their own credential for `slot` when sharing the
 * skill with B; B adds it to B's agent (provision-local `shared`, attached by
 * slot) and the skill's script reads A's. Answers what the steps after need.
 */
async function providedThenAdded(team: Parameters<Parameters<typeof test>[2]>[0]['team'], base: string) {
  const { fixture } = team
  const { a: personA, b: personB } = fixture.people
  const skill = skillName(base)
  const slot = slotName(fixture, base)
  const workshopName = uniqueName(fixture, 'Skill workshop')
  const mine = uniqueName(fixture, 'Ledger bot')
  const a = await team.open('a')
  const provided = await createCoreCredential(fixture, personA.token, { name: personCredentialName(fixture, 'a'), serviceUri: slot, allowSharing: true, allowLocalUse: true })
  await buildAgent(a, fixture, { name: workshopName, skill: { name: skill, ...ledgerSkill([slot]) } })
  await shareSkill(a, workshopName, skill, { people: [personB], provide: { [slot]: provided.name } })
  expect(await providedBy(fixture, personA.token, skill)).toEqual([`${slot}:publisher`])
  const item = await skillItem(fixture, personA.token, skill)

  const b = await team.open('b')
  const agent = await buildAgent(b, fixture, { name: mine })
  await test.step('B adds it: provision-local shares A’s credential, it is attached by slot, and the skill’s script reads it', async () => {
    await addSkillToAgent(b, skill, mine)
    await expect.poll(() => storedAttachments(agent.path), { timeout: 30_000 }).toEqual([`account:${provided.id} auto:${slot}`])
    await expect
      .poll(async () => (await skillSlotDetails(b, agent.id)).map((s) => `${s.state}:${s.attached}:${s.provision}`), { timeout: 30_000 })
      .toEqual([`connected:${provided.name}:shared`])
    await expect.poll(() => cachedSkillDir(b, item.uuid, 1, skill), { timeout: 30_000 }).not.toBeNull()
    await addScriptCommand(b, agent.path, 'skill-check', join(cachedSkillDir(b, item.uuid, 1, skill)!, 'scripts/skill_check'))
    await expectRunLine(b, mine, 'skill-check', slotLine('skill-check', slot, provided.secret))
  })
  return { fixture, personA, personB, skill, slot, mine, provided, item, b, agent }
}

/*
 * T4.8 — the share provision-local made of the publisher's credential ends
 * only when the credential's owner changes that credential's own sharing:
 * (i) turns its sharing off, or (ii) unshares it from B. Never on a skill
 * update: B's Update to Version 2 and 3 keeps A's credential attached and
 * read while A still shares it — T4.7 above, not repeated here.
 *
 * B's app learns of it at its next credential sync (`syncCredentials`, what
 * Settings → Credentials → Sync Now and the five-minute poll run): until then
 * a shared credential's cached value keeps reaching B's agent.
 */
test('T4.8 (i) A turns sharing off on the credential A provides: B’s skill no longer reads it, and Finish setup says the publisher cannot share it', async ({ team }) => {
  test.setTimeout(600_000)
  const { fixture, personA, personB, skill, slot, mine, provided, item, b, agent } = await providedThenAdded(team, 'ledger-off')

  await test.step('A, as the credential’s owner, turns its sharing off: core counts B’s share and the skill in its impact, then revokes it', async () => {
    const impact = await coreCall(fixture, personA.token, `/credentials/${provided.id}/deletion-impact`)
    expect(impact.status, JSON.stringify(impact.body)).toBe(200)
    expect(impact.body.direct_share_count).toBe(1)
    expect(impact.body.skill_pbp_usages.map((usage: any) => usage.package_uuid)).toEqual([item.uuid])
    const off = await coreCall(fixture, personA.token, `/credentials/${provided.id}/sharing`, { method: 'PATCH', body: { allow_sharing: false } })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect({ allow_sharing: off.body.allow_sharing, share_count: off.body.share_count }).toEqual({ allow_sharing: false, share_count: 0 })
    expect(await provisionLocal(fixture, personB.token, item.uuid, 1)).toEqual([`${slot}:publisher:not_shareable:-`])
  })

  await test.step('B’s app syncs: the slot is missing, the Skills row asks for Finish setup, and Finish setup says why', async () => {
    await syncCredentials(b)
    await expect.poll(async () => (await skillSlotDetails(b, agent.id)).map((s) => `${s.state}:${s.attached}`), { timeout: 30_000 }).toEqual(['missing:null'])
    await openSkills(b, mine)
    const row = skillRow(b, skill, 'From the catalog')
    await expect(row.getByRole('img', { name: `No credential for ${slot} is attached yet`, exact: true })).toBeVisible()
    const { dialog, row: slotRow } = await openSkillFinishSetup(b, mine, skill)
    await expect(slotRow(slot).getByText(NOT_SHAREABLE, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(slotRow(slot).getByText('Missing', { exact: true })).toBeVisible()
    await expect(slotRow(slot).getByRole('button', { name: 'Use this' })).toHaveCount(0)
    expect((await skillSlotDetails(b, agent.id))[0]).toMatchObject({ state: 'missing', attached: null, provision: 'not_shareable' })
    await dialog.getByRole('button', { name: 'Finish later', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  await test.step('B runs the skill’s script again: A’s credential no longer reaches it', async () => {
    await expectRunLine(b, mine, 'skill-check', `skill-check: ${slot}=none`)
  })
})

test('T4.8 (ii) A unshares the credential from B only: B’s Finish setup must not share it again, and the skill no longer reads it', async ({ team }) => {
  // Core defect: provision-local re-creates a share its owner revoked from B
  // (credential_provisioner.py, the `_insert_share` after `existing is None`),
  // and B's Finish setup calls it on every opening. Observed: core's share
  // list for the credential is `[<B>:skill_local_install]` again, the row
  // says "Connected automatically" and the script reads A's hash.
  test.fail()
  test.setTimeout(600_000)
  const { fixture, personA, personB, skill, slot, mine, provided, b, agent } = await providedThenAdded(team, 'ledger-unshared')
  const sharesOf = async () => {
    const shares = await coreCall(fixture, personA.token, `/credentials/${provided.id}/shares`)
    expect(shares.status, JSON.stringify(shares.body)).toBe(200)
    return (shares.body.data as { shared_with_email: string; source: string }[]).map((share) => `${share.shared_with_email}:${share.source}`)
  }

  await test.step('A, as the credential’s owner, deletes B’s share (and only that)', async () => {
    expect(await sharesOf()).toEqual([`${personB.email}:skill_local_install`])
    const shares = await coreCall(fixture, personA.token, `/credentials/${provided.id}/shares`)
    const share = shares.body.data.find((s: any) => s.shared_with_email === personB.email)
    const removed = await coreCall(fixture, personA.token, `/credentials/${provided.id}/shares/${share.id}`, { method: 'DELETE' })
    expect(removed.status, JSON.stringify(removed.body)).toBe(200)
    expect(await sharesOf()).toEqual([])
  })

  await test.step('B’s app syncs and B opens Finish setup: nothing shares it again, and the slot is missing', async () => {
    await syncCredentials(b)
    await expect.poll(async () => (await skillSlotDetails(b, agent.id)).map((s) => `${s.state}:${s.attached}`), { timeout: 30_000 }).toEqual(['missing:null'])
    const { dialog, row } = await openSkillFinishSetup(b, mine, skill)
    // What the opening runs (provision-local, then the account sync), awaited to its end.
    expect(await b.page.evaluate((id) => window.api.serviceCredentials.setupSkills(id), agent.id)).toMatchObject({ ok: true })
    expect(await sharesOf()).toEqual([])
    await expect(row(slot).getByText('Missing', { exact: true })).toBeVisible()
    await expect(row(slot).getByText('Connected automatically', { exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Finish later', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  await test.step('B runs the skill’s script again: A’s credential no longer reaches it', async () => {
    await expectRunLine(b, mine, 'skill-check', `skill-check: ${slot}=none`)
  })
})
