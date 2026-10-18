import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { runtimeModelCatalogs } from './schema'
import type { AgentEngine } from '../../shared/engine'
import type { RuntimeModelCatalog } from '../../shared/runtimeModelCatalog'

/** One catalogue document per profile and runtime, kept across restarts. */
export const runtimeModelCatalogRepo = {
  get(userId: string, engine: AgentEngine): RuntimeModelCatalog | null {
    const row = getDb().select({ json: runtimeModelCatalogs.json }).from(runtimeModelCatalogs)
      .where(and(eq(runtimeModelCatalogs.userId, userId), eq(runtimeModelCatalogs.engine, engine))).get()
    return row?.json ?? null
  },
  save(userId: string, catalog: RuntimeModelCatalog): void {
    const updatedAt = new Date(catalog.updatedAt ?? Date.now())
    getDb().insert(runtimeModelCatalogs).values({ userId, engine: catalog.engine, json: catalog, updatedAt })
      .onConflictDoUpdate({ target: [runtimeModelCatalogs.userId, runtimeModelCatalogs.engine], set: { json: catalog, updatedAt } }).run()
  }
}
