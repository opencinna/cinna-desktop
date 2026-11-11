import { describe, expect, it } from 'vitest'
import { isCloudBackend, isSpeechStreamEvent, isVoiceCloudService, isVoiceCloudTranscription } from './speech'

describe('isSpeechStreamEvent', () => {
  it('lets the Gemini backend through on start and engine-change, so the preload does not drop it', () => {
    expect(isSpeechStreamEvent({ type: 'start', backend: 'gemini-live' })).toBe(true)
    expect(isSpeechStreamEvent({ type: 'engine-change', backend: 'gemini-live', reason: 'x' })).toBe(true)
    expect(isSpeechStreamEvent({ type: 'start', backend: 'sfspeech' })).toBe(true)
    expect(isSpeechStreamEvent({ type: 'start', backend: 'whisper' })).toBe(false)
  })

  it('lets the relay backend through and marks it, like Gemini, as cloud', () => {
    expect(isSpeechStreamEvent({ type: 'start', backend: 'core-relay' })).toBe(true)
    expect(isCloudBackend('core-relay')).toBe(true)
    expect(isCloudBackend('gemini-live')).toBe(true)
    expect(isCloudBackend('sfspeech')).toBe(false)
    expect(isCloudBackend(null)).toBe(false)
  })

  it('accepts an error with a well-formed relay offer and drops a malformed one', () => {
    const error = { type: 'error', code: 'failed', message: 'x', recoverable: false }
    expect(isSpeechStreamEvent(error)).toBe(true)
    expect(isSpeechStreamEvent({ ...error, offer: { engine: 'core-relay', serverName: 'Acme' } })).toBe(true)
    expect(isSpeechStreamEvent({ ...error, offer: { engine: 'gemini-live', serverName: 'Acme' } })).toBe(false)
    expect(isSpeechStreamEvent({ ...error, offer: { engine: 'core-relay' } })).toBe(false)
    expect(isSpeechStreamEvent({ ...error, offer: 'yes' })).toBe(false)
  })
})

describe('isVoiceCloudService', () => {
  it('accepts automatic, core and gemini only', () => {
    expect(['', 'core', 'gemini'].every(isVoiceCloudService)).toBe(true)
    expect(isVoiceCloudService('openai')).toBe(false)
    expect(isVoiceCloudService(undefined)).toBe(false)
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
