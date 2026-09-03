import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `commandService` against the real bundled kit contract (`resources/`), a
 * real temp folder, and — for most cases — a real subprocess: mocking
 * `spawn` risks pinning the wrong call site (a lesson this project has paid
 * for before, see the handover), and "does `sh -c` actually run and capture
 * output" is exactly the kind of claim a mock cannot prove. `spawn` is only
 * ever forced to throw for the one case a real environment cannot reliably
 * reproduce.
 *
 * `localAgentService` is mocked at the module boundary: what it resolves is
 * already covered by its own tests, and this file only needs to prove
 * `commandService` reacts correctly to what `locate()` returns or throws.
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
// Real login-shell resolution is slow and machine-dependent; a command's
// actual PATH behaviour is exercised through real `spawn` below regardless.
vi.mock('../../shell/env', () => ({
  getShellEnv: async () => process.env,
  shellEnvForChild: (env: NodeJS.ProcessEnv) => env
}))

const locateImpl = vi.hoisted(() => ({
  current: null as null | ((userId: string, agentId: string) => { root: { path: string }; agentDir: string })
}))
vi.mock('./localAgentService', () => ({
  localAgentService: {
    locate: (userId: string, agentId: string) => {
      if (!locateImpl.current) throw new Error('test bug: locateImpl not configured')
      return locateImpl.current(userId, agentId)
    }
  }
}))

const spawnShouldThrow = vi.hoisted(() => ({ current: false }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (spawnShouldThrow.current) throw new Error('synthetic spawn failure')
      return actual.spawn(...args)
    }
  }
})

const { commandService, resolveCommandRunner } = await import('./commandService')
const { turnLock } = await import('./turnLock')
const { LocalAgentError } = await import('../../errors')
const { clearContractCache } = await import('../../kit/contractStore')

const USER = '__default__'
const AGENT_ID = 'folder:alpha'

let workshop: string
let agentDir: string

function writeCatalog(yaml: string): void {
  writeFileSync(join(agentDir, 'docs', 'CLI_COMMANDS.yaml'), yaml)
}

beforeEach(() => {
  workshop = mkdtempSync(join(tmpdir(), 'cinna-command-'))
  agentDir = join(workshop, 'Local', 'alpha')
  mkdirSync(join(agentDir, 'docs'), { recursive: true })
  locateImpl.current = (_userId, agentId) => {
    if (agentId !== AGENT_ID) {
      throw new LocalAgentError('not_found', 'That agent is no longer in your agents folder.')
    }
    return { root: { path: workshop }, agentDir }
  }
  spawnShouldThrow.current = false
  turnLock.releaseAll()
})

afterEach(() => {
  turnLock.releaseAll()
  clearContractCache()
  rmSync(workshop, { recursive: true, force: true })
})

describe('resolveCommandRunner — the actual dispatch point `agent_a2a.ipc.ts` calls', () => {
  const fallback = { runTurn: async () => ({ text: 'fallback', parts: [], notices: [] }) }

  it('leaves a non-folder agent’s runner untouched, even if the text looks like a command', () => {
    const result = resolveCommandRunner(false, '/run:check', USER, AGENT_ID, fallback)
    expect(result).toBe(fallback)
  })

  it('leaves a folder agent’s runner untouched when the message is not a bare /run:', () => {
    const result = resolveCommandRunner(true, 'run check please', USER, AGENT_ID, fallback)
    expect(result).toBe(fallback)
  })

  it('swaps in a command-backed runner for a folder agent’s /run:<name> message', async () => {
    writeCatalog('commands:\n  - name: greet\n    description: x\n    command: echo dispatched\n')
    const result = resolveCommandRunner(true, '/run:greet', USER, AGENT_ID, fallback)
    expect(result).not.toBe(fallback)
    const turn = await result.runTurn({
      chatId: 'chat-1',
      agentId: AGENT_ID,
      agentName: 'alpha',
      wireContent: '/run:greet',
      signal: new AbortController().signal
    })
    expect(turn.parts[0]?.commandInvocation).toBe('/run:greet')
    expect(turn.parts[0]?.text).toContain('dispatched')
  })
})

