import type Database from 'better-sqlite3'

/**
 * `agent_mcp_providers` — MCP connectors attached to a folder agent as addons.
 * A link only: the connector stays in the global MCP list. Deleting either the
 * connector or the agent row removes the link. Creation only, no DML.
 */
export function migrateAgentMcpProviders(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_mcp_providers (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      mcp_provider_id TEXT NOT NULL REFERENCES mcp_providers(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, mcp_provider_id)
    );
    CREATE INDEX IF NOT EXISTS agent_mcp_providers_provider ON agent_mcp_providers(mcp_provider_id);
  `)
}
