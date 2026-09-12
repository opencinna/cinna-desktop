/**
 * What the golden suites need to drive a **driver** rather than a runner.
 *
 * One helper left: phase 3 replaced the two folder drivers with the ACP driver,
 * whose own suite builds its rows and its world from the fake agent, so the
 * `folderReader` and `wrongEngine` stand-ins that existed to keep a golden turn
 * on the driver under test went with them.
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
