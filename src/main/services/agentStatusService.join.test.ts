import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * **One test, for one seam.**
 *
 * `agentStatusService.test.ts` mocks `./localAgents/statusRefresh`, and
 * `statusRefresh.test.ts` proves what a real STATUS.md turns into. Between them
 * the whole chain is covered — but in two halves that meet at an asserted call,
 * and a convention mismatch is exactly the kind of defect that hides in a join
 * like that. This is not a hypothesis: `readStatus` did not accept `timestamp`,
 * the only key the contract's own `scripts/update_status.py` ever writes, and
 * the test that should have caught it passed because it used the `updated`
 * synonym instead of the bytes the script emits.
 *
 * So this file writes the bytes `render_status()` emits into a real temp agent
 * folder, runs the **unmocked** path — real `readStatus`, real `parseFrontmatter`,
 * real bundled kit contract — and asserts they arrive in a `list()` result.
 * Nothing else. Coverage is the other two files' job; the join is this one's.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  app: {
    isPackaged: false,
    getAppPath: () => repoRoot,
    getVersion: () => '0.0.0-test',
    on: () => undefined
  }
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
// A local-only account: `getCinnaContext` answers null, so the remote leg is
// never entered and the folder leg is the whole answer.
vi.mock('../db/users', () => ({
  userRepo: { get: () => ({ id: 'u1', type: 'local_user', cinnaServerUrl: null }) }
}))

const rows = vi.hoisted(() => ({ current: [] as Array<{ id: string; name: string }> }))
vi.mock('../db/agents', () => ({
  agentRepo: {
    listFolder: () => rows.current,
    getOwned: () => null,
    listRemote: () => []
  }
}))

const dirs = vi.hoisted(() => ({ root: '', agent: '' }))
vi.mock('./localAgents/localAgentService', () => ({
  localAgentService: {
    locate: () => ({ root: { path: dirs.root }, agentDir: dirs.agent })
  }
}))

const { agentStatusService } = await import('./agentStatusService')
const { clearContractCache } = await import('../kit/contractStore')

beforeEach(() => {
  dirs.root = mkdtempSync(join(tmpdir(), 'cinna-join-'))
  dirs.agent = join(dirs.root, 'Local', 'alpha')
  mkdirSync(join(dirs.agent, 'app-data', 'storage'), { recursive: true })
  rows.current = [{ id: 'folder:alpha', name: 'Alpha' }]
})

afterEach(() => {
  clearContractCache()
  rmSync(dirs.root, { recursive: true, force: true })
})

describe('a real STATUS.md all the way to a list() result', () => {
  it('carries the summary, the severity and the timestamp the contract’s script writes', async () => {
    // Byte-for-byte what `render_status()` emits:
    // `resources/cinna-kit-contract/templates/agent/scripts/update_status.py:54-63`.
    writeFileSync(
      join(dirs.agent, 'app-data/storage/STATUS.md'),
      [
        '---',
        'status: attention',
        'summary: "3 invoices without a PO number"',
        'timestamp: 2026-09-02T10:15:00Z',
        '---',
        '',
        'Optional detail, in markdown.',
        ''
      ].join('\n')
    )

    const result = await agentStatusService.list('u1')

    expect(result.items).toHaveLength(1)
    const [snapshot] = result.items
    expect(snapshot.summary).toBe('3 invoices without a PO number')
    // `attention` is the contract's word for it; `warning` is the app's.
    expect(snapshot.severity).toBe('warning')
    // The key that was silently dropped for the whole of Phases 1–7a.
    expect(snapshot.reportedAt).toBe('2026-09-02T10:15:00Z')
    expect(snapshot.reportedAtSource).toBe('frontmatter')
    expect(snapshot.name).toBe('Alpha')
    expect(snapshot.body).toContain('Optional detail')
  })
})
