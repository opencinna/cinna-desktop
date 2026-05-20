/**
 * DTOs for the Cinna task run view (comments + attachments fetched from
 * cinna-core). Lives in `shared` so the main-process service, preload
 * binding, and renderer all type-check against the same shape.
 */

export interface CinnaTaskAttachmentDto {
  id: string
  filename: string
  size: number | null
  mimeType: string | null
  /** Optional direct URL — when null the desktop falls back to /api/v1/files/{id}/download. */
  url: string | null
}

/**
 * `comment_type` values from cinna-core (see workflow-runner-core's
 * input_tasks docs). `message` and `result` are user/agent content;
 * the rest (`status_change`, `assignment`, `system`) are system-generated
 * activity entries the UI renders compactly.
 */
export type CinnaTaskCommentType =
  | 'message'
  | 'result'
  | 'status_change'
  | 'assignment'
  | 'system'
  | string

/**
 * comment_type values that represent system-generated activity (status
 * transitions, assignment changes, platform notifications) rather than
 * authored content. Both the task view and the run row's badge use this
 * to separate "activity log" entries from real comments.
 */
export const SYSTEM_COMMENT_TYPES: ReadonlySet<CinnaTaskCommentType> = new Set([
  'status_change',
  'assignment',
  'system'
])

export function isContentComment(c: { commentType: CinnaTaskCommentType }): boolean {
  return !SYSTEM_COMMENT_TYPES.has(c.commentType)
}

export interface CinnaTaskCommentDto {
  id: string
  commentType: CinnaTaskCommentType
  authorName: string | null
  authorRole: string | null
  authorId: string | null
  content: string
  createdAt: string | null
  attachments: CinnaTaskAttachmentDto[]
}

export interface CinnaTaskViewDto {
  task: {
    id: string
    short_code: string | null
    status: string
    title: string
  }
  comments: CinnaTaskCommentDto[]
  attachments: CinnaTaskAttachmentDto[]
}
