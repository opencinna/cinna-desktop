/**
 * Facts about a brand theme asset read from its bytes, never from a file name
 * or from what the server says: the MIME type (core's `images.sniff_mime`)
 * and a raster's pixel size (PNG IHDR, JPEG SOF, WebP VP8 / VP8L / VP8X).
 *
 * Pure module.
 */

export const MIME_SVG = 'image/svg+xml'
export const MIME_PNG = 'image/png'
export const MIME_JPEG = 'image/jpeg'
export const MIME_WEBP = 'image/webp'

export type BrandAssetMime = typeof MIME_SVG | typeof MIME_PNG | typeof MIME_JPEG | typeof MIME_WEBP

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// Core serves only its own canonical SVG serialisation, which always opens
// with `<svg` (svgCheck.ts refuses anything else). So the sniff is a linear
// prefix test, not core's `_SVG_HEAD_RE`: that pattern's repeated
// `<!--[\s\S]*?-->` group backtracks exponentially on a run of comments not
// followed by `<svg`, and a few hundred hostile bytes would freeze main.
function isSvgHead(data: Uint8Array): boolean {
  if (data.length < 5) return false
  if (ascii(data, 0, 4) !== '<svg') return false
  const next = data[4]
  return next === 0x3e /* > */ || next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d
}

function startsWith(data: Uint8Array, bytes: number[], at = 0): boolean {
  if (data.length < at + bytes.length) return false
  return bytes.every((b, i) => data[at + i] === b)
}

function ascii(data: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...data.subarray(at, at + length))
}

/** The asset's real type from its leading bytes, or null when it is not one core accepts. */
export function sniffMime(data: Uint8Array): BrandAssetMime | null {
  if (startsWith(data, PNG_SIGNATURE)) return MIME_PNG
  if (startsWith(data, [0xff, 0xd8, 0xff])) return MIME_JPEG
  if (data.length >= 12 && ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP') return MIME_WEBP
  if (isSvgHead(data)) return MIME_SVG
  return null
}

export interface RasterSize {
  width: number
  height: number
}

function u16be(d: Uint8Array, at: number): number {
  return (d[at] << 8) | d[at + 1]
}
function u16le(d: Uint8Array, at: number): number {
  return d[at] | (d[at + 1] << 8)
}
function u24le(d: Uint8Array, at: number): number {
  return d[at] | (d[at + 1] << 8) | (d[at + 2] << 16)
}
function u32be(d: Uint8Array, at: number): number {
  return ((d[at] << 24) >>> 0) + (d[at + 1] << 16) + (d[at + 2] << 8) + d[at + 3]
}

function pngSize(d: Uint8Array): RasterSize | null {
  if (d.length < 24 || ascii(d, 12, 4) !== 'IHDR') return null
  return { width: u32be(d, 16), height: u32be(d, 20) }
}

/** Start-of-frame markers: every SOFn except DHT (C4), JPG (C8) and DAC (CC). */
function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function jpegSize(d: Uint8Array): RasterSize | null {
  let at = 2
  while (at + 3 < d.length) {
    if (d[at] !== 0xff) return null
    // Fill bytes: any number of 0xFF before the marker.
    while (at < d.length && d[at] === 0xff) at += 1
    if (at >= d.length) return null
    const marker = d[at]
    at += 1
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (marker === 0xd9 || marker === 0xda) return null
    if (at + 2 > d.length) return null
    const length = u16be(d, at)
    if (length < 2) return null
    if (isSof(marker)) {
      if (at + 7 > d.length) return null
      return { height: u16be(d, at + 3), width: u16be(d, at + 5) }
    }
    at += length
  }
  return null
}

function webpSize(d: Uint8Array): RasterSize | null {
  if (d.length < 30) return null
  const chunk = ascii(d, 12, 4)
  const data = 20
  if (chunk === 'VP8 ') {
    // Frame tag (3 bytes), start code 9d 01 2a, then 14-bit width and height.
    if (d[data + 3] !== 0x9d || d[data + 4] !== 0x01 || d[data + 5] !== 0x2a) return null
    return { width: u16le(d, data + 6) & 0x3fff, height: u16le(d, data + 8) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (d[data] !== 0x2f) return null
    const bits = (d[data + 1] | (d[data + 2] << 8) | (d[data + 3] << 16) | (d[data + 4] << 24)) >>> 0
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    return { width: u24le(d, data + 4) + 1, height: u24le(d, data + 7) + 1 }
  }
  return null
}

/** A raster's pixel size from its header, or null when the header cannot be read. */
export function rasterSize(data: Uint8Array, mime: BrandAssetMime): RasterSize | null {
  if (mime === MIME_PNG) return pngSize(data)
  if (mime === MIME_JPEG) return jpegSize(data)
  if (mime === MIME_WEBP) return webpSize(data)
  return null
}
