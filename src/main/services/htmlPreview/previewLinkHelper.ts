/**
 * The small script the preview server puts into a served HTML document so its
 * web links still open on a click.
 *
 * The frame's sandbox has no popups and may navigate the app's main frame only
 * inside a user activation (`allow-top-navigation-by-user-activation`); main
 * stops that navigation and sends an `http(s)` target to the browser. A plain
 * link would navigate the frame itself (blocked), and `target=_blank` or
 * `window.open` would be a popup (blocked), so the helper:
 *
 * - retargets a clicked web link to `_top`, and any other link (a `#fragment`,
 *   a page beside the document) to `_self` when its target would take it out
 *   of the frame;
 * - replaces `window.open` with setting `window.top.location`, which Chromium
 *   allows only inside a click;
 * - adds `<base target="_top">` unless the page has its own `<base>`.
 *
 * A convenience only: a page that removes it breaks nothing but its own links.
 * The enforcement is Chromium's sandbox and main's navigation guard. The script
 * has no `<` or `&`, so it is also well-formed inside an XHTML document.
 */
export const PREVIEW_LINK_HELPER_SCRIPT =
  '(function(){' +
  'var d=document,w=window;' +
  "function abs(u){try{return new URL(String(u),d.baseURI)}catch(e){return null}}" +
  "function web(u){if(!u)return false;return u.protocol==='http:'||u.protocol==='https:'}" +
  "d.addEventListener('click',function(e){" +
  "var t=e.target;if(!t||!t.closest)return;var a=t.closest('a[href],area[href]');if(!a)return;" +
  "var h=a.getAttribute('href');" +
  "if(h.charAt(0)!=='#'){if(web(abs(h))){a.setAttribute('target','_top');return}}" +
  "var g=(a.getAttribute('target')||'').toLowerCase();" +
  "if(g===''||g==='_top'||g==='_parent'||g==='_blank')a.setAttribute('target','_self')" +
  '},true);' +
  "w.open=function(u){var x=u?abs(u):null;if(web(x)){try{w.top.location.href=x.href}catch(e){}}return null}" +
  '})();'

const HELPER_TAGS = `<script>${PREVIEW_LINK_HELPER_SCRIPT}</script>`
const BASE_TAG = '<base target="_top"/>'

/**
 * The served document with the helper in it: right after `<head …>`, else
 * after `<html …>`, else after a leading doctype, else at the start. The bytes
 * are handled as latin1 so the page's own encoding survives untouched; a
 * UTF-16 document (by its BOM) is returned as it is.
 */
export function injectPreviewLinkHelper(bytes: Buffer): Buffer {
  if (bytes.length >= 2) {
    const [a, b] = [bytes[0], bytes[1]]
    if ((a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff)) return bytes
  }
  const text = bytes.toString('latin1')
  const hasBase = /<base[\s/>]/i.test(text)
  const tags = hasBase ? HELPER_TAGS : BASE_TAG + HELPER_TAGS
  const at = insertionPoint(text)
  return Buffer.from(text.slice(0, at) + tags + text.slice(at), 'latin1')
}

function insertionPoint(text: string): number {
  for (const pattern of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i]) {
    const match = pattern.exec(text)
    if (match) return match.index + match[0].length
  }
  // Nothing may come before a doctype (it would put the page in quirks mode), nor before an XML declaration.
  const prolog = /^(?:\xef\xbb\xbf)?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!doctype[^>]*>)?/i.exec(text)
  return prolog ? prolog[0].length : 0
}
