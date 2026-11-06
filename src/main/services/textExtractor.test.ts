import { describe, expect, it, vi } from 'vitest'

const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug: vi.fn(), error: vi.fn(), ...logged }) }))
const { extractText, isTextExtractableMime } = await import('./textExtractor')

const SENTENCE = 'Quarterly attachment check'

/** A one-page PDF drawing `text` in Helvetica — the same shape as the packaged-main probe's. */
function pdfFixture(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const start = Buffer.byteLength(pdf)
  pdf += 'xref\n0 6\n0000000000 65535 f \n'
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(pdf)
}

describe('extractText', () => {
  it('decodes text formats as UTF-8 and caps a runaway file with a marker', async () => {
    expect(await extractText(Buffer.from('héllo, world'), 'text/markdown', 'a.md')).toBe('héllo, world')
    const huge = await extractText(Buffer.from('x'.repeat(300 * 1024)), 'text/plain', 'big.txt')
    expect(huge?.startsWith('x'.repeat(256 * 1024))).toBe(true)
    expect(huge).toContain('[…truncated: original was')
  })

  it('reads the text of an RTF document through officeparser', async () => {
    const text = await extractText(Buffer.from(`{\\rtf1\\ansi ${SENTENCE}}`), 'application/rtf', 'note.rtf')
    expect(text).toContain(SENTENCE)
  })

  it('reads the text of a PDF with pdf.js in its own process', async () => {
    logged.info.mockClear()
    const text = await extractText(pdfFixture(SENTENCE), 'application/pdf', 'report.pdf')
    expect(text).toContain(SENTENCE)
    // A fallback to this process would be logged as a warning code.
    expect(logged.info).toHaveBeenCalledWith('office extracted', expect.not.objectContaining({ warnings: expect.anything() }))
  }, 30_000)

  it('turns a document it cannot read into null rather than a failed turn', async () => {
    logged.warn.mockClear()
    expect(await extractText(Buffer.from('not a pdf at all'), 'application/pdf', 'broken.pdf')).toBeNull()
    expect(logged.warn).toHaveBeenCalled()
  }, 30_000)

  it('returns null for a type it does not extract', async () => {
    expect(isTextExtractableMime('image/png')).toBe(false)
    expect(await extractText(Buffer.from([0x89, 0x50]), 'image/png')).toBeNull()
  })
})
