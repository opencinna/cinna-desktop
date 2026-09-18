import type { EngineBinaryState } from '../../../../shared/engine'
import { CODEX_CLI, cliStatusText, cliToolCell, cliVersionLabel } from './managedCliStatus'

/**
 * The managed **Codex CLI**'s sentences. The wording lives in
 * `managedCliStatus.ts`, shared with Claude Code; these are that module applied
 * to Codex, kept so a caller reads `codexStatusText(binary)` and not a tuple.
 *
 * `configured` — a Codex Path is saved — is what keeps a row from claiming the
 * managed pin while the user's own file is what will run, or has just failed to.
 */
export const codexStatusText = (binary: EngineBinaryState | undefined, configured = false): string =>
  cliStatusText(CODEX_CLI, binary, configured)

export const codexVersionLabel = (binary: EngineBinaryState | undefined, configured = false): string =>
  cliVersionLabel(CODEX_CLI, binary, configured)

export const codexToolCell = (binary: EngineBinaryState | undefined, configured = false): { text: string; mono: boolean } =>
  cliToolCell(CODEX_CLI, binary, configured)
