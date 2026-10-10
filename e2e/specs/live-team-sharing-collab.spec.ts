import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  test,
  expect,
  agentName,
  buildAcmeReporter,
  cloneHistory,
  coreCall,
  findAgent,
  finishDialog,
  finishWithWeather,
  getFromLibrary,
  libraryEntry,
  openAgent,
  refreshLibrary,
  shareChanges,
  shareWithTeam,
  type PersonApp,
  type SharingFixture,
  type SharingPerson,
  type Team
} from '../fixtures/liveTeamSharing'

/**
 * Two people changing one shared agent, against the real local cinna-core:
 * Update and Share changes in both directions, a teammate who shared first, a
 * collision and its two answers, edit access taken away mid-way, and what the
 * team library's push policy refuses. B can edit, C can only use.
 * Setup: `e2e/fixtures/live-team-sharing.py`.
 */

const ACME_MD = 'knowledge/acme.md'
const SKILL_MD = 'skills/acme-report/SKILL.md'

/** A builds and shares with B (Can edit) and C (Can use); B Gets it. */
async function sharedWithEditor(team: Team): Promise<{ a: PersonApp; b: PersonApp; name: string; aPath: string; bPath: string; slug: string }> {
  const { fixture } = team
  const name = agentName(fixture)
  const a = await team.open('a')
  const built = await buildAcmeReporter(a, fixture, { name, weatherKey: `weather-a-${fixture.tag}-secret` })
  await shareWithTeam(a, name, [
    { person: fixture.people.b, access: 'Can edit' },
    { person: fixture.people.c, access: 'Can use' }
  ])
  const b = await team.open('b')
  await getFromLibrary(b, name)
  await finishWithWeather(b, name, `weather-b-${fixture.tag}-secret`)
  return { a, b, name, aPath: built.path, bPath: (await findAgent(b, name)).path, slug: built.slug }
}

function edit(path: string, rel: string, text: string): void {
  writeFileSync(join(path, rel), text)
}

function head(path: string): string {
  return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

/** The share badge, by the words it shows. */
function badge(app: PersonApp, words: string) {
  return app.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: words, exact: true })
}

/** Settings → Sharing for `name`. */
async function openSharingTab(app: PersonApp, name: string): Promise<void> {
  await openAgent(app, name)
  await app.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await app.page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: 'Sharing', exact: true }).click()
}

function section(app: PersonApp, title: string) {
  return app.page.locator('section').filter({ has: app.page.getByRole('heading', { level: 2, name: title, exact: true }) })
}

/** The team changed it: refresh B's library, open the page, Update from the badge. */
async function updateFromBadge(app: PersonApp, name: string): Promise<void> {
  await refreshLibrary(app)
  await openAgent(app, name)
  await expect(badge(app, 'The team changed this agent')).toBeVisible().catch(async (error: Error) => {
    // Seen once in ~15 runs and not reproduced since: say what main believed.
    const id = (await findAgent(app, name)).id
    const status = await app.page.evaluate((agentId) => window.api.sharing.status(agentId), id)
    throw new Error(`${error.message}\nmain's status then: ${JSON.stringify(status)}`)
  })
  await app.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Update', exact: true }).click()
  await expect(badge(app, 'Up to date with the team')).toBeVisible({ timeout: 60_000 })
}

