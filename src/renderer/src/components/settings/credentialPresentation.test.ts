import { describe, expect, it } from 'vitest'
import type { ServiceCredentialDto } from '../../../../shared/serviceCredentials'
import { accountReference, credentialHealth, credentialManageUrl, credentialOwnership, profileReference } from './credentialPresentation'

const dto: ServiceCredentialDto = {
  id: 'c', origin: 'cloud', cloudId: 'core-id', name: 'Token', type: 'api_token', serviceUri: null, notes: null,
  status: 'complete', isPlaceholder: false, relation: 'owned', ownerEmail: null, localUseAllowed: true,
  revision: null, hasValues: true, expiresAt: null
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
