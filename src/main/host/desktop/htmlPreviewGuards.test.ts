import { describe, expect, it } from 'vitest'
import {
  isDetailsFrameEscape,
  createExternalOpenGate,
  isAppPermissionRequester,
  isPreviewDownloadUrl,
  mainFrameNavigation,
  previewFrameNavigation,
  safeHtmlFilename,
  type FrameNavigation
} from './htmlPreviewGuards'

/** What keeps a previewed page inside its frame, decided without Electron. */

const PREVIEW = 'cinna-preview://0123abcd/report.html'

const nav = (over: Partial<FrameNavigation>): FrameNavigation => ({
  isMainFrame: false,
  url: 'https://example.com/',
  frameUrl: PREVIEW,
  ancestorUrls: [],
  ...over
})

describe('mainFrameNavigation', () => {
  const PACKAGED = 'file:///Applications/Cinna%20Desktop.app/Contents/Resources/app.asar/out/renderer/index.html'
  const DEV = 'http://localhost:5173/'
  const main = (url: string, initiatorUrls: string[] = [], appUrls: string[] = [PACKAGED]) =>
    mainFrameNavigation({ url, appUrls, initiatorUrls })

  it("lets the app reload its own page, packaged or on the dev server", () => {
    expect(main(`${PACKAGED}#/chat/1`, [PACKAGED])).toBe('allow')
    expect(main(`${PACKAGED}?x=1`)).toBe('allow')
    expect(main('http://localhost:5173/index.html', [DEV], [DEV])).toBe('allow')
  })

  it('sends a web page a preview frame navigates the window to to the browser', () => {
    expect(main('https://example.com/a', [PREVIEW])).toBe('open-external')
    expect(main('http://example.com/a', [PREVIEW])).toBe('open-external')
    // A frame the page embeds, clicked: its preview ancestor counts.
    expect(main('https://www.youtube.com/watch?v=x', ['https://www.youtube.com/embed/x', PREVIEW])).toBe('open-external')
  })

  it('blocks anything else leaving the app page', () => {
    expect(main('file:///etc/passwd', [PREVIEW])).toBe('block')
    expect(main('file:///Applications/Other.app/index.html', [PREVIEW])).toBe('block')
    expect(main('cinna://connect', [PREVIEW])).toBe('block')
    expect(main('javascript:alert(1)', [PREVIEW])).toBe('block')
    // Not from a preview: the app's own frame, or an initiator that is gone.
    expect(main('https://example.com/a', [])).toBe('block')
    expect(main('https://example.com/a', ['https://example.com/'])).toBe('block')
    expect(main('file:///etc/passwd', [PREVIEW], [DEV])).toBe('block')
  })

  it("never lets a preview navigate the window to the app's own page", () => {
    // In development the app page is http(s): it goes to the browser, the window stays.
    expect(main('http://localhost:5173/', [PREVIEW], [DEV])).toBe('open-external')
    expect(main('http://localhost:5173/trayPanel.html', [PREVIEW], [DEV])).toBe('open-external')
    expect(main(PACKAGED, [PREVIEW])).toBe('block')
  })
})

