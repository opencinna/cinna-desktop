import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `statusRefresh` against the real bundled kit contract, a real temp folder,
 * a real STATUS.md and a real subprocess — the same choices `commandService`'s
 * own suite made, and for the same reason: the claims here are "does the file
 * on disk reach the snapshot" and "does the script actually run", neither of
 * which a mock can prove.
 *
 * Only `localAgentService.locate` is mocked, at the module boundary, so a
 * command can be aimed at a temp folder without a database.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => repoRoot,
    getVersion: () => '0.0.0-test',
    on: () => undefined
  }
}))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../shell/env', () => ({
  getShellEnv: async () => process.env,
  shellEnvForChild: (env: NodeJS.ProcessEnv) => env
}))

const locateImpl = vi.hoisted(() => ({
  current: null as
    | null
    | ((userId: string, agentId: string) => { root: { path: string }; agentDir: string })
}))
vi.mock('./localAgentService', () => ({
  localAgentService: {
    locate: (userId: string, agentId: string) => {
      if (!locateImpl.current) throw new Error('test bug: locateImpl not configured')
      return locateImpl.current(userId, agentId)
    }
  }
}))

// The real contract store, except when a test needs `getLayoutView` to fail
// the way a broken install would. Same shape `commandService.test.ts` uses.
const layoutShouldThrow = vi.hoisted(() => ({ current: false }))
vi.mock('../../kit/contractStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../kit/contractStore')>()
  return {
    ...actual,
    getLayoutView: (...args: Parameters<typeof actual.getLayoutView>) => {
      if (layoutShouldThrow.current) throw new Error('synthetic contract failure')
      return actual.getLayoutView(...args)
    }
  }
})

const {
  severityFromState,
  toStatusSnapshot,
  readFolderAgentSnapshot,
  runStatusRefresh
} = await import('./statusRefresh')
const { turnLock } = await import('./turnLock')
const { LocalAgentError } = await import('../../errors')
const { clearContractCache } = await import('../../kit/contractStore')

const USER = '__default__'
const AGENT_ID = 'folder:alpha'
const STATUS_REL = 'app-data/storage/STATUS.md'

let workshop: string
let agentDir: string

function writeStatus(text: string): void {
  writeFileSync(join(agentDir, STATUS_REL), text)
}

function writeCatalog(yaml: string): void {
  writeFileSync(join(agentDir, 'docs', 'CLI_COMMANDS.yaml'), yaml)
}

beforeEach(() => {
  workshop = mkdtempSync(join(tmpdir(), 'cinna-status-'))
  agentDir = join(workshop, 'Local', 'alpha')
  mkdirSync(join(agentDir, 'docs'), { recursive: true })
  mkdirSync(join(agentDir, 'app-data', 'storage'), { recursive: true })
  locateImpl.current = (_userId, agentId) => {
    if (agentId !== AGENT_ID) {
      throw new LocalAgentError('not_found', 'That agent is no longer in your agents folder.')
    }
    return { root: { path: workshop }, agentDir }
  }
  layoutShouldThrow.current = false
  turnLock.releaseAll()
})

afterEach(() => {
  turnLock.releaseAll()
  clearContractCache()
  rmSync(workshop, { recursive: true, force: true })
})

describe('severityFromState — the free-form word the agent wrote', () => {
  it('never calls an unrecognised word OK', () => {
    // The consequence first: a word nobody understood must not paint the menu
    // bar green. `unknown` is a question; `ok` is an answer nobody gave.
    for (const word of ['wibble', 'partially-degraded', 'ERR', '???', 'okish', '0']) {
      expect(severityFromState(word)).not.toBe('ok')
      expect(severityFromState(word)).toBe('unknown')
    }
  })

  it('maps the contract’s own four words', () => {
    // `update_status.py:40` — STATUSES = ("ok", "attention", "error", "unknown")
    expect(severityFromState('ok')).toBe('ok')
    expect(severityFromState('attention')).toBe('warning')
    expect(severityFromState('error')).toBe('error')
    expect(severityFromState('unknown')).toBe('unknown')
  })

  it('maps the synonyms a hand-written file uses, case- and space-insensitively', () => {
    expect(severityFromState('healthy')).toBe('ok')
    expect(severityFromState('  HEALTHY  ')).toBe('ok')
    expect(severityFromState('Blocked')).toBe('warning')
    expect(severityFromState('degraded')).toBe('warning')
    expect(severityFromState('FAILED')).toBe('error')
    expect(severityFromState('critical')).toBe('error')
  })

  it('distinguishes “claimed nothing” from “claimed something unreadable”', () => {
    // null sorts below `unknown` (sortByUrgency ranks a null severity at -1)
    // and is skipped by worstSeverity, so an agent that reported only a summary
    // does not colour the tray icon. An unreadable word does.
    expect(severityFromState(null)).toBeNull()
    expect(severityFromState(undefined)).toBeNull()
    expect(severityFromState('')).toBeNull()
    expect(severityFromState('   ')).toBeNull()
    expect(severityFromState('wibble')).toBe('unknown')
  })
})

