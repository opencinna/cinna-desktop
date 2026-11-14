/**
 * Where an agent's files live, as the agent-file service sees it (hub core).
 *
 * The service validates, applies the rules every file reference shares (files
 * only, never a credential file, the preview kinds, the caps) and maps the
 * result; an {@link AgentFileSource} answers what is particular to the place:
 * which references resolve, what a path names, the bytes, and the actions it
 * supports. Today: a folder on this computer (`hostFolderSource.ts`) and an
 * Agent Vault (`vaultFileSource.ts`). {@link createFileSourceFor} is the only
 * place that tells them apart.
 */
import type {
  AgentFileActionResult,
  AgentFileActions,
  AgentFileErrorCode,
  AgentFileFailure,
  AgentFileRefKind,
  AuthorizeAgentFileResult,
  DownloadAgentFileResult,
  FileRefEntry,
  ResolveAgentFileRefsResult
} from '../../../shared/agentFiles'
import { isVaultAgent, VaultAgentRefused } from '../../vault/isVaultAgent'
import type { ConsentPrompt } from './consent'

export const AGENT_FILE_MESSAGES: Record<AgentFileErrorCode, string> = {
  invalid_input: 'Nothing to open.',
  agent_not_found: 'That agent is no longer in your agents folder.',
  not_found: 'That file is no longer there.',
  needs_consent: 'Cinna needs your approval to use a file outside the agent folder.',
  credential_file: 'Preview is off for credential files.',
  not_previewable: 'No preview for this file type.',
  not_a_file: 'That is a folder, not a file.',
  read_failed: 'Could not read the file.',
  launch_failed: 'Could not open the file.',
  too_large: 'This file is too large.',
  not_text: "This isn't a text file.",
  locked: 'Unlock the vault to use this file.',
  denied: 'Cancelled at the prompt.',
  unsupported: "That isn't available for this file."
}

export function fail(code: AgentFileErrorCode, error: string = AGENT_FILE_MESSAGES[code]): AgentFileFailure {
  return { success: false, code, error }
}

export function isFailure(value: object): value is AgentFileFailure {
  return 'success' in value && (value as { success: unknown }).success === false
}

/** A path the source located, allowed and stat-ed: what every read and action starts from. */
export interface AgentFileTarget {
  agentId: string
  /** The path as the renderer named it. */
  requested: string
  /** Where it really is: the canonical realpath on this computer, or the realpath inside the vault. */
  real: string
  kind: AgentFileRefKind
  inside: boolean
  /** The credential-file rule, applied by the source to every spelling it knows. */
  credential: boolean
}

/** Bytes of a target, and the file's size when it was opened. */
export type AgentFileReadResult = { success: true; bytes: Buffer; size: number } | AgentFileFailure

export interface AgentFileSource {
  /** What the renderer may offer for this source's references; main refuses the rest. */
  readonly actions: AgentFileActions
  /** Which entries name a real file or folder; `entries` are already cleaned. */
  resolve(agentId: string, entries: FileRefEntry[]): Promise<ResolveAgentFileRefsResult>
  /**
   * Locates the agent, checks the path is one Cinna may use (inside the
   * folder, or approved) and stats it. `input` is untrusted.
   */
  stat(input: unknown): Promise<AgentFileTarget | AgentFileFailure>
  /**
   * Reads what {@link stat} checked. `whole: false`: the first
   * `min(size, maxBytes)` bytes. `whole: true`: refuses `too_large` when the
   * file is over `maxBytes`, and reads one byte past its size, so a file that
   * grew shows as `bytes.length > size` (the caller decides).
   */
  read(target: AgentFileTarget, options: { maxBytes: number; whole: boolean }): Promise<AgentFileReadResult>
  /** Asks the user before a path outside the folder is used; absent, a path {@link stat} allows is approved. */
  authorize?(input: unknown, prompt: ConsentPrompt): Promise<AuthorizeAgentFileResult>
  open?(input: unknown): Promise<AgentFileActionResult>
  openInBrowser?(input: unknown): Promise<AgentFileActionResult>
  reveal?(input: unknown): Promise<AgentFileActionResult>
  /** **Download**: a copy saved where the user says, behind whatever gate the source keeps. */
  exportFile?(target: AgentFileTarget): Promise<DownloadAgentFileResult>
}

/** Stands in for the vault source where none is wired: every call says the agent's files are not reachable. */
export function refusingVaultSource(): AgentFileSource {
  const refuse = async (): Promise<AgentFileFailure> => fail('agent_not_found', new VaultAgentRefused('File preview').message)
  return {
    actions: {
      preview: false, previewImages: false, open: false, reveal: false, openInBrowser: false,
      readText: false, pin: false, publish: false, run: false, reference: false, download: false, copyPath: false
    },
    resolve: refuse,
    stat: refuse,
    read: refuse
  }
}

/**
 * The one place that knows a vault agent's files are not in a folder here:
 * the source for an agent id.
 */
export function createFileSourceFor(sources: {
  host: AgentFileSource
  vault: AgentFileSource
}): (agentId: string) => AgentFileSource {
  return (agentId) => (isVaultAgent(agentId) ? sources.vault : sources.host)
}
