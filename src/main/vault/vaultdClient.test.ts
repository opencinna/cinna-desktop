import { connect } from 'node:net'
import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { startVaultd, type Harness } from '../../../native/vault/guest/vaultd/test/harness'
import type { VaultChannel } from './backend'
import { RPC_METHOD_NOT_FOUND, VaultdClient, VaultdError } from './vaultdClient'

let harness: Harness | null = null

afterEach(async () => {
  await harness?.stop()
  harness = null
})

async function channelTo(sock: string): Promise<VaultChannel> {
  const socket = connect(sock)
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const web = Duplex.toWeb(socket) as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }
  return { readable: web.readable, writable: web.writable, close: () => socket.destroy() }
}

describe('VaultdClient errors', () => {
  it('carries the JSON-RPC code: "Method not found" from a guest without the method, -32000 for vaultd’s own refusals', async () => {
    harness = await startVaultd()
    const sock = harness.sock
    const client = await VaultdClient.connect(await channelTo(sock), { openChannel: () => channelTo(sock) })
    try {
      const missing = await client.request('no.such.method' as never, {} as never).catch((error: unknown) => error)
      expect(missing).toBeInstanceOf(VaultdError)
      expect(missing).toMatchObject({ code: 'internal', message: 'Method not found', rpcCode: RPC_METHOD_NOT_FOUND })
      const refused = await client.request('engine.providerErrors', { stream: 'none', sessionId: 's', sinceAgoMs: 0 }).catch((error: unknown) => error)
      expect(refused).toMatchObject({ code: 'invalid', rpcCode: -32000 })
    } finally {
      client.close()
    }
  })
})
