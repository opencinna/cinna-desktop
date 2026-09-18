import type { EngineBinaryState } from '../../../../shared/engine'
import { CLAUDE_CLI, cliStatusText, cliToolCell, cliVersionLabel } from './managedCliStatus'

/** The pinned **Claude Code CLI**'s sentences — `codexStatus.ts`'s twin over the same module. */
export const claudeStatusText = (binary: EngineBinaryState | undefined, configured = false): string =>
  cliStatusText(CLAUDE_CLI, binary, configured)

export const claudeVersionLabel = (binary: EngineBinaryState | undefined, configured = false): string =>
  cliVersionLabel(CLAUDE_CLI, binary, configured)

export const claudeToolCell = (binary: EngineBinaryState | undefined, configured = false): { text: string; mono: boolean } =>
  cliToolCell(CLAUDE_CLI, binary, configured)
