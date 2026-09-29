import type {
  AgentFileErrorCode,
  AgentFileRef,
  AuthorizeAgentFileInput,
  AuthorizeAgentFileResult
} from '../../../shared/agentFiles'
import { unwrapIpcError } from './ipcError'

/**
 * Whether the renderer may act on a path. Always main's answer, inside the
 * agent folder too: the renderer's `inside` flag was true when the transcript
 * resolved and may not be now (the file became a symlink out of the folder).
 * Main answers an inside path without a dialog and asks natively otherwise.
 */
export function authorizeAgentFile(input: AuthorizeAgentFileInput): Promise<AuthorizeAgentFileResult> {
  return window.api.agentFiles.authorize(input)
}

export type AgentFileTextOutcome =
  | { status: 'text'; text: string }
  /** The user declined the consent dialog: nothing is read and nothing is said. */
  | { status: 'denied' }
  /** `code` is null when a call threw rather than answering. */
  | { status: 'failed'; code: AgentFileErrorCode | null; error: string }

/**
 * A referenced file's whole text: authorize (asking the user for a path outside
 * the agent folder), then read. Never throws; failures come back as data with
 * main's reason.
 */
export async function readAgentFileText(
  agentId: string,
  ref: AgentFileRef,
  options: {
    /** Told when the authorize call — during which main may show its consent dialog — starts and ends. */
    onAuthorize?: (pending: boolean) => void
  } = {}
): Promise<AgentFileTextOutcome> {
  const input = { agentId, path: ref.path }
  try {
    let access: AuthorizeAgentFileResult
    options.onAuthorize?.(true)
    try {
      access = await authorizeAgentFile({ ...input, purpose: 'read' })
    } finally {
      options.onAuthorize?.(false)
    }
    if (!access.success) return { status: 'failed', code: access.code, error: access.error }
    if (!access.approved) return { status: 'denied' }
    const result = await window.api.agentFiles.readText(input)
    if (!result.success) return { status: 'failed', code: result.code, error: result.error }
    return { status: 'text', text: result.text }
  } catch (err) {
    return { status: 'failed', code: null, error: unwrapIpcError(err, 'Could not read the file.') }
  }
}