describe('readFolderAgentSnapshot — STATUS.md into the shape the tray renders', () => {
  it('reads the file the contract’s own update_status.py writes', () => {
    writeStatus(
      '---\nstatus: attention\nsummary: "3 invoices without a PO number"\ntimestamp: 2026-09-02T10:15:00Z\n---\n\nOptional detail.\n'
    )
    const snap = readFolderAgentSnapshot(AGENT_ID, 'Alpha', workshop, agentDir)
    expect(snap?.severity).toBe('warning')
    expect(snap?.summary).toBe('3 invoices without a PO number')
    expect(snap?.reportedAt).toBe('2026-09-02T10:15:00Z')
    expect(snap?.reportedAtSource).toBe('frontmatter')
    expect(snap?.body).toContain('Optional detail.')
    expect(snap?.agentId).toBe(AGENT_ID)
    expect(snap?.name).toBe('Alpha')
  })

  it('never reports “env not running” for an agent that has no environment', () => {
    // `statusViews.tsx:127,266` prints "· env not running" and "Environment is
    // not running — showing last cached status" for `environmentId === null`.
    // A folder agent's status was just read from this machine's disk, so that
    // line would be a confident falsehood shown to the user.
    writeStatus('---\nstatus: ok\nsummary: fine\n---\n')
    const snap = readFolderAgentSnapshot(AGENT_ID, 'Alpha', workshop, agentDir)
    expect(snap?.environmentId).not.toBeNull()
  })

  it('falls back to the file mtime, and labels it as inferred', () => {
    writeStatus('---\nstatus: ok\nsummary: no timestamp here\n---\n')
    const when = new Date('2026-08-01T09:00:00.000Z')
    utimesSync(join(agentDir, STATUS_REL), when, when)
    const snap = readFolderAgentSnapshot(AGENT_ID, 'Alpha', workshop, agentDir)
    // The consequence: the card says *when*, and says the time was inferred.
    expect(snap?.reportedAt).toBe('2026-08-01T09:00:00.000Z')
    expect(snap?.reportedAtSource).toBe('file_mtime')
  })

  it('reports a body-only STATUS.md with no severity rather than a green one', () => {
    // No frontmatter at all: `readStatus` returns the whole file as the body.
    writeStatus('# Just some notes\n\nNothing structured here.\n')
    const snap = readFolderAgentSnapshot(AGENT_ID, 'Alpha', workshop, agentDir)
    expect(snap?.severity).toBeNull()
    expect(snap?.hasStructuredMetadata).toBe(false)
    expect(snap?.body).toContain('Just some notes')
  })

  it('omits an agent that has no STATUS.md at all', () => {
    expect(readFolderAgentSnapshot(AGENT_ID, 'Alpha', workshop, agentDir)).toBeNull()
  })

  it('omits an agent whose kit contract cannot be loaded, instead of throwing', () => {
    // `getLayoutView` throws `KitError` for a contract it cannot load, and this
    // runs in a loop over every folder agent on a 45s poll — one broken install
    // must not take the other agents' rows down with it, and must not surface
    // as a status-system failure.
    writeStatus('---\nstatus: ok\nsummary: fine\n---\n')
    layoutShouldThrow.current = true
    let snap: ReturnType<typeof readFolderAgentSnapshot> | undefined
    expect(() => {
      snap = readFolderAgentSnapshot(AGENT_ID, 'Alpha', workshop, agentDir)
    }).not.toThrow()
    expect(snap).toBeNull()
  })

  it('stamps fetchedAt from the read, not from the file', () => {
    writeStatus('---\nstatus: ok\nsummary: fine\ntimestamp: 2020-01-01T00:00:00Z\n---\n')
    const at = new Date('2026-09-03T12:00:00.000Z')
    const snap = readFolderAgentSnapshot(AGENT_ID, 'Alpha', workshop, agentDir, at)
    expect(snap?.fetchedAt).toBe('2026-09-03T12:00:00.000Z')
    expect(snap?.reportedAt).toBe('2020-01-01T00:00:00Z')
  })
})

describe('toStatusSnapshot — the fields with no local counterpart', () => {
  it('claims no severity history it never observed', () => {
    const snap = toStatusSnapshot(
      AGENT_ID,
      'Alpha',
      { summary: 's', state: 'ok', updatedAt: '2026-01-01', body: 'b' },
      join(agentDir, STATUS_REL)
    )
    expect(snap.prevSeverity).toBeNull()
    expect(snap.severityChangedAt).toBeNull()
  })

  it('leaves reportedAt null when there is neither a timestamp nor a file', () => {
    const snap = toStatusSnapshot(
      AGENT_ID,
      'Alpha',
      { summary: 's', state: 'ok', updatedAt: null, body: 'b' },
      join(agentDir, 'does-not-exist.md')
    )
    expect(snap.reportedAt).toBeNull()
    expect(snap.reportedAtSource).toBeNull()
  })
})

