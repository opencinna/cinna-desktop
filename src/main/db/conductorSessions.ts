import { getRawSqlite } from './client'

/** Only a descriptor digest is durable; the loopback bearer credential stays in main memory. */
export const conductorSessionRepo = {
  get(chatId: string, agentId: string): string | null {
    const row = getRawSqlite().prepare('SELECT descriptor_hash FROM conductor_sessions WHERE chat_id = ? AND agent_id = ?').get(chatId, agentId) as { descriptor_hash: string } | undefined
    return row?.descriptor_hash ?? null
  },
  save(chatId: string, agentId: string, hash: string): void {
    getRawSqlite().prepare('INSERT INTO conductor_sessions (chat_id, agent_id, descriptor_hash) VALUES (?, ?, ?) ON CONFLICT(chat_id, agent_id) DO UPDATE SET descriptor_hash=excluded.descriptor_hash').run(chatId, agentId, hash)
  }
}
