import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { runtimeModelCatalogs } from './schema'
import type { RuntimeModelCatalog } from '../../shared/runtimeModelCatalog'

/**
 * One catalogue document per profile and runtime slot, kept across restarts.
 * The `engine` column holds the slot: the engine id, or `<engine>:<variant>`
 * when one runtime keeps a catalogue per login (Claude on an API token is
 * `claude:api_key`). The document's own `engine` stays the bare id.
 */
export const runtimeModelCatalogRepo = {
  get(userId: string, slot: string): RuntimeModelCatalog | null {
    const row = getDb().select({ json: runtimeModelCatalogs.json }).from(runtimeModelCatalogs)
      .where(and(eq(runtimeModelCatalogs.userId, userId), eq(runtimeModelCatalogs.engine, slot))).get()
    return row?.json ?? null
  },
  save(userId: string, slot: string, catalog: RuntimeModelCatalog): void {
    const updatedAt = new Date(catalog.updatedAt ?? Date.now())
    getDb().insert(runtimeModelCatalogs).values({ userId, engine: slot, json: catalog, updatedAt })
      .onConflictDoUpdate({ target: [runtimeModelCatalogs.userId, runtimeModelCatalogs.engine], set: { json: catalog, updatedAt } }).run()
  }
}
