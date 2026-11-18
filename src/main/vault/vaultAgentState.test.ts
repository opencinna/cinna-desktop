import { beforeEach, describe, expect, it } from 'vitest'
import { vaultAgentState, VAULT_KV_GRANTS } from './vaultAgentState'
import type { LocalPermissionRequest } from '../../shared/localAgentRequests'

/** A vault's key-value store, as `kv.get` / `kv.put` answer it. */
function fakeVault(initial: Record<string, unknown> = {}) {
  const kv = new Map<string, unknown>(Object.entries(initial))
  const client = {
    request: async (method: string, params: { key: string; value?: unknown }): Promise<{ value?: unknown }> => {
      if (method === 'kv.get') return { value: kv.get(params.key) }
      if (method === 'kv.put') {
        kv.set(params.key, params.value)
        return {}
      }
      throw new Error(`unexpected ${method}`)
    }
  }
  return { kv, client: client as never, connect: async () => client as never }
}

const ask = (pattern: string): LocalPermissionRequest =>
  ({ action: 'bash', resources: [pattern], savable: [pattern] })

describe('vaultAgentState grants (the Permissions card)', () => {
  beforeEach(() => vaultAgentState.resetForTest())

  it('lists the vault’s grants keyed, newest first', async () => {
    const { client } = fakeVault({
      [VAULT_KV_GRANTS]: {
        'bash::ls': { action: 'bash', pattern: 'ls', scope: 'exact', decidedAt: 1 },
        'bash::make': { action: 'bash', pattern: 'make', scope: 'exact', decidedAt: 2 }
      }
    })
    const rows = await vaultAgentState.listGrants('v1', client)
    expect(rows.map((row) => row.key)).toEqual(['bash::make', 'bash::ls'])
  })

  it('lists none for a vault that holds none', async () => {
    expect(await vaultAgentState.listGrants('v1', fakeVault().client)).toEqual([])
  })

  it('revokes one grant in the vault and in the copy a turn reads', async () => {
    const vault = fakeVault()
    await vaultAgentState.load('v1', vault.client)
    vaultAgentState.rememberGrant('v1', vault.connect, ask('ls'))
    vaultAgentState.rememberGrant('v1', vault.connect, ask('make'))
    await vaultAgentState.settled('v1')
    const [key] = Object.keys(vault.kv.get(VAULT_KV_GRANTS) as object).filter((k) => k.includes('ls'))

    const left = await vaultAgentState.forgetGrants('v1', vault.connect, key)

    expect(left.map((row) => row.pattern)).toEqual(['make'])
    expect(Object.keys(vault.kv.get(VAULT_KV_GRANTS) as object)).toEqual(left.map((row) => row.key))
    expect(vaultAgentState.isGranted('v1', ask('ls'))).toBe(false)
    expect(vaultAgentState.isGranted('v1', ask('make'))).toBe(true)
  })

  it('a grant made after a revoke does not bring the revoked one back', async () => {
    const vault = fakeVault()
    await vaultAgentState.load('v1', vault.client)
    vaultAgentState.rememberGrant('v1', vault.connect, ask('ls'))
    const forgetting = vaultAgentState.forgetGrants('v1', vault.connect, null)
    vaultAgentState.rememberGrant('v1', vault.connect, ask('make'))
    await forgetting
    await vaultAgentState.settled('v1')
    const stored = Object.values(vault.kv.get(VAULT_KV_GRANTS) as Record<string, { pattern: string }>)
    expect(stored.map((grant) => grant.pattern)).toEqual(['make'])
  })

  it('a turn loading while a revoke is in flight does not get the revoked grant back', async () => {
    const vault = fakeVault()
    await vaultAgentState.load('v1', vault.client)
    vaultAgentState.rememberGrant('v1', vault.connect, ask('ls'))
    await vaultAgentState.settled('v1')
    const [key] = Object.keys(vault.kv.get(VAULT_KV_GRANTS) as object)
    // A slow vault connection: the revoke's write is still queued when the turn loads.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const forgetting = vaultAgentState.forgetGrants('v1', async () => { await gate; return vault.client }, key)
    const loading = vaultAgentState.load('v1', vault.client)
    release()
    await Promise.all([forgetting, loading])
    expect(vaultAgentState.isGranted('v1', ask('ls'))).toBe(false)
    vaultAgentState.rememberGrant('v1', vault.connect, ask('make'))
    await vaultAgentState.settled('v1')
    expect(Object.values(vault.kv.get(VAULT_KV_GRANTS) as Record<string, { pattern: string }>).map((g) => g.pattern)).toEqual(['make'])
  })

  it('a failed revoke is the caller’s', async () => {
    const failing = { request: async () => { throw new Error('vault gone') } } as never
    await expect(vaultAgentState.forgetGrants('v1', async () => failing, null)).rejects.toThrow('vault gone')
  })
})
