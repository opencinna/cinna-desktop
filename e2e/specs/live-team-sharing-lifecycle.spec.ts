import { cpSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { repoRoot } from '../playwright.config'
import {
  test,
  expect,
  agentName,
  buildAcmeReporter,
  cloneHistory,
  findAgent,
  finishWithWeather,
  getFromLibrary,
  openCatalogAgents,
  catalogEntry,
  catalogEntryOrFail,
  openAgent,
  refreshLibrary,
  setCatalogAccess,
  shareChanges,
  shareWithTeam,
  type PersonApp,
  type SharingFixture,
  type Team
} from '../fixtures/liveTeamSharing'

/**
 * A shared agent's life outside the day-to-day, against the real local
 * cinna-core: sharing removed, access taken away, a Get that would land on
 * an agent already here, the Inbox's "Update available for X", and a blocked job
 * fetching its agent from the catalog, and core refusing Claude's
 * per-machine settings file. Setup:
 * `e2e/fixtures/live-team-sharing.py`.
 */

/** A builds and shares with B (Can use); B Gets it and finishes setup. */
async function shared(team: Team): Promise<{ a: PersonApp; b: PersonApp; name: string; aPath: string; slug: string; manifestId: string; aId: string }> {
  const { fixture } = team
  const name = agentName(fixture)
  const a = await team.open('a')
  const built = await buildAcmeReporter(a, fixture, { name, weatherKey: `weather-a-${fixture.tag}-secret` })
  await shareWithTeam(a, name, [{ person: fixture.people.b }])
  const b = await team.open('b')
  await getFromLibrary(b, name)
  await finishWithWeather(b, name, `weather-b-${fixture.tag}-secret`)
  return { a, b, name, aPath: built.path, slug: built.slug, manifestId: built.manifestId, aId: built.id }
}

function badge(app: PersonApp, words: string) {
  return app.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: words, exact: true })
}

async function openSharingTab(app: PersonApp, name: string): Promise<void> {
  await openAgent(app, name)
  await app.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await app.page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: 'Sharing', exact: true }).click()
}

function section(app: PersonApp, title: string) {
  return app.page.locator('section').filter({ has: app.page.getByRole('heading', { level: 2, name: title, exact: true }) })
}


/**
 * A version made by plain git on top of the folder's HEAD, carrying `files`
 * at exactly the given paths (casing included), sent with a raw `git push`.
 * Built in a throwaway index, so the folder's HEAD, index and files are
 * untouched whether core takes it or not. Returns git's output on a refusal.
 */
