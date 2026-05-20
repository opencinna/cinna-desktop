/**
 * MIME types that can be reduced to plain text via the text extractor
 * (`src/main/services/textExtractor.ts`). Every adapter accepts these
 * regardless of native multimodal support — the extractor runs in the
 * resolver and the adapter sees a plain `text` MediaPart it just inlines
 * into the user message.
 *
 * Kept in one place so the three adapters' `modelCapability` lists stay in
 * sync. New extractable formats only need to be added once.
 */
export const TEXT_EXTRACTABLE_MIMES: readonly string[] = [
  // Plain text / structured-text
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
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
  'application/x-sh',
  // Office binary formats (handled by `officeparser`)
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
]
