/**
 * Agent Vault: what the renderer sees. Types and literals only (no imports
 * from main); the wire protocols are in `protocol.ts`.
 */
import type { EgressPolicy, HelperFlavor, VaultAvailability, VaultEngine, VaultLaunchProvider, VaultState } from './protocol'

import type { CinnaAgentManifest } from '../kit/manifest'
import type { ClaudeApproval } from '../engine'
import type { LocalAgentCredentialState, LocalAgentPromptKind, LocalAgentStatusSummary } from '../localAgents'

export type { EgressPolicy, HelperFlavor, VaultAvailability, VaultEngine, VaultLaunchProvider, VaultState }

/**
 * The reserved folder in the default workshop root that holds every vault
 * (`<root>/SecureAgents/<vaultId>/`). No walker enters it, no agent may be
 * scaffolded under that name, and a root that already has one Cinna did not
 * make is refused.
 */
export const SECURE_AGENTS_DIR = 'SecureAgents'
/** Marker file Cinna writes into its own `SecureAgents/`; a folder without it is someone else's. */
export const SECURE_AGENTS_MARKER = '.cinna-vaults'

/** True for the reserved name, any case (`secureagents`, `SECUREAGENTS`, …). */
export function isSecureAgentsName(name: string): boolean {
  return name.trim().toLowerCase() === SECURE_AGENTS_DIR.toLowerCase()
}

/** A vault agent as `LocalAgentDto.vault` carries it. */
export interface LocalAgentVaultInfo {
  vaultId: string
  state: VaultState
  engine: VaultEngine
  /** Display copy of the model it runs on inside (`cinna.launch` decides); null: the CLI's default. */
  model?: string | null
  /** Display copy of OpenCode's provider, when a switch recorded one. */
  provider?: VaultLaunchProvider | null
  /** The agent's host folder is still there after the move (until **Delete host copy**). */
  hostCopy?: boolean
  /**
   * Set when the vault is `tampered` because another build of Cinna made it
   * (its keys live with that build's helper): which one. See
   * {@link vaultOtherBuildText}.
   */
  otherBuild?: HelperFlavor | null
}

/** Which backend serves vaults and what it can promise (README "capabilities"). */
export interface VaultCapabilities {
  /** The vault runs under its own kernel (a VM), not as another process of this OS. */
  separateKernel: boolean
  /** The disk key is wrapped by hardware (Secure Enclave). */
  hardwareKey: boolean
  /** Each gated action raises its own user-presence prompt. */
  perActionPresence: boolean
  /**
   * The lock timeouts this backend can keep, in ms, in the order offered (0 =
   * no idle timer: until Cinna quits). Empty: the vault's lock timeout cannot
   * be changed, and the Security tab hides its Lock after row.
   */
  lockTimeouts: readonly number[]
  /** `touch` restarts an unlocked vault's idle window (typing in its chat keeps it open). */
  idleTouch: boolean
}

export interface VaultAvailabilityDto {
  availability: VaultAvailability
  /** `apple-vz`, `fake`, `unavailable`, … */
  backend: string
  /** The helper's flavor once it said hello; anything but `release` shows a "Test helper" badge. */
  flavor: HelperFlavor | null
  capabilities: VaultCapabilities
}

/** One vault's status, by agent. */
export interface VaultStatusDto {
  agentId: string
  vaultId: string
  agentName: string
  engine: VaultEngine
  state: VaultState
  /** Epoch ms the unlock window ends; null while a turn holds it open, or with no timer (`lockAfterMs` 0). */
  until: number | null
  /** How long it stays unlocked after its last use (`VAULT_LOCK_TIMEOUTS`); 0 = until Cinna quits. */
  lockAfterMs: number
  sizeBytes: number
  usedBytes: number | null
  egress: EgressPolicy
  createdAt: number
  imageVersion: string
  /** Set when `state` is `error`. */
  error: string | null
  /**
   * Set when `state` is `tampered` because another build of Cinna made the
   * vault (a development build's vault met by the released app, or the other
   * way round): which build. Null when it is tampered for any other reason,
   * or the origin cannot be told.
   */
  otherBuild: HelperFlavor | null
}

