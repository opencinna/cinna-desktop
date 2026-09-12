import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ watermark: 0, updatedAt: 1000, title: 'initial', push: vi.fn() }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
vi.mock('../db/sync', () => ({ syncRepo: {
  ensureState: () => ({ lastPushedAt: state.watermark, cursor: 0 }),
  patchState: (_user: string, patch: { lastPushedAt?: number }) => { if (patch.lastPushedAt !== undefined) state.watermark = patch.lastPushedAt },
  listUnpushedTombstones: () => [], markTombstonePushed() {}
} }))
vi.mock('../services/syncApi', () => ({ syncApi: { push: state.push,
  pull: async () => ({ changes: [], next_cursor: 0, has_more: false }) } }))
vi.mock('./collections', () => ({ newResolveCache: () => ({}), MAPPERS_BY_COLLECTION: {}, COLLECTION_MAPPERS: [{
  maxUpdatedAt: () => state.updatedAt,
  listDirty: (_user: string, since: number) => state.updatedAt > since ? [{ collection: 'task', clientEntityId: 'task-a',
    plaintext: { title: state.title }, deleted: false, clientUpdatedAt: state.updatedAt }] : []
}] }))
vi.mock('./crypto/umk', () => ({ encryptPayload: async () => 'encrypted', decryptPayload: vi.fn(),
  contentFingerprint: async (_key: unknown, value: { title: string }) => value.title }))
import { runSyncCycle } from './syncEngine'
afterEach(() => vi.useRealTimers())
it.each([1000, 2000])('pushes a write landing during network work, including a same-second write (%s)', async (writeTime) => {
  vi.useFakeTimers(); vi.setSystemTime(1500)
  state.watermark = 0; state.updatedAt = 1000; state.title = 'initial'
  state.push.mockReset().mockImplementationOnce(async () => {
    state.updatedAt = writeTime; state.title = 'terminal'; vi.setSystemTime(2500)
    return { results: [] }
  }).mockResolvedValue({ results: [] })
  await runSyncCycle('user', 'subject', new Uint8Array(), 1)
  await runSyncCycle('user', 'subject', new Uint8Array(), 1)
  expect(state.push.mock.calls[1][1].changes[0].content_fingerprint).toBe('terminal')
})
