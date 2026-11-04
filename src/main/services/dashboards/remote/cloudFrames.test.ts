import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))
vi.mock('../../../db/agents', () => ({ agentRepo: {} }))
vi.mock('../../../db/dashboards', () => ({ dashboardRepo: {} }))
vi.mock('../../../host/runtimeHost', () => ({ runtimeHost: {} }))
vi.mock('../../cinna-http', () => ({ resolveBaseUrl: () => 'https://cinna.example.com' }))
vi.mock('./coreDashboardsClient', () => ({ coreDashboardsClient: {} }))

const { createCloudFrames, PAGE_STATE_RESEND_MS } = await import('./cloudFrames')
type Deps = import('./cloudFrames').CloudFramesDeps

function setup(overrides: Partial<Deps> = {}) {
  let clock = 1_700_000_000_000
  let docs = 0
  const ticks: Array<() => void> = []
  const puts: Array<{ blockId: string; pageDoc: string | null; highlightReady: boolean; seq: number; ifPageDoc?: string | null }> = []
  const deps: Deps = {
    tile: (_userId, tileId) =>
      tileId === 'cloud' ? { coreDashboardId: 'cd1', coreBlockId: 'b1', wrongServer: false, view: 'html' }
        : tileId === 'elsewhere' ? { coreDashboardId: 'cd1', coreBlockId: 'b2', wrongServer: true, view: 'html' }
          : tileId === 'native' ? { coreDashboardId: 'cd1', coreBlockId: 'b3', wrongServer: false, view: 'table' }
            : null,
    remoteAgent: (_userId, agentId) => (agentId === 'remote-row' ? { remoteTargetId: 'core-agent' } : null),
    mintTile: vi.fn(async () => ({ ok: true as const, value: { frame_url: 'https://c.example.com/d/v/cap/index.html', expires_at: new Date(clock + 3600_000).toISOString() } })),
    mintComponent: vi.fn(async () => ({ ok: true as const, value: { frame_url: 'https://c.example.com/d/v/cap/p/index.html', expires_at: new Date(clock + 3600_000).toISOString() } })),
    putPageState: vi.fn(async (_userId, _dashboardId, blockId, state) => {
      puts.push({ blockId, ...state })
      return { ok: true as const, value: {} }
    }),
    fetch: vi.fn(),
    newPageDoc: () => `doc${++docs}`,
    now: () => clock,
    setInterval: (fn) => {
      ticks.push(fn)
      return ticks.length
    },
    clearInterval: (handle) => {
      ticks[(handle as number) - 1] = () => {}
    },
    ...overrides
  }
  return { frames: createCloudFrames(deps), deps, puts, ticks, advance: (ms: number) => { clock += ms } }
}

describe('cloudFrames', () => {
  it('opens a cloud tile’s block frame and a remote agent’s preview frame; anything else is not cloud (null)', async () => {
    const { frames, deps } = setup()
    const tile = await frames.openTile('p1', 'cloud')
    expect(tile).toMatchObject({ ok: true, tileId: 'cloud' })
    expect(deps.mintTile).toHaveBeenCalledWith('p1', 'cd1', 'b1')
    const preview = await frames.openPreview('p1', 'remote-row', 'chart', 'crm')
    expect(preview).toMatchObject({ ok: true, tileId: null })
    expect(preview?.ok && preview.frame.entry).toBe('p/index.html')
    expect(deps.mintComponent).toHaveBeenCalledWith('p1', 'core-agent', 'chart', 'crm')
    expect(await frames.openTile('p1', 'local')).toBeNull()
    expect(await frames.openPreview('p1', 'folder:m1', 'chart', null)).toBeNull()
  })

  it('refuses as data: another server, a native view, core’s refusal', async () => {
    const { frames } = setup({ mintTile: async () => ({ ok: false, code: 'reauth_required', message: 'sign in', status: 401 }) })
    expect(await frames.openTile('p1', 'elsewhere')).toMatchObject({ ok: false, code: 'wrong_server' })
    expect(await frames.openTile('p1', 'native')).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await frames.openTile('p1', 'cloud')).toEqual({ ok: false, code: 'reauth_required', message: 'sign in' })
    expect(await frames.openPreview('p1', 'remote-row', '', null)).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('puts page state with a page doc and a strictly increasing µs seq, withdraws with if_page_doc on a reload', async () => {
    const { frames, puts } = setup()
    expect(await frames.highlightReady('p1', 'cloud', true)).toBe(true)
    expect(await frames.highlightReady('p1', 'cloud', true)).toBe(true)
    expect(await frames.highlightReady('p1', 'cloud', false)).toBe(true)
    expect(await frames.highlightReady('p1', 'cloud', true)).toBe(true)
    expect(puts.map(({ seq: _seq, ...rest }) => rest)).toEqual([
      { blockId: 'b1', pageDoc: 'doc1', highlightReady: true },
      { blockId: 'b1', pageDoc: 'doc1', highlightReady: true },
      { blockId: 'b1', pageDoc: null, highlightReady: false, ifPageDoc: 'doc1' },
      { blockId: 'b1', pageDoc: 'doc2', highlightReady: true }
    ])
    expect(puts[0].seq).toBe(1_700_000_000_000 * 1000)
    for (let i = 1; i < puts.length; i++) expect(puts[i].seq).toBeGreaterThan(puts[i - 1].seq)
    expect(await frames.highlightReady('p1', 'elsewhere', true)).toBe(false)
  })

  it('writes the state again before core forgets it, and stops once withdrawn', async () => {
    const { frames, puts, ticks } = setup()
    await frames.highlightReady('p1', 'cloud', true)
    expect(PAGE_STATE_RESEND_MS).toBeLessThan(15 * 60_000)
    ticks[0]()
    await vi.waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1]).toMatchObject({ pageDoc: 'doc1', highlightReady: true })
    await frames.highlightReady('p1', 'cloud', false)
    ticks[0]()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(puts).toHaveLength(3)
  })

  it('withdraws when the tile’s last frame is released', async () => {
    const { frames, puts } = setup()
    frames.registered('tok1', 'cloud')
    frames.registered('tok2', 'cloud')
    await frames.highlightReady('p1', 'cloud', true)
    frames.released('tok1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(puts).toHaveLength(1)
    frames.released('tok2')
    await vi.waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1]).toMatchObject({ pageDoc: null, highlightReady: false, ifPageDoc: 'doc1' })
  })
})
