import { describe, expect, it } from 'vitest'
import type { ServiceCredentialDto } from '../../../../shared/serviceCredentials'
import { accountReference, credentialHealth, credentialManageUrl, credentialOwnership, oauthFlowHealth, profileReference } from './credentialPresentation'

const dto: ServiceCredentialDto = {
  id: 'c', origin: 'cloud', cloudId: 'core-id', name: 'Token', type: 'api_token', serviceUri: null, notes: null,
  status: 'complete', isPlaceholder: false, relation: 'owned', ownerEmail: null, localUseAllowed: true,
  revision: null, hasValues: true, expiresAt: null, keyStatus: null, agentApi: null, keyBlocked: null, oauthStatus: null, grantedUserEmail: null
}

describe('credentialHealth', () => {
  it('derives the settings-list status from the record, most blocking first', () => {
    expect(credentialHealth(dto)).toEqual({ tone: 'ok', label: 'Ready' })
    expect(credentialHealth({ ...dto, isPlaceholder: true })).toMatchObject({ tone: 'warning' })
    expect(credentialHealth({ ...dto, status: 'incomplete' })).toMatchObject({ tone: 'warning' })
    expect(credentialHealth({ ...dto, expiresAt: 1000 }, undefined, 1000)).toEqual({ tone: 'warning', label: 'Values expired' })
    expect(credentialHealth({ ...dto, expiresAt: 2000 }, undefined, 1000)).toMatchObject({ tone: 'ok' })
    expect(credentialHealth({ ...dto, localUseAllowed: false, isPlaceholder: true })).toEqual({ tone: 'error', label: 'The owner must allow use on your computer' })
    expect(credentialHealth(null)).toMatchObject({ tone: 'error' })
    expect(credentialHealth({ ...dto, hasValues: false })).toEqual({ tone: 'ok', label: 'Available — values download when an agent uses it' })
  })

  it('takes the attachment state over the record when one is given', () => {
    expect(credentialHealth({ ...dto, localUseAllowed: false }, 'ready')).toEqual({ tone: 'ok', label: 'Ready' })
    expect(credentialHealth(dto, 'not_cached')).toEqual({ tone: 'warning', label: 'Values not downloaded yet' })
    expect(credentialHealth(dto, 'expired')).toMatchObject({ tone: 'warning' })
    expect(credentialHealth(dto, 'incomplete')).toMatchObject({ tone: 'warning' })
    expect(credentialHealth(null, 'missing')).toMatchObject({ tone: 'error' })
    expect(credentialHealth(dto, 'local_use_not_allowed')).toEqual({ tone: 'error', label: 'The owner must allow use on your computer' })
    expect(credentialHealth(null, 'account_unavailable')).toMatchObject({ tone: 'error' })
    expect(credentialHealth(dto, 'pending_authorization')).toEqual({ tone: 'warning', label: 'Waiting for Google sign-in' })
    expect(credentialHealth(dto, 'reauth_required')).toEqual({ tone: 'error', label: 'Google access expired' })
  })

  it('reads a Google record’s grant from its oauth status before its values', () => {
    const google: ServiceCredentialDto = { ...dto, type: 'gmail_oauth', hasValues: false }
    expect(credentialHealth({ ...google, oauthStatus: 'ready' })).toMatchObject({ tone: 'ok' })
    expect(credentialHealth({ ...google, oauthStatus: 'pending_authorization', isPlaceholder: true })).toEqual({ tone: 'warning', label: 'Waiting for Google sign-in' })
    expect(credentialHealth({ ...google, oauthStatus: 'reauth_required' })).toEqual({ tone: 'error', label: 'Google access expired' })
    // Only the owner can sign in again: a shared record names whom to ask.
    const shared = { ...google, relation: 'shared' as const, ownerEmail: 'bob@example.com' }
    expect(credentialHealth({ ...shared, oauthStatus: 'reauth_required' })).toEqual({ tone: 'error', label: 'Google access expired — ask bob@example.com to reconnect' })
    expect(credentialHealth(shared, 'pending_authorization')).toEqual({ tone: 'warning', label: 'Waiting for bob@example.com to finish Google sign-in' })
    expect(credentialHealth({ ...shared, ownerEmail: null }, 'reauth_required').label).toBe('Google access expired — ask the owner to reconnect')
    // An attachment state still wins: main has already resolved it.
    expect(credentialHealth({ ...google, oauthStatus: 'reauth_required' }, 'ready')).toEqual({ tone: 'ok', label: 'Ready' })
  })
})

