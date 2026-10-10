import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  agentName,
  buildAcmeReporter,
  cloneHistory,
  catalogEntry,
  catalogGrants,
  coreCall,
  getFromLibrary,
  runCommand,
  shareWithTeam,
  shortHash,
  whereFact
} from '../fixtures/liveTeamSharing'

/**
 * Team sharing, main path, against the real local cinna-core: A shares an
 * agent that needs two credentials with B as Can use; core holds exactly the
 * grants A chose and none of A's secrets; B Gets it, the shared credential is
 * connected without asking, B types the other one into Finish setting up, and
 * the agent's own script reads both. Setup: `e2e/fixtures/live-team-sharing.py`.
 */

/** What git tracks in an agent folder: what travels to the team. */
function trackedFiles(root: string): string[] {
  return execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort()
}

test('A shares an agent with B as Can use; B gets it, finishes setup and runs it with the shared credential', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { a: personA, b: personB, c: personC } = fixture.people
  const name = agentName(fixture)
  const weatherA = `weather-a-${fixture.tag}-secret`
  const weatherB = `weather-b-${fixture.tag}-secret`
  const acmeHash = shortHash(`Bearer ${fixture.credentials.acme.secret}`)
  const adminEmail = (await coreCall(fixture, fixture.admin.token, '/users/me')).body.email as string

  const a = await team.open('a')
  const agent = await buildAcmeReporter(a, fixture, { name, weatherKey: weatherA })

  await test.step('A: check-creds reads both credentials', async () => {
    await runCommand(a, name, 'check-creds')
    await expect(a.page.getByText(`acme=${acmeHash} weather=${shortHash(weatherA)}`)).toBeVisible({ timeout: 30_000 })
  })

  let repoId = ''
  let uuid = ''
  let bundleId = ''
  await test.step('A: Share with the team, B as Can use; core lists a desktop agent at Version 1 and desktop.json records its catalog id', async () => {
    await shareWithTeam(a, name, [{ person: personB }])
    // Core records the version a moment after the send lands.
    await expect.poll(async () => (await catalogEntry(fixture, personA.token, agent.slug))?.latest?.revision_number ?? null).toBe(1)
    const entry = await catalogEntry(fixture, personA.token, agent.slug)
    expect(entry?.display_name).toBe(name)
    expect(entry.kind).toBe('agent')
    expect(entry.runs_on).toBe('desktop')
    expect(entry.access).toBe('maintain')
    expect(entry.id).toMatch(/\S/)
    expect(entry.desktop.manifest_id).toBe(agent.manifestId)
    expect(entry.latest?.revision_number).toBe(1)
    expect(entry.latest?.published_by?.user_id).toBe(personA.id)
    expect(entry.desktop.head_sha).toBe(execFileSync('git', ['-C', agent.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
    repoId = entry.desktop.repo_id
    uuid = entry.uuid
    bundleId = entry.id
    expect(JSON.parse(readFileSync(join(agent.path, 'app-data/desktop.json'), 'utf8')).shared_remote?.bundle_id).toBe(bundleId)
  })

  await test.step('A: the Sharing tab shows Version 1, shared by A, and the catalog id, read-only', async () => {
    await a.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await a.page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: 'Sharing', exact: true }).click()
    await expect(whereFact(a, 'Version')).toHaveText('1')
    await expect(whereFact(a, 'Shared by')).toHaveText(personA.name)
    await expect(whereFact(a, 'Catalog id')).toHaveText(bundleId)
    await expect(a.page.getByRole('textbox', { name: 'Catalog id' })).toHaveCount(0)
  })

  await test.step('core: exactly A maintains and B uses; history carries no secret and is authored by A', async () => {
    expect(await catalogGrants(fixture, personA.token, uuid)).toEqual([`user:${personA.id}:maintain`, `user:${personB.id}:use`].sort())

    const history = cloneHistory(fixture, repoId, fixture.admin.token)
    if (history.status !== 'ok') throw new Error(`admin clone refused: ${history.output}`)
    expect(history.paths.filter((p) => /^(credentials|app-data)\//.test(p) || /(^|\/)\.env(\.|$)/.test(p))).toEqual([])
    expect(history.paths).toEqual(expect.arrayContaining(['cinna-agent.json', 'scripts/check_creds.py', 'skills/acme-report/SKILL.md', 'knowledge/acme.md']))
    // Claude's per-machine permissions stay on the machine (kit layout.json shared_remote.never_travels, contract 1.9.0).
    expect(existsSync(join(agent.path, '.claude/settings.local.json'))).toBe(true)
    expect(history.paths).not.toContain('.claude/settings.local.json')
    expect(history.blobs).not.toContain(weatherA)
    expect(history.blobs).not.toContain(fixture.credentials.acme.secret)
    expect([...new Set(history.authors)]).toEqual([`${personA.name} <${personA.email}>`])
  })

  await test.step('core: C, not granted, neither lists it nor can clone it', async () => {
    expect(await catalogEntry(fixture, personC.token, agent.slug)).toBeUndefined()
    const clone = cloneHistory(fixture, repoId, personC.token)
    expect(clone.status).toBe('refused')
    if (clone.status === 'refused') expect(clone.output).toContain('403')
  })

  const b = await team.open('b')
  await test.step('B: Get from the Team library lands on the agent, files and id as A shared them', async () => {
    await getFromLibrary(b, name)
    const listed = await b.page.evaluate(() => window.api.localAgents.list())
    const got = listed.agents.find((row) => row.name === name)
    expect(got?.slug).toBe(agent.slug)
    expect(JSON.parse(readFileSync(join(got!.path, 'cinna-agent.json'), 'utf8')).id).toBe(agent.manifestId)
    expect(trackedFiles(got!.path)).toEqual(trackedFiles(agent.path))
    expect(trackedFiles(got!.path)).not.toContain('.claude/settings.local.json')
    // …and the template's own copy is still there for B's Claude.
    expect(existsSync(join(got!.path, '.claude/settings.local.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(got!.path, 'app-data/desktop.json'), 'utf8')).shared_remote?.bundle_id).toBe(bundleId)
  })

  await test.step('core: B’s Get is reported as B’s local install at Version 1, and A sees one person using it', async () => {
    await expect
      .poll(async () => {
        const mine = ((await catalogEntry(fixture, personB.token, agent.slug))?.my_installs ?? []) as any[]
        return mine.map((row) => `${row.where}:${row.revision_number}`)
      })
      .toEqual(['local:1'])
    expect((await catalogEntry(fixture, personA.token, agent.slug)).install_count).toBe(1)
  })

  const dialog = b.page.getByRole('dialog', { name: `Finish setting up ${name}` })
  const acmeRow = dialog.getByTestId('finish-setup-slot-acme')
  const weatherRow = dialog.getByTestId('finish-setup-slot-weather')
  await test.step('B: Finish setting up opens — acme connected automatically from the shared record, weather missing', async () => {
    await expect(dialog).toBeVisible()
    await expect(acmeRow.getByText('Connected automatically', { exact: true })).toBeVisible()
    await expect(acmeRow.getByText(fixture.credentials.acme.name, { exact: true })).toBeVisible()
    await expect(acmeRow.getByRole('img', { name: `Shared by ${adminEmail}` })).toBeVisible()
    await expect(weatherRow.getByText('Missing', { exact: true })).toBeVisible()
    await expect(weatherRow.getByLabel('WEATHER_API_KEY')).toHaveAttribute('type', 'password')
  })

  await test.step('B: types the weather key, Save, Done — no warning left', async () => {
    await weatherRow.getByLabel('WEATHER_API_KEY').fill(weatherB)
    await weatherRow.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(weatherRow.getByText('Set on this computer', { exact: true })).toBeVisible()
    await expect(weatherRow.getByText('Set', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(b.page.getByRole('button', { name: 'Finish setup', exact: true })).toHaveCount(0)
    const listed = await b.page.evaluate(() => window.api.localAgents.list())
    const got = listed.agents.find((row) => row.name === name)!
    expect(got.readiness).toBe('ok')
    expect(readFileSync(join(got.path, 'credentials/.env'), 'utf8')).not.toContain(weatherA)
  })

  await test.step('B: check-creds reads B’s weather key and the shared Acme key', async () => {
    await runCommand(b, name, 'check-creds')
    await expect(b.page.getByText(`acme=${acmeHash} weather=${shortHash(weatherB)}`)).toBeVisible({ timeout: 30_000 })
  })
})
