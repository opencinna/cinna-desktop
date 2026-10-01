import { and, asc, eq, sql } from 'drizzle-orm'
import { getDb } from './client'
import { agentMcpProviders, agents, mcpProviders } from './schema'

/**
 * MCP connectors attached to a folder agent as addons. Keyed by `agents.id`:
 * a stamp re-key moves the links with the row (`agentRepo.rekeyFolderRow`),
 * and an agent or connector deleted takes them with it (FK cascade).
 *
 * Reads are filtered by the connector's owner — the settings scope the agent
 * and the MCP list both live in — so a link never offers another scope's
 * connector.
 */
export const agentMcpRepo = {
  /** Attached connector ids owned by `ownerId`, oldest attachment first. */
  listProviderIds(ownerId: string, agentId: string): string[] {
    return getDb()
      .select({ id: agentMcpProviders.mcpProviderId })
      .from(agentMcpProviders)
      .innerJoin(mcpProviders, eq(mcpProviders.id, agentMcpProviders.mcpProviderId))
      .where(and(eq(agentMcpProviders.agentId, agentId), eq(mcpProviders.userId, ownerId)))
      .orderBy(asc(agentMcpProviders.createdAt), sql`${agentMcpProviders}.rowid`)
      .all()
      .map((r) => r.id)
  },

  /** Idempotent: attaching twice keeps the first attachment time. */
  attach(agentId: string, mcpProviderId: string): boolean {
    return (
      getDb()
        .insert(agentMcpProviders)
        .values({ agentId, mcpProviderId })
        .onConflictDoNothing()
        .run().changes > 0
    )
  },

  detach(agentId: string, mcpProviderId: string): boolean {
    return (
      getDb()
        .delete(agentMcpProviders)
        .where(
          and(
            eq(agentMcpProviders.agentId, agentId),
            eq(agentMcpProviders.mcpProviderId, mcpProviderId)
          )
        )
        .run().changes > 0
    )
  },

  /** The agents (of `ownerId`) a connector is attached to, oldest attachment first. */
  agentsUsing(ownerId: string, mcpProviderId: string): { id: string; name: string }[] {
    return getDb()
      .select({ id: agents.id, name: agents.name })
      .from(agentMcpProviders)
      .innerJoin(agents, eq(agents.id, agentMcpProviders.agentId))
      .where(and(eq(agentMcpProviders.mcpProviderId, mcpProviderId), eq(agents.userId, ownerId)))
      .orderBy(asc(agentMcpProviders.createdAt), sql`${agentMcpProviders}.rowid`)
      .all()
  },

  /** Every agent with this connector attached, any owner — for tool-change fan-out. */
  agentIdsFor(mcpProviderId: string): string[] {
    return getDb()
      .select({ id: agentMcpProviders.agentId })
      .from(agentMcpProviders)
      .where(eq(agentMcpProviders.mcpProviderId, mcpProviderId))
      .all()
      .map((r) => r.id)
  }
}