describe('previewFrameNavigation', () => {
  it('leaves the main frame alone', () => {
    expect(previewFrameNavigation(nav({ isMainFrame: true, url: 'file:///x', frameUrl: '' }))).toBe('allow')
  })

  it('lets a frame load the preview scheme and a blank document', () => {
    expect(previewFrameNavigation(nav({ url: PREVIEW, frameUrl: 'about:blank' }))).toBe('allow')
    expect(previewFrameNavigation(nav({ url: 'cinna-preview://0123abcd/page2.html' }))).toBe('allow')
    expect(previewFrameNavigation(nav({ url: 'about:blank', frameUrl: '' }))).toBe('allow')
    expect(previewFrameNavigation(nav({ url: 'about:srcdoc', frameUrl: '' }))).toBe('allow')
  })

  it('blocks the preview document leaving for the web on its own, and sends nothing to the browser', () => {
    // No user gesture reaches this event: a link opens through a top navigation instead.
    expect(previewFrameNavigation(nav({ url: 'https://example.com/' }))).toBe('block')
    expect(previewFrameNavigation(nav({ url: 'http://example.com/' }))).toBe('block')
  })

  it('never lets the preview document go anywhere else', () => {
    for (const url of ['file:///etc/passwd', 'cinna://connect', 'mailto:a@b.c', 'chrome://gpu', 'devtools://x']) {
      expect(previewFrameNavigation(nav({ url }))).toBe('block')
    }
  })

  it('lets a frame the page embeds load web content, and nothing local', () => {
    const embedded = { frameUrl: 'about:blank', ancestorUrls: [PREVIEW] }
    expect(previewFrameNavigation(nav({ ...embedded, url: 'https://www.youtube.com/embed/x' }))).toBe('allow')
    expect(previewFrameNavigation(nav({ ...embedded, url: 'data:text/html,hi' }))).toBe('allow')
    expect(previewFrameNavigation(nav({ ...embedded, url: 'blob:null/1234' }))).toBe('allow')
    expect(previewFrameNavigation(nav({ ...embedded, url: 'file:///Users/me/.ssh/id_rsa' }))).toBe('block')
    // Deeper: under a web frame that is itself under the preview.
    expect(
      previewFrameNavigation(nav({ frameUrl: 'https://a.test/', ancestorUrls: ['https://b.test/', PREVIEW], url: 'https://c.test/' }))
    ).toBe('allow')
  })

  it('blocks a subframe outside any preview', () => {
    expect(previewFrameNavigation(nav({ frameUrl: 'https://a.test/', url: 'https://b.test/' }))).toBe('block')
    expect(previewFrameNavigation(nav({ frameUrl: '', url: 'http://localhost:5173/' }))).toBe('block')
  })
})

describe('isAppPermissionRequester', () => {
  it('keeps the default for the app itself', () => {
    expect(isAppPermissionRequester({ isMainFrame: true, requestingUrl: 'file:///app/index.html' }, 'file:///')).toBe(true)
    expect(isAppPermissionRequester({ isMainFrame: true, requestingUrl: 'http://localhost:5173/' })).toBe(true)
  })

  it('refuses every frame, and anything from the preview scheme or an opaque origin', () => {
    expect(isAppPermissionRequester({ isMainFrame: false, requestingUrl: PREVIEW })).toBe(false)
    expect(isAppPermissionRequester({ isMainFrame: false })).toBe(false)
    expect(isAppPermissionRequester({ isMainFrame: false, requestingUrl: 'https://maps.test/' }, 'https://maps.test')).toBe(false)
    expect(isAppPermissionRequester({ isMainFrame: true, requestingUrl: PREVIEW })).toBe(false)
    expect(isAppPermissionRequester({ isMainFrame: true }, 'null')).toBe(false)
  })
})

describe('isPreviewDownloadUrl', () => {
  it('names the downloads a preview could start', () => {
    expect(isPreviewDownloadUrl(PREVIEW)).toBe(true)
    expect(isPreviewDownloadUrl('blob:null/5b1c')).toBe(true)
    expect(isPreviewDownloadUrl('blob:cinna-preview://0123abcd/5b1c')).toBe(true)
    expect(isPreviewDownloadUrl('data:image/png;base64,AAAA')).toBe(true)
  })

  it('leaves the app’s own blob downloads alone', () => {
    expect(isPreviewDownloadUrl('blob:file:///5b1c')).toBe(false)
    expect(isPreviewDownloadUrl('blob:http://localhost:5173/5b1c')).toBe(false)
  })
})

describe('safeHtmlFilename', () => {
  it('keeps an html name, stripped to its last segment and safe characters', () => {
    expect(safeHtmlFilename('Q3 report (final).html')).toBe('Q3 report (final).html')
    expect(safeHtmlFilename('../../etc/evil.htm')).toBe('evil.htm')
    expect(safeHtmlFilename('..\\..\\x.xhtml')).toBe('x.xhtml')
    expect(safeHtmlFilename('.hidden.html')).toBe('hidden.html')
    expect(safeHtmlFilename('a;b$`c`.html')).toBe('a_b__c_.html')
    expect(safeHtmlFilename(`${'x'.repeat(300)}.html`)).toBe(`${'x'.repeat(115)}.html`)
  })

  it('refuses a name that is not html', () => {
    expect(safeHtmlFilename('report.html.exe')).toBeNull()
    expect(safeHtmlFilename('report')).toBeNull()
    expect(safeHtmlFilename('')).toBeNull()
  })
})

