/**
 * Who authored the message that starts a turn.
 *
 * A closed set, and the closing is the point: the origin decides which row the
 * transcript keeps (a user bubble or a system row), whether a chat title is
 * generated from it, and whether the send carries an A2A `messageId`. Every
 * value but `user` is written by the desktop itself, so a new one has to be
 * read against all three of those decisions rather than added to a union.
 *
 *  - `user`     — a person typed it. The only origin an IPC payload can cause.
 *  - `runner`   — an autonomous task's prompt (`taskRunnerService`,
 *                 `scriptRuntimeService`). Requires an owning task runner.
 *  - `handover` — a file handover coming back to the chat that asked for it
 *                 (`drafts/file_handovers` §3.6). Owns no task runner.
 */
export type TurnInputOrigin = 'user' | 'runner' | 'handover' | 'specialist'

/**
 * Did the desktop write this message rather than a person?
 *
 * The one predicate behind "it is a system row, it generates no title, and it
 * is not an A2A user message". Written as "not `user`" so a future origin is
 * desktop-authored by default: the safe direction is a visible system row, not
 * a fake user bubble.
 */
export function isDesktopAuthored(origin: TurnInputOrigin | undefined): boolean {
  return origin !== undefined && origin !== 'user'
}
