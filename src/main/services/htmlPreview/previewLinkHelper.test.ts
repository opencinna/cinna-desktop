// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { PREVIEW_LINK_HELPER_SCRIPT, injectPreviewLinkHelper } from './previewLinkHelper'

/**
 * The link helper the preview server puts into a served document: where it
 * goes (a pure string transform), and what the script does to a click and to
 * `window.open`. The enforcement is Chromium's sandbox and main's navigation
 * guard, checked by hand in Electron; this is the convenience that makes a
 * link work inside it.
 */

const inject = (html: string): string => injectPreviewLinkHelper(Buffer.from(html, 'latin1')).toString('latin1')
const TAGS = `<base target="_top"/><script>${PREVIEW_LINK_HELPER_SCRIPT}</script>`

describe('injectPreviewLinkHelper', () => {
  it('goes right after <head>, attributes and all', () => {
    expect(inject('<!doctype html><html lang="en"><HEAD data-x="1"><title>t</title></HEAD><body></body></html>')).toBe(
      `<!doctype html><html lang="en"><HEAD data-x="1">${TAGS}<title>t</title></HEAD><body></body></html>`
    )
  })

  it('does not take <header> for <head>', () => {
    expect(inject('<html><body><header>x</header></body></html>')).toBe(
      `<html>${TAGS}<body><header>x</header></body></html>`
    )
  })

  it('goes after a doctype or XML declaration when there is no head or html tag, never before', () => {
    expect(inject('<!DOCTYPE html>\n<p>hi</p>')).toBe(`<!DOCTYPE html>${TAGS}\n<p>hi</p>`)
    expect(inject('<?xml version="1.0"?>\n<!DOCTYPE html><p/>')).toBe(`<?xml version="1.0"?>\n<!DOCTYPE html>${TAGS}<p/>`)
    expect(inject('<p>hi</p>')).toBe(`${TAGS}<p>hi</p>`)
  })

  it("leaves the page's own <base> alone", () => {
    expect(inject('<head><base href="https://cdn.test/"></head>')).toBe(
      `<head><script>${PREVIEW_LINK_HELPER_SCRIPT}</script><base href="https://cdn.test/"></head>`
    )
  })

  it("keeps the page's bytes in any ASCII-compatible encoding, and leaves UTF-16 alone", () => {
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<head></head><p>Grüße — ok</p>', 'utf8')])
    const out = injectPreviewLinkHelper(utf8)
    expect(out.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(out.toString('utf8')).toContain('<p>Grüße — ok</p>')
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<head></head>', 'utf16le')])
    expect(injectPreviewLinkHelper(utf16)).toBe(utf16)
  })

  it('has nothing that would break an XHTML document', () => {
    expect(PREVIEW_LINK_HELPER_SCRIPT).not.toMatch(/[<&]/)
  })
})

describe('the helper script', () => {
  let top: { location: { href: string } }
  let fakeWindow: { open: (url?: unknown) => unknown; top: typeof top }

  beforeEach(() => {
    // The served document's own URL, as in the frame: a relative link resolves to the preview scheme.
    document.head.innerHTML = '<base href="cinna-preview://tok/report.html">'
    document.body.innerHTML = `
      <a id="plain" href="https://example.com/a"><span id="inner">x</span></a>
      <a id="blank" target="_blank" href="http://example.com/b">b</a>
      <a id="named" target="map" href="https://example.com/c">c</a>
      <a id="frag" href="#section">f</a>
      <a id="fragblank" target="_blank" href="#top">f</a>
      <a id="page" target="_blank" href="page2.html">p</a>
      <a id="framed" target="map" href="page3.html">m</a>
      <a id="mail" href="mailto:a@b.test">m</a>`
    top = { location: { href: 'unchanged' } }
    fakeWindow = { open: () => 'original', top }
    // The script reads `window` and `document` by name; the fake window stands in for the frame's.
    new Function('window', 'document', PREVIEW_LINK_HELPER_SCRIPT)(fakeWindow, document)
  })

  const clickAndTarget = (id: string): string | null => {
    const el = document.getElementById(id)!
    // Keep jsdom from trying to navigate.
    document.addEventListener('click', (e) => e.preventDefault(), { once: true })
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return document.getElementById(id === 'inner' ? 'plain' : id)!.getAttribute('target')
  }

  it('sends every clicked web link to the top frame, where main takes it to the browser', () => {
    expect(clickAndTarget('plain')).toBe('_top')
    expect(clickAndTarget('inner')).toBe('_top')
    expect(clickAndTarget('blank')).toBe('_top')
    expect(clickAndTarget('named')).toBe('_top')
  })

  it('keeps a fragment or a page beside the document inside the frame, and a named frame named', () => {
    expect(clickAndTarget('frag')).toBe('_self')
    expect(clickAndTarget('fragblank')).toBe('_self')
    expect(clickAndTarget('page')).toBe('_self')
    expect(clickAndTarget('framed')).toBe('map')
    expect(clickAndTarget('mail')).toBe('_self')
  })

  it('turns window.open of a web page into a top navigation, and nothing else', () => {
    expect(fakeWindow.open('https://example.com/opened')).toBeNull()
    expect(top.location.href).toBe('https://example.com/opened')
    fakeWindow.open('javascript:alert(1)')
    fakeWindow.open('file:///etc/passwd')
    fakeWindow.open()
    expect(top.location.href).toBe('https://example.com/opened')
  })
})
