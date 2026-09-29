import { eq } from 'drizzle-orm'
import { getDb } from './client'
import { sessionTelemetry } from './schema'
import type { SessionTelemetry } from '../../shared/sessionTelemetry'

/** One JSON document per chat: the last known telemetry of its agent session. */
export const sessionTelemetryRepo = {
  get(chatId: string): SessionTelemetry | null {
    const row = getDb().select({ json: sessionTelemetry.json }).from(sessionTelemetry)
      .where(eq(sessionTelemetry.chatId, chatId)).get()
    return row?.json ?? null
  },
  save(telemetry: SessionTelemetry): void {
    const updatedAt = new Date(telemetry.updatedAt)
    getDb().insert(sessionTelemetry).values({ chatId: telemetry.chatId, json: telemetry, updatedAt })
      .onConflictDoUpdate({ target: sessionTelemetry.chatId, set: { json: telemetry, updatedAt } }).run()
  },
  delete(chatId: string): void {
    getDb().delete(sessionTelemetry).where(eq(sessionTelemetry.chatId, chatId)).run()
  }
}
