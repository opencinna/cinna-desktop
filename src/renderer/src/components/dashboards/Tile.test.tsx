import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentInfo, TileResultDto, TileView } from '../../../../shared/dashboards'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { Tile } from './Tile'
import { MarkdownView } from './views/nativeViews'

const COMPONENT: ComponentInfo = {
  agentId: 'folder:sales', manifestId: 'sales', agentName: 'Sales Agent', name: 'deals', skill: null, title: 'Deals',
  description: '', view: 'list', size: 'wide', source: { endpoint: 'e' }, maxAge: '15m', refreshCommand: null,
  params: {}, prompts: [], valid: true, findings: [], missingCredentials: []
}

const VIEW: TileView = {
  tile: { id: 't1', dashboardId: 'd1', agentManifestId: 'sales', component: 'deals', skill: null, title: 'Deals', size: 'wide', position: 0, params: {}, refreshOverride: null },
  displayTitle: 'Deals',
  state: 'ok',
  component: COMPONENT
}

let result: TileResultDto

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Tile view={VIEW} dashboardName="Sales" span={{ cols: 6, rows: 2 }} editMode={false} dragging={false} onHandlePointerDown={() => {}} onVisibilityChange={() => {}} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  result = { tileId: 't1', data: { items: [{ title: 'Call Bob' }] }, fetchedAt: Date.now(), error: null, refreshing: false, stale: false, tooLarge: false, notice: null }
  window.api = {
    dashboards: {
      tileResult: async () => ({ ok: true, result }),
      onTileChanged: () => () => {},
      ensureFresh: async () => ({ ok: true })
    }
  } as never
})

describe('Tile', () => {
  it('reserves the bar’s strip: the content starts below it, the bar is opaque and takes its own clicks', async () => {
    // Mutation: put the content back at `inset-0` under a translucent,
    // click-through bar and this fails.
    show()
    await screen.findByText('Call Bob')
    const bar = screen.getByTestId('tile-bar')
    const content = screen.getByTestId('tile-content')
    expect(bar.className).toContain('h-7')
    expect(content.className).toContain('top-7')
    expect(content.className).not.toContain('inset-0')
    expect(bar.className).not.toContain('pointer-events-none')
    expect(bar.className).not.toMatch(/bg-\[var\(--color-bg\)\]\/\d+/)
    // The title is always there; nothing in the strip appears on hover except the controls.
    expect(within(bar).getByText('Deals')).toBeTruthy()
  })

  it('a failed tile with no data still shows the error mark', async () => {
    result = { ...result, data: null, fetchedAt: null, error: 'The endpoint answered 500.' }
    show()
    expect(await screen.findByLabelText('Last refresh failed: The endpoint answered 500.')).toBeTruthy()
  })
})

describe('a markdown tile', () => {
  it('demotes headings two levels, so a tile never renders an h1', () => {
    render(<MarkdownView data={'# Week\n\n## Done\n\n###### Small'} />)
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
    expect(screen.getByRole('heading', { level: 3, name: 'Week' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 4, name: 'Done' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 6, name: 'Small' })).toBeTruthy()
  })
})

