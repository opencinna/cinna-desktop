/**
 * The adapter for a service this build does not have.
 *
 * A task row carries whatever `remote_adapter` string was written when it was
 * bound — by an older build, by a newer one over app-sync, by a feature that
 * has since been removed. The row must still open: its title, its status, its
 * handoff note and its history are all local, and none of them depends on the
 * service being reachable. So an unknown id resolves to this rather than to
 * `undefined`, and every surface gets an adapter-shaped answer instead of a
 * branch for "there is no adapter".
 *
 * It keeps the id it stands in for, so `binding.adapter === adapter.id` holds
 * here as it does for a real one, and so the reason can name the service the
 * task actually claims to be on.
 *
 * Everything it can do is nothing: {@link RemoteTaskCapabilities} is false
 * throughout, so a caller that asks first never calls anything, and a caller
 * that does not gets {@link UnsupportedRemoteOperation} — which is the bug it
 * is, rather than a task that silently stops syncing.
 */

import {
  UnsupportedRemoteOperation,
  type RemoteAvailability,
  type RemoteBinding,
  type RemoteTaskAdapter,
  type RemoteTaskCapabilities
} from './adapter'

const NOTHING: RemoteTaskCapabilities = {
  assigneeDirectory: false,
  create: false,
  writeStatus: false,
  handoffNote: false,
  archive: false,
  writeFields: [],
  comments: false,
  writeArtifactKinds: [],
  subtasks: false,
  execute: false,
  asks: false,
}

export function createNullAdapter(id: string): RemoteTaskAdapter {
  const refuse = (operation: string): never => {
    throw new UnsupportedRemoteOperation(id, operation)
  }

  const unavailable: RemoteAvailability = {
    ready: false,
    reason: `This task is on a service this version of Cinna does not know about (“${id}”). Everything on this page is stored here and still works; nothing is being sent to that service.`
  }

  return {
    id,
    listAssignees: async () => refuse('listAssignees'),
    // A fresh object every call. The temptation is to hand out the shared
    // `NOTHING` — every field is false, so what is there to protect? — but a
    // caller that edits what it was handed would then be editing the answer
    // every *other* task on an unknown service gets for the rest of the
    // session. The contract suite fails on exactly that.
    capabilities: () => ({ ...NOTHING, writeFields: [], writeArtifactKinds: [] }),
    availability: async () => unavailable,
    create: async () => refuse('create'),
    putHandoffNote: async () => refuse('putHandoffNote'),
    pushFields: async () => refuse('pushFields'),
    pushStatus: async () => refuse('pushStatus'),
    archive: async () => refuse('archive'),
    fetch: async () => refuse('fetch'),
    // **`null`, not a refusal**, and it is the one method here that answers.
    // `null` is this question's own word for "cannot tell", which is exactly
    // what a build with no adapter for this service knows — and the caller
    // already has to handle it, so refusing would make the take-over path
    // choose between a throw and a tri-state for the same fact.
    liveSession: async () => null,
    list: async () => refuse('list'),
    listSubtasks: async () => refuse('listSubtasks'),
    execute: async () => refuse('execute'),
    addComment: async () => refuse('addComment'),
    listComments: async () => refuse('listComments'),
    putArtifact: async () => refuse('putArtifact'),
    listOpenAsks: async () => refuse('listOpenAsks'),
    answerAsk: async () => refuse('answerAsk'),
    deepLink: (_binding: RemoteBinding) => null
  }
}
