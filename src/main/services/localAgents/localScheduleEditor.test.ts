vi.mock('../../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'

/**
 * The write path: Invariant 3 in both halves.
 *
 * A save must be refused while a turn holds the agent, and refused when the
 * file changed since the editor read it. Both are tested against real files —
 * the stamp guard is only meaningful over a real mtime.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
/** `shell.trashItem`, replaced per test — the default fake is set in `delete`. */
const trash = vi.hoisted(() => vi.fn<(path: string) => Promise<void>>())
/** `shell.openPath` — '' is Electron's "it opened"; a message is a failure. */
const openPath = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>(async () => ''))
/** `shell.showItemInFolder` — the fallback the credentials click must not need. */
const reveal = vi.hoisted(() => vi.fn<(path: string) => void>())

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => repoRoot,
    getVersion: () => '0.0.0-test',
    on: () => undefined
  },
  shell: { showItemInFolder: reveal, trashItem: trash, openPath },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../index', () => ({ getMainWindow: () => null }))
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

vi.mock('../scriptRuntimeService', () => ({ scriptRuntimeService: {} }))
vi.mock('./commandService', () => ({ commandService: { resolve: (_u: string, _a: string, command: string) => ({ localCommand: command, revision: command }) } }))
const { localScheduleService } = await import('../localScheduleService')
const { localScheduleRepo } = await import('../../db/localSchedules')
const { agentRootRepo } = await import('../../db/agentRoots')
const { appSettingsRepo } = await import('../../db/appSettings')
const { clearContractCache } = await import('../../kit/contractStore')
const { scaffoldService } = await import('./scaffoldService')
const { scannerService } = await import('./scannerService')
const { localAgentService } = await import('./localAgentService')
const { turnLock } = await import('./turnLock')
const { jobsRepo } = await import('../../db/jobs')

const USER = '__default__'
const MANIFEST = 'cinna-agent.json'

let workshop: string
let agentDir: string
let agentId: string

beforeEach(() => {
  holder.current = createTestDatabase()
  clearContractCache()
  scannerService.markAllRootsDirty()
  turnLock.releaseAll()
  workshop = mkdtempSync(join(tmpdir(), 'cinna-write-'))
  // Point the agents home at the temp workshop *before* anything calls
  // `ensureHome`, which would otherwise resolve the real `~/Documents/CinnaAgents`
  // and create it. A test must never write outside its temp directory.
  appSettingsRepo.set('localAgentsHome', workshop)
  scaffoldService.installRootTemplates(workshop)
  const root = agentRootRepo.create(USER, { path: workshop, label: 'Agents', isDefault: true })
  agentDir = scaffoldService.scaffoldAgent({
    rootPath: workshop,
    slug: 'alpha',
    name: 'Alpha',
    description: 'Watches the alpha feed.'
  }).agentDir
  agentId = scannerService.scanRoot(USER, root).agents[0].id
})

afterEach(() => {
  turnLock.releaseAll()
  holder.current?.close()
  holder.current = null
  clearContractCache()
  rmSync(workshop, { recursive: true, force: true })
})

function currentAgent() {
  return localAgentService.get(USER, agentId)
}

const scope = { profileUserId: USER, settingsUserId: USER }
const NOW = Date.parse('2026-09-21T11:00:00Z')
function input() {
  return { profileUserId: USER, agentId, expectedStamp: currentAgent().stamps[MANIFEST]!, name: 'Morning', executionType: 'static_prompt' as const,
    prompt: 'Read the report.', cron: '0 8 * * 1-5', timezone: 'UTC', enabled: true,
    editorMetadata: { mode: 'template' as const, templateId: 'workday-morning', templateVersion: 1, weekdays: [5, 4, 3, 2, 1], hours: [8] } }
}
function editInput() {
  const item = localScheduleService.list(scope, agentId).find(row => row.name === 'Morning')!
  return { ...input(), originalName: item.name, revision: item.revision }
}

