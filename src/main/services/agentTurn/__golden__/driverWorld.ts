/**
 * What the golden suites need to drive a **driver** rather than a runner.
 *
 * Phase 2 of the agent runtime plan moved every golden subject up one layer: a
 * turn goes through the `AgentDriver` that production dispatches to, and the
 * driver wraps the same runner the suite's fakes construct. So a golden that
 * goes through a driver pins exactly the stream it pinned when it called the
 * runner, plus whatever the driver itself does around it.
 *
 * A driver takes an `AgentRow` and a small world beside its runner. These build
 * both from what each suite already has, and nothing else.
 */
import type { AgentRow } from '../../../db/agents'
import type {
  FolderDriver,
  FolderDriverId,
  FolderView
} from '../../../agents/drivers/folderDriver'

/**
 * A whole `agents` row. Every column is written out, so a column added to the
 * schema fails to compile here rather than reaching a driver as `undefined`.
 */
export function goldenRow(
  fields: Pick<AgentRow, 'id' | 'name' | 'driver' | 'source'> & Partial<AgentRow>
): AgentRow {
  return {
    userId: '__default__',
    description: null,
    protocol: 'a2a',
    cardUrl: null,
    endpointUrl: null,
    protocolInterfaceUrl: null,
    protocolInterfaceVersion: null,
    accessTokenEncrypted: null,
    cardData: null,
    skills: null,
    enabled: true,
    remoteTargetType: null,
    remoteTargetId: null,
    remoteMetadata: null,
    createdBySync: false,
    localPath: null,
    localRootId: null,
    driverConfig: null,
    createdAt: new Date(0),
    ...fields
  }
}

/** The part of a runner's own `getAgent` view a folder driver reads. */
interface AgentView {
  name: string
  enabled: boolean
  readiness: string
  readinessReason: string | null
}

/**
 * A folder driver's `readFolder`, answered from the runner's own `getAgent`
 * fake, with a runtime naming `engine` — the driver under test, so the
 * reconcile keeps the turn where the suite put it. A folder that is gone reads
 * as null, as production's does.
 */
export function folderReader(
  getAgent: (userId: string, agentId: string) => AgentView | null,
  engine: FolderDriverId
): (userId: string, agentId: string) => FolderView | null {
  return (userId, agentId) => {
    const agent = getAgent(userId, agentId)
    return agent
      ? {
          name: agent.name,
          enabled: agent.enabled,
          readiness: agent.readiness,
          readinessReason: agent.readinessReason,
          runtime: { engine }
        }
      : null
  }
}

/**
 * The sibling a golden folder driver is handed: one that fails loudly if the
 * reconcile ever gives it a turn.
 *
 * Without a sibling the reconcile falls back to the driver itself, so a subject
 * whose folder named the other engine would run here anyway and pass. With
 * this one, that turn rejects — which the goldens and the contract's
 * never-rejects clause both catch.
 */
export function wrongEngine(underTest: FolderDriverId): (id: FolderDriverId) => FolderDriver {
  return (id) => {
    const message = `golden: the ${underTest} driver handed its turn to the ${id} driver`
    const refuse = (): never => {
      throw new Error(message)
    }
    return {
      id,
      capabilities: refuse,
      respond: refuse,
      readiness: () => Promise.reject(new Error(message)),
      run: () => Promise.reject(new Error(message)),
      runHere: () => Promise.reject(new Error(message))
    }
  }
}
