import { describe, it, expect } from 'vitest'
import { decodeTaskTarget, encodeTaskTarget, taskTargetKind, type TaskTargetRef } from './taskTargets'

describe('task target strings', () => {
  it('encodes each kind and decodes it back to the same target', () => {
    const targets: TaskTargetRef[] = [
      { kind: 'bare', agentId: 'agent-1' },
      { kind: 'kit', agentId: 'agent-2' },
      { kind: 'cloud', agentId: 'remote-7', adapter: 'cinna' }
    ]
    expect(targets.map(encodeTaskTarget)).toEqual(['folder:agent-1', 'kit:agent-2', 'cinna:cinna:remote-7'])
    for (const target of targets) expect(decodeTaskTarget(encodeTaskTarget(target))).toEqual(target)
    expect(targets.map((target) => taskTargetKind(target.kind))).toEqual(['folder', 'kit', 'cinna'])
  })

  it('keeps a separator inside an id from being read as one', () => {
    const awkward: TaskTargetRef = { kind: 'cloud', agentId: 'team:a/b c', adapter: 'svc:2' }
    const encoded = encodeTaskTarget(awkward)
    expect(encoded.split(':')).toHaveLength(3)
    expect(decodeTaskTarget(encoded)).toEqual(awkward)
    expect(decodeTaskTarget(encodeTaskTarget({ kind: 'kit', agentId: 'a:b' }))).toEqual({ kind: 'kit', agentId: 'a:b' })
  })

  it('refuses anything it would not have written', () => {
    for (const value of [undefined, 42, { kind: 'kit', agentId: 'x' }, '', 'kit', 'kit:', 'bare:x', 'folder:a:b', 'cinna:x', 'cinna::x',
      'cinna:x:', 'kit:%zz', 'kit:a%3ab', 'remote:x', `kit:${'a'.repeat(300)}`]) {
      expect(decodeTaskTarget(value)).toBeNull()
    }
  })
})
