import { describe, expect, it } from 'vitest'
import { desktopAppsBannerText, visibleDesktopApps, type DetectedDesktopApp } from './desktopApps'

const claude: DetectedDesktopApp = { id: 'claude-desktop', label: 'Claude Desktop', engine: 'claude' }
const chatgpt: DetectedDesktopApp = { id: 'chatgpt', label: 'ChatGPT', engine: 'codex' }

describe('visibleDesktopApps', () => {
  it('offers every detected app that is neither dismissed nor already the default runtime', () => {
    expect(visibleDesktopApps([claude, chatgpt], [], 'opencode')).toEqual([claude, chatgpt])
  })

  it('drops a dismissed app', () => {
    expect(visibleDesktopApps([claude, chatgpt], ['chatgpt'], 'opencode')).toEqual([claude])
  })

  it('drops the app whose engine is already the default runtime', () => {
    expect(visibleDesktopApps([claude, chatgpt], [], 'claude')).toEqual([chatgpt])
    expect(visibleDesktopApps([claude, chatgpt], [], 'codex')).toEqual([claude])
    // The default chat mode inherits (null) or names the same engine: in use.
    expect(visibleDesktopApps([claude], [], 'claude', null)).toEqual([])
    expect(visibleDesktopApps([claude], [], 'claude', 'claude')).toEqual([])
    // The default chat mode spends an API key through OpenCode: still offered.
    expect(visibleDesktopApps([claude], [], 'claude', 'opencode')).toEqual([claude])
  })

  it('offers nothing when nothing is left', () => {
    expect(visibleDesktopApps([claude], ['claude-desktop'], 'opencode')).toEqual([])
    expect(visibleDesktopApps([], [], 'opencode')).toEqual([])
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
