import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'

/**
 * Scaffold real folders into a temp workshop, scan them, then edit them the way
 * the three parties that share these folders do — a rename, a hand-broken
 * manifest, a credential appearing in `.env` — and assert the index follows.
 *
 * Everything here is the production code path: the contract tree in
 * `resources/`, the scaffolder, the validator, the scanner and a real database
 * with the real migrations. The only stand-ins are Electron (`app`) and the
 * logger.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
/**
 * The contract version this build bundles, read rather than pinned: what these
 * tests assert is that the scaffolder records *the contract it built against*,
 * which is a property of the code, not of any particular version number.
 */
const BUNDLED_CONTRACT = readFileSync(
  join(repoRoot, 'resources/cinna-kit-contract/VERSION'),
  'utf8'
).trim()

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => repoRoot,
    getVersion: () => '0.0.0-test',
    on: () => undefined
  },
  shell: { showItemInFolder: () => undefined }
}))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))

const { agentRepo } = await import('../../db/agents')
const { agentRootRepo } = await import('../../db/agentRoots')
const { clearContractCache, getLayoutView } = await import('../../kit/contractStore')
const { manifestPath, readManifest, writeManifest } = await import('../../kit/manifestIo')
const { scaffoldService } = await import('./scaffoldService')
const { scannerService } = await import('./scannerService')

const USER = '__default__'

let workshop: string
let root: Awaited<ReturnType<typeof agentRootRepo.create>>

beforeEach(() => {
  holder.current = createTestDatabase()
  clearContractCache()
  scannerService.markAllRootsDirty()
  workshop = mkdtempSync(join(tmpdir(), 'cinna-workshop-'))
  scaffoldService.installRootTemplates(workshop)
  root = agentRootRepo.create(USER, { path: workshop, label: 'Agents', isDefault: true })
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
  clearContractCache()
  rmSync(workshop, { recursive: true, force: true })
})

function scaffold(slug: string, name = slug, description = `Does ${slug} things.`): string {
  return scaffoldService.scaffoldAgent({ rootPath: workshop, slug, name, description }).agentDir
}

/**
 * Turn a scaffolded folder into a pre-contract one: the integer
 * `schema_version` the old start-kit wrote, and neither of the keys 1.0.0
 * introduced. This is the exact shape `validator.checkIdentity` recognises as
 * legacy, and the shape a workshop built before the desktop existed has.
 */
function makeLegacy(agentDir: string): void {
  const manifest = readManifest(manifestPath(agentDir))
  delete manifest.id
  delete manifest.contract_version
  manifest.schema_version = 1
  writeManifest(manifestPath(agentDir), manifest)
}

