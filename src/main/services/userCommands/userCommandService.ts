/**
 * Commands the user runs from an agent's message, in the agent's folder.
 *
 * Hub core: Node only, no Electron. A run is a non-interactive child of the
 * user's login shell (`$SHELL -c <command>`, stdin closed, no PTY), in its own
 * process group so Stop and quit reach everything it forked. Its stdout and
 * stderr interleave into one log under `userData/command-runs/<chatId>/`, and
 * it shows in the chat's session activity as an item of kind `command`.
 *
 * - **The guard** (`reviewed: false`): the own-command rule
 *   (`localAgents/ownCommandPolicy.ts`), against the agent's real folder and
 *   pinned skill folders, with the run's cwd that folder. A refusal is
 *   `needs_review` carrying the rule's reason (`ownCommandRefusal`), and the
 *   renderer opens the edit dialog with it. A reviewed command runs as given.
 * - **The folder** is the agent's workspace root, resolved where a turn's is
 *   (`agents/drivers` `agentWorkspaceFolder`), injected rather than imported.
 * - **The environment** is what a terminal there would see (D6): the login
 *   shell's, narrowed as every child's is, plus colour hints. Nothing from the
 *   agent's runtime, no credentials.
 *
 * Runs die with the app: `sweep` deletes every log at startup and `shutdown`
 * kills every group, including a removed chat's that are still going. A
 * removed chat's runs are killed and its logs deleted, and a run whose chat
 * went away while it was starting is killed before anyone sees it. A run that
 * ends on its own leaves what it put in the background running, as a terminal
 * would; Stop and quit reach the whole group.
 *
 * The log holds the decoded text the panel was sent, not the raw bytes, so a
 * replay ends on a character boundary and joins the live stream cleanly.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, rmSync, rmdirSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'
import {
  USER_COMMAND_RUN_REASONS,
  homeDisplayPath,
  stripAnsi,
  userCommandOutputRefusal,
  type UserCommandDismissResult,
  type UserCommandEnd,
  type UserCommandOutputFileResult,
  type UserCommandOutputFrame,
  type UserCommandOutputTextResult,
  type UserCommandRunFailure,
  type UserCommandRunInput,
  type UserCommandRunResult
} from '../../../shared/userCommands'
import type { SessionActivityChange, SessionActivitySnapshot, SessionActivityTerminalState } from '../../../shared/sessionActivity'
import type { SessionActivityStopper } from '../sessionActivityStop'
import { ownCommandRefusal } from '../localAgents/ownCommandPolicy'
import { commandOutputFilename } from '../../../shared/commandRun'
import { createLogger } from '../../logger/logger'

const logger = createLogger('user-commands')

/** Where a log stops growing; the process keeps running. */
export const LOG_CAP_BYTES = 20 * 1024 * 1024
/** How much of the log a newly opened output panel replays. */
export const BACKLOG_BYTES = 2 * 1024 * 1024
/** How much of the output an attachment carries: the end of it. */
export const ATTACHMENT_BYTES = 200 * 1024
/** How long a stopped group has between SIGTERM and SIGKILL. */
export const STOP_GRACE_MS = 5_000
/** How long quitting waits for the groups to go before SIGKILL. */
export const SHUTDOWN_GRACE_MS = 2_000

const TRUNCATED_LINE = '\r\n[output truncated]\r\n'
/** A chat id is a path segment here; anything else is not a chat of ours. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/

/** The agent a message belongs to, as far as running a command needs it. */
export interface UserCommandAgent {
  /** The owner `workspace` is asked with. */
  userId: string
  id: string
}

/** The agent's workspace: the folder a command runs in, and where its pinned skills' scripts are. */
export interface UserCommandWorkspace {
  folder: string
  scriptRoots: readonly string[]
}

/** What the service reports to and reads from: the session activity hub's surface. */
export interface UserCommandHub {
  report(chatId: string, agentId: string, change: SessionActivityChange): void
  remove(chatId: string, itemId: string): boolean
  onChange(listener: (chatId: string, snapshot: SessionActivitySnapshot) => void): () => void
}

