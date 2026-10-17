import type Database from 'better-sqlite3'

/**
 * `published_artifacts` and `chat_artifact_cards` (artifacts A12).
 *
 * `published_artifacts` remembers, per profile and server, which artifact a
 * path on this machine was published as — the desktop's side of "no marker
 * file in the source folder" — so the Publish dialog can offer *Update*. One
 * row per (profile, server, artifact); a path published twice as new has two
 * rows, and the latest is the one offered.
 *
 * `chat_artifact_cards` anchors a card after a message of a chat; it goes
 * with the chat. `message_id` has no foreign key: a card whose message is
 * gone simply renders nowhere.
 *
 * Creation only, no DML. After `users` and `chats` (both referenced).
 */
export function migratePublishedArtifacts(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS published_artifacts (
      id TEXT PRIMARY KEY,
      profile_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      server_url TEXT NOT NULL,
      source_path TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      revision INTEGER NOT NULL,
      visibility TEXT NOT NULL,
      url TEXT NOT NULL,
      live_link_count INTEGER NOT NULL DEFAULT 0,
      approved_agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (profile_user_id, server_url, artifact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_published_artifacts_source
      ON published_artifacts(profile_user_id, server_url, source_path);
    CREATE TABLE IF NOT EXISTS chat_artifact_cards (
      id TEXT PRIMARY KEY,
      profile_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_artifact_cards_chat ON chat_artifact_cards(chat_id);
  `)
}
