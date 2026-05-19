/**
 * Shape of a file attachment shared between main and renderer. A successful
 * upload to the Cinna backend's `/api/v1/files/upload` endpoint is condensed
 * into one of these so the renderer can render badges without knowing the
 * upstream's full FileUploadPublic schema.
 *
 * `id` is the backend file_id (UUID) — sent back via A2A message metadata
 * so the cinna-backend can attach the file to the user message when the
 * agent receives it.
 */
export interface MessageAttachment {
  id: string
  filename: string
  size: number
  mimeType: string
}