/** A raw `git push` of one new commit with `person`'s web token, as anything outside the app could. */
function rawPush(fixture: SharingFixture, dir: string, person: SharingPerson): string {
  const auth = ['-c', `http.${fixture.server}/.extraheader=Authorization: Bearer ${person.token}`]
  const id = ['-c', 'user.name=Raw', '-c', 'user.email=raw@example.com', '-c', 'commit.gpgsign=false']
  writeFileSync(join(dir, 'knowledge/raw.md'), `raw ${randomBytes(4).toString('hex')}\n`)
  execFileSync('git', ['-C', dir, ...id, 'add', 'knowledge/raw.md'])
  execFileSync('git', ['-C', dir, ...id, 'commit', '-q', '-m', 'raw'])
  try {
    execFileSync('git', ['-C', dir, ...auth, 'push', 'origin', 'HEAD:main'], { stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    return 'pushed'
  } catch (error) {
    return ((error as { stderr?: Buffer }).stderr?.toString() ?? String(error)).replace(/Bearer \S+/g, 'Bearer ***')
  }
}

test('a file edited in a shared agent offers Share changes while its page stays open', async ({ team }) => {
  // No rescan, no remount, no status read: only the folder watcher's push.
  test.setTimeout(240_000)
  const { fixture } = team
  const name = agentName(fixture)
  const a = await team.open('a')
  const built = await buildAcmeReporter(a, fixture, { name, weatherKey: 'weather-key' })
  await shareWithTeam(a, name, [{ person: fixture.people.b }])
  await expect(badge(a, 'Up to date with the team')).toBeVisible()
  edit(built.path, ACME_MD, '# Acme\n\nAcme sells anvils and rope.\n')
  await expect(badge(a, '1 change not shared')).toBeVisible({ timeout: 20_000 })
  await expect(a.page.getByRole('button', { name: 'Share changes…', exact: true })).toBeVisible()
})

test('a change shared by either side comes in with Update, with its note and author in History', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { people } = fixture
  const { a, b, name, aPath, bPath } = await sharedWithEditor(team)

  await test.step('A shares; B updates', async () => {
    edit(aPath, ACME_MD, '# Acme\n\nAnvils are heavy.\n')
    await shareChanges(a, name, 'A: anvils are heavy')
    await updateFromBadge(b, name)
    expect(readFileSync(join(bPath, ACME_MD), 'utf8')).toBe('# Acme\n\nAnvils are heavy.\n')
    await openSharingTab(b, name)
    const history = section(b, 'History')
    await expect(history.getByText('A: anvils are heavy', { exact: true }).locator('..')).toContainText(`${people.a.name} · `)
    await expect(history.getByText('Not shared yet', { exact: true })).toHaveCount(0)
  })

  await test.step('B shares; A updates', async () => {
    edit(bPath, SKILL_MD, '---\nname: acme-report\ndescription: Write the Acme report.\n---\n\nAlways mention anvils.\n')
    await shareChanges(b, name, 'B: mention anvils')
    await openSharingTab(b, name)
    await expect(section(b, 'History').getByText('Not shared yet', { exact: true })).toHaveCount(0)
    await updateFromBadge(a, name)
    expect(readFileSync(join(aPath, SKILL_MD), 'utf8')).toContain('Always mention anvils.')
    await openSharingTab(a, name)
    const history = section(a, 'History')
    await expect(history.getByText('B: mention anvils', { exact: true }).locator('..')).toContainText(`${people.b.name} · `)
    expect(head(aPath)).toBe(head(bPath))
  })
})

test('a teammate shared first: Share changes brings their version in, sends once more, and both converge', async ({ team }) => {
  test.setTimeout(300_000)
  const { a, b, name, aPath, bPath, slug } = await sharedWithEditor(team)
  edit(aPath, ACME_MD, '# Acme\n\nA was here first.\n')
  await shareChanges(a, name, 'A first')
  edit(bPath, SKILL_MD, '---\nname: acme-report\ndescription: Write the Acme report.\n---\n\nB second.\n')
  await shareChanges(b, name, 'B second')
  expect(readFileSync(join(bPath, ACME_MD), 'utf8')).toContain('A was here first.')
  await updateFromBadge(a, name)
  expect(readFileSync(join(aPath, SKILL_MD), 'utf8')).toContain('B second.')
  expect(head(aPath)).toBe(head(bPath))
  expect((await libraryEntry(team.fixture, team.fixture.people.a.token, slug)).head_sha).toBe(head(aPath))
})

test('the same lines on both: Keep working on mine leaves both changed; Use the team’s version keeps mine as a copy', async ({ team }) => {
  test.setTimeout(300_000)
  const { a, b, name, aPath, bPath, slug } = await sharedWithEditor(team)
  const conflict = () => b.page.getByRole('dialog', { name: 'The team changed this agent too' })
  edit(aPath, ACME_MD, '# Acme\n\nAcme sells rockets (from A).\n')
  await shareChanges(a, name, 'A says rockets')
  edit(bPath, ACME_MD, '# Acme\n\nAcme sells skates (from B).\n')

  await test.step('Keep working on mine', async () => {
    await shareChanges(b, name, 'B says skates')
    await expect(conflict()).toBeVisible({ timeout: 60_000 })
    await expect(conflict().getByRole('button', { name: 'Keep working on mine (share later)', exact: true })).toBeFocused()
    await conflict().getByRole('button', { name: 'Keep working on mine (share later)', exact: true }).click()
    await expect(conflict()).toHaveCount(0)
    await openAgent(b, name)
    await expect(badge(b, 'You and the team both changed it')).toBeVisible()
    expect(readFileSync(join(bPath, ACME_MD), 'utf8')).toContain('skates (from B)')
  })

  await test.step('Use the team’s version (keep mine as a copy)', async () => {
    await b.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Share changes…', exact: true }).click()
    const dialog = b.page.getByRole('dialog', { name: 'Share changes' })
    await dialog.getByRole('textbox').fill('B says skates again')
    await dialog.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(conflict()).toBeVisible({ timeout: 60_000 })
    await conflict().getByRole('button', { name: 'Use the team’s version (keep mine as a copy)', exact: true }).click()
    await expect(conflict()).toHaveCount(0, { timeout: 60_000 })
    const listed = await b.page.evaluate(() => window.api.localAgents.list())
    const original = listed.agents.find((row) => row.name === name)!
    const mine = listed.agents.find((row) => row.name === `${name} (my copy)`)
    expect(mine?.path).toBe(`${original.path}-mine`)
    expect(mine?.slug).toBe(`${slug}-mine`)
    expect(mine?.readiness).toBe('ok')
    expect(JSON.parse(readFileSync(join(mine!.path, 'cinna-agent.json'), 'utf8')).slug).toBe(`${slug}-mine`)
    expect(readFileSync(join(original.path, ACME_MD), 'utf8')).toContain('rockets (from A)')
    expect(readFileSync(join(mine!.path, ACME_MD), 'utf8')).toContain('skates (from B)')
    const id = (path: string): string => JSON.parse(readFileSync(join(path, 'cinna-agent.json'), 'utf8')).id
    expect(id(mine!.path)).not.toBe(id(original.path))
    expect(execFileSync('git', ['-C', mine!.path, 'remote'], { encoding: 'utf8' }).trim()).toBe('')
    await expect(b.page.getByText(`Your version is kept as ${name} (my copy).`, { exact: true })).toBeVisible()
  })
})

test('edits here and a team that moved: Update is refused, Share changes combines them', async ({ team }) => {
  test.setTimeout(300_000)
  const { a, b, name, aPath, bPath } = await sharedWithEditor(team)
  edit(aPath, ACME_MD, '# Acme\n\nThe team moved.\n')
  await shareChanges(a, name, 'Team moved')
  edit(bPath, SKILL_MD, '---\nname: acme-report\ndescription: Write the Acme report.\n---\n\nUnsent edit.\n')
  await refreshLibrary(b)
  // Edits here and a team that moved is `diverged`: the badge and the Sharing
  // tab offer only Share changes (canUpdate), so Update is the catalog tile's.
  await openAgent(b, name)
  await expect(badge(b, 'You and the team both changed it')).toBeVisible()
  await b.page.getByRole('button', { name: 'Add an agent' }).click()
  await b.page.getByRole('dialog', { name: 'Add an agent' }).getByRole('button', { name: /Install from catalog/ }).click()
  const catalog = b.page.getByRole('dialog', { name: 'Agent catalog' })
  await catalog.getByRole('tablist', { name: 'Catalog source' }).getByRole('tab', { name: 'Team library' }).click()
  const tile = catalog.getByRole('group', { name })
  await tile.getByRole('button', { name: 'Update available', exact: true }).click()
  await expect(tile.getByRole('alert')).toHaveText('Share your changes first — Share changes brings in the team’s version too.')
  await catalog.getByRole('button', { name: 'Close', exact: true }).click()
  expect(readFileSync(join(bPath, ACME_MD), 'utf8')).not.toContain('The team moved.')
  await b.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Share changes…', exact: true }).click()
  const dialog = b.page.getByRole('dialog', { name: 'Share changes' })
  await dialog.getByRole('textbox').fill('Unsent edit')
  await dialog.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 60_000 })
  expect(readFileSync(join(bPath, ACME_MD), 'utf8')).toContain('The team moved.')
  await expect(badge(b, 'Up to date with the team')).toBeVisible()
})