describe('createExternalOpenGate', () => {
  it('lets one open through per activation window', () => {
    let now = 0
    const gate = createExternalOpenGate(5000, () => now)
    expect(gate.mayOpen()).toBe(true)
    now = 1000
    expect(gate.mayOpen()).toBe(false)
    now = 4999
    expect(gate.mayOpen()).toBe(false)
    now = 5000
    expect(gate.mayOpen()).toBe(true)
  })

  it('opens again at once after the user left the app and came back', () => {
    let now = 0
    const gate = createExternalOpenGate(5000, () => now)
    expect(gate.mayOpen()).toBe(true)
    now = 500
    // Focus alone, without leaving first, is not a return.
    gate.windowFocused()
    expect(gate.mayOpen()).toBe(false)
    gate.windowBlurred()
    expect(gate.mayOpen()).toBe(false)
    gate.windowFocused()
    now = 800
    expect(gate.mayOpen()).toBe(true)
    // The return is spent by that open.
    now = 900
    expect(gate.mayOpen()).toBe(false)
  })
})

describe('previewFrameNavigation: a dashboard tile stays under its own path', () => {
  const H = 'dash-00112233445566778899aabbccddeeff'
  const TILE = `cinna-preview://${H}/tile0001/index.html`

  it('lets a tile frame load and reload its first page, and move within its own path', () => {
    expect(previewFrameNavigation(nav({ url: TILE, frameUrl: '' }))).toBe('allow')
    expect(previewFrameNavigation(nav({ url: TILE, frameUrl: 'about:blank' }))).toBe('allow')
    expect(previewFrameNavigation(nav({ url: TILE, frameUrl: TILE }))).toBe('allow')
    expect(previewFrameNavigation(nav({ url: `cinna-preview://${H}/tile0001/sub/other.html#x`, frameUrl: TILE }))).toBe('allow')
  })

  it('blocks another tile on the same host, another dash host, another preview and a climb out of its path', () => {
    for (const url of [
      `cinna-preview://${H}/tile0002/index.html`,
      `cinna-preview://dash-ffff/tile0001/index.html`,
      'cinna-preview://0123abcd/report.html',
      'cinna-preview://art-abc/index.html',
      `cinna-preview://${H}/tile0001/../tile0002/index.html`,
      `cinna-preview://${H}/tile0001%2F..%2Ftile0002/index.html`,
      'about:blank',
      'https://example.com/',
      'data:text/html,hi'
    ]) {
      expect(previewFrameNavigation(nav({ url, frameUrl: TILE })), url).toBe('block')
    }
  })

  it('leaves the HTML preview’s own rules alone', () => {
    expect(previewFrameNavigation(nav({ url: `cinna-preview://${H}/tile0002/index.html`, frameUrl: PREVIEW }))).toBe('allow')
  })

  it('takes the HTML preview sandbox minus top navigation for dashboard frames', async () => {
    const { DASHBOARD_FRAME_SANDBOX, HTML_PREVIEW_SANDBOX } = await import('../../../shared/htmlPreview')
    expect(DASHBOARD_FRAME_SANDBOX.split(' ').sort()).toEqual(
      HTML_PREVIEW_SANDBOX.split(' ').filter((token) => token !== 'allow-top-navigation-by-user-activation').sort()
    )
    expect(DASHBOARD_FRAME_SANDBOX).not.toMatch(/allow-same-origin|allow-popups|allow-top-navigation/)
  })
})

