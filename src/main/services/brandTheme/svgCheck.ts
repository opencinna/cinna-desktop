/**
 * The desktop's check of a brand theme SVG (logo or background).
 *
 * Core sanitises every SVG on save (`services/brand_theme/svg_sanitizer.py`)
 * and stores its own deterministic serialisation: no XML declaration,
 * comment, processing instruction, DOCTYPE or CDATA, no whitespace between
 * tags, attributes double-quoted, text only inside `<title>`, and the
 * sanitiser's element and attribute allowlists. This module accepts exactly
 * that form and **rejects** anything else rather than repairing it: core
 * already sanitised the file, so a mismatch means a buggy core or a hostile
 * server. It is a strict tokenizer, not an XML parser — no library, no
 * entities beyond the handful core's escaping emits.
 *
 * The allowlists below are part of the contract and mirror core's.
 *
 * Pure module.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline',
  'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop',
  'clipPath', 'mask', 'title'
])

/** Allowed as attributes and as `style` declarations. */
const PRESENTATION_PROPERTIES: ReadonlySet<string> = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity',
  'clip-path', 'clip-rule', 'mask', 'stop-color', 'stop-opacity', 'color',
  'display', 'visibility', 'overflow', 'shape-rendering', 'vector-effect',
  'paint-order', 'color-interpolation', 'mix-blend-mode', 'isolation'
])

/** Geometry and structural attributes (attributes only, never `style`). */
const GEOMETRY_ATTRIBUTES: ReadonlySet<string> = new Set([
  'id', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy',
  'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'd', 'points', 'pathLength',
  'viewBox', 'preserveAspectRatio', 'transform', 'offset',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'clipPathUnits',
  'maskUnits', 'maskContentUnits', 'version', 'style', 'href'
])

export const SVG_MAX_ELEMENTS = 20_000
export const SVG_MAX_DEPTH = 64

// Python's `\w` on str is Unicode-aware; `\p{L}\p{N}_` is its JS equivalent.
const LOCAL_REF = String.raw`#[A-Za-z_][\p{L}\p{N}_.\-]*`
const HREF_RE = new RegExp(`^${LOCAL_REF}$`, 'u')
const ID_RE = /^[A-Za-z_][\p{L}\p{N}_.\-]*$/u
const URL_RE = /url\(/giu
const SAFE_URL_RE = new RegExp(String.raw`url\(\s*(['"]?)${LOCAL_REF}\1\s*\)`, 'giu')
const FORBIDDEN_VALUE_RE = /javascript:|vbscript:|data:|expression\s*\(|@import|\\|<|>|\/\*/iu
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

const ELEMENT_NAME_RE = /^[A-Za-z][A-Za-z0-9]*/
const ATTRIBUTE_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*/

/** The entities core's attribute escaping emits, and the subset its text escaping does. */
const ATTRIBUTE_ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#10;': '\n', '&#13;': '\r', '&#9;': '\t'
}
const TEXT_ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>' }

export type SvgCheck = { ok: true } | { ok: false; reason: string }

class Refused extends Error {}

function refuse(reason: string): never {
  throw new Refused(reason)
}

function safeValue(value: string): boolean {
  if (FORBIDDEN_VALUE_RE.test(value)) return false
  const urls = value.match(URL_RE)?.length ?? 0
  const safe = value.match(SAFE_URL_RE)?.length ?? 0
  return urls === safe
}

/** Core keeps `prop:value` declarations joined by `;`, lowercased, trimmed, each allowed and safe. */
function checkStyle(style: string, where: string): void {
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) refuse(`a style declaration without a value on <${where}>`)
    const prop = declaration.slice(0, colon)
    const value = declaration.slice(colon + 1)
    if (!PRESENTATION_PROPERTIES.has(prop)) refuse(`style property not allowed on <${where}>`)
    if (!value || value !== value.trim()) refuse(`a non-canonical style value on <${where}>`)
    if (!safeValue(value)) refuse(`an unsafe style value on <${where}>`)
  }
}

function checkViewBox(value: string | undefined): void {
  if (value === undefined) refuse('the <svg> root has no viewBox')
  const parts = value.trim().split(/[\s,]+/).filter(Boolean)
  if (parts.length !== 4 || !parts.every((p) => NUMBER_RE.test(p))) refuse('the viewBox is not four numbers')
  const numbers = parts.map(Number)
  if (!numbers.every(Number.isFinite) || numbers[2] <= 0 || numbers[3] <= 0) {
    refuse('the viewBox has no positive width and height')
  }
}

function checkAttribute(element: string, name: string, value: string): void {
  if (!PRESENTATION_PROPERTIES.has(name) && !GEOMETRY_ATTRIBUTES.has(name)) {
    refuse(`attribute not allowed on <${element}>`)
  }
  if (name === 'href') {
    if (!HREF_RE.test(value) || (element !== 'linearGradient' && element !== 'radialGradient')) {
      refuse(`an href that is not a local gradient reference on <${element}>`)
    }
  } else if (name === 'id') {
    if (!ID_RE.test(value)) refuse(`an id that is not a plain name on <${element}>`)
  } else if (name === 'style') {
    if (!value) refuse(`an empty style on <${element}>`)
    checkStyle(value, element)
  } else if (!safeValue(value)) {
    refuse(`an unsafe attribute value on <${element}>`)
  }
}

