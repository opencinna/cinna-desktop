import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { useUpsertMcpProvider } from './useMcp'

it('throws main’s refusal with its sentence and its code, so a policy refusal is told from a retry', async () => {
  const upsert = vi.fn(async () => ({ id: '', success: false, ok: false as const, code: 'policy' as const, message: 'Your admin does not allow connectors from public MCP registries.' }))
  window.api = { mcp: { upsert } } as never
  const client = new QueryClient()
  const { result } = renderHook(() => useUpsertMcpProvider(), {
    wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  })
  await expect(result.current.mutateAsync({ name: 'Ledger', transportType: 'streamable-http' })).rejects.toMatchObject({
    message: 'Your admin does not allow connectors from public MCP registries.',
    code: 'policy'
  })
})
