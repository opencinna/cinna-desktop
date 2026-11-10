#!/usr/bin/env node
// Ensures exactly one draft GitHub release exists for this version before
// electron-builder publishes.
//
// Why: electron-builder (26.18) creates its GitHub publisher behind an await
// before caching it, so two artifacts finishing together (x64 dmg + zip) get two
// publishers. Each looks the release up, finds none, and creates one: two drafts
// for the same tag, with the artifacts split between them. When a draft already
// exists, every publisher reuses it (gitHubPublisher getOrCreateRelease), so
// creating it here up front closes the race.
'use strict'

const { owner, repo } = { owner: 'opencinna', repo: 'cinna-desktop' }

/**
 * Decide what to do given the repo's releases.
 * A published release is left to electron-builder, which still uploads to one
 * published under 2 hours ago (a Linux re-run) and skips with a warning after.
 * @returns {{ action: 'reuse', id: number } | { action: 'create' } | { action: 'published', id: number } | { action: 'fail', reason: string }}
 */
function decide(releases, version) {
  const tag = `v${version}`
  const matching = releases.filter((r) => r.tag_name === tag || r.tag_name === version)
  const published = matching.filter((r) => !r.draft)
  const drafts = matching.filter((r) => r.draft)
  if (published.length > 0) {
    return { action: 'published', id: published[0].id }
  }
  if (drafts.length > 1) {
    return {
      action: 'fail',
      reason: `${tag} has ${drafts.length} drafts (${drafts.map((r) => r.id).join(', ')}); delete all but one, then rerun`
    }
  }
  if (drafts.length === 1) return { action: 'reuse', id: drafts[0].id }
  return { action: 'create' }
}

async function github(path, token, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `token ${token}`,
      'user-agent': 'cinna-desktop-release',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error(`GitHub ${body ? 'POST' : 'GET'} ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) throw new Error('GH_TOKEN is not set (source ~/.cinna-desktop-signing.env)')
  const { version } = require('../package.json')
  const releases = await github(`/repos/${owner}/${repo}/releases?per_page=100`, token)
  const decision = decide(releases, version)
  if (decision.action === 'fail') throw new Error(decision.reason)
  if (decision.action === 'published') {
    console.log(`release-draft: v${version} is already published (release ${decision.id}); electron-builder decides whether to upload`)
    return
  }
  if (decision.action === 'reuse') {
    console.log(`release-draft: reusing draft ${decision.id} for v${version}`)
    return
  }
  // Same fields electron-builder's createRelease sends.
  const created = await github(`/repos/${owner}/${repo}/releases`, token, {
    tag_name: `v${version}`,
    name: version,
    draft: true,
    prerelease: false
  })
  console.log(`release-draft: created draft ${created.id} for v${version}`)
}

module.exports = { decide }

if (require.main === module) {
  main().catch((err) => {
    console.error(`release-draft: ${err.message}`)
    process.exit(1)
  })
}