test('Can use: no Share changes in the app, and a raw send is refused by core', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { name } = await sharedWithEditor(team)
  const c = await team.open('c')
  await getFromLibrary(c, name)
  await c.page.getByRole('dialog', { name: `Finish setting up ${name}` }).getByRole('button', { name: 'Finish later', exact: true }).click()
  const cPath = (await findAgent(c, name)).path
  edit(cPath, ACME_MD, '# Acme\n\nC would like to change this.\n')
  await openAgent(c, name)
  await expect(badge(c, '1 change not shared')).toBeVisible()
  await expect(c.page.getByRole('button', { name: 'Share changes…', exact: true })).toHaveCount(0)
  const pushed = rawPush(fixture, cPath, fixture.people.c)
  expect(pushed).toContain('403')
})

test('edit access taken away mid-way: the send asks for a maintainer', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { b, name, bPath, slug } = await sharedWithEditor(team)
  edit(bPath, ACME_MD, '# Acme\n\nB edits before being demoted.\n')
  await openAgent(b, name)
  await b.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Share changes…', exact: true }).click()
  const dialog = b.page.getByRole('dialog', { name: 'Share changes' })
  await dialog.getByRole('textbox').fill('B, about to be demoted')

  const entry = await libraryEntry(fixture, fixture.people.a.token, slug)
  const grants = await coreCall(fixture, fixture.people.a.token, `/library/agents/${entry.repo_id}/grants`)
  const rows = (Array.isArray(grants.body) ? grants.body : grants.body.grants ?? grants.body.data) as any[]
  const demoted = rows.map((g) => (g.principal?.user_id ?? g.user_id) === fixture.people.b.id ? { ...g, access: 'read' } : g)
  const put = await coreCall(fixture, fixture.people.a.token, `/library/agents/${entry.repo_id}/grants`, {
    method: 'PUT',
    body: Array.isArray(grants.body) ? demoted : { grants: demoted }
  })
  expect(put.status, JSON.stringify(put.body)).toBe(200)

  await dialog.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText(
    'Ask a maintainer for edit access — you can use this agent but not change it for the team.',
    { timeout: 60_000 }
  )
  await expect(dialog).toBeVisible()
})

