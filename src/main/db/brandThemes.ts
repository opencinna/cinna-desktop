import { eq, inArray } from 'drizzle-orm'
import { getDb } from './client'
import { brandThemeAssets, brandThemes } from './schema'
import { servedAssetShas } from '../../shared/brandTheme/servedAssets'

/**
 * The last good brand theme per Cinna server origin (README B9), and its
 * assets by sha256. The row holds the served document as core sent it, so a
 * cached theme is checked again by the same parser on the way out — nothing
 * here trusts the bytes. Assets are shared between rows and pruned when no
 * row references them any more.
 */

export interface BrandThemeRow {
  origin: string
  revision: number
  etag: string | null
  /** The served document, parsed JSON; null when the stored text is not JSON. */
  served: unknown
  fetchedAt: Date
}

export interface BrandThemeAssetRow {
  sha256: string
  mime: string
  bytes: Buffer
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

/** Delete every asset no stored theme references. Inside the caller's transaction. */
function pruneAssets(tx: Tx): void {
  const referenced = new Set<string>()
  for (const row of tx.select({ json: brandThemes.themeJson }).from(brandThemes).all()) {
    try {
      for (const sha of servedAssetShas(JSON.parse(row.json))) referenced.add(sha)
    } catch {
      // An unreadable row references nothing.
    }
  }
  const stored = tx.select({ sha256: brandThemeAssets.sha256 }).from(brandThemeAssets).all()
  const orphans = stored.map((r) => r.sha256).filter((sha) => !referenced.has(sha))
  if (orphans.length) tx.delete(brandThemeAssets).where(inArray(brandThemeAssets.sha256, orphans)).run()
}

export const brandThemeRepo = {
  get(origin: string): BrandThemeRow | null {
    const row = getDb().select().from(brandThemes).where(eq(brandThemes.origin, origin)).get()
    if (!row) return null
    let served: unknown = null
    try {
      served = JSON.parse(row.themeJson)
    } catch {
      served = null
    }
    return { origin: row.origin, revision: row.revision, etag: row.etag ?? null, served, fetchedAt: row.fetchedAt }
  },

  /** The stored assets among `shas`, by sha256. */
  assets(shas: readonly string[]): Map<string, BrandThemeAssetRow> {
    const out = new Map<string, BrandThemeAssetRow>()
    if (!shas.length) return out
    const rows = getDb().select().from(brandThemeAssets).where(inArray(brandThemeAssets.sha256, [...shas])).all()
    for (const row of rows) out.set(row.sha256, { sha256: row.sha256, mime: row.mime, bytes: Buffer.from(row.bytes) })
    return out
  },

  /**
   * Replace an origin's theme and store its assets, in one synchronous
   * transaction (no await can split it), then prune assets nothing references.
   */
  save(entry: { origin: string; revision: number; etag: string | null; served: unknown; assets: readonly BrandThemeAssetRow[] }): void {
    const themeJson = JSON.stringify(entry.served)
    const fetchedAt = new Date()
    getDb().transaction((tx) => {
      for (const asset of entry.assets) {
        tx.insert(brandThemeAssets)
          .values({ sha256: asset.sha256, mime: asset.mime, bytes: asset.bytes })
          .onConflictDoNothing()
          .run()
      }
      tx.insert(brandThemes)
        .values({ origin: entry.origin, revision: entry.revision, etag: entry.etag, themeJson, fetchedAt })
        .onConflictDoUpdate({
          target: brandThemes.origin,
          set: { revision: entry.revision, etag: entry.etag, themeJson, fetchedAt }
        })
        .run()
      pruneAssets(tx)
    })
  },

  /** Forget an origin's theme (the server unpublished it) and the assets only it used. */
  delete(origin: string): void {
    getDb().transaction((tx) => {
      tx.delete(brandThemes).where(eq(brandThemes.origin, origin)).run()
      pruneAssets(tx)
    })
  }
}