describe('Agent API key status', () => {
  const key: ServiceCredentialDto = { ...dto, type: 'agent_api', keyStatus: 'active', hasValues: false, agentApi: { producerName: 'CRM agent', issuerEmail: 'bob@example.com' } }
  const unknown = { producerName: null, issuerEmail: null }
  // status, tone, label with both facts, label with neither
  const labels: [string, string, string, string][] = [
    ['api_disabled', 'warning', 'CRM agent’s API is turned off — works again when its owner turns it back on', 'API turned off by producer — works again when its owner turns it back on'],
    ['external_access_paused', 'warning', 'External access to CRM agent is paused — works again when its owner resumes it', 'External access paused — works again when its owner resumes it'],
    ['expired', 'error', 'Expired — ask bob@example.com for a new key', 'Expired — ask the issuer for a new key'],
    ['revoked_by_issuer', 'error', 'Revoked by bob@example.com — ask them for a new key', 'Revoked by issuer — ask the issuer for a new key'],
    ['producer_removed', 'error', 'CRM agent was removed — this key no longer calls anything', 'Producer removed — the agent this key called no longer exists'],
    ['issuer_removed', 'error', 'Issuer account removed — ask the producer’s owner for a new key', 'Issuer account removed — ask the producer’s owner for a new key'],
    ['something_new', 'error', 'Unavailable — open it on the remote for details', 'Unavailable — open it on the remote for details']
  ]
  it.each(labels)('reads %s the same on a settings row and an attached row, naming what Core sent', (keyStatus, tone, named, generic) => {
    expect(credentialHealth({ ...key, keyStatus })).toEqual({ tone, label: named })
    expect(credentialHealth({ ...key, keyStatus }, 'key_unavailable')).toEqual({ tone, label: named })
    expect(credentialHealth({ ...key, keyStatus, agentApi: unknown })).toEqual({ tone, label: generic })
    expect(credentialHealth({ ...key, keyStatus, agentApi: null }, 'key_unavailable')).toEqual({ tone, label: generic })
  })
  it('treats an active key like any other record', () => {
    expect(credentialHealth({ ...key, hasValues: true })).toEqual({ tone: 'ok', label: 'Ready' })
    expect(credentialHealth({ ...key, hasValues: true }, 'ready')).toEqual({ tone: 'ok', label: 'Ready' })
    expect(credentialHealth(key)).toMatchObject({ tone: 'ok' })
  })
  it('falls back to unavailable when the state says unavailable but the record does not say why', () => {
    expect(credentialHealth(key, 'key_unavailable')).toEqual({ tone: 'error', label: 'Unavailable — open it on the remote for details' })
    expect(credentialHealth(null, 'key_unavailable')).toEqual({ tone: 'error', label: 'Unavailable — open it on the remote for details' })
  })
  it('puts a non-active key status before local use, missing values and expiry', () => {
    expect(credentialHealth({ ...key, keyStatus: 'revoked_by_issuer', localUseAllowed: false, isPlaceholder: true, status: 'incomplete', expiresAt: 1 }, undefined, 1000))
      .toEqual({ tone: 'error', label: 'Revoked by bob@example.com — ask them for a new key' })
    expect(credentialHealth({ ...key, keyStatus: 'api_disabled', expiresAt: 1 }, undefined, 1000)).toMatchObject({ tone: 'warning', label: expect.stringMatching(/API is turned off/) })
    // Active falls through to the record's own checks.
    expect(credentialHealth({ ...key, expiresAt: 1 }, undefined, 1000)).toEqual({ tone: 'warning', label: 'Values expired' })
  })
  it('reads a blocked delivery as blocked over active, downloaded values and the unavailable fallback, but not over a dead key', () => {
    const blocked = { tone: 'error', label: 'Blocked — this key’s API address isn’t secure (https); ask your Cinna server’s admin to fix it' }
    expect(credentialHealth({ ...key, keyBlocked: 'insecure_base_url' })).toEqual(blocked)
    expect(credentialHealth({ ...key, keyBlocked: 'insecure_base_url', hasValues: true })).toEqual(blocked)
    expect(credentialHealth({ ...key, keyBlocked: 'insecure_base_url' }, 'key_unavailable')).toEqual(blocked)
    expect(credentialHealth({ ...key, keyStatus: 'something_new', keyBlocked: 'other_reason' }, 'key_unavailable')).toEqual(blocked)
    expect(credentialHealth({ ...key, keyStatus: 'revoked_by_issuer', keyBlocked: 'insecure_base_url' })).toMatchObject({ label: expect.stringMatching(/^Revoked by/) })
  })
  it('says who issued the key in its ownership glyph', () => {
    expect(credentialOwnership(key)).toEqual({ kind: 'owned', label: 'Issued to you by bob@example.com' })
    expect(credentialOwnership({ ...key, agentApi: unknown })).toEqual({ kind: 'owned', label: 'Issued to you' })
    expect(credentialOwnership({ ...key, agentApi: null })).toEqual({ kind: 'owned', label: 'Issued to you' })
  })
})