for (const refusal of [
  {
    title: 'a symlink',
    make: (path: string) => symlinkSync('acme.md', join(path, 'knowledge/link.md')),
    sentence: "This change includes knowledge/link.md, a shortcut (symlink) to another file, which can't be shared. Replace it with the file itself."
  },
  {
    title: 'an oversized file',
    make: (path: string) => writeFileSync(join(path, 'files/big.bin'), randomBytes(11 * 1024 * 1024)),
    sentence: 'The file files/big.bin is larger than 10 MB, too big to share with the team.'
  },
  {
    title: 'an invalid manifest',
    make: (path: string) => {
      const manifest = JSON.parse(readFileSync(join(path, 'cinna-agent.json'), 'utf8'))
      manifest.schedules = 'every morning'
      writeFileSync(join(path, 'cinna-agent.json'), JSON.stringify(manifest, null, 2) + '\n')
    },
    sentence: "This agent's cinna-agent.json isn't valid (schedules: 'every morning' is not of type 'array'), so it can't be shared."
  }
]) {
  test(`core refuses ${refusal.title}: the dialog shows core's sentence and the version stays Not shared yet`, async ({ team }) => {
    test.setTimeout(300_000)
    const { fixture } = team
    const { a, name, aPath, slug } = await sharedWithEditor(team)
    const before = (await libraryEntry(fixture, fixture.people.a.token, slug)).head_sha
    refusal.make(aPath)
    await openAgent(a, name)
    await a.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Share changes…', exact: true }).click()
    const dialog = a.page.getByRole('dialog', { name: 'Share changes' })
    await dialog.getByRole('textbox').fill(`Adds ${refusal.title}`)
    await dialog.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText(`Fix what the team library refused, then share again. ${refusal.sentence}`, { timeout: 60_000 })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await libraryEntry(fixture, fixture.people.a.token, slug)).head_sha).toBe(before)
    await openSharingTab(a, name)
    const history = section(a, 'History')
    await expect(history.getByText(`Adds ${refusal.title}`, { exact: true })).toBeVisible()
    await expect(history.getByText('Not shared yet', { exact: true })).toHaveCount(1)
  })
}

