import { beforeEach, describe, expect, it } from 'vitest'
import { forgetPreviewViews, rememberPreviewView, rememberedPreviewView } from './previewViewMemory'

const view = (scrollTop: number) => ({ scrollTop, share: 0, width: 0 })

describe('previewViewMemory', () => {
  beforeEach(forgetPreviewViews)

  it('holds a view per file', () => {
    rememberPreviewView('a', view(40))
    expect(rememberedPreviewView('a')).toEqual(view(40))
    expect(rememberedPreviewView('b')).toBeUndefined()
  })

  it('forgets the file touched longest ago, not the one first opened', () => {
    rememberPreviewView('first', view(1))
    for (let i = 0; i < 199; i++) rememberPreviewView(`f${i}`, view(i))
    rememberPreviewView('first', view(2))
    rememberPreviewView('one more', view(3))
    expect(rememberedPreviewView('first')?.scrollTop).toBe(2)
    expect(rememberedPreviewView('f0')).toBeUndefined()
  })
})
