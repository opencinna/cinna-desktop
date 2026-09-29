import { describe, expect, it, vi } from 'vitest'
import type { ContextCategories, ContextMeasurement, SessionTelemetry } from '../../../shared/sessionTelemetry'

vi.mock('../../db/sessionTelemetry', () => ({ sessionTelemetryRepo: { get: () => null, save: () => {}, delete: () => {} } }))
vi.mock('../../db/chats', () => ({ chatRepo: { isTrashed: () => false } }))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { createSessionTelemetryService } = await import('./sessionTelemetryService')

function memoryStore(initial: SessionTelemetry[] = []) {
  const rows = new Map(initial.map((t) => [t.chatId, structuredClone(t)]))
  return {
    rows,
    get: vi.fn((chatId: string) => (rows.has(chatId) ? structuredClone(rows.get(chatId)!) : null)),
    save: vi.fn((t: SessionTelemetry) => { rows.set(t.chatId, structuredClone(t)) }),
    delete: vi.fn((chatId: string) => { rows.delete(chatId) })
  }
}

const turn = { type: 'turn' as const, engine: 'claude' as const, sessionId: 's1',
  message: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, tokenScope: 'turn' as const, costSource: 'runtime' as const, costUsd: 0.5 } }

describe('the session telemetry service', () => {
  it('folds a report, saves it and tells listeners', () => {
    const store = memoryStore()
    const service = createSessionTelemetryService({ store, now: () => 42 })
    const heard: [string, SessionTelemetry][] = []
    service.onChange((chatId, telemetry) => heard.push([chatId, telemetry]))

    service.report('chat', turn)
    expect(store.rows.get('chat')?.totals).toMatchObject({ turns: 1, costUsd: 0.5 })
    expect(heard).toHaveLength(1)
    expect(heard[0][1]).toMatchObject({ chatId: 'chat', updatedAt: 42 })
    // Copies out: a listener cannot reach the held state.
    heard[0][1].totals.turns = 99
    expect(service.get('chat')?.totals.turns).toBe(1)
  })

  it('continues from what was saved before a restart', () => {
    const first = createSessionTelemetryService({ store: memoryStore(), now: () => 1 })
    first.report('chat', turn)
    const saved = first.get('chat')!
    const store = memoryStore([saved])
    const second = createSessionTelemetryService({ store })
    expect(second.get('chat')?.totals.turns).toBe(1)
    second.report('chat', turn)
    expect(store.rows.get('chat')?.totals.turns).toBe(2)
  })

  it('says nothing and writes nothing for a report that changed nothing', () => {
    const store = memoryStore()
    let now = 0
    const service = createSessionTelemetryService({ store, now: () => ++now })
    const listener = vi.fn()
    service.onChange(listener)
    service.report('chat', { type: 'model', engine: 'claude', selected: 'default' })
    service.report('chat', { type: 'model', engine: 'claude', selected: 'default' })
    expect(store.save).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('writes nothing, announces nothing and forgets the chat when it is trashed', () => {
    const store = memoryStore()
    const trashed = new Set<string>()
    const service = createSessionTelemetryService({ store, isTrashed: (chatId) => trashed.has(chatId) })
    const listener = vi.fn()
    service.onChange(listener)
    service.report('chat', turn)
    listener.mockClear()
    store.save.mockClear()
    trashed.add('chat')
    // A turn that ended as its chat was trashed.
    service.report('chat', turn)
    expect(store.save).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    expect(store.rows.has('chat')).toBe(false)
    expect(service.get('chat')).toBeNull()
  })

  it('answers a session’s last persisted cost reading', () => {
    const service = createSessionTelemetryService({ store: memoryStore() })
    expect(service.lastCostReading('chat', 's1')).toBeUndefined()
    service.report('chat', { type: 'context', engine: 'claude', sessionId: 's1', used: 1, size: 2, costed: true, costReading: 3.5, at: 1 })
    expect(service.lastCostReading('chat', 's1')).toBe(3.5)
    expect(service.lastCostReading('chat', 's2')).toBeUndefined()
  })

  it('answers a session’s last persisted per-model cost readings, as a copy', () => {
    const service = createSessionTelemetryService({ store: memoryStore() })
    expect(service.lastModelCostReadings('chat', 's1')).toBeUndefined()
    service.report('chat', {
      type: 'turn', engine: 'claude', sessionId: 's1',
      message: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, tokenScope: 'turn', costSource: 'runtime' },
      modelCostReadings: { 'claude-sonnet-5[1m]': 1.25 }
    })
    const readings = service.lastModelCostReadings('chat', 's1')!
    expect(readings).toEqual({ 'claude-sonnet-5[1m]': 1.25 })
    readings['claude-sonnet-5[1m]'] = 0
    expect(service.lastModelCostReadings('chat', 's1')).toEqual({ 'claude-sonnet-5[1m]': 1.25 })
  })

  it('keeps going when the write fails, and forgets a chat whole', () => {
    const store = memoryStore()
    store.save.mockImplementation(() => { throw new Error('FOREIGN KEY constraint failed') })
    const service = createSessionTelemetryService({ store })
    expect(() => service.report('gone', turn)).not.toThrow()
    expect(service.get('gone')?.totals.turns).toBe(1)
    service.forget('gone')
    expect(store.delete).toHaveBeenCalledWith('gone')
    expect(service.get('gone')).toBeNull()
  })
})

describe('measuring a chat’s context on demand', () => {
  const categories: ContextCategories = {
    categories: [{ name: 'System prompt', tokens: 3_000 }], totalTokens: 3_000, maxTokens: 200_000, rawMaxTokens: 200_000,
    percentage: 1.5, model: 'claude-sonnet-5', memoryFiles: [], mcpTools: [], agents: [], systemTools: [], systemPromptSections: []
  }

  it('reports a measurement as a change listeners hear, and answers only ok', async () => {
    const store = memoryStore()
    const service = createSessionTelemetryService({ store, now: () => 77 })
    const heard: SessionTelemetry[] = []
    service.onChange((_chatId, telemetry) => heard.push(telemetry))
    service.installContextMeasurer(async () => ({ ok: true, engine: 'claude', sessionId: 's1', categories }))
    await expect(service.measureContext('chat')).resolves.toEqual({ ok: true })
    expect(heard).toHaveLength(1)
    expect(heard[0].context).toMatchObject({ categories, categoriesMeasuredAt: 77, categoriesSessionId: 's1' })
    expect(store.rows.get('chat')?.context.categories).toEqual(categories)
  })

  it('passes a refusal on as its code and changes nothing', async () => {
    const service = createSessionTelemetryService({ store: memoryStore() })
    const heard = vi.fn()
    service.onChange(heard)
    service.installContextMeasurer(async () => ({ ok: false, code: 'not_ready' }))
    await expect(service.measureContext('chat')).resolves.toEqual({ ok: false, code: 'not_ready' })
    expect(heard).not.toHaveBeenCalled()
    expect(service.get('chat')).toBeNull()
  })

  it('answers unsupported with no measurer installed, and failed when the measurer throws', async () => {
    const service = createSessionTelemetryService({ store: memoryStore() })
    await expect(service.measureContext('chat')).resolves.toEqual({ ok: false, code: 'unsupported' })
    service.installContextMeasurer(async () => { throw new Error('boom') })
    await expect(service.measureContext('chat')).resolves.toEqual({ ok: false, code: 'failed' })
  })

  it('shares one measurement between two asks for the same chat', async () => {
    const service = createSessionTelemetryService({ store: memoryStore() })
    let release!: () => void
    const measurer = vi.fn(() => new Promise<ContextMeasurement>((resolve) => {
      release = () => resolve({ ok: true, engine: 'claude', sessionId: 's1', categories })
    }))
    service.installContextMeasurer(measurer)
    const first = service.measureContext('chat')
    const second = service.measureContext('chat')
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }])
    expect(measurer).toHaveBeenCalledTimes(1)
    // Once settled, the next ask measures again.
    const third = service.measureContext('chat')
    release()
    await third
    expect(measurer).toHaveBeenCalledTimes(2)
  })

  it('reads back a session’s last running token total, as a copy', () => {
    const service = createSessionTelemetryService({ store: memoryStore() })
    service.report('chat', { ...turn, engine: 'codex', tokenTotalReading: { input: 10, output: 2, cacheRead: 30, cacheWrite: 0 } })
    const reading = service.lastTokenTotal('chat', 's1')!
    expect(reading).toEqual({ input: 10, output: 2, cacheRead: 30, cacheWrite: 0 })
    reading.input = 0
    expect(service.lastTokenTotal('chat', 's1')?.input).toBe(10)
    expect(service.lastTokenTotal('chat', 's2')).toBeUndefined()
  })
})
