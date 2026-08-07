import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HINTS, DEFAULT_RETIRE_AFTER, type Hint } from '../constants/hints'

/**
 * Retirement / preemption arithmetic for the hint bar.
 *
 * Tests run in the node environment (see `vitest.config.ts`), so `localStorage`
 * is shimmed in-memory before each import. The store snapshots localStorage at
 * module load, so every test re-imports it through `vi.resetModules()` — that
 * also resets the module-level session bookkeeping (`firedThisSession`,
 * `lastPreemptAt`) that the fire-once and gap rules depend on.
 */

const STORAGE_KEY = 'cinna-hints'

function installLocalStorage(seed?: Record<string, unknown>): void {
  const store = new Map<string, string>()
  if (seed) store.set(STORAGE_KEY, JSON.stringify(seed))
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear()
    }
  })
}

type Store = typeof import('./hints.store')

async function freshStore(seed?: Record<string, unknown>): Promise<Store> {
  installLocalStorage(seed)
  vi.resetModules()
  return import('./hints.store')
}

/** Anchor the tests to real catalog entries so a rename can't silently pass. */
const AMBIENT_NOTES = 'notes-attach'
const CTX_PICKER = 'ctx-popup-keys'
const CTX_NOTE_EXPAND = 'ctx-notes-expand'