/** A build of Cinna as the vault UI names it, by its helper's flavor. */
const BUILD_NAME: Record<HelperFlavor, string> = {
  dev: 'a development build of Cinna',
  test: 'a test build of Cinna',
  release: 'the released Cinna app',
  fake: 'a test build of Cinna'
}

/** The same builds, short: the Security tab's one-line status detail and the row menu's note. */
const BUILD_SHORT: Record<HelperFlavor, string> = {
  dev: 'a development build',
  test: 'a test build',
  release: 'the released app',
  fake: 'a test build'
}

/** The build that can still open a vault another build made, for "Open it in …". */
const BUILD_THAT_MADE_IT: Record<HelperFlavor, string> = {
  dev: 'the development build of Cinna',
  test: 'the test build of Cinna',
  release: 'the released Cinna app',
  fake: 'the test build of Cinna'
}

/**
 * Why a vault another build made can't be opened, in full: the message of
 * the `tampered` error its unlock (and any gated call) answers with, so every
 * surface that prints the error says it the same way. Each build keeps its
 * vault keys in its own keychain group, so this one cannot check or open it.
 */
export function vaultOtherBuildText(origin: HelperFlavor): string {
  return `This vault was made by ${BUILD_NAME[origin]}. This version can't open it: each build keeps its own vault keys.`
}

/** The build alone, short enough for the Security tab's one-line status detail at 800px. */
export function vaultOtherBuildShortText(origin: HelperFlavor): string {
  return `Made by ${BUILD_SHORT[origin]}`
}

/** Why Move out of vault is off for a vault another build made: only that build can read it. */
export function vaultOtherBuildMoveOutText(origin: HelperFlavor): string {
  return `Open it in ${BUILD_THAT_MADE_IT[origin]} to move it out.`
}

/** The Delete vault confirm's added sentence for a vault another build made. */
export function vaultOtherBuildDeleteText(origin: HelperFlavor): string {
  return `${BUILD_THAT_MADE_IT[origin].replace(/^the/, 'The')} made this vault and can still open it.`
}

/** A tampered vault's composer sentence when no other build explains it. */
export const VAULT_TAMPERED_TEXT = "This vault failed its integrity check and can't be opened."

/** Why a tampered vault can't be opened, in one sentence: another build made it, or it failed its check. */
export function vaultTamperedText(otherBuild: HelperFlavor | null | undefined): string {
  return otherBuild ? vaultOtherBuildText(otherBuild) : VAULT_TAMPERED_TEXT
}

/** `vault:state` push. */
export interface VaultStateEvent {
  agentId: string
  vaultId: string
  state: VaultState
  until: number | null
  lockAfterMs: number
  error: string | null
}

export const VAULT_STATE_CHANNEL = 'vault:state'

/**
 * `vault:unlock-progress` push: an unlock is first downloading the guest image
 * this version of Cinna pins (the first unlock after an update). `percent`
 * 0–100 while it downloads, null once it is done or failed.
 */
export interface VaultUnlockProgressEvent {
  agentId: string
  vaultId: string
  percent: number | null
}

export const VAULT_UNLOCK_PROGRESS_CHANNEL = 'vault:unlock-progress'

/** What an unlock's pending label says while it downloads the image. */
export function vaultImageDownloadText(percent: number): string {
  return `Downloading vault image… ${percent}%`
}

/** "4:32", "0:12": a vault's time to its lock, minutes and seconds, rounded up. */
export function formatVaultCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * `vault:chat-files-swept` push: the vault locked and the `userData` copies of
 * its chats' not-yet-sent attachments were deleted (D23). The ids, by chat,
 * so each composer draft can drop those chips and say why. Sent only for a
 * lock that removed something, never for the sweep at start.
 */
export interface VaultChatFilesSweptEvent {
  vaultId: string
  chats: VaultChatFilesSwept[]
}
export interface VaultChatFilesSwept {
  chatId: string
  attachmentIds: string[]
}

export const VAULT_CHAT_FILES_SWEPT_CHANNEL = 'vault:chat-files-swept'

