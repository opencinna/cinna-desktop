import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionActivityHub } from '../sessionActivityHub'
import { stopSessionActivity } from '../sessionActivityStop'
import { createUserCommandService, displayPath, relativeArgPath, type UserCommandAgent, type UserCommandWorkspace } from './userCommandService'
import { USER_COMMAND_RUN_REASONS, type UserCommandOutputFrame } from '../../../shared/userCommands'
import { OWN_COMMAND_REASONS, readableOwnScript } from '../localAgents/ownCommandPolicy'

// The real check, unless a test stands in for a file swapped after it.
vi.mock('../localAgents/ownCommandPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../localAgents/ownCommandPolicy')>()
  return { ...actual, readableOwnScript: vi.fn(actual.readableOwnScript) }
})

/**
 * The user command service against real processes (`/bin/sh`) in a real
 * temporary folder: process groups, exit codes and the guard's realpaths are
 * what it is about, and a fake would pass all of them.
 */

let base: string
let folder: string
let userData: string

function file(path: string, body = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'user-commands-')))
  folder = join(base, 'agent')
  file(join(folder, 'scripts', 'hello.sh'), 'echo "hello from $1"\n')
  file(join(folder, 'credentials', 'x'), 'secret')
  file(join(folder, 'notes', 'a.txt'), 'note')
  file(join(base, 'outside', 'evil.sh'), 'echo evil')
  symlinkSync(join(base, 'outside'), join(folder, 'linked'))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

interface World {
  hub: ReturnType<typeof createSessionActivityHub>
  service: ReturnType<typeof createUserCommandService>
  state: {
    workspace: UserCommandWorkspace | 'missing' | null; shell: string; trashed: boolean; onShellEnv: (() => void) | null; onUserData: (() => void) | null
    /** Agent ids the profile no longer sees (a folder agent pruned by a rescan). */
    gone: Set<string>
  }
}

const services: World['service'][] = []

function world(options: { logCapBytes?: number; stopGraceMs?: number } = {}): World {
  userData = mkdtempSync(join(base, 'userData-'))
  const hub = createSessionActivityHub()
  const state: World['state'] = { workspace: { folder, scriptRoots: [] }, shell: '/bin/sh', trashed: false, onShellEnv: null, onUserData: null, gone: new Set() }
  const service = createUserCommandService<UserCommandAgent>({
    chat: (_profile, chatId) => chatId === 'chat-1' || chatId === 'chat-2'
      ? { id: chatId, agentId: 'agent-root', deletedAt: state.trashed ? new Date() : null } : undefined,
    message: (id) => id === 'msg-1' ? { chatId: 'chat-1', role: 'assistant', sourceAgentId: 'agent-a' }
      : id === 'msg-2' ? { chatId: 'chat-2', role: 'assistant', sourceAgentId: null }
        : id === 'msg-folder' ? { chatId: 'chat-1', role: 'assistant', sourceAgentId: 'folder:moved' }
          : id === 'msg-remote' ? { chatId: 'chat-1', role: 'assistant', sourceAgentId: 'remote:gone' } : undefined,
    agent: (_profile, agentId) => state.gone.has(agentId) ? null : { userId: 'settings', id: agentId },
    workspace: async () => state.workspace,
    shellEnv: async () => {
      state.onShellEnv?.()
      return { PATH: process.env.PATH ?? '/usr/bin:/bin', SHELL: state.shell, HOME: base }
    },
    userData: () => {
      state.onUserData?.()
      return userData
    },
    hub,
    ...options
  })
  services.push(service)
  return { hub, service, state }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown(200)))
})

const run = (w: World, command: string, reviewed = false, chatId = 'chat-1', messageId = 'msg-1') =>
  w.service.run('profile', { chatId, messageId, command, reviewed })

async function ended(w: World, chatId: string, itemId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const item = w.hub.snapshot(chatId).items.find((candidate) => candidate.id === itemId)
    if (item && item.state !== 'running') return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`run ${itemId} did not end`)
}

function item(w: World, itemId: string, chatId = 'chat-1') {
  return w.hub.snapshot(chatId).items.find((candidate) => candidate.id === itemId)
}