function hint(id: string): Hint {
  const found = HINTS.find((h) => h.id === id)
  if (!found) throw new Error(`catalog entry '${id}' is gone — update this test`)
  return found
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('catalog assumptions', () => {
  it('the hints these tests pin still have the shape they rely on', () => {
    expect(hint(AMBIENT_NOTES).retiredBy).toContain('note-picker-opened')
    expect(hint(AMBIENT_NOTES).retireAfter).toBeUndefined() // uses the default
    expect(hint(CTX_PICKER).trigger).toBe('note-picker-opened')
    expect(hint(CTX_NOTE_EXPAND).trigger).toBe('note-attached')
  })

  it('no ambient hint is credited twice by a single event', () => {
    for (const h of HINTS) {
      const events = h.retiredBy ?? []
      expect(new Set(events).size).toBe(events.length)
    }
  })

  it('at most one contextual hint is bound to each trigger', () => {
    const triggers = HINTS.filter((h) => h.trigger).map((h) => h.trigger)
    expect(new Set(triggers).size).toBe(triggers.length)
  })
})

describe('retirement', () => {
  it('retires a hint only after the threshold is reached', async () => {
    const { useHintsStore, isHintRetired } = await freshStore()
    const target = hint(AMBIENT_NOTES)

    for (let i = 1; i < DEFAULT_RETIRE_AFTER; i++) {
      useHintsStore.getState().observe('note-picker-opened')
      expect(isHintRetired(useHintsStore.getState().progress, target)).toBe(false)
    }

    useHintsStore.getState().observe('note-picker-opened')
    expect(isHintRetired(useHintsStore.getState().progress, target)).toBe(true)
  })

  it('never retires a hint that declares no teaching signal', async () => {
    const { useHintsStore, isHintRetired } = await freshStore()
    const evergreen = HINTS.find((h) => !h.retiredBy?.length)
    expect(evergreen).toBeDefined()
    for (let i = 0; i < 10; i++) useHintsStore.getState().observe('note-picker-opened')
    expect(isHintRetired(useHintsStore.getState().progress, evergreen!)).toBe(false)
  })

  it('persists usage across a reload', async () => {
    const first = await freshStore()
    first.useHintsStore.getState().observe('note-picker-opened')
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(persisted.used[AMBIENT_NOTES]).toBe(1)

    // Same blob, new module instance — the counter survives.
    const second = await freshStore(persisted)
    expect(second.useHintsStore.getState().progress.used[AMBIENT_NOTES]).toBe(1)
  })

  it('falls back to empty progress on a corrupt blob', async () => {
    installLocalStorage()
    localStorage.setItem(STORAGE_KEY, '{not json')
    vi.resetModules()
    const { useHintsStore, hasHintProgress } = await import('./hints.store')
    expect(hasHintProgress(useHintsStore.getState().progress)).toBe(false)
  })
})

describe('contextual preemption', () => {
  it('fires the hint bound to the observed trigger', async () => {
    const { useHintsStore } = await freshStore()
    useHintsStore.getState().observe('note-picker-opened')
    expect(useHintsStore.getState().contextual?.hintId).toBe(CTX_PICKER)
  })

  it('fires a given hint at most once per session', async () => {
    const { useHintsStore } = await freshStore()
    useHintsStore.getState().observe('note-picker-opened')
    useHintsStore.getState().clearContextual()

    vi.advanceTimersByTime(60_000) // well past the inter-preemption floor
    useHintsStore.getState().observe('note-picker-opened')
    expect(useHintsStore.getState().contextual).toBeNull()
  })

  it('honours the lifetime cap across sessions', async () => {
    // Seeded at the cap (2) — a brand-new session must not fire it again.
    const { useHintsStore } = await freshStore({ used: {}, shown: { [CTX_PICKER]: 2 } })
    useHintsStore.getState().observe('note-picker-opened')
    expect(useHintsStore.getState().contextual).toBeNull()
  })

  it('drops a second preemption inside the minimum gap', async () => {
    const { useHintsStore } = await freshStore()
    useHintsStore.getState().observe('note-picker-opened')
    expect(useHintsStore.getState().contextual?.hintId).toBe(CTX_PICKER)
    useHintsStore.getState().clearContextual()

    vi.advanceTimersByTime(1000) // < the 5 s floor
    useHintsStore.getState().observe('note-attached')
    expect(useHintsStore.getState().contextual).toBeNull()

    vi.advanceTimersByTime(5000) // now past it
    useHintsStore.getState().observe('note-attached')
    expect(useHintsStore.getState().contextual?.hintId).toBe(CTX_NOTE_EXPAND)
  })

  it('does not fire a contextual hint that has already retired', async () => {
    const { useHintsStore } = await freshStore({
      used: { [CTX_NOTE_EXPAND]: DEFAULT_RETIRE_AFTER },
      shown: {}
    })
    useHintsStore.getState().observe('note-attached')
    expect(useHintsStore.getState().contextual).toBeNull()
  })

  it('restarts the dwell when the same hint is re-fired (nonce advances)', async () => {
    const { useHintsStore } = await freshStore()
    useHintsStore.getState().observe('note-picker-opened')
    const first = useHintsStore.getState().contextual!
    useHintsStore.getState().clearContextual(true) // refund so it can fire again
    vi.advanceTimersByTime(10_000)
    useHintsStore.getState().observe('note-picker-opened')
    const second = useHintsStore.getState().contextual!
    expect(second.hintId).toBe(first.hintId)
    expect(second.nonce).toBeGreaterThan(first.nonce)
  })
})

describe('refund', () => {
  it('gives back the show and lets the hint fire again this session', async () => {
    const { useHintsStore } = await freshStore()
    useHintsStore.getState().observe('note-picker-opened')
    expect(useHintsStore.getState().progress.shown[CTX_PICKER]).toBe(1)

    useHintsStore.getState().clearContextual(true)
    expect(useHintsStore.getState().progress.shown[CTX_PICKER]).toBeUndefined()

    vi.advanceTimersByTime(10_000)
    useHintsStore.getState().observe('note-picker-opened')
    expect(useHintsStore.getState().contextual?.hintId).toBe(CTX_PICKER)
  })

  it('keeps the show when clearing normally', async () => {
    const { useHintsStore } = await freshStore()
    useHintsStore.getState().observe('note-picker-opened')
    useHintsStore.getState().clearContextual()
    expect(useHintsStore.getState().progress.shown[CTX_PICKER]).toBe(1)
  })

  it('decrements rather than deleting when a prior session already showed it', async () => {
    const { useHintsStore } = await freshStore({ used: {}, shown: { [CTX_PICKER]: 1 } })
    useHintsStore.getState().observe('note-picker-opened')
    expect(useHintsStore.getState().progress.shown[CTX_PICKER]).toBe(2)
    useHintsStore.getState().clearContextual(true)
    expect(useHintsStore.getState().progress.shown[CTX_PICKER]).toBe(1)
  })
})

describe('reset', () => {
  it('clears counters, storage, and the session fire-once bookkeeping', async () => {
    const { useHintsStore, hasHintProgress } = await freshStore()
    useHintsStore.getState().observe('note-picker-opened')
    useHintsStore.getState().clearContextual()
    expect(hasHintProgress(useHintsStore.getState().progress)).toBe(true)

    useHintsStore.getState().reset()
    expect(hasHintProgress(useHintsStore.getState().progress)).toBe(false)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ used: {}, shown: {} })

    // The per-session guard is cleared too, so the hint can fire again.
    useHintsStore.getState().observe('note-picker-opened')
    expect(useHintsStore.getState().contextual?.hintId).toBe(CTX_PICKER)
  })

  it('hands out a fresh object rather than a shared empty constant', async () => {
    const { useHintsStore } = await freshStore()
    useHintsStore.getState().reset()
    const a = useHintsStore.getState().progress
    useHintsStore.getState().observe('note-picker-opened')
    useHintsStore.getState().reset()
    const b = useHintsStore.getState().progress
    expect(a).not.toBe(b)
    expect(a.used).toEqual({})
  })
})

describe('silence', () => {
  it('is session-only and drops any showing contextual hint', async () => {
    const { useHintsStore } = await freshStore()
    useHintsStore.getState().observe('note-picker-opened')
    useHintsStore.getState().silence()
    expect(useHintsStore.getState().silenced).toBe(true)
    expect(useHintsStore.getState().contextual).toBeNull()
    // Nothing about silencing is persisted.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).silenced).toBeUndefined()
  })
})
