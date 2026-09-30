import { nativeImage } from 'electron'

/**
 * A small thumbnail of an image through Electron's `nativeImage`: scaled to fit
 * `maxSide` square (never enlarged), PNG when the source is a PNG (it may have
 * transparency), JPEG otherwise. Null when `nativeImage` cannot decode the
 * bytes (SVG, and formats the platform does not read).
 */
export function nativeImageThumbnail(
  bytes: Buffer,
  maxSide: number,
  create: (buffer: Buffer) => Electron.NativeImage = (buffer) => nativeImage.createFromBuffer(buffer)
): { bytes: Buffer; mimeType: string } | null {
  let image: Electron.NativeImage
  try {
    image = create(bytes)
  } catch {
    return null
  }
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  if (width <= 0 || height <= 0) return null
  const scale = Math.min(1, maxSide / Math.max(width, height))
  const small =
    scale < 1
      ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' })
      : image
  const isPng = bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  return isPng ? { bytes: small.toPNG(), mimeType: 'image/png' } : { bytes: small.toJPEG(80), mimeType: 'image/jpeg' }
}
