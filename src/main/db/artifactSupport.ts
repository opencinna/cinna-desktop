import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { artifactSupport } from './schema'
import type { ArtifactLimits } from '../../shared/artifacts'

/** What is kept of a supported answer: the instance's name and limits. */
export interface RememberedArtifactSupport {
  instanceName?: string
  limits: ArtifactLimits
}

/**
 * The last supported artifacts answer per (profile, server), so a relaunch
 * offers Publish… before core has answered again. A definite "no artifacts"
 * forgets it. See `migrations/artifact-support.ts`.
 */
export const artifactSupportRepo = {
  get(profileUserId: string, serverUrl: string): RememberedArtifactSupport | null {
    const row = getDb()
      .select()
      .from(artifactSupport)
      .where(and(eq(artifactSupport.profileUserId, profileUserId), eq(artifactSupport.serverUrl, serverUrl)))
      .get()
    if (!row) return null
    return {
      ...(row.instanceName ? { instanceName: row.instanceName } : {}),
      limits: { maxRevisionBytes: row.maxRevisionBytes, maxRevisionFiles: row.maxRevisionFiles, maxFileBytes: row.maxFileBytes }
    }
  },

  set(profileUserId: string, serverUrl: string, support: RememberedArtifactSupport): void {
    const values = {
      instanceName: support.instanceName ?? null,
      maxRevisionBytes: support.limits.maxRevisionBytes,
      maxRevisionFiles: support.limits.maxRevisionFiles,
      maxFileBytes: support.limits.maxFileBytes,
      updatedAt: new Date()
    }
    getDb()
      .insert(artifactSupport)
      .values({ profileUserId, serverUrl, ...values })
      .onConflictDoUpdate({ target: [artifactSupport.profileUserId, artifactSupport.serverUrl], set: values })
      .run()
  },

  forget(profileUserId: string, serverUrl: string): void {
    getDb()
      .delete(artifactSupport)
      .where(and(eq(artifactSupport.profileUserId, profileUserId), eq(artifactSupport.serverUrl, serverUrl)))
      .run()
  }
}
