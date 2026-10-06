import { describe, expect, it } from 'vitest'
import { concatSamples, encodeWav } from './wav'

const text = (bytes: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...bytes.slice(at, at + length))

describe('encodeWav', () => {
  it('writes a 16-bit mono PCM header', () => {
    const bytes = encodeWav(new Float32Array(3), 16000)
    const view = new DataView(bytes.buffer)
    expect(bytes.byteLength).toBe(44 + 6)
    expect(text(bytes, 0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 6)
    expect(text(bytes, 8, 8)).toBe('WAVEfmt ')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(28, true)).toBe(32000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(text(bytes, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(6)
  })

  it('scales samples to int16 little-endian and clips out-of-range values', () => {
    const bytes = encodeWav(new Float32Array([0, 1, -1, 0.5, 2, -3]), 8000)
    const view = new DataView(bytes.buffer)
    const sample = (i: number): number => view.getInt16(44 + i * 2, true)
    expect([0, 1, 2, 3, 4, 5].map(sample)).toEqual([0, 32767, -32768, 16383, 32767, -32768])
  })
})

describe('concatSamples', () => {
  it('joins chunks in order', () => {
    expect(Array.from(concatSamples([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])]))).toEqual([1, 2, 3])
  })
})
