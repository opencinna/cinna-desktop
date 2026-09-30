import { describe, expect, it } from 'vitest'
import { browserLaunchPlan, createBrowserLauncher } from './openInBrowser'

/** Open in browser: the default web browser per platform, then the OS default app. */

const FILE = '/tmp/cinna-html-preview/abc/report.html'

describe('browserLaunchPlan', () => {
  it('opens the https handler app on macOS', () => {
    expect(browserLaunchPlan('darwin', '/Applications/Firefox.app', FILE)).toEqual([
      { kind: 'exec', file: 'open', args: ['-a', '/Applications/Firefox.app', FILE] },
      { kind: 'open-path' }
    ])
  })

  it('starts the browser executable on Windows', () => {
    const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    expect(browserLaunchPlan('win32', exe, 'C:\\tmp\\report.html')).toEqual([
      { kind: 'spawn', file: exe, args: ['C:\\tmp\\report.html'] },
      { kind: 'open-path' }
    ])
  })

  it('uses xdg-open on Linux', () => {
    expect(browserLaunchPlan('linux', null, FILE)).toEqual([
      { kind: 'exec', file: 'xdg-open', args: [FILE] },
      { kind: 'open-path' }
    ])
  })

  it('falls back to the default app when no browser is known', () => {
    expect(browserLaunchPlan('darwin', null, FILE)).toEqual([{ kind: 'open-path' }])
    expect(browserLaunchPlan('win32', null, FILE)).toEqual([{ kind: 'open-path' }])
  })
})

describe('createBrowserLauncher', () => {
  function launcher(options: { browser?: string | null; execFails?: boolean; refusal?: string; findThrows?: boolean }) {
    const ran: string[][] = []
    const launch = createBrowserLauncher({
      platform: 'darwin',
      findBrowser: async () => {
        if (options.findThrows) throw new Error('unsupported')
        return options.browser ?? null
      },
      openPath: async (path) => {
        ran.push(['openPath', path])
        return options.refusal ?? ''
      },
      exec: async (file, args) => {
        ran.push([file, ...args])
        if (options.execFails) throw new Error('open failed')
      },
      spawnDetached: async (file, args) => void ran.push(['spawn', file, ...args])
    })
    return { launch, ran }
  }

  it('stops at the first step that works', async () => {
    const { launch, ran } = launcher({ browser: '/Applications/Safari.app' })
    await launch(FILE)
    expect(ran).toEqual([['open', '-a', '/Applications/Safari.app', FILE]])
  })

  it('falls back to the default app when the browser launch fails or the lookup throws', async () => {
    const failed = launcher({ browser: '/Applications/Safari.app', execFails: true })
    await failed.launch(FILE)
    expect(failed.ran).toEqual([['open', '-a', '/Applications/Safari.app', FILE], ['openPath', FILE]])
    const unknown = launcher({ findThrows: true })
    await unknown.launch(FILE)
    expect(unknown.ran).toEqual([['openPath', FILE]])
  })

  it('throws when nothing opened the file', async () => {
    const { launch } = launcher({ browser: '/Applications/Safari.app', execFails: true, refusal: 'no app' })
    await expect(launch(FILE)).rejects.toThrow()
  })
})