describe('credentialOwnership', () => {
  it('names who holds the record', () => {
    expect(credentialOwnership(dto)).toEqual({ kind: 'owned', label: 'Owned by you' })
    expect(credentialOwnership({ ...dto, relation: 'shared', ownerEmail: 'ann@example.com' })).toEqual({ kind: 'shared', label: 'Shared by ann@example.com' })
    expect(credentialOwnership({ ...dto, relation: 'shared' })).toEqual({ kind: 'shared', label: 'Shared by owner' })
    expect(credentialOwnership({ ...dto, origin: 'local' })).toEqual({ kind: 'local', label: 'Stored on this computer' })
  })
})

describe('credentialManageUrl', () => {
  it('points at Core’s per-credential route on the server root', () => {
    expect(credentialManageUrl('core-id', 'https://core.example.com')).toBe('https://core.example.com/credential/core-id')
    expect(credentialManageUrl('core-id', 'http://localhost:5173/some/path')).toBe('http://localhost:5173/some/path/credential/core-id')
    expect(credentialManageUrl('core-id', 'http://localhost:5173/')).toBe('http://localhost:5173/credential/core-id')
  })
  it('is null without a Core id or a usable server', () => {
    expect(credentialManageUrl(null, 'https://core.example.com')).toBeNull()
    expect(credentialManageUrl('core-id', null)).toBeNull()
    expect(credentialManageUrl('core-id', 'not a url')).toBeNull()
  })
})

describe('profileReference', () => {
  const user = { username: 'ann@example.com', displayName: 'ann', cinnaServerUrl: 'https://core.example.com' }
  it('prefers the Cinna full name and keeps the email', () => {
    expect(profileReference({ ...user, cinnaFullName: 'Ann Lee' })).toEqual({ name: 'Ann Lee', email: 'ann@example.com', serverUrl: 'https://core.example.com', host: 'core.example.com' })
    expect(profileReference({ ...user, cinnaFullName: '' })).toMatchObject({ name: 'ann' })
  })
  it('drops the email when it would repeat the name', () => {
    expect(profileReference({ ...user, displayName: 'ann@example.com' })).toMatchObject({ name: 'ann@example.com', email: null })
  })
  it('is null for a profile without a server', () => {
    expect(profileReference({ ...user, cinnaServerUrl: undefined })).toBeNull()
  })
})

describe('accountReference', () => {
  it('keeps the host as stored when the server URL does not parse', () => {
    expect(accountReference({ name: 'Ann', email: 'ann@example.com', serverUrl: 'not a url' })).toEqual({ name: 'Ann', email: 'ann@example.com', serverUrl: 'not a url', host: 'not a url' })
  })
})

describe('oauthFlowHealth', () => {
  it('reads a waiting flow as a pending grant and a failed one as its reason', () => {
    expect(oauthFlowHealth({ state: 'waiting', error: null })).toEqual({ tone: 'warning', label: 'Waiting for Google sign-in' })
    expect(oauthFlowHealth({ state: 'failed', error: { code: 'timeout', message: 'x' } })).toEqual({ tone: 'error', label: 'Google sign-in was not finished in time.' })
    expect(oauthFlowHealth({ state: 'failed', error: { code: 'other', message: 'Core said no.' } }).label).toBe('Core said no.')
  })
})
