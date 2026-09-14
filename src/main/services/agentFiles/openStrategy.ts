import {
  BINARY_DOCUMENT_EXTENSIONS,
  TEXT_DOCUMENT_EXTENSIONS,
  agentFileExtension,
  isCredentialFilePath,
  type AgentFileOpenStrategy,
  type AgentFileRefKind
} from '../../../shared/agentFiles'
import { isLocalToolId, type DetectedTool, type LocalToolId } from '../../../shared/localTools'

export interface OpenStrategyInput {
  kind: AgentFileRefKind
  filename: string
  platform: NodeJS.Platform
  /** The user's default tool is an installed editor. */
  hasDefaultEditor: boolean
}

/**
 * How **Open** hands a file to the OS. Pure, and ordered so that nothing on
 * the way can execute the file:
 *  - a binary document (pdf, spreadsheet, image…) goes to the system app, even
 *    when a default editor is set — an editor would show it as bytes;
 *  - text and code go to the default editor when there is one;
 *  - else a text document type goes to the system app;
 *  - else macOS `open -t` is the text editor, and anywhere else the file is
 *    only selected in the file manager.
 * A folder is always revealed. The system app is reached only for an
 * allowlisted type.
 *
 * A credential file never reaches the system app: `.key` is a Keynote
 * document to the OS and a private key to the agent that wrote it, so the
 * name alone cannot tell which. It goes to the editor, else `open -t`, else
 * a reveal.
 */
export function chooseOpenStrategy(input: OpenStrategyInput): AgentFileOpenStrategy {
  if (input.kind === 'dir') return 'reveal'
  if (isCredentialFilePath(`/${input.filename}`, null)) {
    if (input.hasDefaultEditor) return 'editor'
    return input.platform === 'darwin' ? 'text-editor' : 'reveal'
  }
  const extension = agentFileExtension(input.filename)
  if (BINARY_DOCUMENT_EXTENSIONS.includes(extension)) return 'default-app'
  if (input.hasDefaultEditor) return 'editor'
  if (TEXT_DOCUMENT_EXTENSIONS.includes(extension)) return 'default-app'
  if (input.platform === 'darwin') return 'text-editor'
  return 'reveal'
}

/** The user's default tool (`localAgentsDefaultTool`) when it is an installed editor. */
export async function findDefaultEditor(
  setting: string,
  getTool: (id: LocalToolId) => Promise<DetectedTool | undefined>
): Promise<(DetectedTool & { path: string }) | null> {
  if (!isLocalToolId(setting)) return null
  const tool = await getTool(setting)
  if (!tool || !tool.available || !tool.path || tool.kind !== 'editor') return null
  return tool as DetectedTool & { path: string }
}
