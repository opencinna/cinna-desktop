import { describe, expect, it } from 'vitest'
import {
  desktopAppsBannerText,
  hasWorkingRuntime,
  visibleDesktopApps,
  type DetectedDesktopApp,
  type RuntimeSetup
} from './desktopApps'

const claude: DetectedDesktopApp = { id: 'claude-desktop', label: 'Claude Desktop', engine: 'claude' }
const chatgpt: DetectedDesktopApp = { id: 'chatgpt', label: 'ChatGPT', engine: 'codex' }

describe('visibleDesktopApps', () => {
  it('offers every detected app that is not dismissed', () => {
    expect(visibleDesktopApps([claude, chatgpt], [])).toEqual([claude, chatgpt])
    expect(visibleDesktopApps([claude, chatgpt], ['chatgpt'])).toEqual([claude])
  })

  it('offers nothing when nothing is left', () => {
    expect(visibleDesktopApps([claude], ['claude-desktop'])).toEqual([])
    expect(visibleDesktopApps([], [])).toEqual([])
  })
})

describe('hasWorkingRuntime', () => {
  const none: RuntimeSetup['cli'] = {
    claude: { auth: 'unknown', installed: false },
    codex: { auth: 'unknown', installed: false }
  }
  const setup = (patch: Partial<RuntimeSetup> = {}): RuntimeSetup => ({
    defaultEngine: 'opencode',
    hasActiveCredential: false,
    cli: none,
    ...patch
  })

  it('is false on a Mac with nothing: no credential, no CLI', () => {
    expect(hasWorkingRuntime(setup())).toBe(false)
    expect(hasWorkingRuntime(setup({ defaultEngine: 'claude' }))).toBe(false)
  })

  it('is true for OpenCode with a credential, and only when OpenCode is the Default runtime', () => {
    expect(hasWorkingRuntime(setup({ hasActiveCredential: true }))).toBe(true)
    // Claude is the default but not signed in: the key does not make that work.
    expect(hasWorkingRuntime(setup({ defaultEngine: 'claude', hasActiveCredential: true }))).toBe(false)
  })

  it('is true for a signed-in CLI, whichever engine is the default', () => {
    const claudeIn = { ...none, claude: { auth: 'logged_in' as const, installed: true } }
    expect(hasWorkingRuntime(setup({ defaultEngine: 'claude', cli: claudeIn }))).toBe(true)
    expect(hasWorkingRuntime(setup({ defaultEngine: 'opencode', cli: claudeIn }))).toBe(true)
    const codexIn = { ...none, codex: { auth: 'logged_in' as const, installed: true } }
    expect(hasWorkingRuntime(setup({ defaultEngine: 'claude', cli: codexIn }))).toBe(true)
  })

  it('treats an unknown login as working only when the CLI is installed', () => {
    const unsure = { ...none, claude: { auth: 'unknown' as const, installed: true } }
    expect(hasWorkingRuntime(setup({ defaultEngine: 'claude', cli: unsure }))).toBe(true)
    // No binary answers unknown too: that is the Mac the offer is for.
    expect(hasWorkingRuntime(setup({ defaultEngine: 'claude', cli: none }))).toBe(false)
  })

  it('is false for an installed CLI that is signed out', () => {
    const out = { ...none, claude: { auth: 'logged_out' as const, installed: true } }
    expect(hasWorkingRuntime(setup({ defaultEngine: 'claude', cli: out }))).toBe(false)
  })
})

describe('desktopAppsBannerText', () => {
  it('names one app and its subscription', () => {
    expect(desktopAppsBannerText([claude])).toBe(
      "Claude Desktop is installed — use your Claude subscription as Cinna's default for chats and agents."
    )
    expect(desktopAppsBannerText([chatgpt])).toBe(
      "ChatGPT is installed — use your ChatGPT subscription as Cinna's default for chats and agents."
    )
  })

  it('names both', () => {
    expect(desktopAppsBannerText([claude, chatgpt])).toBe(
      "Claude Desktop and ChatGPT are installed — use either subscription as Cinna's default for chats and agents."
    )
  })
})