/**
 * What a draft that lost files to a lock says, in place of its file error:
 * short, since it sits in the composer toolbar's one-line slot. Only Cinna's
 * staged copy went; the user's own file is untouched, so it says what to do.
 */
export function vaultChatFilesSweptText(count: number): string {
  return count === 1 ? 'Vault locked: attach the file again' : 'Vault locked: attach the files again'
}

/**
 * Readiness `vault_other_chat`: a vault agent in a chat that started before it
 * moved into its vault. The same words in the composer row and in the refusal
 * of a send there.
 */
export function vaultOtherChatReason(agentName: string): string {
  return `This chat started before ${agentName} moved into its vault. Start a new chat to talk to it.`
}

/**
 * Error codes a vault IPC answers with, as data (a thrown code does not cross
 * IPC). `denied` = the user cancelled the helper's prompt.
 */
export type VaultErrorCode =
  | 'unavailable'
  | 'not_found'
  | 'not_vault_agent'
  | 'locked'
  | 'denied'
  | 'busy'
  | 'invalid'
  | 'tampered'
  | 'internal'

export type VaultResult<T> = { ok: true; data: T } | { ok: false; code: VaultErrorCode; message: string }

// ---------------------------------------------------------------------------
// Open terminal (gated): a shell inside the vault over a MessagePort

/** Main → window: `open` once the shell is attached, its output, then exactly one `exit` or `error`. */
export type VaultTerminalEvent =
  | { type: 'open' }
  | { type: 'data'; data: Uint8Array }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; code: VaultErrorCode; message: string }

/** Window → main: keystrokes, the terminal's size (columns × rows), and the end of the session. */
export type VaultTerminalCommand =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'close' }

export interface VaultTerminalHandle {
  write(data: string): void
  /** The terminal's size; the shell's pty follows it (sent before `open` too: the shell starts at it). */
  resize(cols: number, rows: number): void
  close(): void
}

// ---------------------------------------------------------------------------
// Move to vault… / Move out / secrets / files (phase 1 + 2 surface)

export const VAULT_MOVE_PROGRESS_CHANNEL = 'vault:move-progress'

/** Steps of Move to vault…, in order (README "Moving an existing agent"). */
export const VAULT_MOVE_STEPS = [
  'create',
  'unlock',
  'approve',
  'runtime',
  'copy',
  'rebuild',
  'credentials',
  'check'
] as const
export type VaultMoveInStep = (typeof VAULT_MOVE_STEPS)[number]

/**
 * Steps of a change of engine on a vault agent, in order: set up the
 * engine's runtime, allow its hosts, store a key, then switch. Progress on
 * the move channel too; a step with nothing to do is `skipped`.
 */
export const VAULT_SWITCH_STEPS = ['runtime', 'egress', 'credentials', 'engine'] as const
export type VaultSwitchStep = (typeof VAULT_SWITCH_STEPS)[number]

/** Any step a `vault:move-progress` event names: a move in, Update dependencies (`rebuild`) or a switch of engine. */
export type VaultMoveStep = VaultMoveInStep | VaultSwitchStep

export type VaultPrecheckKind =
  | 'unsupported-engine'
  | 'mac-command'
  | 'macho-binary'
  | 'absolute-symlink'
  | 'host-mcp'
  | 'schedule'
  | 'delegation-grant'
  | 'pending-task'
  | 'pending-handover'
  | 'service-credential'
  | 'env-file'
  | 'git-remote'
  | 'time-machine'
  | 'external-root'
  | 'too-large'
  | 'engine-login'
  | 'python-lock'
  | 'python-wheels'

/** One finding of the pre-check. A `blocker` disables Move; `warning` and `info` are listed. */
export interface VaultPrecheckItem {
  kind: VaultPrecheckKind
  severity: 'blocker' | 'warning' | 'info'
  title: string
  detail?: string
  /** Folder-relative paths, at most 20. */
  paths?: string[]
}

