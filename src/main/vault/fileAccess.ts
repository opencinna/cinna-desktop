/**
 * The vault side of file references in a vault agent's chat (hub core, no
 * Electron): what a path in the vault names, a capped read of one file, and
 * the gated export behind **Download**. The agent-file service reaches the
 * vault only through this seam (`services/agentFiles/vaultFileSource.ts`).
 *
 * The default implementation speaks the guest protocol (vaultd `files.stat`,
 * `files.read`, `files.export`); a backend that runs no vaultd supplies its
 * own through `VaultBackend.files`, and `vaultService.files()` hands out
 * whichever applies.
 */
import { VAULT_FILES_READ_MAX, VAULT_FILES_STAT_MAX, type VaultFileStatEntry } from '../../shared/vault/protocol'
import type { VaultdClient } from './vaultdClient'

export type { VaultFileStatEntry }

/** At most {@link VAULT_FILES_READ_MAX} bytes of one file, and whether it was cut. */
export interface VaultFileRead {
  /**
   * Where the opened file really is, agent-relative, as the vault found it
   * from the open file after the open; the caller checks it against what it
   * stat-ed before trusting the bytes.
   */
  rel: string
  bytes: Buffer
  /** The whole file's size. */
  size: number
  truncated: boolean
}

export interface VaultFileAccess {
  /**
   * What each path names, in order: agent-relative, or absolute under the
   * agent folder as the vault sees it. Anything missing, outside the agent
   * folder or leading out of it is `type: null`. Rejects with a `VaultError`
   * (`locked`, …) when the vault cannot be asked.
   */
  resolve(vaultId: string, paths: readonly string[]): Promise<VaultFileStatEntry[]>
  /** At most `maxBytes` (and never past {@link VAULT_FILES_READ_MAX}) of one file in the agent folder. */
  read(vaultId: string, path: string, options: { maxBytes: number }): Promise<VaultFileRead>
  /**
   * Saves a copy of one agent-relative file or folder outside the vault:
   * the backend's own prompt, then the save dialog. Null when the dialog was
   * cancelled; a `denied` `VaultError` when the prompt was.
   */
  exportFile(vaultId: string, path: string): Promise<{ savedTo: string } | null>
}

/** The guest-protocol implementation, over the vault's shared vaultd connection. */
export function createGuestFileAccess(deps: {
  client: (vaultId: string) => Promise<VaultdClient>
  exportPath: (vaultId: string, path: string) => Promise<{ savedTo: string } | null>
}): VaultFileAccess {
  return {
    async resolve(vaultId, paths) {
      if (paths.length === 0) return []
      const client = await deps.client(vaultId)
      const out: VaultFileStatEntry[] = []
      for (let at = 0; at < paths.length; at += VAULT_FILES_STAT_MAX) {
        const batch = paths.slice(at, at + VAULT_FILES_STAT_MAX)
        const { entries } = await client.request('files.stat', { paths: [...batch] })
        // An answer that does not line up with the question links nothing from this batch.
        if (!Array.isArray(entries) || entries.length !== batch.length) {
          out.push(...batch.map((path) => ({ path, rel: null, type: null, size: 0 })))
        } else {
          out.push(...entries)
        }
      }
      return out
    },

    async read(vaultId, path, { maxBytes }) {
      const client = await deps.client(vaultId)
      const cap = Math.max(0, Math.min(Math.floor(maxBytes), VAULT_FILES_READ_MAX))
      const read = await client.request('files.read', { path, maxBytes: cap })
      const bytes = Buffer.from(read.bytes, 'base64')
      return { rel: read.rel, bytes, size: read.size, truncated: read.truncated || bytes.length < read.size }
    },

    exportFile: (vaultId, path) => deps.exportPath(vaultId, path)
  }
}
