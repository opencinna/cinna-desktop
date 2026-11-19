import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../playwright.config'
import type { CinnaApp } from './app'

/**
 * A scripted **`claude` CLI** for the Claude engine, behind the real
 * `@agentclientprotocol/claude-agent-acp` adapter the app ships.
 *
 * Only the CLI is faked. The app spawns the adapter exactly as for a real
 * session, with `CLAUDE_CODE_EXECUTABLE` set to the path saved as
 * `localAgentsClaudePath`; the adapter's Agent SDK then speaks its stream-json
 * control protocol to `fakeClaudeCli.mjs`, which answers `initialize` with the
 * model list below (so `session/new` offers it as the adapter builds it,
 * per-model `effort` options included), succeeds every other control request,
 * and answers a prompt with one text reply and a costed result — the constant
 * `reply`, or `Heard <match>.` when `echoPattern` matches the prompt — while a
 * prompt holding `holdMarker` gets a `Bash` tool use and then nothing until the
 * SDK's `interrupt`, which ends it as the real CLI does (`interrupted()` is the
 * witness that a stop reached the CLI). `--version`
 * and `auth status` answer as a logged-in install, so the launcher's own login
 * check passes without stubbing anything in main.
 *
 * What the adapter asked of the CLI is the witness: an ACP
 * `session/set_config_option` for `model` reaches the CLI as `set_model`, and
 * one for `effort` as `apply_flag_settings` with `effortLevel`.
 */

/** One entry of the CLI's `initialize` `models`, as the real CLI reports it. */
export interface FakeClaudeModel {
  value: string
  displayName: string
  description: string
  supportsAutoMode?: boolean
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
}

export interface FakeClaudeLogEntry {
  pid: number
  cwd: string
  dir: 'argv' | 'in' | 'event'
  args?: string[]
  /** `held`: a hold-marker prompt got its tool use; `interrupted`: the interrupt ended it. */
  event?: 'held' | 'interrupted'
  toolUseId?: string
  message?: { type: string; request?: { subtype?: string; [key: string]: unknown }; [key: string]: unknown }
}

export interface FakeClaudeCli {
  /** The executable to save as `localAgentsClaudePath`. */
  path: string
  /** Every line every process read, in order, with its pid and cwd. */
  log(): FakeClaudeLogEntry[]
  /** The control requests of one subtype, in order. */
  controls(subtype: string): FakeClaudeLogEntry[]
  /** The text of every `user` message (prompt) the CLI read, in order. */
  prompts(): string[]
  /** The held turns that an interrupt ended. */
  interrupted(): FakeClaudeLogEntry[]
}

export interface FakeClaudeInput {
  models: FakeClaudeModel[]
  /** The answer to every prompt the options below leave alone. */
  reply: string
  /** A prompt containing this is held open on a `Bash` tool use until interrupted. */
  holdMarker?: string
  /** A regex source: a prompt it matches is answered `Heard <match>.` instead of `reply`. */
  echoPattern?: string
}

export const FAKE_CLAUDE_VERSION = '9.9.9'

const SCRIPT = join(repoRoot, 'e2e', 'fixtures', 'fakeClaudeCli.mjs')

export function writeFakeClaudeCli(cinna: CinnaApp, input: FakeClaudeInput): FakeClaudeCli {
  const dir = join(cinna.sandbox.root, 'fake-claude')
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, 'config.json')
  const logPath = join(dir, 'log.jsonl')
  const path = join(dir, 'claude')
  writeFileSync(configPath, JSON.stringify({ models: input.models, reply: input.reply, holdMarker: input.holdMarker, echoPattern: input.echoPattern }, null, 2))
  // The launcher builds the child's whole environment, so the shim names node,
  // the script and its files itself.
  writeFileSync(path, [
    '#!/bin/sh',
    `FAKE_CLAUDE_CONFIG='${configPath}'`,
    `FAKE_CLAUDE_LOG='${logPath}'`,
    `FAKE_CLAUDE_VERSION='${FAKE_CLAUDE_VERSION}'`,
    'export FAKE_CLAUDE_CONFIG FAKE_CLAUDE_LOG FAKE_CLAUDE_VERSION',
    `exec '${process.execPath}' '${SCRIPT}' "$@"`,
    ''
  ].join('\n'), { mode: 0o755 })
  const log = (): FakeClaudeLogEntry[] => existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as FakeClaudeLogEntry)
    : []
  return {
    path,
    log,
    controls: (subtype) => log().filter((entry) => entry.message?.type === 'control_request' && entry.message.request?.subtype === subtype),
    prompts: () => log().filter((entry) => entry.dir === 'in' && entry.message?.type === 'user').map((entry) => promptText(entry.message)),
    interrupted: () => log().filter((entry) => entry.event === 'interrupted')
  }
}

function promptText(message: FakeClaudeLogEntry['message']): string {
  const content = (message as { message?: { content?: unknown } } | undefined)?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => (block as { type?: string })?.type === 'text')
    .map((block) => block.text)
    .join('\n')
}