export interface VaultPrecheckDto {
  agentId: string
  agentName: string
  engine: VaultEngine | null
  folderPath: string
  /** Bytes and files that would be copied (after exclusions). */
  copyBytes: number
  copyFiles: number
  items: VaultPrecheckItem[]
  canMove: boolean
  /** What the engine login inside will use: an API key must be pasted when the host is on subscription login. */
  needsApiKey: boolean
  /** The secret that key becomes inside (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`); null when the engine's provider is unknown. */
  apiKeyName: string | null
}

export interface VaultMoveOptions {
  sizeBytes?: number
  /** Claude: an Anthropic API key delivered with secrets.put (never stored by Cinna). */
  apiKey?: string
  /** Extra allowlisted hosts beyond the engine defaults. */
  extraHosts?: string[]
}

/** `vault:move-progress` push: one step changed, or a chunk of its output. */
export interface VaultMoveProgressEvent {
  moveId: string
  agentId: string
  step: VaultMoveStep
  status: 'running' | 'done' | 'failed' | 'skipped'
  message?: string
  /** Output to append under the step (rebuild, check). Never secrets. */
  output?: string
  /** On the final event of a failed move: the half-built vault is gone and the host folder untouched. */
  rolledBack?: boolean
  /** On success: what to rotate (README step 8). */
  rotation?: VaultRotationItem[]
  /**
   * On a final `done` whose agent did move in but a later step failed (the
   * list or the transcripts could not be refreshed): what went wrong. The move
   * itself stands; nothing is rolled back.
   */
  warning?: string
}

export interface VaultRotationItem {
  kind: 'service-credential' | 'env-key' | 'engine-login' | 'git-history'
  name: string
  detail?: string
  /** Opens Manage for a Core credential record. */
  credentialId?: string
}

/** A vault agent whose host folder still exists after a move, until the user deletes it. */
export interface VaultHostCopyDto {
  agentId: string
  folderPath: string
  inGitRepo: boolean
  gitRemote: string | null
  underTimeMachine: boolean
}

export interface VaultSecretListDto {
  names: string[]
}

/**
 * What a vault agent's settings page shows from inside its vault, read in one
 * go while it is unlocked (`vault:agent-details`). Read-only: nothing here is
 * saved back. Key names only, never values.
 */
export interface VaultAgentDetailsDto {
  /** `cinna-agent.json` as the folder agent's `manifest`; `{}` when missing or unreadable. */
  manifest: CinnaAgentManifest
  /** The manifest's `description`, '' when none. */
  description: string
  /** `STATUS.md`, parsed as the Status card reads it; null when the agent has written none. */
  status: LocalAgentStatusSummary | null
  /** The kit prompt documents; null for one the folder does not have. */
  docs: Record<LocalAgentPromptKind, { relPath: string; text: string } | null>
  /** Each declared credential slot, judged against the vault folder's `credentials/.env` names. */
  credentials: LocalAgentCredentialState[]
  /** How the vault launches the agent (`cinna.launch`): its approval mode, model and sealed or native launch. */
  launch: { kind: 'kit' | 'bare'; model: string | null; approval: ClaudeApproval }
}

export interface VaultEngineAuthDto {
  loggedIn: boolean
  method: 'api_key' | 'oauth_token' | 'login' | null
  /** The secret the engine signs in with in this vault (OpenCode's follows the agent's model provider); null: none. */
  keyName: string | null
}

/**
 * One engine a vault agent may run on, as the engine picker lists it:
 * `setUp` when its pinned runtime (and adapter) is installed in the vault,
 * `version` the installed executable's then.
 */
export interface VaultEngineChoiceDto {
  engine: VaultEngine
  setUp: boolean
  version: string | null
}

/** `vault:switch-engine` options. OpenCode always names its provider and model; a key is optional. */
export interface VaultSwitchEngineOptions {
  engine: VaultEngine
  provider?: VaultLaunchProvider
  model?: string
  apiKey?: string
}

export interface VaultRuntimeDto {
  engine: VaultEngine
  version: string
  kind: 'executable' | 'archive' | 'adapter'
  /** The pinned version this app would install; differs ⇒ Update dependencies offers it. */
  pinned: string | null
}

export interface VaultFileEntryDto {
  name: string
  type: 'file' | 'dir' | 'link'
  size: number
  mtime: number
}