describe('scaffolding', () => {
  it('lays out a folder the contract recognises', () => {
    const dir = scaffold('invoice-reader', 'Invoice Reader', 'Reads invoices and files them.')

    const manifest = readManifest(manifestPath(dir))
    expect(manifest.slug).toBe('invoice-reader')
    expect(manifest.name).toBe('Invoice Reader')
    expect(manifest.description).toBe('Reads invoices and files them.')
    expect(manifest.contract_version).toBe(BUNDLED_CONTRACT)
    // A fresh UUID, written once, that identity survives a rename by.
    expect(manifest.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(manifest.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // Serialized the way every writer of these files writes them.
    const text = readFileSync(manifestPath(dir), 'utf8')
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "id": ')
  })

  it('restores every dotless ignore file the contract declares', () => {
    const dir = scaffold('alpha')
    // Driven by the contract, not by a list written here: a future third pair
    // added to `scaffold_ignore_files` must be restored too, and a test that
    // named the files by hand would keep passing while the scaffolder missed it.
    const pairs = getLayoutView(workshop).scaffoldIgnoreFiles('agent')
    expect(pairs.length).toBeGreaterThan(1)
    for (const [from, to] of pairs) {
      expect(existsSync(join(dir, ...to.split('/')))).toBe(true)
      expect(existsSync(join(dir, ...from.split('/')))).toBe(false)
    }
    // …and the one that ships dotted on purpose is not in the list, and keeps
    // its dot regardless.
    expect(pairs.some(([, to]) => to.endsWith('credentials/.gitignore'))).toBe(false)
    expect(readFileSync(join(dir, 'credentials/.gitignore'), 'utf8')).not.toBe('')
  })

  it('restores the root tree’s own ignore file, which is keyed separately', () => {
    for (const [from, to] of getLayoutView(workshop).scaffoldIgnoreFiles('root')) {
      expect(existsSync(join(workshop, ...to.split('/')))).toBe(true)
      expect(existsSync(join(workshop, ...from.split('/')))).toBe(false)
    }
  })

  it('substitutes the tokens in the documents, and only there', () => {
    const dir = scaffold('alpha', 'Alpha Agent', 'Watches the alpha feed.')
    const workflow = readFileSync(join(dir, 'docs/WORKFLOW_PROMPT.md'), 'utf8')
    expect(workflow).toContain('Alpha Agent')
    expect(workflow).not.toContain('{{NAME}}')
    // A script is copied byte-for-byte; nothing the user typed rewrites code.
    const script = readFileSync(join(dir, 'scripts/update_status.py'), 'utf8')
    expect(script).not.toContain('Alpha Agent')
  })

  it('refuses to write into a folder that already exists', () => {
    scaffold('alpha')
    expect(() => scaffold('alpha')).toThrow(/already/i)
  })

  it('rejects a slug the contract would not accept', () => {
    expect(() =>
      scaffoldService.scaffoldAgent({
        rootPath: workshop,
        slug: 'Not A Slug',
        name: 'x',
        description: 'y'
      })
    ).toThrow(/lower case/i)
  })

  it('leaves nothing behind in Local/ but the agent folder', () => {
    scaffold('alpha')
    expect(scannerService.listAgentDirs(workshop)).toEqual([join(workshop, 'Local', 'alpha')])
  })
})

describe('slugify', () => {
  it('derives a folder name from what the user typed', () => {
    expect(scaffoldService.slugify('Invoice Reader')).toBe('invoice-reader')
    expect(scaffoldService.slugify('  Café  Monitor ')).toBe('cafe-monitor')
    expect(scaffoldService.slugify('A/B — test!')).toBe('a-b-test')
  })

  it('returns empty when nothing usable survives', () => {
    expect(scaffoldService.slugify('!!!')).toBe('')
    expect(scaffoldService.slugify('a')).toBe('')
  })
})

describe('the scan cache', () => {
  it('does not re-walk the disk until something marks the root dirty', () => {
    const dir = scaffold('alpha', 'Alpha')
    expect(scannerService.scanRootCached(USER, root).agents[0].name).toBe('Alpha')

    // An edit the app never learned about: no watcher event, no mutation.
    const manifest = readManifest(manifestPath(dir))
    manifest.name = 'Alpha, renamed'
    writeManifest(manifestPath(dir), manifest)

    // Still the cached answer — this is the point: `list` is called on every
    // renderer refetch, and re-validating every agent each time blocked the
    // main thread.
    expect(scannerService.scanRootCached(USER, root).agents[0].name).toBe('Alpha')

    scannerService.markRootDirty(root.id)
    expect(scannerService.scanRootCached(USER, root).agents[0].name).toBe('Alpha, renamed')
  })

  it('never caches a root it could not read', () => {
    scaffold('alpha')
    scannerService.scanRootCached(USER, root)
    rmSync(join(workshop, 'Local'), { recursive: true, force: true })
    scannerService.markRootDirty(root.id)

    expect(scannerService.scanRootCached(USER, root).rootMissing).toBe(true)
    // An unavailable root must be retried, not remembered as empty — otherwise
    // remounting a volume would leave the list blank until a manual rescan.
    mkdirSync(join(workshop, 'Local'), { recursive: true })
    expect(scannerService.scanRootCached(USER, root).rootMissing).toBe(false)
  })

  it('ignores a cache entry taken at a different root path', () => {
    scaffold('alpha')
    scannerService.scanRootCached(USER, root)
    // The home moved; the cached scan describes the old location.
    const moved = { ...root, path: join(workshop, 'nowhere') }
    expect(scannerService.scanRootCached(USER, moved).rootMissing).toBe(true)
  })
})

describe('scanning a workshop', () => {
  it('indexes what it finds, keyed by the manifest id', () => {
    const dir = scaffold('alpha', 'Alpha')
    const manifestId = readManifest(manifestPath(dir)).id

    const result = scannerService.scanRoot(USER, root)

    expect(result.rootMissing).toBe(false)
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0].id).toBe(`folder:${manifestId}`)
    expect(result.agents[0].name).toBe('Alpha')
    expect(result.agents[0].readiness).toBe('ok')
    expect(result.agents[0].path).toBe(dir)

    const rows = agentRepo.listFolder(USER)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(`folder:${manifestId}`)
    expect(rows[0].source).toBe('folder')
    expect(rows[0].localRootId).toBe(root.id)
  })

  it('follows a manifest edited on disk', () => {
    const dir = scaffold('alpha', 'Alpha')
    scannerService.scanRoot(USER, root)

    // What an assistant working in the folder does.
    const manifest = readManifest(manifestPath(dir))
    manifest.name = 'Alpha, renamed'
    manifest.example_prompts = ['Summarise today', 'What changed?']
    writeManifest(manifestPath(dir), manifest)

    const result = scannerService.scanRoot(USER, root)
    expect(result.agents[0].name).toBe('Alpha, renamed')
    expect(result.agents[0].manifest.example_prompts).toEqual([
      'Summarise today',
      'What changed?'
    ])
    expect(agentRepo.listFolder(USER)[0].name).toBe('Alpha, renamed')
    // Same row: the id came from the manifest, not the name.
    expect(agentRepo.listFolder(USER)).toHaveLength(1)
  })

  it('prunes an agent whose folder was deleted', () => {
    scaffold('alpha')
    scaffold('beta')
    expect(scannerService.scanRoot(USER, root).agents).toHaveLength(2)

    rmSync(join(workshop, 'Local', 'beta'), { recursive: true, force: true })

    const result = scannerService.scanRoot(USER, root)
    expect(result.pruned).toBe(1)
    expect(agentRepo.listFolder(USER)).toHaveLength(1)
  })

  it('reports a corrupt manifest as invalid instead of crashing', () => {
    const dir = scaffold('alpha')
    writeFileSync(manifestPath(dir), '{ "name": "half a fi')

    const result = scannerService.scanRoot(USER, root)

    expect(result.agents).toHaveLength(1)
    expect(result.agents[0].readiness).toBe('invalid')
    expect(result.agents[0].validation.errors[0].code).toContain('manifest')
    expect(result.agents[0].name).toBe('alpha')
  })

  /**
   * The destructive case. A manifest is unparseable for the moment an assistant
   * saves it — the designed workflow — and for the duration of a `git checkout`
   * or an unresolved merge conflict. A rescan in that window must change
   * readiness and nothing else.
   *
   * Asserting the DTO is not enough: the row is what `a2a_sessions` and
   * `job_agents` cascade from, so this asserts the row id, the prune count, and
   * that the session survived.
   */
  it('keeps the row and its session when a manifest goes unparseable', () => {
    const dir = scaffold('alpha')
    const before = scannerService.scanRoot(USER, root)
    const agentId = before.agents[0].id
    expect(agentId).toMatch(/^folder:[0-9a-f]{8}-/)

    // A live chat with this agent, holding the engine session id (seam 9).
    holder.current!.raw
      .prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?,?,?,?)')
      .run('c1', 'chat', Date.now(), Date.now())
    holder.current!.raw
      .prepare(
        `INSERT INTO a2a_sessions (id, chat_id, agent_id, context_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`
      )
      .run('s1', 'c1', agentId, 'engine-session-1', Date.now(), Date.now())

    writeFileSync(manifestPath(dir), '{ "name": "half a fi')
    const during = scannerService.scanRoot(USER, root)

    expect(during.pruned).toBe(0)
    expect(during.indexed).toBe(0)
    // The list still shows the agent, under the same id, now invalid.
    expect(during.agents.map((a) => a.id)).toEqual([agentId])
    expect(during.agents[0].readiness).toBe('invalid')

    // The row and its session are untouched — identity did not change.
    expect(agentRepo.listFolder(USER).map((r) => r.id)).toEqual([agentId])
    expect(
      holder.current!.raw.prepare('SELECT context_id FROM a2a_sessions').all()
    ).toEqual([{ context_id: 'engine-session-1' }])
  })

  it('recovers cleanly once the manifest parses again', () => {
    const dir = scaffold('alpha')
    const agentId = scannerService.scanRoot(USER, root).agents[0].id
    const good = readFileSync(manifestPath(dir), 'utf8')

    writeFileSync(manifestPath(dir), 'not json at all')
    scannerService.scanRoot(USER, root)
    writeFileSync(manifestPath(dir), good)

    const after = scannerService.scanRoot(USER, root)
    expect(after.pruned).toBe(0)
    expect(after.agents[0].id).toBe(agentId)
    expect(after.agents[0].readiness).toBe('ok')
    expect(agentRepo.listFolder(USER).map((r) => r.id)).toEqual([agentId])
  })

  it('never indexes a synthetic identity for a folder it has never seen', () => {
    // A broken folder with no row yet must not get a substitute row that a
    // later, valid scan would then have to prune.
    mkdirSync(join(workshop, 'Local', 'broken'), { recursive: true })
    writeFileSync(join(workshop, 'Local', 'broken', 'cinna-agent.json'), '{{{')

    const result = scannerService.scanRoot(USER, root)
    expect(result.indexed).toBe(0)
    expect(result.pruned).toBe(0)
    expect(agentRepo.listFolder(USER)).toEqual([])
    // It is still listed, so the user can see what is wrong with it.
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0].readiness).toBe('invalid')
  })

  it('still prunes a folder that is genuinely gone while another is unreadable', () => {
    const alpha = scaffold('alpha')
    scaffold('beta')
    const ids = scannerService.scanRoot(USER, root).agents.map((a) => a.id)
    expect(ids).toHaveLength(2)

    // One folder breaks, the other is deleted, in the same pass.
    writeFileSync(manifestPath(alpha), '{ broken')
    rmSync(join(workshop, 'Local', 'beta'), { recursive: true, force: true })

    const result = scannerService.scanRoot(USER, root)
    expect(result.pruned).toBe(1)
    // The unreadable one survives; only the deleted one went.
    expect(agentRepo.listFolder(USER).map((r) => r.id)).toEqual([ids[0]])
  })

  it('re-keys a folder whose manifest id was deliberately changed', () => {
    const dir = scaffold('alpha')
    const oldId = scannerService.scanRoot(USER, root).agents[0].id

    const manifest = readManifest(manifestPath(dir))
    manifest.id = '11111111-2222-4333-8444-555555555555'
    writeManifest(manifestPath(dir), manifest)

    const result = scannerService.scanRoot(USER, root)
    // A readable manifest that states a new identity *is* a new identity — the
    // protection above must not turn into "rows are never pruned".
    expect(result.pruned).toBe(1)
    expect(agentRepo.listFolder(USER).map((r) => r.id)).toEqual([
      'folder:11111111-2222-4333-8444-555555555555'
    ])
    expect(oldId).not.toBe(result.agents[0].id)

    // Same rule in both directions across the legacy boundary. Losing the `id`
    // drops the folder onto its positional identity...
    makeLegacy(dir)
    const legacy = scannerService.scanRoot(USER, root)
    expect(legacy.pruned).toBe(1)
    expect(legacy.agents[0].identity).toBe('legacy')
    expect(agentRepo.listFolder(USER).map((r) => r.id)).toEqual([
      `folder:legacy:${root.id}:alpha`
    ])

    // ...and an `id` appearing later re-keys it back, exactly as a changed id
    // does. This is the transition "Stamp identity" performs.
    const stamped = readManifest(manifestPath(dir))
    stamped.id = '99999999-8888-4777-8666-555555555555'
    writeManifest(manifestPath(dir), stamped)

    const after = scannerService.scanRoot(USER, root)
    expect(after.pruned).toBe(1)
    expect(after.agents[0].identity).toBe('manifest')
    expect(agentRepo.listFolder(USER).map((r) => r.id)).toEqual([
      'folder:99999999-8888-4777-8666-555555555555'
    ])
  })

  /**
   * A workshop built by hand before the desktop existed — `schema_version`, no
   * `contract_version`, no `id`. The kit contract tolerates this deliberately
   * (1.0.0 "Breaking": such a manifest is *read*, not rejected), and "an
   * existing workshop is adopted as-is" is an explicit goal of the feature, so
   * the folder has to be a usable agent rather than a row that never exists.
   */
  it('indexes a legacy folder, so a hand-built workshop can be opened', () => {
    const dir = scaffold('alpha')
    makeLegacy(dir)

    const result = scannerService.scanRoot(USER, root)

    expect(result.indexed).toBe(1)
    expect(result.agents[0].identity).toBe('legacy')
    expect(result.agents[0].manifestId).toBe('')
    expect(result.agents[0].id).toBe(`folder:legacy:${root.id}:alpha`)
    // Valid, not broken: the validator warns about the missing identity and
    // reports no error, so the agent is runnable as it stands.
    expect(result.agents[0].readiness).toBe('ok')
    expect(result.agents[0].validation.warnings.some((w) => w.code === 'manifest.legacy')).toBe(
      true
    )
    // And it is in the index, which is what `locate()` — and so the page, the
    // editors and every write — resolves through.
    const row = agentRepo.listFolder(USER)[0]
    expect(row.id).toBe(`folder:legacy:${root.id}:alpha`)
    expect(row.localPath).toBe(dir)
  })

  it('keys a legacy folder by its root, so same-named folders in two roots do not collide', () => {
    const second = mkdtempSync(join(tmpdir(), 'cinna-workshop-b-'))
    try {
      scaffoldService.installRootTemplates(second)
      const otherRoot = agentRootRepo.create(USER, { path: second, label: 'Other' })
      makeLegacy(scaffold('assistant'))
      makeLegacy(
        scaffoldService.scaffoldAgent({
          rootPath: second,
          slug: 'assistant',
          name: 'assistant',
          description: 'Does assistant things.'
        }).agentDir
      )

      scannerService.scanRoot(USER, root)
      scannerService.scanRoot(USER, otherRoot)

      // Two folders, two rows. A folder-name-only key would have handed the
      // second scan the first one's row and re-pointed it at the other root.
      expect(agentRepo.listFolder(USER).map((r) => r.id).sort()).toEqual(
        [`folder:legacy:${root.id}:assistant`, `folder:legacy:${otherRoot.id}:assistant`].sort()
      )
    } finally {
      rmSync(second, { recursive: true, force: true })
    }
  })

  it('holds a legacy folder back when its manifest stops parsing, like any other', () => {
    const dir = scaffold('alpha')
    makeLegacy(dir)
    const agentId = scannerService.scanRoot(USER, root).agents[0].id

    writeFileSync(manifestPath(dir), '{ "name": "half a fi')
    const during = scannerService.scanRoot(USER, root)

    // Unreadable is `unresolved`, never `legacy`: there is no manifest to say
    // it has no id. The row survives on the protected-path ground.
    expect(during.pruned).toBe(0)
    expect(during.agents[0].identity).toBe('unresolved')
    expect(agentRepo.listFolder(USER).map((r) => r.id)).toEqual([agentId])
  })

  it('reports a folder with no manifest at all as invalid', () => {
    mkdirSync(join(workshop, 'Local', 'not-an-agent'), { recursive: true })

    const result = scannerService.scanRoot(USER, root)

    expect(result.agents).toHaveLength(1)
    expect(result.agents[0].readiness).toBe('invalid')
    expect(result.agents[0].validation.errors[0].code).toBe('manifest.manifest_not_found')
  })

  it('reports a folder whose slug no longer matches its name as invalid', () => {
    const dir = scaffold('alpha')
    const manifest = readManifest(manifestPath(dir))
    manifest.slug = 'renamed-in-the-manifest-only'
    writeManifest(manifestPath(dir), manifest)

    const result = scannerService.scanRoot(USER, root)
    expect(result.agents[0].readiness).toBe('invalid')
    expect(result.agents[0].validation.errors.some((e) => e.code.includes('slug'))).toBe(true)
  })

  it('flags a missing credential, and clears it once .env supplies the key', () => {
    const dir = scaffold('alpha')
    const manifest = readManifest(manifestPath(dir))
    manifest.credentials = [
      { name: 'Acme API', type: 'api_token', env_prefix: 'ACME_', fields: ['token'] }
    ]
    writeManifest(manifestPath(dir), manifest)

    let agent = scannerService.scanRoot(USER, root).agents[0]
    expect(agent.readiness).toBe('credentials_needed')
    expect(agent.credentials[0].expectedKeys).toEqual(['ACME_TOKEN'])
    expect(agent.credentials[0].presentKeys).toEqual([])

    writeFileSync(join(dir, 'credentials/.env'), 'ACME_TOKEN=super-secret\n')

    agent = scannerService.scanRoot(USER, root).agents[0]
    expect(agent.readiness).toBe('ok')
    expect(agent.credentials[0].presentKeys).toEqual(['ACME_TOKEN'])
    // The value is never read, so it cannot leak into the DTO.
    expect(JSON.stringify(agent)).not.toContain('super-secret')
  })

  it('refuses to operate a folder built against a newer contract major', () => {
    const dir = scaffold('alpha')
    const manifest = readManifest(manifestPath(dir))
    manifest.contract_version = '9.0.0'
    writeManifest(manifestPath(dir), manifest)

    const agent = scannerService.scanRoot(USER, root).agents[0]
    expect(agent.readiness).toBe('contract_too_new')
    expect(agent.contractStatus).toBe('app_too_old')
  })

  it('reads the command catalog and localises each command', () => {
    const dir = scaffold('alpha')
    writeFileSync(
      join(dir, 'docs/CLI_COMMANDS.yaml'),
      [
        'commands:',
        '  - name: refresh',
        '    description: Refresh the status file',
        '    command: python scripts/update_status.py',
        ''
      ].join('\n')
    )

    // A scaffolded agent ships a pyproject.toml, so the contract's
    // local_command_runner rule turns the cloud-first command into a local one.
    let agent = scannerService.scanRoot(USER, root).agents[0]
    expect(agent.commands).toEqual([
      {
        name: 'refresh',
        description: 'Refresh the status file',
        command: 'python scripts/update_status.py',
        localCommand: 'uv run scripts/update_status.py'
      }
    ])

    // Without one, the rule's condition fails and the command runs as written.
    rmSync(join(dir, 'pyproject.toml'))
    agent = scannerService.scanRoot(USER, root).agents[0]
    expect(agent.commands[0].localCommand).toBe('python scripts/update_status.py')
  })

  it('is not runnable when a command entry cannot be read', () => {
    const dir = scaffold('alpha')
    writeFileSync(
      join(dir, 'docs/CLI_COMMANDS.yaml'),
      [
        'commands:',
        '  - name: refresh',
        '    description: Refresh the status file',
        // An unquoted `#` truncates the command — the exact construct the kit's
        // YAML reader reports rather than silently mis-parsing.
        '    command: python scripts/update_status.py --tag #1',
        ''
      ].join('\n')
    )

    const agent = scannerService.scanRoot(USER, root).agents[0]
    // The dropped command must not simply vanish into a shorter list.
    expect(agent.commands).toEqual([])
    expect(agent.readiness).toBe('invalid')
    expect(
      [...agent.validation.errors, ...agent.validation.warnings].some((f) =>
        f.code.includes('command')
      )
    ).toBe(true)
  })

  it('reads STATUS.md frontmatter into the list sub-line', () => {
    const dir = scaffold('alpha')
    writeFileSync(
      join(dir, 'app-data/storage/STATUS.md'),
      '---\nsummary: 4 invoices waiting\nstate: healthy\nupdated: 2026-09-02\n---\n\n# Detail\n'
    )

    const agent = scannerService.scanRoot(USER, root).agents[0]
    expect(agent.status?.summary).toBe('4 invoices waiting')
    expect(agent.status?.state).toBe('healthy')
    expect(agent.status?.updatedAt).toBe('2026-09-02')
    expect(agent.status?.body).toContain('# Detail')
  })

  it('reads the timestamp key the contract\u2019s own update_status.py writes', () => {
    const dir = scaffold('alpha')
    // Byte-for-byte the shape `render_status()` emits — the contract's
    // `scripts/update_status.py` writes `status:`/`summary:`/`timestamp:`, and
    // `timestamp` was the one key `readStatus` did not accept, so every
    // scaffolded agent's status arrived with no time on it.
    writeFileSync(
      join(dir, 'app-data/storage/STATUS.md'),
      '---\nstatus: attention\nsummary: "3 invoices without a PO number"\ntimestamp: 2026-09-02T10:15:00Z\n---\n\nOptional detail.\n'
    )

    const agent = scannerService.scanRoot(USER, root).agents[0]
    expect(agent.status?.updatedAt).toBe('2026-09-02T10:15:00Z')
    expect(agent.status?.state).toBe('attention')
    expect(agent.status?.summary).toBe('3 invoices without a PO number')
  })

  it('keeps the desktop-owned state out of the renderer’s reach', () => {
    const dir = scaffold('alpha')
    writeFileSync(
      join(dir, 'app-data/desktop.json'),
      JSON.stringify({
        localApiBaseUrl: 'http://127.0.0.1:4096',
        agentToken: 'tok_do_not_leak',
        sessions: { chat1: { sessionId: 's1', updatedAt: 1 } }
      })
    )

    const agent = scannerService.scanRoot(USER, root).agents[0]
    expect(agent.desktop).toEqual({
      localApiBaseUrl: 'http://127.0.0.1:4096',
      hasAgentToken: true,
      sessionCount: 1,
      lastStatusAt: null
    })
    expect(JSON.stringify(agent)).not.toContain('tok_do_not_leak')
  })

  it('marks the second folder claiming an id as invalid, and indexes only the first', () => {
    const alpha = scaffold('alpha')
    const beta = scaffold('beta')
    const shared = readManifest(manifestPath(alpha)).id
    const betaManifest = readManifest(manifestPath(beta))
    betaManifest.id = shared
    writeManifest(manifestPath(beta), betaManifest)

    const result = scannerService.scanRoot(USER, root)
    expect(result.agents).toHaveLength(2)
    expect(result.agents[1].readiness).toBe('invalid')
    expect(result.agents[1].validation.errors[0].code).toBe('manifest.id.duplicate')
    expect(agentRepo.listFolder(USER)).toHaveLength(1)

    // The finding being *produced* is not enough. The two entries have to be
    // **distinguishable**: the list keys rows by `id` and selects by `id`, so a
    // shared id gives React a duplicate key and sends a click on the loser to
    // the winner's page — where the user then edits a different agent's files
    // than the one they clicked, with no indication. Assert the set of ids.
    const ids = result.agents.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(result.agents[1].id).toBe(`folder:duplicate:${root.id}:beta`)
    // ...while still naming the identity they are fighting over, so the message
    // and the Publish path keep talking about the same thing.
    expect(result.agents[1].manifestId).toBe(shared)
    expect(result.agents[0].id).toBe(`folder:${shared}`)
    // The loser is not indexed, so `locate()` says `not_found` and the page
    // shows its "could not be read" state instead of opening someone else's.
    expect(agentRepo.listFolder(USER).map((r) => r.id)).toEqual([`folder:${shared}`])
  })

  it('leaves the index untouched when the root is unreadable', () => {
    scaffold('alpha')
    scannerService.scanRoot(USER, root)
    expect(agentRepo.listFolder(USER)).toHaveLength(1)

    // An unmounted volume, or a folder the user moved.
    rmSync(join(workshop, 'Local'), { recursive: true, force: true })

    const result = scannerService.scanRoot(USER, root)
    expect(result.rootMissing).toBe(true)
    expect(result.pruned).toBe(0)
    // Critically: the row survives, so its chats and sessions do too.
    expect(agentRepo.listFolder(USER)).toHaveLength(1)
  })

  it('ignores the scaffolder’s staging directory', () => {
    mkdirSync(join(workshop, 'Local', '.alpha.scaffold-1-2'), { recursive: true })
    expect(scannerService.scanRoot(USER, root).agents).toEqual([])
  })
})

