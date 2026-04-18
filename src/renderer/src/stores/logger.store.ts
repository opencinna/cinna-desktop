import { create } from 'zustand'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: number
  timestamp: number
  level: LogLevel
  scope: string
  source: 'main' | 'renderer'
  message: string
  data?: unknown
}

const MAX_ENTRIES = 2000

interface LoggerStore {
  entries: LogEntry[]
  subscribed: boolean
  unsubscribe: (() => void) | null
  append: (entry: LogEntry) => void
  setAll: (entries: LogEntry[]) => void
  clear: () => Promise<void>
  log: (level: LogLevel, scope: string, message: string, data?: unknown) => void
  subscribe: () => Promise<void>
}

export const useLoggerStore = create<LoggerStore>((set, get) => ({
  entries: [],
  subscribed: false,
  unsubscribe: null,

  append: (entry) =>
    set((state) => {
      const next = state.entries.length >= MAX_ENTRIES ? state.entries.slice(-MAX_ENTRIES + 1) : state.entries.slice()
      next.push(entry)
      return { entries: next }
    }),

  setAll: (entries) => set({ entries }),

  clear: async () => {
    await window.api.logger.clear()
    set({ entries: [] })
  },

  log: (level, scope, message, data) => {
    void window.api.logger.log({ level, scope, message, data })
  },

  subscribe: async () => {
    if (get().subscribed) return
    const initial = await window.api.logger.getAll()
    const unsub = window.api.logger.onEntry((entry) => {
      get().append(entry)
    })
    set({ entries: initial, subscribed: true, unsubscribe: unsub })
  }
}))

export interface RendererLogger {
  debug: (message: string, data?: unknown) => void
  info: (message: string, data?: unknown) => void
  warn: (message: string, data?: unknown) => void
  error: (message: string, data?: unknown) => void
}

export function createLogger(scope: string): RendererLogger {
  const log = (level: LogLevel, message: string, data?: unknown): void => {
    useLoggerStore.getState().log(level, scope, message, data)
  }
  return {
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    warn: (message, data) => log('warn', message, data),
    error: (message, data) => log('error', message, data)
  }
}