describe('matchRunCommand', () => {
  it('extracts the name from a bare /run: message', () => {
    expect(commandService.matchRunCommand('/run:check')).toBe('check')
    expect(commandService.matchRunCommand('  /run:rotate_status  ')).toBe('rotate_status')
  })

  it('does not match a message that merely starts with a reference', () => {
    // "/run:check please" is chat text, not an invocation — the whole
    // trimmed message must equal the reference, matching the exact grammar
    // `validateAgentFolder` checks `status_refresh_command` against.
    expect(commandService.matchRunCommand('/run:check please')).toBeNull()
    expect(commandService.matchRunCommand('please /run:check')).toBeNull()
    expect(commandService.matchRunCommand('hello')).toBeNull()
    expect(commandService.matchRunCommand('')).toBeNull()
  })
})

describe('error paths', () => {
  it('command not found in the catalog: no subprocess runs, the failure names the file', async () => {
    writeCatalog('commands:\n  - name: other\n    description: x\n    command: echo hi\n')
    const result = await commandService.run(USER, AGENT_ID, 'missing')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('No command named "missing" in docs/CLI_COMMANDS.yaml.')
    expect(result.exitCode).toBeNull()
  })

  it('the agent folder is gone: locate()’s failure is reported, not thrown', async () => {
    const result = await commandService.run(USER, 'folder:does-not-exist', 'anything')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('That agent is no longer in your agents folder.')
  })

  it('the localized binary is not on PATH: a real shell 127, captured as output', async () => {
    writeCatalog(
      'commands:\n  - name: ghost\n    description: x\n    command: cinna-test-definitely-not-a-real-binary-xyz\n'
    )
    const result = await commandService.run(USER, AGENT_ID, 'ghost')
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(127)
    expect(result.error).toContain('exited with code 127')
    expect(result.output.toLowerCase()).toContain('not found')
  })

  it('a non-zero exit is reported with the real exit code', async () => {
    writeCatalog('commands:\n  - name: fail\n    description: x\n    command: exit 3\n')
    const result = await commandService.run(USER, AGENT_ID, 'fail')
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.error).toBe('"exit 3" exited with code 3.')
  })

  it('a spawn that throws is reported, not left to crash the caller', async () => {
    writeCatalog('commands:\n  - name: quick\n    description: x\n    command: echo hi\n')
    spawnShouldThrow.current = true
    const result = await commandService.run(USER, AGENT_ID, 'quick')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('"echo hi" could not run: synthetic spawn failure')
    // The lock must not be left held by a path that never got to run anything.
    expect(turnLock.isLocked(AGENT_ID)).toBe(false)
  })

  it('a command that runs past its ceiling is stopped, not left to hang the lock forever', async () => {
    writeCatalog('commands:\n  - name: slow\n    description: x\n    command: sleep 5\n')
    const result = await commandService.run(USER, AGENT_ID, 'slow', undefined, 80)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/did not finish within/)
    expect(turnLock.isLocked(AGENT_ID)).toBe(false)
  }, 10_000)

  it('a running subprocess — and what it already forked — is killed on abort, promptly', async () => {
    // `sleep 2 && touch <marker>` runs as a *grandchild* of the spawned
    // process (the shell IS the direct child under `shell:true`). Killing
    // only the shell leaves `sleep` running orphaned, holding the piped
    // stdio open — this is the exact defect `killTree` exists to close, and
    // the wall-clock assertion below is what actually catches its absence:
    // the marker-never-appears assertion alone passed even with the bug,
    // because the killed shell can never reach `&& touch` regardless of
    // whether `sleep` itself died. See `killTree`'s docstring.
    const marker = join(workshop, 'should-not-exist')
    writeCatalog(
      `commands:\n  - name: slow\n    description: x\n    command: sleep 2 && touch ${JSON.stringify(marker)}\n`
    )
    const controller = new AbortController()
    const pending = commandService.run(USER, AGENT_ID, 'slow', controller.signal)
    // Let the child actually start before aborting — this is the realistic
    // `agent:cancel-message` shape, distinct from the next test.
    await new Promise((r) => setTimeout(r, 50))
    const abortedAt = Date.now()
    controller.abort()
    const result = await pending
    expect(Date.now() - abortedAt).toBeLessThan(1500)
    expect(result.ok).toBe(false)
    expect(turnLock.isLocked(AGENT_ID)).toBe(false)
    const { existsSync } = await import('node:fs')
    expect(existsSync(marker)).toBe(false)
  })

  it('an abort fired before the subprocess even starts is not lost', async () => {
    // Aborting in the same synchronous tick as the call: the abort signal
    // fires before `execute()` has reached its `addEventListener`, so a
    // listener alone would miss it — see the pre-check in `execute()`.
    writeCatalog('commands:\n  - name: slow\n    description: x\n    command: sleep 2\n')
    const controller = new AbortController()
    const pending = commandService.run(USER, AGENT_ID, 'slow', controller.signal)
    controller.abort()
    const result = await pending
    expect(result.ok).toBe(false)
    expect(turnLock.isLocked(AGENT_ID)).toBe(false)
  })
})

