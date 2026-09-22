import { getRawSqlite } from './client'
import type { ServiceCredentialDto } from '../../shared/serviceCredentials'
export interface ServiceCredentialRow {
  id: string; user_id: string; origin: 'local' | 'cloud'; cloud_id: string | null
  server_origin: string | null; metadata: string; payload_enc: Buffer | null
  payload_fetched_at: number | null; expires_at: number | null; created_at: number; updated_at: number
}
export function credentialDto(row: ServiceCredentialRow): ServiceCredentialDto {
  return { ...JSON.parse(row.metadata), id: row.id, origin: row.origin, cloudId: row.cloud_id,
    hasValues: !!row.payload_enc, expiresAt: row.expires_at }
}
export const serviceCredentialRepo = {
  list(userId: string): ServiceCredentialRow[] {
    return getRawSqlite().prepare('SELECT * FROM service_credentials WHERE user_id = ? ORDER BY created_at, id').all(userId) as ServiceCredentialRow[]
  },
  get(id: string): ServiceCredentialRow | undefined {
    return getRawSqlite().prepare('SELECT * FROM service_credentials WHERE id = ?').get(id) as ServiceCredentialRow | undefined
  },
  put(row: ServiceCredentialRow): void {
    getRawSqlite().prepare(`INSERT INTO service_credentials VALUES (@id,@user_id,@origin,@cloud_id,@server_origin,@metadata,@payload_enc,@payload_fetched_at,@expires_at,@created_at,@updated_at)
      ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,payload_enc=excluded.payload_enc,payload_fetched_at=excluded.payload_fetched_at,expires_at=excluded.expires_at,updated_at=excluded.updated_at`).run(row)
  },
  remove(id: string): void { getRawSqlite().prepare('DELETE FROM service_credentials WHERE id = ?').run(id) },
  clearProfile(userId: string): void { getRawSqlite().prepare('DELETE FROM service_credentials WHERE user_id = ? AND origin = ?').run(userId, 'cloud') }
}