/**
 * The manifest metadata the chat surfaces read, end to end from real bytes.
 *
 * `remoteMetadata` was built for backend-synced agents and a folder row always
 * carried null, which left two things dead: the composer's `#` prompt list, and
 * the "Example tasks: …" clause of the description the orchestrator LLM sees
 * for the agent-as-tool. Both read `example_prompts` off that column and
 * nothing else.
 *
 * These go through the real scaffolder, the real manifest writer and the real
 * scanner rather than a hand-built fixture, because a fixture written from a
 * format's documentation rather than its emitter is how a defect survives —
 * this project has one that lasted from Phase 3 that way.
 */
describe('the manifest metadata a folder row carries', () => {
  it('carries the folder’s example prompts onto the row', () => {
    const dir = scaffold('alpha', 'Alpha')
    const manifest = readManifest(manifestPath(dir))
    manifest.example_prompts = ['dad-joke: tell me one', 'Summarise today']
    writeManifest(manifestPath(dir), manifest)

    scannerService.scanRoot(USER, root)

    expect(agentRepo.listFolder(USER)[0].remoteMetadata?.example_prompts).toEqual([
      'dad-joke: tell me one',
      'Summarise today'
    ])
  })

  it('follows an edit to them, which is a rescan and therefore an update', () => {
    // The trap this design exists to defeat: a rescan never inserts again, so a
    // write on the insert branch alone would leave the row's copy frozen at
    // whatever the folder said the first time it was seen.
    const dir = scaffold('alpha', 'Alpha')
    const manifest = readManifest(manifestPath(dir))
    manifest.example_prompts = ['first']
    writeManifest(manifestPath(dir), manifest)
    scannerService.scanRoot(USER, root)

    manifest.example_prompts = ['second', 'third']
    writeManifest(manifestPath(dir), manifest)
    scannerService.markAllRootsDirty()
    scannerService.scanRoot(USER, root)

    expect(agentRepo.listFolder(USER)[0].remoteMetadata?.example_prompts).toEqual([
      'second',
      'third'
    ])
  })

  it('drops junk an editor put in `example_prompts` before it reaches the row', () => {
    // Written as real bytes because that is the only way to show the guard is
    // reachable in production: `parseManifest` proves the file is a JSON object
    // and nothing more, and the scanner indexes a folder whose manifest is
    // invalid as long as its *identity* resolved. The validator does flag this
    // — but it flags it as a finding, and a finding does not stop the row being
    // written. Whatever survives here is joined into an LLM-facing description.
    const dir = scaffold('alpha', 'Alpha')
    const manifest = readManifest(manifestPath(dir))
    ;(manifest as Record<string, unknown>).example_prompts = [1, null, {}, '  ', 'the real one']
    writeManifest(manifestPath(dir), manifest)

    scannerService.scanRoot(USER, root)

    expect(agentRepo.listFolder(USER)[0].remoteMetadata?.example_prompts).toEqual(['the real one'])
  })

  it('leaves an empty list, not a null column, for a folder that lists none', () => {
    // A scaffolded manifest has no `example_prompts`. The row still gets an
    // object, so `#` and the tool description read an empty list rather than
    // stepping through a null the way they did before.
    scaffold('alpha', 'Alpha')
    scannerService.scanRoot(USER, root)

    const meta = agentRepo.listFolder(USER)[0].remoteMetadata
    expect(meta?.example_prompts).toEqual([])
    // No `cinna_mcp`: `A2AAsMcpProvider` builds a better tool from its own
    // fallbacks than a descriptor synthesized from the manifest blurb would,
    // and the remote write path omits the key in the same situation.
    expect(meta?.cinna_mcp).toBeUndefined()
  })
})