export interface UserCommandDeps<A extends UserCommandAgent = UserCommandAgent> {
  /** The chat when the profile sees it, live; undefined when not visible or trashed. */
  chat(profileUserId: string, chatId: string): { id: string; agentId: string | null; deletedAt: Date | null } | undefined
  message(messageId: string): { chatId: string; role: string; sourceAgentId: string | null } | undefined
  agent(profileUserId: string, agentId: string): A | null
  /**
   * The agent's workspace root and script roots; `missing` when it is a
   * folder agent whose folder is gone; null when it is not a local agent with
   * a folder.
   */
  workspace(agent: A): Promise<UserCommandWorkspace | 'missing' | null>
  /** The login shell's environment, narrowed for a child. */
  shellEnv(): Promise<Record<string, string>>
  userData(): string
  hub: UserCommandHub
  now?: () => number
  platform?: NodeJS.Platform
  /** Tests only: a smaller log cap and stop grace. */
  logCapBytes?: number
  stopGraceMs?: number
}

interface Run {
  id: string
  chatId: string
  agentId: string
  command: string
  folder: string
  displayFolder: string
  logPath: string
  startedAt: number
  child: ChildProcess
  fd: number | null
  bytes: number
  truncated: boolean
  state: 'running' | SessionActivityTerminalState
  end: UserCommandEnd | null
  endedAt: number | null
  stopRequested: boolean
  killTimer: ReturnType<typeof setTimeout> | null
  listeners: Set<(frame: UserCommandOutputFrame) => void>
  /** stdout's and stderr's: what each holds of a split character is flushed at close. */
  decoders: StringDecoder[]
  closed: Promise<void>
  /** The chat went away: nothing more is reported or kept. */
  removed: boolean
}

const refusal = (code: UserCommandRunFailure, extra: { reason?: string; folder?: string } = {}): UserCommandRunResult => ({
  ok: false, code, reason: extra.reason ?? USER_COMMAND_RUN_REASONS[code], ...(extra.folder ? { folder: extra.folder } : {})
})

