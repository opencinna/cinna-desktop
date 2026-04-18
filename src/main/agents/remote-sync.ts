/**
 * Remote agent sync — fetches agents from the Cinna backend's External Agent Access API
 * and upserts them into the local agents table.
 *
 * Remote agents use the same A2A protocol as local agents, but authenticate
 * with the user's Cinna JWT instead of a per-agent access token.
 */
import { eq, and } from 'drizzle-orm'
import { getDb } from '../db/client'
import { users, agents } from '../db/schema'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { nanoid } from 'nanoid'
import { createLogger } from '../logger/logger'
import { getMainWindow } from '../index'

const logger = createLogger('remote-sync')

/** Shape of a target returned by GET /api/v1/external/agents */
interface ExternalTarget {
  target_type: 'agent' | 'app_mcp_route' | 'identity'
  target_id: string
  name: string
  description: string | null
  entrypoint_prompt: string | null
  example_prompts: string[]
  session_mode: string | null
  ui_color_preset: string | null
  agent_card_url: string
  protocol_versions: string[]
  metadata: Record<string, unknown>
}

interface ExternalAgentListResponse {
  targets: ExternalTarget[]
}

/** Deterministic local ID for a remote agent */
function remoteAgentLocalId(targetType: string, targetId: string): string {
  return `remote:${targetType}:${targetId}`
}

let syncInterval: ReturnType<typeof setInterval> | null = null

const SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Fetch remote agents from the Cinna backend and upsert into local DB.
 * Removes local remote agents that no longer appear in the backend response.
 */
export async function syncRemoteAgents(userId: string): Promise<{ synced: number; removed: number }> {
  const db = getDb()
  const user = db.select().from(users).where(eq(users.id, userId)).get()

  if (!user || user.type !== 'cinna_user' || !user.cinnaServerUrl) {
    return { synced: 0, removed: 0 }
  }

  let accessToken: string
  try {
    accessToken = await getCinnaAccessToken(userId)
  } catch {
    console.warn('[remote-sync] Could not get Cinna access token, skipping sync')
    return { synced: 0, removed: 0 }
  }

  const baseUrl = user.cinnaServerUrl.replace(/\/$/, '')
  let targets: ExternalTarget[]

  try {
    const response = await fetch(`${baseUrl}/api/v1/external/agents`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    })
    if (!response.ok) {
      console.warn(`[remote-sync] Backend returned ${response.status}, skipping sync`)
      return { synced: 0, removed: 0 }
    }
    const data = (await response.json()) as ExternalAgentListResponse
    targets = data.targets ?? []
  } catch (err) {
    logger.warn('Failed to fetch remote agents', { error: String(err) })
    return { synced: 0, removed: 0 }
  }

  logger.info(`Fetched ${targets.length} remote agents from ${baseUrl}`)

  // Upsert each target into the local agents table
  const remoteIds = new Set<string>()
  let synced = 0

  for (const target of targets) {
    const localId = remoteAgentLocalId(target.target_type, target.target_id)
    remoteIds.add(localId)

    const existing = db.select().from(agents).where(eq(agents.id, localId)).get()

    const skills = extractSkills(target)
    const remoteMetadata: Record<string, unknown> = {
      entrypoint_prompt: target.entrypoint_prompt,
      example_prompts: target.example_prompts,
      session_mode: target.session_mode,
      ui_color_preset: target.ui_color_preset,
      protocol_versions: target.protocol_versions,
      ...target.metadata
    }

    if (existing) {
      db.update(agents)
        .set({
          name: target.name,
          description: target.description,
          cardUrl: target.agent_card_url,
          skills,
          remoteTargetType: target.target_type,
          remoteTargetId: target.target_id,
          remoteMetadata
        })
        .where(eq(agents.id, localId))
        .run()
    } else {
      db.insert(agents)
        .values({
          id: localId,
          userId,
          name: target.name,
          description: target.description,
          protocol: 'a2a',
          cardUrl: target.agent_card_url,
          endpointUrl: null,
          protocolInterfaceUrl: null,
          protocolInterfaceVersion: null,
          accessTokenEncrypted: null,
          cardData: null,
          skills,
          enabled: true,
          source: 'remote',
          remoteTargetType: target.target_type,
          remoteTargetId: target.target_id,
          remoteMetadata,
          createdAt: new Date()
        })
        .run()
    }
    synced++
  }

  // Remove local remote agents that are no longer in the backend response
  const localRemoteAgents = db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.source, 'remote')))
    .all()

  let removed = 0
  for (const agent of localRemoteAgents) {
    if (!remoteIds.has(agent.id)) {
      db.delete(agents).where(eq(agents.id, agent.id)).run()
      removed++
    }
  }

  if (removed > 0) {
    logger.info(`Removed ${removed} stale remote agents`)
  }

  return { synced, removed }
}

/**
 * Start periodic sync for a user. Stops any existing interval first.
 */
export function startPeriodicSync(userId: string): void {
  stopPeriodicSync()
  syncInterval = setInterval(() => {
    syncRemoteAgents(userId)
      .then(() => {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('agents:remote-sync-complete')
        }
      })
      .catch((err) => {
        console.warn('[remote-sync] Periodic sync failed:', String(err))
      })
  }, SYNC_INTERVAL_MS)
}

/**
 * Stop periodic sync.
 */
export function stopPeriodicSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
  }
}

/** Extract skills from target metadata or example prompts */
function extractSkills(target: ExternalTarget): Array<{ id: string; name: string; description?: string }> | null {
  // For identity targets, metadata may contain agent_count and binding info
  // For agent/route targets, skills come from the agent card (fetched later)
  // For now, synthesize skills from example_prompts if available
  if (target.example_prompts.length > 0) {
    return target.example_prompts.slice(0, 5).map((prompt, i) => ({
      id: `example-${i}`,
      name: prompt.length > 50 ? prompt.slice(0, 47) + '...' : prompt,
      description: prompt
    }))
  }
  return null
}
