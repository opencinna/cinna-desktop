import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { DashboardsList } from './DashboardsList'

beforeEach(() => {
  window.api = {
    dashboards: {
      list: async () => [
        { id: 'd1', name: 'Sales overview', sortOrder: 0, tileCount: 3, createdAt: 0, updatedAt: 0 },
        { id: 'd2', name: 'Ops', sortOrder: 1, tileCount: 1, createdAt: 0, updatedAt: 0 }
      ]
    }
  } as never
})

describe('DashboardsList', () => {
  it('names each row with its tile count, as it shows it', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <DashboardsList />
      </QueryClientProvider>
    )
    expect(await screen.findByRole('button', { name: 'Sales overview, 3 tiles' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ops, 1 tile' })).toBeTruthy()
  })
})
