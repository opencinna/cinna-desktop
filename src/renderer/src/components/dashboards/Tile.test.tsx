import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentInfo, TileResultDto, TileView } from '../../../../shared/dashboards'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { Tile } from './Tile'
import { MarkdownView, MetricsView } from './views/nativeViews'
import { TileBody } from './TileBody'

const COMPONENT: ComponentInfo = {
  agentId: 'folder:sales', manifestId: 'sales', agentName: 'Sales Agent', name: 'deals', skill: null, title: 'Deals',
  description: '', view: 'list', size: 'wide', source: { endpoint: 'e' }, maxAge: '15m', refreshCommand: null,
  refresh: { maxAge: '15m', whileOpenEvery: null, afterTurn: false, onAppStart: false, command: null, schedule: null },
  params: {}, prompts: [], valid: true, findings: [], missingCredentials: []
}

const VIEW: TileView = {
  tile: { id: 't1', dashboardId: 'd1', agentManifestId: 'sales', component: 'deals', skill: null, title: 'Deals', size: 'wide', position: 0, params: {}, refreshOverride: null },
  displayTitle: 'Deals',
  state: 'ok',
  component: COMPONENT,
  schedule: null
}

let result: TileResultDto

function show(editMode = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Tile view={VIEW} dashboardName="Sales" span={{ cols: 6, rows: 2 }} editMode={editMode} dragging={false} onHandlePointerDown={() => {}} onVisibilityChange={() => {}} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  result = { tileId: 't1', data: { items: [{ title: 'Call Bob' }] }, fetchedAt: Date.now(), error: null, refreshing: false, stale: false, tooLarge: false, notice: null }
  window.api = {
    dashboards: {
      tileResult: async () => ({ ok: true, result }),
      onTileChanged: () => () => {},
      highlight: async () => [],
      onTileHighlight: () => () => {},
      clearHighlight: async () => true,
      highlightReady: async () => true,
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
    expect(bar.className).toContain('h-[34px]')
    expect(content.className).toContain('top-[34px]')
    expect(content.className).not.toContain('inset-0')
    expect(bar.className).not.toContain('pointer-events-none')
    expect(bar.className).not.toMatch(/bg-\[var\(--color-bg\)\]\/\d+/)
    // The title is always there; nothing in the strip appears on hover except the controls.
    expect(within(bar).getByText('Deals')).toBeTruthy()
  })

  it('the hidden controls take none of the title’s width: they appear over its end on hover or focus', async () => {
    // Mutation: put the controls back in the bar's flow (an opacity-0 flex
    // child keeps its width) and this fails.
    show()
    await screen.findByText('Call Bob')
    const bar = screen.getByTestId('tile-bar')
    const controls = screen.getByTestId('tile-bar-controls')
    const title = within(bar).getByText('Deals')
    expect(title.className).toContain('flex-1')
    expect(controls.contains(title)).toBe(false)
    expect(controls.className.split(' ')).toEqual(expect.arrayContaining(['absolute', 'right-full', 'opacity-0', 'group-hover:opacity-100', 'focus-within:opacity-100']))
    // Over the title's end, faded into the bar's own colour.
    expect(controls.className).toContain('var(--color-bg)')
    expect(within(controls).getByLabelText('Actions for Deals')).toBeTruthy()
    // The 12 px bar text.
    expect(within(controls).getByText(/ago|now|Refreshing/i).className).toContain('text-[12px]')
  })

  it('in edit mode the controls stay shown beside the title, not over it', async () => {
    show(true)
    await screen.findByText('Call Bob')
    const controls = screen.getByTestId('tile-bar-controls')
    expect(controls.className).not.toContain('absolute')
    expect(controls.className).not.toContain('opacity-0')
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


describe('a metrics tile', () => {
  // The view formats in the user's locale (48.200 under de-DE), so expect the same.
  const VALUE = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(48200)
  const DATA = { items: [1, 2, 3, 4].map((n) => ({ id: `k${n}`, label: `KPI ${n}`, value: 48200, delta: 3, trend: [1, 3, 2] })) }
  const body = (size: 's' | 'm' | 'wide' | 'l' | 'tall') =>
    render(
      <TileBody
        view="metrics"
        result={{ ...result, data: DATA }}
        frameTarget={{ tileId: 't1' }}
        meta={{ component: 'kpis', title: 'KPIs', params: {}, size }}
        loading={false}
      />
    )

  it.each(['s', 'm', 'wide'] as const)('a two-row tile (%s) is short: 22 px values on cards that share its height, never scrolled', (size) => {
    // Mutation: drop `short` from TileBody's MetricsView and this fails.
    body(size)
    const value = screen.getAllByText(VALUE)[0]
    expect(value.className).toContain('text-[22px]')
    const grid = screen.getByTestId('metrics-view')
    expect(grid.className).toContain('auto-rows-[minmax(0,1fr)]')
    expect(grid.className).toContain('overflow-hidden')
  })

  it.each(['l', 'tall'] as const)('a four-row tile (%s) keeps the 28 px value', (size) => {
    body(size)
    expect(screen.getAllByText(VALUE)[0].className).toContain('text-[28px]')
    expect(screen.getByTestId('metrics-view').className).not.toContain('overflow-hidden')
  })

  it('defaults to the tall scale where no size is known', () => {
    render(<MetricsView data={DATA} />)
    expect(screen.getAllByText(VALUE)[0].className).toContain('text-[28px]')
  })
})