for (const fixable of [
  {
    title: 'a symlink',
    make: (path: string) => symlinkSync('acme.md', join(path, 'knowledge/link.md')),
    refused: 'a shortcut (symlink) to another file',
    fix: (path: string) => {
      rmSync(join(path, 'knowledge/link.md'))
      writeFileSync(join(path, 'knowledge/link.md'), 'Now a real file.\n')
    }
  },
  {
    title: 'an oversized file',
    make: (path: string) => writeFileSync(join(path, 'files/big.bin'), randomBytes(11 * 1024 * 1024)),
    refused: 'The file files/big.bin is larger than 10 MB',
    fix: (path: string) => writeFileSync(join(path, 'files/big.bin'), randomBytes(1024))
  }
]) {
  test(`after core refuses ${fixable.title}, fixing it lets the next Share changes through as one combined version`, async ({ team }) => {
    test.setTimeout(300_000)
    const { fixture } = team
    const { a, name, aPath, slug } = await sharedWithEditor(team)
    const repoId = (await libraryEntry(fixture, fixture.people.a.token, slug)).repo_id as string
    const clone = () => {
      const history = cloneHistory(fixture, repoId, fixture.admin.token)
      if (history.status !== 'ok') throw new Error(`admin clone refused: ${history.output}`)
      return history
    }
    const before = clone().commits.length
    const dialog = () => a.page.getByRole('dialog', { name: 'Share changes' })
    const share = async (note: string): Promise<void> => {
      await openAgent(a, name)
      await a.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Share changes…', exact: true }).click()
      await dialog().getByRole('textbox').fill(note)
      await dialog().getByRole('button', { name: 'Share', exact: true }).click()
    }

    fixable.make(aPath)
    await share(`Adds ${fixable.title}`)
    await expect(dialog().getByRole('alert')).toContainText(fixable.refused, { timeout: 60_000 })
    await dialog().getByRole('button', { name: 'Cancel', exact: true }).click()

    fixable.fix(aPath)
    await share(`Fixes ${fixable.title}`)
    await expect(dialog().getByRole('alert').or(badge(a, 'Up to date with the team'))).toBeVisible({ timeout: 60_000 })
    await expect(dialog()).toHaveCount(0)
    await expect(badge(a, 'Up to date with the team')).toBeVisible()

    const after = clone()
    expect(after.commits.length).toBe(before + 1)
    expect(after.commits[0].sha).toBe(head(aPath))
    expect(after.commits[0].message).toContain(`Adds ${fixable.title}`)
    expect(after.commits[0].message).toContain(`Fixes ${fixable.title}`)
    expect(after.commits.flatMap((commit) => commit.symlinks)).toEqual([])
    expect(Math.max(...after.commits.map((commit) => commit.maxBlob))).toBeLessThan(10 * 1024 * 1024)
    const localTree = execFileSync('git', ['-C', aPath, 'ls-tree', '-r', '-l', 'HEAD'], { encoding: 'utf8' })
    expect(localTree.split('\n').filter((line) => line.startsWith('120000 '))).toEqual([])
    await openSharingTab(a, name)
    await expect(section(a, 'History').getByText('Not shared yet', { exact: true })).toHaveCount(0)
  })
}
