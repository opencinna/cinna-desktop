import type { LocalAgentDto, AgentRootDto } from '../../src/shared/localAgents'
import { homeDir, type CinnaApp } from './app'

/**
 * Arrange steps, through the same IPC the UI uses. A test asserts on the step
 * it is about and seeds everything before it here: seconds via `window.api`
 * against minutes of click choreography that breaks on every layout change.
 */

/** Register `<sandbox home>/<name>` as an agents root, through the (stubbed) OS picker. */
export async function addAgentRoot(cinna: CinnaApp, name = 'agents-root'): Promise<AgentRootDto> {
  const dir = homeDir(cinna, name)
  await cinna.stubDirectoryPicker(dir)
  const added = await cinna.page.evaluate(() => window.api.localAgents.rootAdd())
  if (added.cancelled) throw new Error('the stubbed directory picker reported cancelled')
  return added.root
}

/** Scaffold a folder agent into `root` from the bundled kit contract. */
export async function createFolderAgent(
  cinna: CinnaApp,
  root: AgentRootDto,
  name: string,
  description = `${name}, scaffolded by the E2E suite.`
): Promise<LocalAgentDto> {
  return cinna.page.evaluate(
    (input) => window.api.localAgents.create(input),
    { rootId: root.id, name, description }
  )
}
