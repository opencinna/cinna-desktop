import { describe, it, expect } from 'vitest'
import { canonicalJson } from './crypto/canonicalJson'
import { mcpRowToDescriptor, agentRowToDescriptor } from './identity'
import type { McpProviderRow } from '../db/mcpProviders'
import type { AgentRow } from '../db/agents'
import type { JobDepDescriptor, JobSyncManifest } from '../../shared/sync'

/**
 * The whole point of the portable-descriptor model is that a job's payload is
 * BYTE-STABLE across an A → B → A round trip: device B applies A's manifest,
 * stores it verbatim, and re-encodes it identically, so the server returns
 * `unchanged` and nothing is lost. These tests reproduce that cycle at the
 * canonical-JSON layer (the exact bytes fed to encryption + fingerprinting).
 */

// The relevant slice of the job plaintext that `collections.ts` listDirty emits.
function encodeJobPlaintext(
  fields: { title: string; prompt: string; folderId: string | null; position: number },
  manifest: JobSyncManifest
): Record<string, unknown> {
  return {
    title: fields.title,
    prompt: fields.prompt,
    folderId: fields.folderId,
    position: fields.position,
    modeName: manifest.modeName,
    deps: manifest.deps,
    deletedAt: null
  }
}

// What `collections.ts` apply stores into `jobs.sync_deps` — VERBATIM raw wire
// values, never a re-derived view.
function storeVerbatim(plaintext: Record<string, unknown>): JobSyncManifest {
  return {
    modeName: (plaintext.modeName as string | null) ?? null,
    deps: (plaintext.deps as JobDepDescriptor[]) ?? []
  }
}

// A decrypt is JSON.parse of what was encrypted — model the wire trip.
function wireRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const mcpRow = {
  id: 'm_a',
  userId: '__default__',
  name: 'Weather MCP',
  transportType: 'streamable-http',
  command: null,
  args: null,
  url: 'https://mcp.weather.io/v1',
  env: { API_KEY: 'super-secret' },
  enabled: true,
  authTokensEncrypted: null,
  clientInfo: null,
  createdBySync: false,
  createdAt: new Date()
} as unknown as McpProviderRow

const remoteAgentRow = {
  id: 'remote:agent:uuid-1',
  userId: 'profile-1',
  name: 'Researcher',
  description: null,
  protocol: 'a2a',
  cardUrl: 'https://srv.io/cards/1',
  endpointUrl: null,
  protocolInterfaceUrl: null,
  protocolInterfaceVersion: null,
  accessTokenEncrypted: null,
  cardData: null,
  skills: null,
  enabled: true,
  source: 'remote',
  remoteTargetType: 'agent',
  remoteTargetId: 'uuid-1',
  remoteMetadata: null,
  createdBySync: false,
  createdAt: new Date()
} as unknown as AgentRow

function deviceAManifest(): JobSyncManifest {
  const deps: JobDepDescriptor[] = [
    mcpRowToDescriptor(mcpRow),
    agentRowToDescriptor(remoteAgentRow, 'https://srv.io') as JobDepDescriptor
  ]
  return { modeName: 'Deep Work', deps }
}

describe('manifest byte-stability across a sync round trip', () => {
  it('B re-encodes A’s manifest to identical canonical bytes (→ server says unchanged)', () => {
    const fields = { title: 'Forecast', prompt: 'Summarize the weather', folderId: null, position: 0 }

    // Device A encodes.
    const plaintextA = encodeJobPlaintext(fields, deviceAManifest())
    const canonA = canonicalJson(plaintextA)

    // Device B pulls (wire trip), stores verbatim, then re-encodes from storage.
    const pulled = wireRoundTrip(plaintextA)
    const storedOnB = storeVerbatim(pulled)
    const plaintextB = encodeJobPlaintext(fields, storedOnB)
    const canonB = canonicalJson(plaintextB)

    expect(canonB).toBe(canonA)
  })

  it('is idempotent over a second round trip (A → B → A → B)', () => {
    const fields = { title: 'X', prompt: 'Y', folderId: 'f1', position: 3 }
    const p0 = encodeJobPlaintext(fields, deviceAManifest())
    const s1 = storeVerbatim(wireRoundTrip(p0))
    const p1 = encodeJobPlaintext(fields, s1)
    const s2 = storeVerbatim(wireRoundTrip(p1))
    const p2 = encodeJobPlaintext(fields, s2)
    expect(canonicalJson(p1)).toBe(canonicalJson(p0))
    expect(canonicalJson(p2)).toBe(canonicalJson(p0))
  })

  it('canonical-JSON is order-independent across object keys', () => {
    // Re-ordering descriptor keys must NOT change the canonical bytes (so a
    // peer that serializes the same descriptor with a different key order still
    // matches).
    const a = canonicalJson({ kind: 'mcp', transport: 'sse', url: 'https://h/p', name: 'n' })
    const b = canonicalJson({ name: 'n', url: 'https://h/p', transport: 'sse', kind: 'mcp' })
    expect(a).toBe(b)
  })

  it('preserves env KEY ordering (and never leaks env values) in the canonical bytes', () => {
    const fields = { title: 'X', prompt: 'Y', folderId: null, position: 0 }
    const canon = canonicalJson(encodeJobPlaintext(fields, deviceAManifest()))
    expect(canon).toContain('"envKeys":["API_KEY"]')
    expect(canon).not.toContain('super-secret')
  })

  it('documents WHY apply stores verbatim instead of rebuilding: a rebuild from a credential-less B row diverges', () => {
    // If device B (which never received the env values) rebuilt the descriptor
    // from its own auto-created row, `envKeys` would be absent and the bytes
    // would differ — which is exactly the loss the verbatim-store design avoids.
    const fields = { title: 'X', prompt: 'Y', folderId: null, position: 0 }
    const canonA = canonicalJson(encodeJobPlaintext(fields, deviceAManifest()))

    const bRowWithoutEnv = { ...mcpRow, env: null } as McpProviderRow
    const rebuilt: JobSyncManifest = {
      modeName: 'Deep Work',
      deps: [
        mcpRowToDescriptor(bRowWithoutEnv),
        agentRowToDescriptor(remoteAgentRow, 'https://srv.io') as JobDepDescriptor
      ]
    }
    const canonRebuilt = canonicalJson(encodeJobPlaintext(fields, rebuilt))
    expect(canonRebuilt).not.toBe(canonA)
  })
})