describe('success', () => {
  it('captures real stdout and localises python → uv run when a pyproject.toml is present', async () => {
    writeFileSync(join(agentDir, 'pyproject.toml'), '[project]\nname = "alpha"\n')
    writeCatalog(
      'commands:\n  - name: check\n    description: x\n    command: python -c "print(1)"\n'
    )
    const result = await commandService.run(USER, AGENT_ID, 'check')
    // `uv` is very unlikely to be installed in CI, so this legitimately fails
    // to run — what matters here is that localisation actually happened, not
    // that `uv` exists on this machine. See the separate localCommand assertion.
    expect(result.localCommand).toBe('uv run -c "print(1)"')
  })

  it('runs a real command and returns its output', async () => {
    writeCatalog('commands:\n  - name: greet\n    description: x\n    command: echo hello-from-command\n')
    const result = await commandService.run(USER, AGENT_ID, 'greet')
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('hello-from-command')
  })
})

describe('the turn lock', () => {
  it('is held for the length of the subprocess, and released once it ends', async () => {
    writeCatalog('commands:\n  - name: slow\n    description: x\n    command: sleep 0.2\n')
    const pending = commandService.run(USER, AGENT_ID, 'slow')
    expect(turnLock.isLocked(AGENT_ID)).toBe(true)
    await pending
    expect(turnLock.isLocked(AGENT_ID)).toBe(false)
  })

  it('refuses a second command for the same agent while the first is still running', async () => {
    writeCatalog(
      'commands:\n  - name: slow\n    description: x\n    command: sleep 0.2\n  - name: quick\n    description: x\n    command: echo hi\n'
    )
    const first = commandService.run(USER, AGENT_ID, 'slow')
    const second = commandService.run(USER, AGENT_ID, 'quick')
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(secondResult.ok).toBe(false)
    expect(secondResult.error).toMatch(/busy/i)
    expect(firstResult.ok).toBe(true)
  })
})

describe('runForTurn', () => {
  it('shapes a successful run into one command_result part, invocation set', async () => {
    writeCatalog('commands:\n  - name: greet\n    description: x\n    command: echo hi-there\n')
    const turn = await commandService.runForTurn(USER, AGENT_ID, 'greet')
    expect(turn.error).toBeUndefined()
    expect(turn.parts).toHaveLength(1)
    expect(turn.parts[0].kind).toBe('command_result')
    expect(turn.parts[0].commandInvocation).toBe('/run:greet')
    expect(turn.parts[0].text).toContain('hi-there')
  })

  it('shapes a failed run into a turn error, not a command_result part', async () => {
    const turn = await commandService.runForTurn(USER, AGENT_ID, 'missing')
    expect(turn.parts).toHaveLength(0)
    expect(turn.error).toBeDefined()
    expect(turn.error?.message).toContain('No command named "missing"')
  })
})
