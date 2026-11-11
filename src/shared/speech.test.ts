import { describe, expect, it } from 'vitest'
import { isSpeechStreamEvent, isVoiceCloudTranscription } from './speech'

describe('isSpeechStreamEvent', () => {
  it('lets the Gemini backend through on start and engine-change, so the preload does not drop it', () => {
    expect(isSpeechStreamEvent({ type: 'start', backend: 'gemini-live' })).toBe(true)
    expect(isSpeechStreamEvent({ type: 'engine-change', backend: 'gemini-live', reason: 'x' })).toBe(true)
    expect(isSpeechStreamEvent({ type: 'start', backend: 'sfspeech' })).toBe(true)
    expect(isSpeechStreamEvent({ type: 'start', backend: 'whisper' })).toBe(false)
  })
})

describe('isVoiceCloudTranscription', () => {
  it('accepts the three modes only', () => {
    expect(['off', 'fallback', 'always'].every(isVoiceCloudTranscription)).toBe(true)
    expect(isVoiceCloudTranscription('on')).toBe(false)
    expect(isVoiceCloudTranscription('')).toBe(false)
    expect(isVoiceCloudTranscription(undefined)).toBe(false)
  })
})