describe('an agent Details frame never navigates itself', () => {
  const DETAILS = 'cinna-preview://det-0123abcd/'
  const frame = (url: string, frameUrl = DETAILS, ancestorUrls: string[] = []) =>
    previewFrameNavigation(nav({ url, frameUrl, ancestorUrls }))

  it('loads once, into a fresh frame', () => {
    expect(frame(DETAILS, '')).toBe('allow')
    expect(frame(DETAILS, 'about:blank')).toBe('allow')
  })

  it('sends an https target (a meta refresh, a plain link) to the browser', () => {
    expect(frame('https://example.com/')).toBe('open-external')
    expect(frame('HTTPS://example.com/a')).toBe('open-external')
  })

  it('blocks every other target, the preview scheme included', () => {
    for (const url of [
      'http://example.com/',
      DETAILS,
      `${DETAILS}#top`,
      'cinna-preview://det-ffff/',
      'cinna-preview://0123abcd/report.html',
      'cinna-preview://art-0123/index.html',
      'data:text/html,<p>x</p>',
      'about:blank',
      'about:srcdoc',
      'blob:null/1234',
      'file:///etc/passwd',
      'javascript:alert(1)'
    ]) {
      expect(frame(url), url).toBe('block')
    }
  })

  it('lets nothing load under it', () => {
    expect(frame('https://example.com/', 'about:blank', [DETAILS])).toBe('block')
    expect(frame('data:text/html,x', '', [DETAILS])).toBe('block')
    expect(frame(PREVIEW, '', [DETAILS])).toBe('block')
  })

  it('sends only https to the browser when it navigates the window', () => {
    const main = (url: string, initiatorUrls: string[]) =>
      mainFrameNavigation({ url, appUrls: ['http://localhost:5173/'], initiatorUrls })
    expect(main('https://example.com/a', [DETAILS])).toBe('open-external')
    expect(main('http://example.com/a', [DETAILS])).toBe('block')
    expect(main('http://localhost:5173/', [DETAILS])).toBe('block')
    expect(main('file:///etc/passwd', [DETAILS])).toBe('block')
    // Another preview keeps its http rule.
    expect(main('http://example.com/a', [PREVIEW])).toBe('open-external')
  })

  it('never navigates the app window to the app itself (the _top its https links carry)', () => {
    // Dev server and packaged file:// app, the page it is on now and another page of it.
    const dev = (url: string) => mainFrameNavigation({ url, appUrls: ['http://localhost:5173/', 'http://localhost:5173/#/chat'], initiatorUrls: [DETAILS] })
    expect(dev('http://localhost:5173/')).toBe('block')
    expect(dev('http://localhost:5173/#/chat')).toBe('block')
    expect(dev('https://localhost:5173/')).toBe('open-external')
    const packaged = (url: string) =>
      mainFrameNavigation({ url, appUrls: ['file:///Applications/Cinna.app/out/renderer/index.html'], initiatorUrls: [DETAILS, 'cinna-preview://0123/'] })
    expect(packaged('file:///Applications/Cinna.app/out/renderer/index.html')).toBe('block')
    expect(packaged(DETAILS)).toBe('block')
    expect(packaged('cinna-preview://det-ffff/')).toBe('block')
  })

  it('forwards Escape only from inside a Details frame', () => {
    expect(isDetailsFrameEscape({ type: 'keyDown', key: 'Escape' }, DETAILS)).toBe(true)
    expect(isDetailsFrameEscape({ type: 'keyUp', key: 'Escape' }, DETAILS)).toBe(false)
    expect(isDetailsFrameEscape({ type: 'keyDown', key: 'Escape', isAutoRepeat: true }, DETAILS)).toBe(false)
    expect(isDetailsFrameEscape({ type: 'keyDown', key: 'Enter' }, DETAILS)).toBe(false)
    // The app's own document hears its Escape itself; other previews are not this modal's.
    expect(isDetailsFrameEscape({ type: 'keyDown', key: 'Escape' }, 'http://localhost:5173/')).toBe(false)
    expect(isDetailsFrameEscape({ type: 'keyDown', key: 'Escape' }, PREVIEW)).toBe(false)
    expect(isDetailsFrameEscape({ type: 'keyDown', key: 'Escape' }, undefined)).toBe(false)
  })

  it('carries a sandbox with no scripts, no same origin, no popups and no forms', async () => {
    const { AGENT_DETAILS_FRAME_SANDBOX } = await import('../../../shared/agentDetails')
    expect(AGENT_DETAILS_FRAME_SANDBOX.split(' ')).toEqual(['allow-top-navigation-by-user-activation'])
  })
})