/**
 * Check one SVG file. Accepts only core's canonical serialisation with the
 * sanitiser's allowlists applied; answers why it refused otherwise (no URL,
 * no file content beyond a tag name).
 */
export function checkSvg(bytes: Uint8Array): SvgCheck {
  let text: string
  try {
    // `ignoreBOM` keeps a BOM in the text, where the first-character check refuses it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return { ok: false, reason: 'the SVG is not UTF-8' }
  }
  try {
    tokenize(text)
    return { ok: true }
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.message }
    throw err
  }
}

function tokenize(text: string): void {
  let pos = 0
  let elements = 0

  const decode = (raw: string, entities: Readonly<Record<string, string>>, where: string): string =>
    raw.replace(/&[^;]*;?/g, (entity) => {
      const decoded = entities[entity]
      if (decoded === undefined) refuse(`an entity core never writes in <${where}>`)
      return decoded
    })

  /** Parse one element starting at `pos` (which holds `<`); returns after its end. */
  const element = (depth: number, isRoot: boolean): void => {
    if (depth > SVG_MAX_DEPTH) refuse(`elements nest more than ${SVG_MAX_DEPTH} deep`)
    elements += 1
    if (elements > SVG_MAX_ELEMENTS) refuse(`more than ${SVG_MAX_ELEMENTS} elements`)
    if (text[pos] !== '<') refuse('content outside an element')
    pos += 1
    const nameMatch = ELEMENT_NAME_RE.exec(text.slice(pos, pos + 32))
    if (!nameMatch) refuse('a tag that is not an element (comment, declaration or instruction)')
    const name = nameMatch[0]
    pos += name.length
    if (!ALLOWED_ELEMENTS.has(name)) refuse(`element <${name}> is not allowed`)
    if (isRoot !== (name === 'svg')) refuse(isRoot ? 'the root element is not <svg>' : 'a nested <svg>')

    const attributes = new Map<string, string>()
    let first = true
    for (;;) {
      const c = text[pos]
      if (c === '/' && text[pos + 1] === '>') {
        pos += 2
        finish(name, attributes, isRoot)
        return
      }
      if (c === '>') {
        pos += 1
        break
      }
      if (c !== ' ') refuse(`a malformed tag <${name}>`)
      pos += 1
      const attrMatch = ATTRIBUTE_NAME_RE.exec(text.slice(pos, pos + 64))
      if (!attrMatch) refuse(`a malformed attribute on <${name}>`)
      const attr = attrMatch[0]
      pos += attr.length
      if (text[pos] !== '=' || text[pos + 1] !== '"') refuse(`an attribute that is not double-quoted on <${name}>`)
      pos += 2
      const end = text.indexOf('"', pos)
      if (end < 0) refuse(`an unterminated attribute on <${name}>`)
      const raw = text.slice(pos, end)
      pos = end + 1
      if (/[<>\n\r\t]/.test(raw)) refuse(`an attribute value core would have escaped on <${name}>`)
      if (isRoot && first) {
        if (attr !== 'xmlns' || raw !== SVG_NS) refuse('the root is not <svg xmlns="http://www.w3.org/2000/svg">')
        first = false
        continue
      }
      first = false
      if (attributes.has(attr) || attr === 'xmlns') refuse(`a repeated attribute on <${name}>`)
      attributes.set(attr, decode(raw, ATTRIBUTE_ENTITIES, name))
    }
    if (isRoot && first) refuse('the root is not <svg xmlns="http://www.w3.org/2000/svg">')
    finish(name, attributes, isRoot)

    // Content: text for <title>, child elements for the rest; never both, never empty.
    if (name === 'title') {
      const end = text.indexOf('<', pos)
      if (end < 0) refuse('an unterminated <title>')
      const raw = text.slice(pos, end)
      if (!raw) refuse('an empty element written open and closed')
      if (raw.includes('>')) refuse('title text core would have escaped')
      decode(raw, TEXT_ENTITIES, 'title')
      pos = end
    } else {
      if (text[pos] !== '<' || text[pos + 1] === '/') refuse(`text or an empty element inside <${name}>`)
      while (text[pos] === '<' && text[pos + 1] !== '/') element(depth + 1, false)
    }
    const close = `</${name}>`
    if (!text.startsWith(close, pos)) refuse(`text or a mismatched end tag inside <${name}>`)
    pos += close.length
  }

  const finish = (name: string, attributes: Map<string, string>, isRoot: boolean): void => {
    for (const [attr, value] of attributes) checkAttribute(name, attr, value)
    if (isRoot) checkViewBox(attributes.get('viewBox'))
  }

  if (!text.startsWith('<svg')) refuse('the file does not start with <svg (declaration, comment, DOCTYPE or BOM)')
  element(1, true)
  if (pos !== text.length) refuse('content after the root element')
}