describe('running a command', () => {
  it('runs a safe command in the agent\'s folder as a command item of the message\'s agent', async () => {
    const w = world()
    const result = await run(w, 'sh scripts/hello.sh you')
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    const started = item(w, result.itemId)!
    expect(started).toMatchObject({ kind: 'command', agentId: 'agent-a', title: 'sh scripts/hello.sh you', canStop: true, detail: folder })
    expect(started.outputPath).toBe(join(userData, 'command-runs', 'chat-1', `${result.itemId}.log`))
    await ended(w, 'chat-1', result.itemId)
    expect(item(w, result.itemId)!.state).toBe('completed')
    expect(readFileSync(started.outputPath!, 'utf8')).toBe('hello from you\n')
  })

  it.each([
    ['the default width when the window sent none', undefined, '120'],
    ['the window\'s width', 97, '97'],
    ['a width clamped up to 40', 3, '40'],
    ['a width clamped down to 400', 9000, '400']
  ])('gives the child unbuffered Python and %s as COLUMNS', async (_name, columns, expected) => {
    const w = world()
    const result = await w.service.run('profile', {
      chatId: 'chat-1', messageId: 'msg-1', command: 'echo "$PYTHONUNBUFFERED $COLUMNS"', reviewed: true,
      ...(columns === undefined ? {} : { columns })
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await ended(w, 'chat-1', result.itemId)
    expect(readFileSync(item(w, result.itemId)!.outputPath!, 'utf8')).toBe(`1 ${expected}\n`)
  })

  it('takes the chat\'s agent for a message with no source agent', async () => {
    const w = world()
    const result = await run(w, 'ls', false, 'chat-2', 'msg-2')
    expect(result.ok && item(w, result.itemId, 'chat-2')?.agentId).toBe('agent-root')
  })

  it.each([
    ['a command outside the rule', 'rm -rf build'],
    ['a missing script', 'sh scripts/missing.sh'],
    ['a script through a symlink out of the folder', 'sh linked/evil.sh'],
    ['a protected file', 'cat credentials/x']
  ])('answers needs_review for %s, and runs it once reviewed', async (_name, command) => {
    const w = world()
    const refused = await run(w, command)
    expect(refused).toEqual({ ok: false, code: 'needs_review', reason: expect.any(String), folder })
    // The rule's own reason, not the generic line.
    expect(!refused.ok && refused.reason).not.toBe(USER_COMMAND_RUN_REASONS.needs_review)
    expect(w.hub.snapshot('chat-1').items).toEqual([])
    const reviewed = await run(w, command, true)
    expect(reviewed.ok).toBe(true)
  })

  it('says which script it could not find', async () => {
    const w = world()
    expect(await run(w, 'sh scripts/missing.sh')).toMatchObject({ code: 'needs_review', reason: OWN_COMMAND_REASONS.scriptMissing('scripts/missing.sh') })
  })

  it('kills a run whose chat was removed while it started, and keeps nothing of it', async () => {
    const w = world()
    const marker = join(folder, 'orphan.txt')
    w.state.onShellEnv = () => w.service.chatRemoved('chat-1')
    expect(await run(w, `sleep 0.4; touch ${marker}`, true)).toEqual({ ok: false, code: 'chat_not_found', reason: USER_COMMAND_RUN_REASONS.chat_not_found })
    expect(w.hub.snapshot('chat-1').items).toEqual([])
    expect(w.service.size()).toBe(0)
    expect(existsSync(join(userData, 'command-runs', 'chat-1'))).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(existsSync(marker)).toBe(false)
    // The next start for the chat is not refused by the old removal.
    w.state.onShellEnv = null
    expect((await run(w, 'ls')).ok).toBe(true)
  })

  it('kills a run whose chat was trashed while it started', async () => {
    const w = world()
    w.state.onShellEnv = () => { w.state.trashed = true }
    expect(await run(w, 'sleep 5', true)).toMatchObject({ ok: false, code: 'chat_not_found' })
    expect(w.hub.snapshot('chat-1').items).toEqual([])
  })

  it('refuses a folder that is gone, an agent with no folder, and a chat or message that is not this one', async () => {
    const w = world()
    w.state.workspace = { folder: join(base, 'gone'), scriptRoots: [] }
    expect(await run(w, 'ls')).toMatchObject({ ok: false, code: 'folder_missing' })
    w.state.workspace = 'missing'
    expect(await run(w, 'ls')).toMatchObject({ ok: false, code: 'folder_missing' })
    w.state.workspace = null
    expect(await run(w, 'ls')).toMatchObject({ ok: false, code: 'not_local' })
    expect(await run(w, 'ls', false, 'chat-2', 'msg-1')).toMatchObject({ ok: false, code: 'chat_not_found' })
    expect(await run(w, 'ls', false, '../escape', 'msg-1')).toMatchObject({ ok: false, code: 'chat_not_found' })
    w.state.trashed = true
    expect(await run(w, 'ls')).toMatchObject({ ok: false, code: 'chat_not_found' })
  })

  it('says folder_missing, not not_local, for a folder agent that dropped out of the list with its folder', async () => {
    const w = world()
    w.state.gone = new Set(['folder:moved', 'remote:gone'])
    expect(await run(w, 'ls', false, 'chat-1', 'msg-folder')).toEqual({ ok: false, code: 'folder_missing', reason: USER_COMMAND_RUN_REASONS.folder_missing })
    expect(await run(w, 'ls', true, 'chat-1', 'msg-folder')).toMatchObject({ ok: false, code: 'folder_missing' })
    // An agent that was never a folder here is still not local.
    expect(await run(w, 'ls', false, 'chat-1', 'msg-remote')).toMatchObject({ ok: false, code: 'not_local' })
  })

  it('answers spawn_failed, with the error, when the shell cannot start', async () => {
    const w = world()
    w.state.shell = join(base, 'no-such-shell')
    const result = await run(w, 'ls')
    expect(result).toMatchObject({ ok: false, code: 'spawn_failed' })
    expect(!result.ok && result.reason).toMatch(/ENOENT/)
    expect(w.hub.snapshot('chat-1').items).toEqual([])
  })

  it('ends a non-zero exit as failed with the exit code in the summary', async () => {
    const w = world()
    const result = await run(w, 'exit 3', true)
    if (!result.ok) throw new Error('did not start')
    await ended(w, 'chat-1', result.itemId)
    expect(item(w, result.itemId)).toMatchObject({ state: 'failed', detail: `Exit code 3 · ${displayPath(folder)}` })
  })

  it('caps the log, says so, and lets the process run on', async () => {
    const w = world({ logCapBytes: 1000 })
    const result = await run(w, 'i=0; while [ $i -lt 200 ]; do echo 0123456789; i=$((i+1)); done; echo done > marker.txt', true)
    if (!result.ok) throw new Error('did not start')
    await ended(w, 'chat-1', result.itemId)
    const log = readFileSync(item(w, result.itemId)!.outputPath!, 'utf8')
    expect(log.length).toBeLessThan(1100)
    expect(log.endsWith('[output truncated]\r\n')).toBe(true)
    expect(readFileSync(join(folder, 'marker.txt'), 'utf8')).toBe('done\n')
    rmSync(join(folder, 'marker.txt'))
  })
})

describe('stopping', () => {
  it('stops the whole process group through sessionActivity:stop, as stopped', async () => {
    const w = world({ stopGraceMs: 2000 })
    const result = await run(w, 'sleep 30 & sleep 30; wait', true)
    if (!result.ok) throw new Error('did not start')
    const { installSessionActivityStopper } = await import('../sessionActivityStop')
    const uninstall = installSessionActivityStopper('user-commands-test', w.service.stopper)
    try {
      expect(await stopSessionActivity('chat-1', result.itemId, w.hub)).toEqual({ ok: true })
      await ended(w, 'chat-1', result.itemId)
      expect(item(w, result.itemId)?.state).toBe('stopped')
    } finally {
      uninstall()
    }
  })

  it('answers null for an item that is not a command', async () => {
    const w = world()
    const outcome = await w.service.stopper.stop('chat-1', { id: 'x', kind: 'background', agentId: 'a', title: 'x', detail: null,
      state: 'running', startedAt: new Date(), endedAt: null, outputPath: null, canStop: true })
    expect(outcome).toBeNull()
  })

  it('kills every running group on shutdown', async () => {
    const w = world()
    const result = await run(w, 'sleep 30', true)
    if (!result.ok) throw new Error('did not start')
    await w.service.shutdown(500)
    await ended(w, 'chat-1', result.itemId)
    expect(item(w, result.itemId)?.state).toBe('failed')
  })

  it('labels a run stopped once Stop was requested, even when it exits 0 on SIGTERM', async () => {
    const w = world({ stopGraceMs: 2000 })
    // Exits 0 on SIGTERM, as a server that shuts down cleanly does.
    const result = await run(w, `trap 'exit 0' TERM; sleep 30 & wait`, true)
    if (!result.ok) throw new Error('did not start')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await w.service.stopper.stop('chat-1', item(w, result.itemId)!)).toBe('stopped')
    await ended(w, 'chat-1', result.itemId)
    expect(item(w, result.itemId)?.state).toBe('stopped')
    // Stop after the close changes nothing.
    expect(await w.service.stopper.stop('chat-1', item(w, result.itemId)!)).toBe('already_ended')
    expect(item(w, result.itemId)?.state).toBe('stopped')
  })

  it('labels a run that closed before any Stop by its exit', async () => {
    const w = world()
    const result = await run(w, 'true', true)
    if (!result.ok) throw new Error('did not start')
    await ended(w, 'chat-1', result.itemId)
    expect(await w.service.stopper.stop('chat-1', item(w, result.itemId)!)).toBe('already_ended')
    expect(item(w, result.itemId)?.state).toBe('completed')
  })

  it('kills a run that was starting when the app quit, and waits for it', async () => {
    const w = world()
    const marker = join(folder, 'outlived-start.txt')
    let quit: Promise<void> | null = null
    let settled = false
    let settledAtQuit: boolean | null = null
    // Read just before the spawn: the quit lands while the process starts.
    w.state.onUserData = () => {
      w.state.onUserData = null
      quit = w.service.shutdown(500)
      void quit.then(() => { settledAtQuit = settled })
    }
    const pending = run(w, `sleep 0.4; touch ${marker}`, true).then((result) => { settled = true; return result })
    while (quit === null) await new Promise((resolve) => setTimeout(resolve, 1))
    // Quitting waits for the start it overlapped.
    await quit
    expect(settledAtQuit).toBe(true)
    expect(await pending).toMatchObject({ ok: false, code: 'spawn_failed', reason: expect.stringMatching(/quitting/) })
    expect(w.service.size()).toBe(0)
    const dir = join(userData, 'command-runs', 'chat-1')
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
    expect(w.hub.snapshot('chat-1').items).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(existsSync(marker)).toBe(false)
    expect(await run(w, 'ls')).toMatchObject({ ok: false, code: 'spawn_failed' })
  })

  it('still kills a removed chat\'s run that ignores SIGTERM when the app quits', async () => {
    const w = world({ stopGraceMs: 30_000 })
    const marker = join(folder, 'outlived-quit.txt')
    const result = await run(w, `trap '' TERM; sleep 0.8; touch ${marker}`, true)
    if (!result.ok) throw new Error('did not start')
    await new Promise((resolve) => setTimeout(resolve, 100))
    w.service.chatRemoved('chat-1')
    const started = Date.now()
    await w.service.shutdown(150)
    expect(Date.now() - started).toBeLessThan(1000)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(existsSync(marker)).toBe(false)
  })

  it('kills a removed chat\'s runs and deletes its logs', async () => {
    const w = world({ stopGraceMs: 200 })
    const marker = join(folder, 'survived.txt')
    const result = await run(w, `sleep 0.5; touch ${marker}`, true)
    if (!result.ok) throw new Error('did not start')
    const dir = join(userData, 'command-runs', 'chat-1')
    expect(existsSync(dir)).toBe(true)
    w.service.chatRemoved('chat-1')
    expect(existsSync(dir)).toBe(false)
    expect(w.service.size()).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(existsSync(marker)).toBe(false)
    // Nothing more is reported for a removed chat: the hub clear is what ends its rows.
    expect(item(w, result.itemId)?.state).toBe('running')
  })
})

describe('output', () => {
  it('replays the log, then streams, then ends', async () => {
    const w = world()
    const result = await run(w, 'echo one; sleep 0.3; echo two', true)
    if (!result.ok) throw new Error('did not start')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const frames: UserCommandOutputFrame[] = []
    w.service.watch('chat-1', result.itemId, (frame) => frames.push(frame))
    await ended(w, 'chat-1', result.itemId)
    expect(frames[0]).toMatchObject({ type: 'start', command: 'echo one; sleep 0.3; echo two', backlog: 'one\n' })
    expect(frames.filter((frame) => frame.type === 'chunk').map((frame) => frame.type === 'chunk' && frame.data).join('')).toBe('two\n')
    expect(frames.at(-1)).toMatchObject({ type: 'end', end: { state: 'completed', exitCode: 0 } })
    const late: UserCommandOutputFrame[] = []
    w.service.watch('chat-1', result.itemId, (frame) => late.push(frame))
    expect(late.map((frame) => frame.type)).toEqual(['start', 'end'])
    const missing: UserCommandOutputFrame[] = []
    expect(w.service.watch('chat-2', result.itemId, (frame) => missing.push(frame))).toBeNull()
    expect(missing).toEqual([{ type: 'missing' }])
  })

  it('replays the log on a character boundary, so a split character joins the live stream whole', async () => {
    const w = world()
    // "€" is E2 82 AC: the first two bytes, a pause, then the last.
    const result = await run(w, `printf 'a\\342\\202'; sleep 0.4; printf '\\254b\\n'`, true)
    if (!result.ok) throw new Error('did not start')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const frames: UserCommandOutputFrame[] = []
    w.service.watch('chat-1', result.itemId, (frame) => frames.push(frame))
    await ended(w, 'chat-1', result.itemId)
    const start = frames[0]
    const text = (start.type === 'start' ? start.backlog : '') +
      frames.filter((frame) => frame.type === 'chunk').map((frame) => frame.type === 'chunk' ? frame.data : '').join('')
    expect(text).toBe('a€b\n')
    expect(readFileSync(item(w, result.itemId)!.outputPath!, 'utf8')).toBe('a€b\n')
  })

  it('names the attachment after an own script', async () => {
    const w = world()
    const result = await run(w, 'sh scripts/hello.sh x')
    if (!result.ok) throw new Error('did not start')
    await ended(w, 'chat-1', result.itemId)
    expect(w.service.outputText('chat-1', result.itemId)).toMatchObject({ ok: true, filename: 'output-hello.txt' })
  })

  it('formats an ended run for an attachment, ANSI stripped, and writes it to a file', async () => {
    const w = world()
    const result = await run(w, `printf '\\033[31mred\\033[0m line\\n'; exit 2`, true)
    if (!result.ok) throw new Error('did not start')
    expect(w.service.outputText('chat-1', result.itemId)).toMatchObject({ ok: false, code: 'running' })
    await ended(w, 'chat-1', result.itemId)
    const text = w.service.outputText('chat-1', result.itemId)
    expect(text.ok).toBe(true)
    if (!text.ok) return
    expect(text.filename).toBe('output-printf.txt')
    expect(text.text).toMatch(/^\$ printf .*\nFolder: .*\nExit code: 2\nDuration: .*\n\nred line\n$/)
    const written = w.service.outputFile('chat-1', result.itemId)
    expect(written).toMatchObject({ ok: true, filename: 'output-printf.txt' })
    if (written.ok) {
      expect(written.path).toBe(join(userData, 'command-runs', 'chat-1', result.itemId, 'output-printf.txt'))
      expect(readFileSync(written.path, 'utf8')).toBe(text.text)
    }
    expect(w.service.outputText('chat-2', result.itemId)).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('dismisses only an ended run, removing its row and its log', async () => {
    const w = world()
    const result = await run(w, 'sleep 0.2; echo x', true)
    if (!result.ok) throw new Error('did not start')
    expect(w.service.dismiss('chat-1', result.itemId)).toMatchObject({ ok: false, code: 'running' })
    await ended(w, 'chat-1', result.itemId)
    const log = item(w, result.itemId)!.outputPath!
    expect(w.service.dismiss('chat-1', result.itemId)).toEqual({ ok: true })
    expect(item(w, result.itemId)).toBeUndefined()
    expect(existsSync(log)).toBe(false)
  })

  it('deletes the log of a run the hub stopped holding', async () => {
    const w = world()
    const result = await run(w, 'echo x', true)
    if (!result.ok) throw new Error('did not start')
    await ended(w, 'chat-1', result.itemId)
    const log = item(w, result.itemId)!.outputPath!
    w.hub.clear('chat-1')
    expect(existsSync(log)).toBe(false)
    expect(w.service.size()).toBe(0)
  })
})

describe('sweep', () => {
  it('deletes every log left by the last app', () => {
    const w = world()
    file(join(userData, 'command-runs', 'old-chat', 'cmd-old.log'))
    w.service.sweep()
    expect(existsSync(join(userData, 'command-runs'))).toBe(false)
  })
})

describe('inspect: a script\'s parameters, read and never run', () => {
  const REPORT = (flag: string): string => `"""Report a scope."""
import argparse
p = argparse.ArgumentParser()
p.add_argument("scope")
p.add_argument("${flag}", action="store_true")
p.parse_args()
`
  const inspect = (w: World, command: string, messageId = 'msg-1') =>
    w.service.inspect('profile', { chatId: 'chat-1', messageId, command })

  beforeAll(() => {
    file(join(folder, 'scripts', 'report.py'), REPORT('--apply'))
    file(join(folder, 'credentials', 'tool.py'), REPORT('--apply'))
    file(join(folder, 'scripts', 'deploy.env'), REPORT('--apply'))
    file(join(base, 'outside', 'evil.py'), REPORT('--apply'))
    file(join(base, 'skills', 'pinned', 'scripts', 'skill.py'), REPORT('--apply'))
    symlinkSync(join(base, 'outside', 'evil.py'), join(folder, 'scripts', 'escape.py'))
    file(join(folder, 'scripts', 'big.py'), REPORT('--apply') + '#'.repeat(512 * 1024))
  })

  it('reads an own script\'s spec, named as the command wrote it, with env assignments and uv run before it', async () => {
    const w = world()
    const result = await inspect(w, 'DEBUG=1 uv run scripts/report.py italy --apply')
    expect(result).toMatchObject({ ok: true, folder: displayPath(folder) })
    if (!result.ok) return
    expect(result.spec).toMatchObject({ script: 'scripts/report.py', summary: 'Report a scope.' })
    expect(result.spec!.params.map((param) => param.id)).toEqual(['scope', 'apply'])
  })

  it('reads a pinned skill\'s script', async () => {
    const w = world()
    w.state.workspace = { folder, scriptRoots: [join(base, 'skills', 'pinned')] }
    const result = await inspect(w, `python3 ${join(base, 'skills', 'pinned', 'scripts', 'skill.py')} x`)
    expect(result.ok && result.spec?.params.length).toBe(2)
  })

  it.each([
    ['outside the folder', 'python3 OUTSIDE/evil.py'],
    ['outside through a symlink', 'python3 scripts/escape.py'],
    ['outside through ..', 'python3 ../outside/evil.py'],
    ['a credential file', 'python3 credentials/tool.py'],
    ['a secret-looking name', 'python3 scripts/deploy.env'],
    ['too big', 'python3 scripts/big.py'],
    ['missing', 'python3 scripts/none.py'],
    ['not a script command', 'ls -la'],
    ['a pipe', 'python3 scripts/report.py | head'],
    ['a block', 'python3 scripts/report.py\nls']
  ])('has no spec for a script %s', async (_name, command) => {
    const result = await inspect(world(), command.replace('OUTSIDE', join(base, 'outside')))
    expect(result).toMatchObject({ ok: true, spec: null })
  })

  it('refuses as data for a chat, message or folder that is not there, and never throws', async () => {
    const w = world()
    expect(await w.service.inspect('profile', { chatId: 'nope', messageId: 'msg-1', command: 'python3 scripts/report.py' }))
      .toMatchObject({ ok: false, code: 'chat_not_found' })
    w.state.workspace = 'missing'
    expect(await inspect(w, 'python3 scripts/report.py')).toMatchObject({ ok: false, code: 'folder_missing' })
    w.state.workspace = null
    expect(await inspect(w, 'python3 scripts/report.py')).toMatchObject({ ok: false, code: 'not_local' })
    expect(await w.service.inspect('profile', null as never)).toMatchObject({ ok: false, code: 'chat_not_found' })
  })

  it('caches by real path, mtime and size: a change the cache cannot see is not read, a new mtime is', async () => {
    const w = world()
    const path = join(folder, 'scripts', 'cached.py')
    file(path, REPORT('--apply'))
    const fixed = new Date('2026-01-01T00:00:00Z')
    utimesSync(path, fixed, fixed)
    const first = await inspect(w, 'python3 scripts/cached.py')
    expect(first.ok && first.spec?.params[1].id).toBe('apply')
    // Same size and mtime: the cached spec is answered.
    writeFileSync(path, REPORT('--force'))
    utimesSync(path, fixed, fixed)
    const cached = await inspect(w, 'python3 scripts/cached.py')
    expect(cached.ok && cached.spec?.params[1].id).toBe('apply')
    const later = new Date('2026-01-02T00:00:00Z')
    utimesSync(path, later, later)
    const fresh = await inspect(w, 'python3 scripts/cached.py')
    expect(fresh.ok && fresh.spec?.params[1].id).toBe('force')
  })
})

describe('inspect: the file read is the file checked', () => {
  const REPORT = 'import argparse\np = argparse.ArgumentParser()\np.add_argument("--apply", action="store_true")\np.parse_args()\n'
  const inspect = (w: World, command: string) => w.service.inspect('profile', { chatId: 'chat-1', messageId: 'msg-1', command })

  beforeAll(() => {
    file(join(base, 'outside', 'swap-target.py'), REPORT)
    symlinkSync(join(base, 'outside', 'swap-target.py'), join(folder, 'scripts', 'swapped.py'))
    execFileSync('mkfifo', [join(folder, 'scripts', 'pipe.py')])
    file(join(folder, 'scripts', 'usage.py'), '"""Tool.\n\nUsage: usage.py <scope> [--apply]\n"""\nimport sys\n')
    symlinkSync(join(folder, 'scripts', 'usage.py'), join(folder, 'scripts', 'alias.py'))
  })

  it('has no spec when the checked path is a symlink by the time it is opened', async () => {
    // As if `scripts/swapped.py` had been a file inside the folder when it was checked.
    const target = statSync(join(base, 'outside', 'swap-target.py'))
    vi.mocked(readableOwnScript).mockReturnValueOnce({ real: join(folder, 'scripts', 'swapped.py'), dev: target.dev, ino: target.ino })
    expect(await inspect(world(), 'python3 scripts/swapped.py')).toMatchObject({ ok: true, spec: null })
  })

  it('has no spec, and does not block, when a FIFO is at the checked path', async () => {
    const pipe = statSync(join(folder, 'scripts', 'pipe.py'))
    vi.mocked(readableOwnScript).mockReturnValueOnce({ real: join(folder, 'scripts', 'pipe.py'), dev: pipe.dev, ino: pipe.ino })
    expect(await inspect(world(), 'python3 scripts/pipe.py')).toMatchObject({ ok: true, spec: null })
  })

  it('has no spec when the file opened is not the file the policy judged (a parent swapped for a symlink)', async () => {
    const path = join(folder, 'scripts', 'judged.py')
    file(path, REPORT)
    const real = statSync(path)
    // The policy judged some other file at this path; whatever is there now is read by nobody.
    vi.mocked(readableOwnScript).mockReturnValueOnce({ real: path, dev: real.dev, ino: real.ino + 1 })
    expect(await inspect(world(), 'python3 scripts/judged.py')).toMatchObject({ ok: true, spec: null })
    // The same file, judged as itself, reads.
    const read = await inspect(world(), 'python3 scripts/judged.py')
    expect(read.ok && read.spec?.params.map((param) => param.id)).toEqual(['apply'])
  })

  it('caches by the name the command gives the script too: a Usage line names one of them', async () => {
    const w = world()
    // The same file by another name: its Usage line does not name alias.py.
    expect(await inspect(w, 'python3 scripts/alias.py x')).toMatchObject({ ok: true, spec: null })
    const named = await inspect(w, 'python3 scripts/usage.py x')
    expect(named.ok && named.spec?.params.map((param) => param.id)).toEqual(['scope', 'apply'])
  })
})

describe('relativeArgPath', () => {
  it('writes a chosen path relative to the folder when inside it, else as chosen', () => {
    expect(relativeArgPath(folder, join(folder, 'notes', 'a.txt'))).toBe(join('notes', 'a.txt'))
    expect(relativeArgPath(folder, folder)).toBe('.')
    expect(relativeArgPath(folder, join(base, 'outside', 'evil.sh'))).toBe(join(base, 'outside', 'evil.sh'))
    // A path that reaches outside through a symlink is outside.
    expect(relativeArgPath(folder, join(folder, 'linked', 'evil.sh'))).toBe(join(folder, 'linked', 'evil.sh'))
  })
})
