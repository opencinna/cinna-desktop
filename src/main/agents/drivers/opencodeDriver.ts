/**
 * The `opencode` driver: a folder agent on the managed `opencode serve`,
 * through `LocalAgentTurnRunner`, unchanged.
 *
 * Readiness is the folder's alone. Whether the engine is running is not
 * readiness: the turn starts it (`ensureEngineRunning`), and a list must never
 * start a process to answer "can this agent run".
 */
import { createFolderDriver, type FolderDriver, type FolderDriverDeps } from './folderDriver'

export type OpencodeDriverDeps = FolderDriverDeps

export function createOpencodeDriver(deps: OpencodeDriverDeps): FolderDriver {
  return createFolderDriver('opencode', deps)
}
