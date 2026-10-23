import type { CSSProperties } from 'react'

/**
 * Cloud positions for an `.ambient-block` (main.css), derived from a stable
 * seed so the same block always looks the same and two blocks in a row do
 * not look stamped. Only custom properties change; the gradients are painted
 * once, like any static background.
 */
export function ambientMeshStyle(seed: string): CSSProperties {
  // FNV-1a: cheap, stable, well spread over short strings.
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  const pick = (shift: number, from: number, span: number): string =>
    `${from + ((hash >>> shift) & 0xf) * (span / 15)}%`
  return {
    '--mesh-x1': pick(0, 0, 35),
    '--mesh-y1': pick(4, 0, 40),
    '--mesh-x2': pick(8, 60, 40),
    '--mesh-y2': pick(12, 0, 50),
    '--mesh-x3': pick(16, 25, 50),
    '--mesh-y3': pick(20, 75, 35)
  } as CSSProperties
}
