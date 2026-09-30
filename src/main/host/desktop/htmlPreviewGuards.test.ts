import { describe, expect, it } from 'vitest'
import {
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
