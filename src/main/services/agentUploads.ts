import { join } from 'path'
import { runtimeHost } from '../host/runtimeHost'

/**
 * The folder a local agent's attachments are copied to for its engine to open
 * (`acpAttachments`). A kit folder keeps them in its own `app-data/uploads/`,
 * as on cinna-core; anything else (a bare folder is somebody's working tree, a
 * build workspace or custom agent's cwd is not ours either) gets a
 * desktop-owned folder per agent.
 */
export function agentUploadsDir(agentId: string, kitFolder: string | null): string {
  return kitFolder ? join(kitFolder, 'app-data', 'uploads') : join(runtimeHost.getPath('userData'), 'agent-uploads', agentId)
}
