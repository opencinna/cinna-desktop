import { describe, expect, it } from 'vitest'
import { redactRemoteUrl, remoteWebUrl } from './gitService'

/**
 * A remote URL is the one string on the Repository dialog that comes from
 * outside the app, gets turned into a clickable link, and can carry a
 * credential. Both halves are covered here: what becomes a link, and what is
 * safe to put on screen.
 */

describe('remoteWebUrl', () => {
  it('derives a browsable URL from the shapes a browser can open', () => {
    expect(remoteWebUrl('git@github.com:acme/agents.git')).toBe('https://github.com/acme/agents')
    expect(remoteWebUrl('https://github.com/acme/agents.git')).toBe(
      'https://github.com/acme/agents'
    )
    expect(remoteWebUrl('ssh://git@gitlab.com/acme/agents.git')).toBe(
      'https://gitlab.com/acme/agents'
    )
    // A port is dropped: it addresses the ssh daemon, not the web UI.
    expect(remoteWebUrl('ssh://git@example.com:2222/acme/agents.git')).toBe(
      'https://example.com/acme/agents'
    )
  })

  it('never carries a credential into the link', () => {
    // The leak this exists to stop: a repository cloned with a PAT keeps it in
    // the remote, and a link would take it wherever the click goes.
    expect(remoteWebUrl('https://x-access-token:ghp_SECRET@github.com/acme/agents.git')).toBe(
      'https://github.com/acme/agents'
    )
    expect(remoteWebUrl('ssh://user:secret@example.com:2222/acme/agents.git')).toBe(
      'https://example.com/acme/agents'
    )
    // Scheme-less `user:token@host/path` parses as scp-style with host=user,
    // which would build a link whose path is the token. Refused outright.
    expect(remoteWebUrl('user:ghp_SECRET@github.com/acme/agents.git')).toBeNull()
  })

  it('offers no link for a remote a browser has no business with', () => {
    // `app:open-external` refuses everything but http(s); these would be a link
    // that fails after the click.
    for (const raw of [
      '/srv/git/agents.git',
      '../sibling.git',
      './other',
      'file:///srv/git/agents.git',
      'git://example.com/acme/agents.git',
      ''
    ]) {
      expect(remoteWebUrl(raw)).toBeNull()
    }
  })
})

describe('redactRemoteUrl', () => {
  it('strips an embedded credential but keeps the remote recognisable', () => {
    // Shown as body text and as the link's tooltip, so the raw value would put
    // the token on screen and in every screenshot of the dialog.
    // The password goes; `x-access-token` stays, so the string still matches
    // what the user's own `git remote -v` prints.
    expect(redactRemoteUrl('https://x-access-token:ghp_SECRET@github.com/acme/agents.git')).toBe(
      'https://x-access-token@github.com/acme/agents.git'
    )
    expect(redactRemoteUrl('ssh://user:secret@example.com/acme/agents.git')).toBe(
      'ssh://user@example.com/acme/agents.git'
    )
    // scp-style: the password goes, the `git@` that says how it is reached stays.
    expect(redactRemoteUrl('git:hunter2@github.com:acme/agents.git')).toBe(
      'git@github.com:acme/agents.git'
    )
  })

  it('leaves a remote with no credential exactly as git has it', () => {
    for (const raw of [
      'git@github.com:acme/agents.git',
      'https://github.com/acme/agents.git',
      '/srv/git/agents.git',
      '../sibling.git'
    ]) {
      expect(redactRemoteUrl(raw)).toBe(raw)
    }
  })
})