function rawSend(fixture: SharingFixture, dir: string, files: Record<string, string>, note: string): { sha: string; refused: string | null } {
  const index = join(dir, '.git', `e2e-raw-index-${process.pid}`)
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_TERMINAL_PROMPT: '0' }
  const git = (args: string[], input?: string): string =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=Plain Git', '-c', 'user.email=plain@example.com', '-c', 'commit.gpgsign=false',
      '-c', `http.${fixture.server}/.extraheader=Authorization: Bearer ${fixture.people.a.token}`, ...args], { encoding: 'utf8', stdio: 'pipe', env, input })
  try {
    git(['read-tree', 'HEAD'])
    for (const [path, content] of Object.entries(files)) {
      const blob = git(['hash-object', '-w', '--stdin'], content).trim()
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`])
    }
    const tree = git(['write-tree']).trim()
    const sha = git(['commit-tree', tree, '-p', 'HEAD', '-m', note]).trim()
    try {
      git(['push', 'origin', `${sha}:refs/heads/main`])
      return { sha, refused: null }
    } catch (error) {
      const err = error as { stderr?: string }
      return { sha, refused: (err.stderr ?? String(error)).replace(/Bearer \S+/g, 'Bearer ***') }
    }
  } finally {
    rmSync(index, { force: true })
  }
}

/** Refresh, open the page, Update from the badge, wait for the folder to be at `sha`. */
async function updateFromBadge(app: PersonApp, name: string, path: string, sha: string): Promise<void> {
  await refreshLibrary(app)
  await openAgent(app, name)
  // Seen settling from "Up to date with the team" up to ~15s after the refresh
  // when this machine's copy of a tracked local-only file is edited.
  await expect(badge(app, 'The team changed this agent')).toBeVisible({ timeout: 30_000 })
  await app.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Update', exact: true }).click()
  await expect.poll(() => execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), { timeout: 60_000 }).toBe(sha)
}

function gitStatus(path: string): string {
  return execFileSync('git', ['-C', path, 'status', '--short'], { encoding: 'utf8' }).trim() || 'clean'
}

test('A’s Remove sharing with delete is refused while B holds it; after B removes it from this computer, the delete goes through and A shares it again', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { a, b, name, slug } = await shared(team)
  const first = await catalogEntryOrFail(fixture, slug)
  // B's Get is reported to core in the background.
  await expect.poll(async () => (await catalogEntryOrFail(fixture, slug)).install_count).toBe(1)

  const removeSharing = async (): Promise<ReturnType<PersonApp['page']['getByRole']>> => {
    await openSharingTab(a, name)
    await section(a, 'Remove sharing').getByRole('button', { name: 'Remove sharing…', exact: true }).click()
    const dialog = a.page.getByRole('dialog', { name: 'Remove sharing' })
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await dialog.getByRole('checkbox', { name: 'Also delete it from the catalog — teammates can no longer get it' }).check()
    await dialog.getByRole('button', { name: 'Remove sharing', exact: true }).click()
    return dialog
  }

  await test.step('refused with core’s sentence while B holds it; nothing changes', async () => {
    const dialog = await removeSharing()
    await expect(dialog.getByRole('alert')).toHaveText('1 person uses this. It can be removed once nobody does.', { timeout: 60_000 })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect((await catalogEntry(fixture, fixture.people.b.token, slug))?.uuid).toBe(first.uuid)
    await expect(section(a, 'Where it’s shared').getByText('Up to date with the team', { exact: true })).toBeVisible()
  })

  await test.step('B removes it from this computer: core drops B’s local install', async () => {
    await openAgent(b, name)
    await b.page.getByRole('button', { name: 'More actions' }).click()
    await b.page.getByRole('menu', { name: 'Agent actions' }).getByRole('menuitem', { name: 'Remove from this computer…' }).click()
    const dialog = b.page.getByRole('dialog', { name: 'Remove from this computer' })
    await dialog.getByRole('button', { name: 'Remove from this computer', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 60_000 })
    await expect
      .poll(async () => ((await catalogEntry(fixture, fixture.people.b.token, slug))?.my_installs ?? []).length)
      .toBe(0)
    expect((await catalogEntryOrFail(fixture, slug)).install_count).toBe(0)
  })

  await test.step('A’s delete now goes through', async () => {
    const dialog = await removeSharing()
    await expect(dialog).toHaveCount(0, { timeout: 60_000 })
    await expect(a.page.getByText(`${name} is no longer shared with the team.`, { exact: true })).toBeVisible()
    expect(await catalogEntry(fixture, fixture.people.a.token, slug)).toBeUndefined()
  })

  await test.step('A shares it again: a new catalog entry at Version 1 that B can get', async () => {
    await shareWithTeam(a, name, [{ person: fixture.people.b }])
    // B sees it once core has recorded its first version.
    await expect.poll(async () => (await catalogEntry(fixture, fixture.people.b.token, slug))?.latest?.revision_number ?? null).toBe(1)
    const again = await catalogEntry(fixture, fixture.people.b.token, slug)
    expect(again?.display_name).toBe(name)
    expect(again.uuid).not.toBe(first.uuid)
    expect(again.latest?.revision_number).toBe(1)
  })
})

test('A takes B’s access away: B’s copy reads No longer shared', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { a, b, name, slug } = await shared(team)
  await openSharingTab(a, name)
  const people = section(a, 'People')
  await people.getByRole('button', { name: `Remove ${fixture.people.b.name}`, exact: true }).click()
  await expect(people.getByText(`Remove ${fixture.people.b.name}’s access?`, { exact: true })).toBeVisible()
  await people.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(people.getByText('No one else has access yet.', { exact: true })).toBeVisible({ timeout: 30_000 })
  expect(await catalogEntry(fixture, fixture.people.b.token, slug)).toBeUndefined()

  await refreshLibrary(b)
  await openAgent(b, name)
  await expect(badge(b, 'No longer shared')).toBeVisible()
  await openSharingTab(b, name)
  await expect(section(b, 'Where it’s shared').getByText('This agent is no longer shared', { exact: true })).toBeVisible()
})

test('Get refuses to land on an agent already here, by folder name or by manifest id, and leaves nothing behind', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const name = agentName(fixture)
  const a = await team.open('a')
  const built = await buildAcmeReporter(a, fixture, { name, weatherKey: 'weather-key' })
  await shareWithTeam(a, name, [{ person: fixture.people.b }])
  const b = await team.open('b')
  const local = join(b.rootPath, 'Local')
  const before = (): string[] => readdirSync(local).sort()

  await test.step('a different agent of B’s already has the folder name', async () => {
    const rootId = await b.rootId()
    const mine = await b.page.evaluate((args) => window.api.localAgents.create(args), { rootId, name, description: 'B’s own.' })
    expect(mine.slug).toBe(built.slug)
    await b.relaunch()
    const folders = before()
    const catalog = await openCatalogAgents(b)
    const tile = catalog.getByRole('group', { name })
    await tile.getByRole('button', { name: 'Get', exact: true }).click()
    await expect(tile.getByRole('alert')).toHaveText(/this agent is already on this computer\.$/)
    await expect(catalog).toBeVisible()
    expect(before()).toEqual(folders)
    expect(JSON.parse(readFileSync(join(mine.path, 'cinna-agent.json'), 'utf8')).description).toBe('B’s own.')
    // Out of the home, not to the Trash: the next step needs the name free.
    renameSync(mine.path, join(b.sandbox.home, 'parked-agent'))
  })

  await test.step('a copy with the same manifest id under another folder name', async () => {
    const elsewhere = join(local, 'acme-elsewhere')
    cpSync(built.path, elsewhere, { recursive: true, filter: (src) => !src.includes('/.git') && !src.includes('/.venv') })
    const manifest = JSON.parse(readFileSync(join(elsewhere, 'cinna-agent.json'), 'utf8'))
    manifest.slug = 'acme-elsewhere'
    writeFileSync(join(elsewhere, 'cinna-agent.json'), JSON.stringify(manifest, null, 2) + '\n')
    await b.relaunch()
    const folders = before()
    const listing = await b.page.evaluate(() => window.api.sharing.library(true))
    const entry = listing.success ? listing.value?.agents.find((agent) => agent.name === name) : undefined
    expect(entry?.localAgentId).not.toBeNull()
    const got = await b.page.evaluate((repoId) => window.api.sharing.get(repoId), entry!.repoId)
    expect(got.success && got.value.refusal).toBe('exists')
    expect(before()).toEqual(folders)
  })
})

test('the Inbox card Update available for X updates the agent and says Updated.', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { a, b, name, aPath } = await shared(team)
  writeFileSync(join(aPath, 'knowledge/acme.md'), '# Acme\n\nNews from A.\n')
  await shareChanges(a, name, 'News from A')
  await refreshLibrary(b)
  await b.page.getByRole('button', { name: /^Inbox/ }).click()
  const card = b.page.getByRole('article', { name: `Update available for ${name}` })
  await expect(card).toContainText(`by ${fixture.people.a.name}`)
  await card.getByRole('button', { name: 'Update', exact: true }).click()
  await expect(card.getByRole('status')).toHaveText('Updated. This agent now has the latest version.', { timeout: 60_000 })
  expect(readFileSync(join((await findAgent(b, name)).path, 'knowledge/acme.md'), 'utf8')).toContain('News from A.')
})

test('a blocked job offers Get X from the catalog, and the Get unblocks it', async ({ team }) => {
  // A job can only be bound to an agent this machine knows (setAgents drops
  // an unknown id), so B binds it to its copy and then the folder goes
  // missing — the state blocked-job.spec.ts arranges — while the team has it.
  test.setTimeout(300_000)
  const { fixture } = team
  const { b, name, aId } = await shared(team)
  const title = `Morning Acme report ${fixture.tag}`
  const bAgent = await findAgent(b, name)
  expect(bAgent.id).toBe(aId)
  await b.page.evaluate(
    async ({ title, agentId }) => {
      const job = await window.api.jobs.create({ type: 'local', title, prompt: 'Write the Acme report.' })
      await window.api.jobs.setAgents(job.id, [agentId])
    },
    { title, agentId: bAgent.id }
  )
  await b.close()
  renameSync(bAgent.path, join(b.sandbox.home, 'parked-agent'))
  await b.start()
  await b.waitForShell()
  await b.page.evaluate(() => window.api.localAgents.rescan())
  await b.page.getByRole('button', { name: 'Jobs', exact: true }).click()
  await b.page.getByText(title, { exact: true }).click()
  await expect(b.page.getByText('Agent unavailable', { exact: true })).toBeVisible()
  await expect(b.page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled()
  await b.page.getByRole('button', { name: `Get ${name} from the catalog`, exact: true }).click()
  await expect(b.page.getByText('Agent unavailable', { exact: true })).toHaveCount(0, { timeout: 60_000 })
  await expect(b.page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled()
  expect((await findAgent(b, name)).id).toBe(aId)
})

const SETTINGS = '.claude/settings.local.json'
const TEMPLATE_SETTINGS = readFileSync(join(repoRoot, 'resources/cinna-agent-kit/templates/agent', SETTINGS), 'utf8')
const SETTINGS_REFUSED = 'This change includes the agent\'s Claude permission settings (.claude/settings.local.json), which never leave your computer.'

// Since core d5bb0a16 (kit contract 1.9.0) the push policy refuses any version
// whose tip still holds .claude/settings.local.json, in any casing, so a team
// version that tracks the file can no longer be made against a real core. The
// migration of an entry shared before d5bb0a16 (B edits a tracked copy, an
// Update keeps B's, a version that deletes the file is accepted) is covered by
// the desktop's gitService unit tests instead.
test('core refuses a plain-git version carrying settings.local.json in any casing; B’s file stays B’s through an Update, and C’s Get gets the template’s', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const name = agentName(fixture)
  const a = await team.open('a')
  const built = await buildAcmeReporter(a, fixture, { name, weatherKey: 'weather-key' })
  await shareWithTeam(a, name, [{ person: fixture.people.b }, { person: fixture.people.c }])
  const b = await team.open('b')
  await getFromLibrary(b, name)
  await finishWithWeather(b, name, `weather-b-${fixture.tag}-secret`)
  const bPath = (await findAgent(b, name)).path
  expect(readFileSync(join(bPath, SETTINGS), 'utf8')).toBe(TEMPLATE_SETTINGS)
  const teamHead = (await catalogEntryOrFail(fixture, built.slug)).desktop.head_sha as string
  const aHead = execFileSync('git', ['-C', built.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  expect(teamHead).toBe(aHead)

  const wide = '{ "permissions": { "allow": ["Bash(*)"] } }\n'
  for (const path of [SETTINGS, '.Claude/Settings.local.json']) {
    await test.step(`a raw push of ${path} is refused with core’s sentence`, async () => {
      const sent = rawSend(fixture, built.path, { [path]: wide, 'knowledge/acme.md': '# Acme\n\nSent by plain git.\n' }, 'Plain git: wide permissions')
      expect(sent.refused, `core accepted ${sent.sha}`).not.toBeNull()
      expect(sent.refused).toContain(`remote: ${SETTINGS_REFUSED}`)
    })
  }

  await test.step('the team version is unchanged and its history never held the file', async () => {
    const entry = await catalogEntryOrFail(fixture, built.slug)
    expect(entry.desktop.head_sha).toBe(teamHead)
    const history = cloneHistory(fixture, entry.desktop.repo_id, fixture.admin.token)
    if (history.status !== 'ok') throw new Error(`admin clone refused: ${history.output}`)
    expect(history.paths.filter((p) => p.toLowerCase() === SETTINGS)).toEqual([])
    expect(history.blobs).not.toContain('Bash(*)')
    expect(execFileSync('git', ['-C', built.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(aHead)
  })

  const mine = '{ "permissions": { "allow": ["Bash(echo from-B)"] } }\n'
  writeFileSync(join(bPath, SETTINGS), mine)
  writeFileSync(join(built.path, SETTINGS), '{ "permissions": { "allow": ["Bash(echo from-A)"] } }\n')
  writeFileSync(join(built.path, 'knowledge/acme.md'), '# Acme\n\nA change shared from the app.\n')
  await shareChanges(a, name, 'A shares a change')
  const head = execFileSync('git', ['-C', built.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  expect(head).not.toBe(aHead)

  await test.step('B’s in-app Update brings the change in and keeps B’s file', async () => {
    await updateFromBadge(b, name, bPath, head)
    expect(readFileSync(join(bPath, 'knowledge/acme.md'), 'utf8')).toContain('A change shared from the app.')
    expect(readFileSync(join(bPath, SETTINGS), 'utf8')).toBe(mine)
    expect(gitStatus(bPath)).toBe('clean')
    expect(execFileSync('git', ['-C', bPath, 'ls-files', SETTINGS], { encoding: 'utf8' }).trim()).toBe('')
  })

  await test.step('B (Can use) reads up to date', async () => {
    await expect(badge(b, 'Up to date with the team')).toBeVisible({ timeout: 20_000 })
    await expect(b.page.getByRole('button', { name: 'Share changes…', exact: true })).toHaveCount(0)
  })

  await test.step('C’s Get has the template’s file, not A’s or B’s', async () => {
    const c = await team.open('c')
    await getFromLibrary(c, name)
    const cPath = (await findAgent(c, name)).path
    expect(readFileSync(join(cPath, SETTINGS), 'utf8')).toBe(TEMPLATE_SETTINGS)
    expect(readFileSync(join(cPath, 'knowledge/acme.md'), 'utf8')).toContain('A change shared from the app.')
  })

  await test.step('B promoted to Can edit: still up to date, nothing of B’s to share', async () => {
    await setCatalogAccess(fixture, built.slug, fixture.people.b.id, 'edit')
    await b.relaunch()
    await refreshLibrary(b)
    await openAgent(b, name)
    await expect(badge(b, 'Up to date with the team')).toBeVisible({ timeout: 20_000 })
    await expect(b.page.getByRole('button', { name: 'Share changes…', exact: true })).toHaveCount(0)
    expect(readFileSync(join(bPath, SETTINGS), 'utf8')).toBe(mine)
  })
})
