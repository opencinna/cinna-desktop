import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testSupport/nodeSqlite'
const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('./client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))
const { publishedArtifactRepo } = await import('./publishedArtifacts')

const A = '0f8fad5b-d9cb-469f-a165-70867728950e'
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const state = (artifactId: string, revision = 1) => ({
  artifactId, title: `T ${revision}`, kind: 'site' as const, revision, visibility: 'private' as const, url: `u/${artifactId}`, liveLinkCount: 0
})

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.current.raw.exec(`INSERT INTO users (id, type, username, display_name, created_at) VALUES ('p1', 'cinna_user', 'p1', 'P1', 1), ('p2', 'cinna_user', 'p2', 'P2', 1);
    INSERT INTO chats (id, title, created_at, updated_at, user_id) VALUES ('chat-1', 'Chat', 1, 1, 'p1');`)
})
afterEach(() => {
  holder.current?.close()
})

describe('published artifacts memory', () => {
  it('remembers a path per profile and server, and moves a republish to its new revision', () => {
    publishedArtifactRepo.recordPublish('p1', 'https://a', { sourcePath: '/x/q3', agentId: 'folder:a' }, state(A))
    publishedArtifactRepo.recordPublish('p1', 'https://a', { sourcePath: '/x/q3', agentId: 'folder:a' }, state(A, 2))
    expect(publishedArtifactRepo.findBySource('p1', 'https://a', '/x/q3')).toMatchObject({ artifactId: A, revision: 2, title: 'T 2' })
    expect(publishedArtifactRepo.findBySource('p2', 'https://a', '/x/q3')).toBeNull()
    expect(publishedArtifactRepo.findBySource('p1', 'https://b', '/x/q3')).toBeNull()
    expect(holder.current!.raw.prepare('SELECT COUNT(*) AS n FROM published_artifacts').get()).toEqual({ n: 1 })
  })

  it('syncs visibility and links, forgets a deleted artifact, and is unique per artifact', () => {
    publishedArtifactRepo.recordPublish('p1', 'https://a', { sourcePath: '/x/q3', agentId: 'folder:a' }, state(A))
    publishedArtifactRepo.sync('p1', 'https://a', { ...state(A), visibility: 'instance', liveLinkCount: 2 })
    publishedArtifactRepo.sync('p1', 'https://a', state(B))
    expect(publishedArtifactRepo.get('p1', 'https://a', A)).toMatchObject({ visibility: 'instance', liveLinkCount: 2 })
    expect(publishedArtifactRepo.get('p1', 'https://a', B)).toBeNull()
    expect(() => holder.current!.raw.exec(`INSERT INTO published_artifacts (id, profile_user_id, server_url, source_path, agent_id, artifact_id, title, kind, revision, visibility, url, created_at, updated_at)
      VALUES ('dup', 'p1', 'https://a', '/y', 'folder:a', '${A}', 't', 'files', 1, 'private', 'u', 1, 1)`)).toThrow(/UNIQUE/)
    publishedArtifactRepo.forget('p1', 'https://a', A)
    expect(publishedArtifactRepo.findBySource('p1', 'https://a', '/x/q3')).toBeNull()
  })

  it('lists the distinct page URLs of one profile and server', () => {
    publishedArtifactRepo.recordPublish('p1', 'https://a', { sourcePath: '/x/q3', agentId: 'folder:a' }, { ...state(A), url: `https://web.a/artifact/${A}` })
    publishedArtifactRepo.recordPublish('p1', 'https://a', { sourcePath: '/x/q4', agentId: 'folder:a' }, { ...state(B), url: `https://web.a/artifact/${B}` })
    publishedArtifactRepo.recordPublish('p2', 'https://a', { sourcePath: '/x/q3', agentId: 'folder:a' }, { ...state(A), url: 'https://other/artifact/x' })
    expect(publishedArtifactRepo.urls('p1', 'https://a').sort()).toEqual([`https://web.a/artifact/${A}`, `https://web.a/artifact/${B}`])
    expect(publishedArtifactRepo.urls('p1', 'https://b')).toEqual([])
  })

  it('anchors a card once per message, joins it to the artifact, and drops it with its chat', () => {
    publishedArtifactRepo.recordPublish('p1', 'https://a', { sourcePath: '/x/q3', agentId: 'folder:a' }, state(A))
    publishedArtifactRepo.addCard('p1', 'chat-1', 'm1', A)
    publishedArtifactRepo.addCard('p1', 'chat-1', 'm1', A)
    publishedArtifactRepo.addCard('p1', 'chat-1', 'm2', B)
    const cards = publishedArtifactRepo.cards('p1', 'https://a', 'chat-1')
    // B has no memory row on this server, so it has no card to draw.
    expect(cards.map(({ card, artifact }) => [card.messageId, artifact.artifactId])).toEqual([['m1', A]])
    expect(publishedArtifactRepo.cards('p1', 'https://b', 'chat-1')).toEqual([])
    expect(publishedArtifactRepo.cards('p2', 'https://a', 'chat-1')).toEqual([])
    holder.current!.raw.exec("DELETE FROM chats WHERE id = 'chat-1'")
    expect(holder.current!.raw.prepare('SELECT COUNT(*) AS n FROM chat_artifact_cards').get()).toEqual({ n: 0 })
  })
})
