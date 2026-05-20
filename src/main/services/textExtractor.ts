import { parseOffice } from 'officeparser'
import { createLogger } from '../logger/logger'

const logger = createLogger('text-extractor')

/**
 * Soft cap on extracted text length per attachment. A 30MB XLSX can
 * decompose into hundreds of MB of cell text — feeding that into the
 * LLM context wastes tokens (and may overflow the model's window
 * silently). The cap is conservative: most useful documents fit, and
 * runaway files get truncated with a clear marker the LLM can read.
 */
const MAX_EXTRACTED_CHARS = 256 * 1024

/**
 * MIME types whose bytes can be decoded as UTF-8 text directly without a
 * parser. Includes plain-text family, code formats, structured-data
 * formats, and `text/csv`. Anything not in this list and not in the
 * office bucket is rejected upstream by the resolver.
 */
const UTF8_DECODE_MIMES = new Set<string>([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/xml',
  'text/css',
  'text/javascript',
  'text/x-python',
  'text/x-yaml',
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
  'application/typescript',
  'application/x-sh'
])

/**
 * MIME types officeparser can handle (binary office documents + PDF).
 * Adapters that natively accept a given MIME (e.g. Anthropic for PDFs)
 * keep the bytes-through path; non-native providers route through here.
 */
const OFFICE_MIMES = new Set<string>([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  'text/rtf'
])

export function isUtf8DecodableMime(mime: string): boolean {
  if (UTF8_DECODE_MIMES.has(mime)) return true
  // `text/*` is a broad text bucket — anything labeled text/ counts even if
  // we didn't enumerate the subtype. Office text-extraction handles binary
  // formats; the text/* branch is for "definitely already text on disk".
  return mime.startsWith('text/')
}

export function isOfficeExtractableMime(mime: string): boolean {
  return OFFICE_MIMES.has(mime)
}

/** Union — the resolver uses this to decide if extraction is even possible. */
export function isTextExtractableMime(mime: string): boolean {
  return isUtf8DecodableMime(mime) || isOfficeExtractableMime(mime)
}

/**
 * Cap an extracted string at {@link MAX_EXTRACTED_CHARS}. Truncation is
 * marked inline so the LLM sees that there's more content it isn't being
 * shown — better than silent dropping where the model invents from
 * truncated data without knowing it's truncated.
 */
function capText(text: string, filename: string | undefined): string {
  if (text.length <= MAX_EXTRACTED_CHARS) return text
  const truncated = text.slice(0, MAX_EXTRACTED_CHARS)
  logger.warn('extracted text truncated', {
    filename,
    originalChars: text.length,
    cap: MAX_EXTRACTED_CHARS
  })
  return `${truncated}\n\n[…truncated: original was ${text.length.toLocaleString()} characters; only the first ${MAX_EXTRACTED_CHARS.toLocaleString()} are shown.]`
}

/**
 * Extract a plain-text representation of `bytes` based on `mime`. Returns
 * `null` when extraction fails or the MIME isn't in either bucket — the
 * resolver logs and drops the part instead of crashing the turn.
 *
 * Office extraction runs through `officeparser`, which is async and can
 * throw on malformed inputs; we catch and convert to a soft failure.
 * Successful extractions log duration + sizes so the logger overlay
 * (Cmd+`) can be used to diagnose slow attachments.
 */
export async function extractText(
  bytes: Buffer,
  mime: string,
  filename?: string
): Promise<string | null> {
  if (isUtf8DecodableMime(mime)) {
    try {
      const text = bytes.toString('utf-8')
      return capText(text, filename)
    } catch (err) {
      logger.warn('utf8 decode failed', {
        mime,
        filename,
        error: err instanceof Error ? err.message : String(err)
      })
      return null
    }
  }

  if (isOfficeExtractableMime(mime)) {
    const started = Date.now()
    try {
      const ast = await parseOffice(bytes)
      const text = ast.toText()
      if (!text || text.trim().length === 0) {
        logger.warn('office extract produced empty text', {
          mime,
          filename,
          durationMs: Date.now() - started,
          bytesIn: bytes.length
        })
        return null
      }
      const capped = capText(text, filename)
      logger.info('office extracted', {
        mime,
        filename,
        durationMs: Date.now() - started,
        bytesIn: bytes.length,
        charsOut: capped.length,
        truncated: capped.length !== text.length
      })
      return capped
    } catch (err) {
      logger.warn('office extract failed', {
        mime,
        filename,
        durationMs: Date.now() - started,
        bytesIn: bytes.length,
        error: err instanceof Error ? err.message : String(err)
      })
      return null
    }
  }

  return null
}