describe('runStatusRefresh — the manifest’s status_refresh_command', () => {
  it('runs a /run:<name> reference and reports it ran', async () => {
    writeCatalog(
      'commands:\n  - name: status\n    description: x\n    command: echo refreshed\n'
    )
    const outcome = await runStatusRefresh(USER, AGENT_ID, '/run:status')
    expect(outcome.error).toBeNull()
    expect(outcome.ran).toBe(true)
  })

  it('the command actually writes STATUS.md, and the next read sees it', async () => {
    // End to end, with a real subprocess: this is the whole point of the
    // feature — the agent's own script updates its status and the surface
    // reflects it.
    writeCatalog(
      `commands:\n  - name: status\n    description: x\n    command: printf -- '---\\nstatus: error\\nsummary: disk full\\n---\\n' > ${STATUS_REL}\n`
    )
    writeStatus('---\nstatus: ok\nsummary: stale\n---\n')
    expect(readFolderAgentSnapshot(AGENT_ID, 'Alpha', workshop, agentDir)?.severity).toBe('ok')

    const outcome = await runStatusRefresh(USER, AGENT_ID, '/run:status')
    expect(outcome.ran).toBe(true)
    const snap = readFolderAgentSnapshot(AGENT_ID, 'Alpha', workshop, agentDir)
    expect(snap?.severity).toBe('error')
    expect(snap?.summary).toBe('disk full')
  })

  it('refuses a raw shell command instead of spawning it', async () => {
    // The manifest may legally carry a raw string (schema: "Shell command, or a
    // /run:<name> reference"). This app runs only the referenced form.
    const marker = join(workshop, 'should-not-exist')
    const outcome = await runStatusRefresh(USER, AGENT_ID, `touch ${marker}`)
    // Consequence first: nothing was executed.
    const { existsSync } = await import('node:fs')
    expect(existsSync(marker)).toBe(false)
    expect(outcome.error).toContain('/run:<name>')
    expect(outcome.ran).toBe(false)
    expect(outcome.skipped).toBe(false)
  })

  it('surfaces a script that exits non-zero as an error, not as a silent no-op', async () => {
    writeCatalog(
      'commands:\n  - name: status\n    description: x\n    command: sh -c "echo broken >&2; exit 3"\n'
    )
    const outcome = await runStatusRefresh(USER, AGENT_ID, '/run:status')
    expect(outcome.error).not.toBeNull()
    expect(outcome.error).toContain('3')
    expect(outcome.skipped).toBe(false)
  })

  it('surfaces a name that is not in the catalog', async () => {
    writeCatalog('commands: []\n')
    const outcome = await runStatusRefresh(USER, AGENT_ID, '/run:nosuch')
    expect(outcome.error).toContain('nosuch')
    expect(outcome.ran).toBe(false)
  })

  it('surfaces an agent whose folder is gone', async () => {
    const outcome = await runStatusRefresh(USER, 'folder:vanished', '/run:status')
    expect(outcome.error).not.toBeNull()
    expect(outcome.skipped).toBe(false)
  })

  it('treats a busy agent as a soft no-op, never as a failure', async () => {
    writeCatalog(
      'commands:\n  - name: status\n    description: x\n    command: echo refreshed\n'
    )
    // A model turn holds the per-agent lock; `commandService.run` takes it as
    // owner 'command' and is refused. The user asked for a status, not for a
    // report that their agent is busy — this must read as "nothing to do".
    const handle = turnLock.acquire(AGENT_ID, 'turn')
    try {
      const outcome = await runStatusRefresh(USER, AGENT_ID, '/run:status')
      expect(outcome.error).toBeNull()
      expect(outcome.skipped).toBe(true)
      expect(outcome.ran).toBe(false)
    } finally {
      handle.release()
    }
  })

  it('treats a cancel as a cancel, never as a failure', async () => {
    writeCatalog(
      'commands:\n  - name: status\n    description: x\n    command: echo refreshed\n'
    )
    const controller = new AbortController()
    controller.abort()
    const outcome = await runStatusRefresh(USER, AGENT_ID, '/run:status', controller.signal)
    expect(outcome.error).toBeNull()
    expect(outcome.skipped).toBe(true)
  })

  it('skips silently when no refresh command is configured', async () => {
    for (const value of [null, undefined, '', '   ', 42]) {
      const outcome = await runStatusRefresh(USER, AGENT_ID, value)
      expect(outcome.skipped).toBe(true)
      expect(outcome.error).toBeNull()
    }
  })
})