describe('schedule editor uses stamped manifest ownership', () => {
  it('creates reviewed future-only schedules and preserves unrelated manifest fields', () => {
    const path = join(agentDir, MANIFEST)
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.custom_extension = { keep: 7 }
    writeFileSync(path, JSON.stringify(manifest))
    const saved = localScheduleService.save(scope, input(), NOW)
    expect(saved.warning).toBeUndefined()
    expect(saved.items[0].binding).toMatchObject({ enabled: true, nextDueAt: Date.parse('2026-09-22T08:00:00Z') })
    expect(JSON.parse(readFileSync(path, 'utf8')).custom_extension).toEqual({ keep: 7 })
    expect(saved.items[0].editorMetadata?.weekdays).toEqual([1, 2, 3, 4, 5])
  })
  it('preserves the binding, historical jobs, receipts and unknown entry fields on rename', () => {
    localScheduleService.save(scope, input(), NOW)
    const prior = localScheduleRepo.list(USER)[0]
    const path = join(agentDir, MANIFEST)
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.schedules[0].extra = 'preserved'
    writeFileSync(path, JSON.stringify(manifest))
    localScheduleRepo.insertOccurrence({ id: 'history', userId: USER, bindingId: prior.id, civilKey: 'past', utcMinute: 1, definition: prior.definition, revision: prior.revision,
      status: 'completed', taskId: null, runId: null, chatId: null, reason: null, scheduledFor: 60000, observedAt: 60000, startedAt: 60000, finishedAt: 61000,
      coveredThrough: 60000, triggerKind: 'scheduled', resultKind: 'quiet_ok', commandOutcome: null })
    const saved = localScheduleService.save(scope, { ...editInput(), name: 'Renamed' }, NOW + 60000)
    expect(saved.warning).toBeUndefined()
    const next = localScheduleRepo.list(USER)[0]
    expect(next.id).toBe(prior.id)
    expect(next.name).toBe('Renamed')
    expect(next.jobIds).toContain(prior.jobId)
    expect(localScheduleRepo.occurrences(USER, next.id)).toHaveLength(1)
    expect(JSON.parse(readFileSync(path, 'utf8')).schedules[0].extra).toBe('preserved')
  })
  it('rejects stale content stamps, busy folders and foreign profiles without writing', () => {
    const stale = input()
    const path = join(agentDir, MANIFEST)
    const original = readFileSync(path, 'utf8')
    writeFileSync(path, original + '\n')
    expect(() => localScheduleService.save(scope, stale, NOW)).toThrow(/changed|modified/i)
    const handle = turnLock.acquire(agentId, 'command')
    try { expect(() => localScheduleService.save(scope, input(), NOW)).toThrow(/progress|busy/i) }
    finally { handle.release() }
    expect(() => localScheduleService.save(scope, { ...input(), profileUserId: 'other' }, NOW)).toThrow(/profile/)
    expect(localScheduleRepo.list(USER)).toEqual([])
  })
  it('rejects impossible timing, metadata mismatch, and execution type edits', () => {
    expect(() => localScheduleService.save(scope, { ...input(), cron: '0 0 30 2 *' }, NOW)).toThrow()
    expect(() => localScheduleService.save(scope, { ...input(), cron: '0 9 * * 1-5' }, NOW)).toThrow(/days and hours/)
    localScheduleService.save(scope, input(), NOW)
    expect(() => localScheduleService.save(scope, { ...editInput(), executionType: 'script_trigger', command: 'printf OK' }, NOW)).toThrow(/type/)
  })
  it('requires a resolved command review and can save disabled scripts without creating jobs', () => {
    const script = { ...input(), executionType: 'script_trigger' as const, command: 'printf OK', enabled: false }
    expect(() => localScheduleService.save(scope, script, NOW)).toThrow(/command changed/)
    const result = localScheduleService.save(scope, { ...script, commandRevision: 'printf OK' }, NOW)
    expect(result.items[0].binding).toMatchObject({ enabled: false, jobId: null, nextDueAt: null })
    expect(jobsRepo.list(USER)).toHaveLength(0)
  })
  it('reports a committed manifest with failed local enablement, leaving old consent stale', () => {
    localScheduleService.save(scope, input(), NOW)
    const save = vi.spyOn(localScheduleRepo, 'save').mockImplementation(() => { throw new Error('disk full') })
    try {
      const result = localScheduleService.save(scope, { ...editInput(), prompt: 'Changed prompt' }, NOW)
      expect(result.warning).toContain('Saved; enablement needs review')
      expect(result.items[0].binding?.enabled).toBe(false)
      expect(JSON.parse(readFileSync(join(agentDir, MANIFEST), 'utf8')).schedules[0].prompt).toBe('Changed prompt')
    } finally { save.mockRestore() }
  })
  it('never carries a Job for an older prompt through a disabled save into a later enable', () => {
    localScheduleService.save(scope, input(), NOW)
    const first = localScheduleRepo.list(USER)[0]
    localScheduleService.save(scope, { ...editInput(), prompt: 'Read the new report.', enabled: false }, NOW)
    const disabled = localScheduleRepo.list(USER)[0]
    expect(disabled).toMatchObject({ enabled: false, jobId: '', jobFingerprint: '' })
    expect(disabled.jobIds).toContain(first.jobId)
    const item = localScheduleService.list(scope, agentId)[0]
    localScheduleService.enable(scope, { profileUserId: USER, agentId, name: item.name, revision: item.revision!, timezone: item.timezone }, NOW)
    const enabled = localScheduleRepo.list(USER)[0]
    expect(enabled.jobId).not.toBe(first.jobId)
    expect(jobsRepo.getById(USER, enabled.jobId)?.prompt).toBe('Read the new report.')
    expect(enabled.jobIds).toEqual(expect.arrayContaining([first.jobId, enabled.jobId]))
  })
  it('lets a schedule with a manifest problem be fixed or deleted', () => {
    localScheduleService.save(scope, input(), NOW)
    const path = join(agentDir, MANIFEST)
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.schedules[0].cron_string = '0 8 * * MON'
    writeFileSync(path, JSON.stringify(manifest))
    const broken = localScheduleService.list(scope, agentId)[0]
    expect(broken).toMatchObject({ revision: null, problem: expect.any(String) })
    // The renderer sends `item.revision ?? undefined` for a problem row.
    const fixed = localScheduleService.save(scope, { ...input(), originalName: broken.name, revision: undefined }, NOW)
    expect(fixed.warning).toBeUndefined()
    expect(fixed.items[0]).toMatchObject({ problem: null, cron: '0 8 * * 1-5', binding: { enabled: true } })
    manifest.schedules[0].cron_string = '0 8 * * MON'
    writeFileSync(path, JSON.stringify(manifest))
    const again = localScheduleService.list(scope, agentId)[0]
    localScheduleService.delete(scope, { profileUserId: USER, agentId, expectedStamp: currentAgent().stamps[MANIFEST]!, name: again.name, revision: again.revision })
    expect(JSON.parse(readFileSync(path, 'utf8')).schedules).toEqual([])
  })
  it('never writes the portable enabled field and keeps an author-disabled entry disabled', () => {
    const path = join(agentDir, MANIFEST)
    localScheduleService.save(scope, input(), NOW)
    expect(JSON.parse(readFileSync(path, 'utf8')).schedules[0]).not.toHaveProperty('enabled')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.schedules[0].enabled = false
    writeFileSync(path, JSON.stringify(manifest))
    const result = localScheduleService.save(scope, { ...editInput(), prompt: 'Edited while disabled.' }, NOW)
    const entry = JSON.parse(readFileSync(path, 'utf8')).schedules[0]
    expect(entry).toMatchObject({ enabled: false, prompt: 'Edited while disabled.' })
    expect(result.warning).toMatch(/disabled in the manifest/)
    expect(result.items[0].binding?.enabled).toBe(false)
  })
  it('saves an author-disabled entry disabled without a warning, and still refuses to enable it', () => {
    const path = join(agentDir, MANIFEST)
    localScheduleService.save(scope, input(), NOW)
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.schedules[0].enabled = false
    writeFileSync(path, JSON.stringify(manifest))
    const result = localScheduleService.save(scope, { ...editInput(), enabled: false, prompt: 'Edited while disabled.',
      editorMetadata: { mode: 'custom' as const, weekdays: [1, 2, 3, 4, 5], hours: [8] } }, NOW)
    expect(result.warning).toBeUndefined()
    expect(JSON.parse(readFileSync(path, 'utf8')).schedules[0]).toMatchObject({ enabled: false, prompt: 'Edited while disabled.' })
    const binding = localScheduleRepo.list(USER)[0]
    expect(binding).toMatchObject({ enabled: false, nextDueAt: null, editorMetadata: { mode: 'custom', weekdays: [1, 2, 3, 4, 5], hours: [8] } })
    expect(binding.definition).toMatchObject({ prompt: 'Edited while disabled.' })
    const item = localScheduleService.list(scope, agentId)[0]
    expect(() => localScheduleService.enable(scope, { profileUserId: USER, agentId, name: item.name, revision: binding.revision, timezone: 'UTC' }, NOW))
      .toThrow(/disabled in the manifest/)
    expect(localScheduleRepo.list(USER)[0].enabled).toBe(false)
  })
  it('deletes the manifest entry and disables admission while retaining history', () => {
    const saved = localScheduleService.save(scope, input(), NOW)
    const item = saved.items[0]
    localScheduleService.delete(scope, { profileUserId: USER, agentId, expectedStamp: saved.stamp, name: item.name, revision: item.revision })
    expect(JSON.parse(readFileSync(join(agentDir, MANIFEST), 'utf8')).schedules).toEqual([])
    expect(localScheduleRepo.get(USER, item.binding!.id)?.enabled).toBe(false)
  })
})
