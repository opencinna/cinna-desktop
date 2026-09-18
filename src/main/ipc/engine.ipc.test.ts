import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A runtime Path saved in Settings → Local Development takes effect when it is
 * saved, for every runtime: until something re-resolves, the status row, the
 * Path field's failure line and readiness go on describing the old binary.
 */

const saved = vi.hoisted(() => new Map<string, () => void>())
const services = vi.hoisted(() => {
  const make = () => ({ refresh: vi.fn(async () => ({ state: 'unresolved' })), onChange: vi.fn(), peek: vi.fn(), state: vi.fn() })
  return { engine: make(), codex: make(), claude: make() }
})
const probes = vi.hoisted(() => ({ codex: { invalidate: vi.fn() }, claude: { invalidate: vi.fn() } }))

vi.mock('./_wrap', () => ({ ipcHandle: vi.fn() }))
vi.mock('../services/appSettingsService', () => ({
  appSettingsService: {
    onSaved: (key: string, listener: () => void) => {
      saved.set(key, listener)
      return () => saved.delete(key)
    }
  }
}))
vi.mock('../engine/engineBinaryService', () => ({
  engineBinaryService: services.engine,
  codexBinaryService: services.codex,
  claudeBinaryService: services.claude
}))
vi.mock('../agents/drivers', () => ({ codexAuthProbe: probes.codex, claudeAuthProbe: probes.claude }))
vi.mock('../index', () => ({ getMainWindow: () => null }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'user' }))
vi.mock('../auth/activation', () => ({ userActivation: { requireActivated: vi.fn() } }))
vi.mock('../services/runtimeModelCatalog', () => ({ getRuntimeModelCatalog: vi.fn() }))
vi.mock('../services/localAgents/defaultEngineService', () => ({ defaultEngineService: { resolved: vi.fn() } }))

const { registerEngineHandlers } = await import('./engine.ipc')
registerEngineHandlers()

describe('saving a runtime path', () => {
  beforeEach(() => {
    for (const service of Object.values(services)) service.refresh.mockClear()
  })

  it.each([
    ['localAgentsEnginePath', 'engine'],
    ['localAgentsCodexPath', 'codex'],
    ['localAgentsClaudePath', 'claude']
  ] as const)('%s re-resolves that runtime, and only that one', (key, which) => {
    saved.get(key)!()
    for (const [name, service] of Object.entries(services)) {
      expect(service.refresh).toHaveBeenCalledTimes(name === which ? 1 : 0)
    }
  })
})