/** `~/…` for a path under the home folder ({@link homeDisplayPath}, shared with the renderer). */
export function displayPath(path: string, home: string = homedir()): string {
  return homeDisplayPath(path, home)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`
}

/** The last `max` bytes of a file, decoded, with a split character at the cut dropped. */
function readTail(path: string, max: number): { text: string; cut: boolean } {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, max)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    let start = 0
    // UTF-8 continuation bytes at the cut belong to a character before it.
    if (size > length) while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
    return { text: buffer.subarray(start).toString('utf8'), cut: size > length }
  } finally {
    closeSync(fd)
  }
}

export function createUserCommandService<A extends UserCommandAgent = UserCommandAgent>(deps: UserCommandDeps<A>) {
  const runs = new Map<string, Run>()
  /**
   * A removed chat's runs that are still going: no longer the chat's, but
   * still processes, so quit reaches them. Each leaves at its close.
   */
  const dying = new Set<Run>()
  /**
   * Removals per chat, for the starts in flight: a start compares the count
   * it began with once its process is up. An entry goes when the chat has no
   * start in flight, so nothing outlives the starts that read it.
   */
  const removals = new Map<string, number>()
  const starting = new Map<string, number>()
  /** Starts in flight, so quitting can wait for each to settle (and kill what it spawned). */
  const inFlight = new Set<Promise<unknown>>()
  /** Set at the top of `shutdown`: a start that sees it after any await starts nothing that stays. */
  let closing = false
  const QUITTING = 'Cinna is quitting, so the command was not started.'
  /** Set by `shutdown`: no SIGKILL grace runs past the quit's. */
  let quitGraceMs: number | null = null
  /** Chats this process wrote logs or outputs for: the only ones a removal has files to delete. */
  const chatsOnDisk = new Set<string>()
  const now = deps.now ?? Date.now
  const platform = deps.platform ?? process.platform
  const logCap = deps.logCapBytes ?? LOG_CAP_BYTES
  const stopGrace = deps.stopGraceMs ?? STOP_GRACE_MS
  const root = (): string => join(deps.userData(), 'command-runs')

  const signalGroup = (child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void => {
    if (!child.pid) return
    if (platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => { /* already gone is the outcome wanted */ })
      return
    }
    try {
      process.kill(-child.pid, signal)
    } catch {
      try { child.kill(signal) } catch { /* already gone */ }
    }
  }

  /** SIGTERM to the group now, SIGKILL after `graceMs` unless it is gone. */
  const terminate = (run: Run, graceMs: number): void => {
    if (run.state !== 'running') return
    signalGroup(run.child, 'SIGTERM')
    if (run.killTimer) return
    const grace = quitGraceMs === null ? graceMs : Math.min(graceMs, quitGraceMs)
    run.killTimer = setTimeout(() => { if (run.state === 'running') signalGroup(run.child, 'SIGKILL') }, grace)
    run.killTimer.unref?.()
  }

  const forget = (run: Run): void => {
    runs.delete(run.id)
    if (run.fd !== null) { try { closeSync(run.fd) } catch { /* closed */ } run.fd = null }
    rmSync(run.logPath, { force: true })
    rmSync(join(root(), run.chatId, run.id), { recursive: true, force: true })
  }

  // An ended run whose row the hub no longer holds (trimmed past the cap,
  // dismissed, or the chat cleared) takes its log with it. Subscribed at the
  // first run, so importing the service touches nothing.
  let watchingHub = false
  const watchHub = (): void => {
    if (watchingHub) return
    watchingHub = true
    deps.hub.onChange((chatId, snapshot) => {
      const held = new Set(snapshot.items.map((item) => item.id))
      for (const run of [...runs.values()]) {
        if (run.chatId === chatId && run.state !== 'running' && !held.has(run.id)) forget(run)
      }
    })
  }

  /** Decoded output to the log and to the panels following it: the same text, so a replay and the stream agree. */
  const emit = (run: Run, text: string): void => {
    if (!text) return
    if (run.fd !== null) {
      try {
        writeSync(run.fd, text)
      } catch (error) {
        logger.warn('a command log could not be written', { itemId: run.id, error: String(error) })
      }
    }
    for (const listener of [...run.listeners]) listener({ type: 'chunk', data: text })
  }

  const write = (run: Run, chunk: Buffer, decoder: StringDecoder): void => {
    if (run.truncated || run.fd === null) return
    const room = logCap - run.bytes
    const over = chunk.length > room
    const kept = over ? chunk.subarray(0, room) : chunk
    run.bytes += kept.length
    let text = decoder.write(kept)
    if (over) {
      run.truncated = true
      text += decoder.end() + TRUNCATED_LINE
    }
    emit(run, text)
  }

  /** The end of a character split at the very end of the output, before the run ends. */
  const flush = (run: Run): void => {
    for (const decoder of run.decoders) {
      const rest = decoder.end()
      if (!run.truncated) emit(run, rest)
    }
  }

  const finish = (run: Run, outcome: { code: number | null; signal: NodeJS.Signals | null; error?: string }): void => {
    if (run.state !== 'running') return
    if (run.killTimer) { clearTimeout(run.killTimer); run.killTimer = null }
    // Stop requested before the close wins whatever the exit (a server exits 0
    // on SIGTERM); a run that closed first is labelled by its exit, and a Stop
    // after the close is a no-op (`already_ended`).
    const state: UserCommandEnd['state'] = run.stopRequested ? 'stopped'
      : outcome.error === undefined && outcome.code === 0 ? 'completed' : 'failed'
    run.state = state
    run.endedAt = now()
    run.end = { state, exitCode: outcome.code, signal: outcome.signal }
    if (run.fd !== null) { try { closeSync(run.fd) } catch { /* closed */ } run.fd = null }
    const summary = state !== 'failed' ? undefined
      : outcome.error !== undefined ? outcome.error
        : outcome.signal ? `${outcome.signal} · ${run.displayFolder}`
          : `Exit code ${outcome.code ?? '?'} · ${run.displayFolder}`
    for (const listener of [...run.listeners]) listener({ type: 'end', end: run.end, endedAt: run.endedAt })
    run.listeners.clear()
    if (!run.removed) deps.hub.report(run.chatId, run.agentId, { type: 'end', id: run.id, state, ...(summary ? { summary } : {}) })
  }

  /** Who the message belongs to, checked: the chat is the profile's, live; the message is in it. */
  const resolveAgent = (profileUserId: string, chatId: unknown, messageId: unknown): { agent: A } | { refusal: UserCommandRunResult } => {
    if (typeof chatId !== 'string' || !SAFE_SEGMENT.test(chatId)) return { refusal: refusal('chat_not_found') }
    const chat = deps.chat(profileUserId, chatId)
    if (!chat || chat.deletedAt) return { refusal: refusal('chat_not_found') }
    const message = typeof messageId === 'string' ? deps.message(messageId) : undefined
    if (!message || message.chatId !== chatId) return { refusal: refusal('chat_not_found') }
    const agentId = (message.role === 'assistant' ? message.sourceAgentId : null) ?? chat.agentId
    const agent = agentId ? deps.agent(profileUserId, agentId) : null
    return agent ? { agent } : { refusal: refusal('not_local') }
  }

  /** The output as an attachment's text: ANSI stripped, the last 200 KB, with a header. */
  const outputText = (chatId: string, itemId: string): UserCommandOutputTextResult => {
    const run = runs.get(itemId)
    if (!run || run.chatId !== chatId || run.removed) return userCommandOutputRefusal('not_found')
    if (run.state === 'running' || !run.end || run.endedAt === null) return userCommandOutputRefusal('running')
    let tail: { text: string; cut: boolean }
    try {
      tail = readTail(run.logPath, ATTACHMENT_BYTES)
    } catch {
      return userCommandOutputRefusal('unreadable')
    }
    const ending = run.end.state === 'stopped' ? 'Stopped'
      : run.end.signal ? `Signal ${run.end.signal}`
        : run.end.exitCode === null ? 'Unknown' : String(run.end.exitCode)
    const header = [
      `$ ${run.command}`,
      `Folder: ${run.displayFolder}`,
      `Exit code: ${ending}`,
      `Duration: ${formatDuration(Math.max(0, run.endedAt - run.startedAt))}`,
      ...(tail.cut ? [`(only the last ${ATTACHMENT_BYTES / 1024} KB of the output)`] : [])
    ].join('\n')
    const body = stripAnsi(tail.text.replace(/\r\n/g, '\n'))
    return { ok: true, text: `${header}\n\n${body}${body.endsWith('\n') || body === '' ? '' : '\n'}`, filename: commandOutputFilename(run.command) }
  }

  /** The chat is still there, live, and was not removed since a start began. */
  const stillLive = (profileUserId: string, chatId: string, removalsAtStart: number): boolean => {
    if ((removals.get(chatId) ?? 0) !== removalsAtStart) return false
    const chat = deps.chat(profileUserId, chatId)
    return !!chat && !chat.deletedAt
  }

  const start = async (profileUserId: string, input: UserCommandRunInput, agent: A, removalsAtStart: number): Promise<UserCommandRunResult> => {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    const workspace = await deps.workspace(agent)
    if (closing) return refusal('spawn_failed', { reason: QUITTING })
    if (workspace === 'missing') return refusal('folder_missing')
    if (!workspace) return refusal('not_local')
    const folder = workspace.folder
    const shown = displayPath(folder)
    let isDir = false
    try { isDir = statSync(folder).isDirectory() } catch { isDir = false }
    if (!isDir) return refusal('folder_missing', { folder: shown })
    // The dialog refuses an empty command itself; this is the backstop.
    if (command === '') return refusal('needs_review', { reason: 'Type a command to run.', folder: shown })
    if (input.reviewed !== true) {
      const why = ownCommandRefusal({ folder, scriptRoots: workspace.scriptRoots }, folder, command)
      if (why !== null) return refusal('needs_review', { reason: why, folder: shown })
    }

    const env = await deps.shellEnv()
    if (closing) return refusal('spawn_failed', { reason: QUITTING, folder: shown })
    const shell = env.SHELL && env.SHELL.startsWith('/') ? env.SHELL : '/bin/zsh'
    const id = `cmd-${randomUUID()}`
    const dir = join(root(), input.chatId)
    const logPath = join(dir, `${id}.log`)
    let fd: number
    try {
      mkdirSync(dir, { recursive: true })
      chatsOnDisk.add(input.chatId)
      fd = openSync(logPath, 'a')
    } catch (error) {
      return refusal('spawn_failed', { reason: `The command could not be started: ${error instanceof Error ? error.message : String(error)}`, folder: shown })
    }

    let child: ChildProcess
    try {
      child = spawn(shell, ['-c', command], {
        cwd: folder,
        env: { ...env, FORCE_COLOR: '1', CLICOLOR_FORCE: '1', TERM: 'xterm-256color', COLUMNS: '120' },
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      closeSync(fd)
      rmSync(logPath, { force: true })
      return refusal('spawn_failed', { reason: `The command could not be started: ${error instanceof Error ? error.message : String(error)}`, folder: shown })
    }
    const spawned = await new Promise<Error | null>((resolve) => {
      child.once('spawn', () => resolve(null))
      child.once('error', (error) => resolve(error))
    })
    if (spawned) {
      closeSync(fd)
      rmSync(logPath, { force: true })
      return refusal('spawn_failed', { reason: `The command could not be started: ${spawned.message}`, folder: shown })
    }
    // The app began quitting while this started: shutdown never saw the
    // group, so it goes now.
    if (closing) {
      signalGroup(child, 'SIGKILL')
      closeSync(fd)
      rmSync(logPath, { force: true })
      logger.info('a user command started as the app quit; killed', { chatId: input.chatId, itemId: id })
      return refusal('spawn_failed', { reason: QUITTING, folder: shown })
    }
    // The chat was trashed or deleted while this started: nobody could see
    // or stop the run, so it does not stay.
    if (!stillLive(profileUserId, input.chatId, removalsAtStart)) {
      signalGroup(child, 'SIGKILL')
      closeSync(fd)
      rmSync(logPath, { force: true })
      try {
        rmdirSync(dir)
        chatsOnDisk.delete(input.chatId)
      } catch { /* other runs' files: the chat's removal takes them */ }
      logger.info('a user command\'s chat went away while it started; killed', { chatId: input.chatId, itemId: id })
      return refusal('chat_not_found')
    }

    let closed!: () => void
    const out = new StringDecoder('utf8')
    const err = new StringDecoder('utf8')
    const run: Run = {
      id, chatId: input.chatId, agentId: agent.id, command, folder, displayFolder: shown, logPath,
      startedAt: now(), child, fd, bytes: 0, truncated: false, state: 'running', end: null, endedAt: null,
      stopRequested: false, killTimer: null, listeners: new Set(), decoders: [out, err],
      closed: new Promise((resolve) => { closed = resolve }), removed: false
    }
    watchHub()
    runs.set(id, run)
    child.stdout?.on('data', (chunk: Buffer) => write(run, chunk, out))
    child.stderr?.on('data', (chunk: Buffer) => write(run, chunk, err))
    child.on('error', (error) => {
      logger.warn('a user command failed after it started', { itemId: id, error: error.message })
      flush(run)
      finish(run, { code: null, signal: null, error: error.message })
      dying.delete(run)
      closed()
    })
    child.once('close', (code, signal) => {
      flush(run)
      finish(run, { code, signal })
      dying.delete(run)
      closed()
    })
    // The command and the folder in the row; the log is its output.
    deps.hub.report(run.chatId, run.agentId, {
      type: 'upsert', id, kind: 'command', title: command, detail: shown, outputPath: logPath, canStop: true
    })
    logger.info('user command started', { chatId: run.chatId, itemId: id, reviewed: input.reviewed === true })
    return { ok: true, itemId: id, folder: shown }
  }

  return {
    outputText,

    async run(profileUserId: string, input: UserCommandRunInput): Promise<UserCommandRunResult> {
      const resolved = resolveAgent(profileUserId, input?.chatId, input?.messageId)
      if ('refusal' in resolved) return resolved.refusal
      if (closing) return refusal('spawn_failed', { reason: QUITTING })
      const chatId = input.chatId
      starting.set(chatId, (starting.get(chatId) ?? 0) + 1)
      const started = start(profileUserId, input, resolved.agent, removals.get(chatId) ?? 0)
      inFlight.add(started)
      try {
        return await started
      } finally {
        inFlight.delete(started)
        const left = (starting.get(chatId) ?? 1) - 1
        if (left > 0) starting.set(chatId, left)
        else { starting.delete(chatId); removals.delete(chatId) }
      }
    },

    /**
     * Follow a run's output: `start` with the tail of the log, then live
     * chunks, then `end`. Answers the unsubscribe, or null (after one
     * `missing`) for a run this chat does not have.
     */
    watch(chatId: string, itemId: string, listener: (frame: UserCommandOutputFrame) => void): (() => void) | null {
      const run = runs.get(itemId)
      if (!run || run.chatId !== chatId || run.removed) {
        listener({ type: 'missing' })
        return null
      }
      let backlog = ''
      try {
        const tail = readTail(run.logPath, BACKLOG_BYTES)
        backlog = tail.cut ? `[earlier output not shown]\r\n${tail.text}` : tail.text
      } catch {
        backlog = ''
      }
      listener({ type: 'start', command: run.command, folder: run.displayFolder, startedAt: run.startedAt, backlog })
      if (run.state !== 'running' && run.end && run.endedAt !== null) {
        listener({ type: 'end', end: run.end, endedAt: run.endedAt })
        return () => undefined
      }
      run.listeners.add(listener)
      return () => { run.listeners.delete(listener) }
    },

    /** {@link outputText} written to a file the composer attaches like a dropped one. */
    outputFile(chatId: string, itemId: string): UserCommandOutputFileResult {
      const text = outputText(chatId, itemId)
      if (!text.ok) return text
      const dir = join(root(), chatId, itemId)
      const path = join(dir, text.filename)
      try {
        mkdirSync(dir, { recursive: true })
        chatsOnDisk.add(chatId)
        writeFileSync(path, text.text, 'utf8')
      } catch {
        return userCommandOutputRefusal('unreadable')
      }
      return { ok: true, path, filename: text.filename }
    },

    /** Remove an ended run's row and delete its log. */
    dismiss(chatId: string, itemId: string): UserCommandDismissResult {
      const run = runs.get(itemId)
      if (!run || run.chatId !== chatId) return userCommandOutputRefusal('not_found')
      if (run.state === 'running') return userCommandOutputRefusal('running')
      forget(run)
      deps.hub.remove(chatId, itemId)
      return { ok: true }
    },

    /** Stop, for `sessionActivity:stop`: SIGTERM to the group, SIGKILL after five seconds; ends `stopped`. */
    stopper: {
      async stop(chatId, item) {
        if (item.kind !== 'command') return null
        const run = runs.get(item.id)
        if (!run || run.chatId !== chatId) return null
        if (run.state !== 'running') return 'already_ended'
        run.stopRequested = true
        terminate(run, stopGrace)
        return 'stopped'
      }
    } satisfies SessionActivityStopper,

    /** The chat was trashed or deleted: kill its runs, drop them and delete its logs. */
    chatRemoved(chatId: string): void {
      // A start in flight for this chat sees it once its process is up.
      if (starting.has(chatId)) removals.set(chatId, (removals.get(chatId) ?? 0) + 1)
      for (const run of [...runs.values()]) {
        if (run.chatId !== chatId) continue
        run.removed = true
        run.listeners.clear()
        if (run.state === 'running') {
          dying.add(run)
          terminate(run, stopGrace)
        }
        runs.delete(run.id)
        if (run.state !== 'running' && run.fd !== null) { try { closeSync(run.fd) } catch { /* closed */ } run.fd = null }
      }
      // Older logs went at startup (`sweep`), so only what this process wrote is on disk.
      if (chatsOnDisk.delete(chatId) && SAFE_SEGMENT.test(chatId)) rmSync(join(root(), chatId), { recursive: true, force: true })
    },

    /**
     * Quit: SIGTERM every group now, SIGKILL whatever is left after the grace.
     * A start in flight kills what it spawned once it sees `closing`; quitting
     * waits for those too, within the same grace.
     */
    shutdown(graceMs: number = SHUTDOWN_GRACE_MS): Promise<void> {
      closing = true
      quitGraceMs = graceMs
      const running = [...runs.values(), ...dying].filter((run) => run.state === 'running')
      for (const run of running) {
        // The quit's SIGKILL below comes first; a Stop's longer grace does not outlive it.
        if (run.killTimer) { clearTimeout(run.killTimer); run.killTimer = null }
        signalGroup(run.child, 'SIGTERM')
      }
      const starts = [...inFlight].map((started) => started.catch(() => undefined))
      if (running.length === 0 && starts.length === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const run of running) if (run.state === 'running') signalGroup(run.child, 'SIGKILL')
          resolve()
        }, graceMs)
        timer.unref?.()
        void Promise.all([...running.map((run) => run.closed), ...starts]).then(() => { clearTimeout(timer); resolve() })
      })
    },

    /** Startup: runs died with the last app, so their logs go. */
    sweep(): void {
      try {
        if (existsSync(root())) rmSync(root(), { recursive: true, force: true })
      } catch (error) {
        logger.warn('old command logs could not be removed', { error: String(error) })
      }
    },

    /** For tests: the runs held. */
    size(): number {
      return runs.size
    }
  }
}

export type UserCommandService = ReturnType<typeof createUserCommandService<UserCommandAgent>>
