'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { decide } = require('./release-draft.cjs')

const rel = (id, tag_name, draft) => ({ id, tag_name, draft })

test('creates a draft when no release has the tag', () => {
  assert.deepEqual(decide([rel(1, 'v0.11.0', false)], '0.11.1'), { action: 'create' })
})

test('reuses the single existing draft, matching v-prefixed or bare tags', () => {
  assert.deepEqual(decide([rel(7, 'v0.11.1', true), rel(1, 'v0.11.0', false)], '0.11.1'), { action: 'reuse', id: 7 })
  assert.deepEqual(decide([rel(8, '0.11.1', true)], '0.11.1'), { action: 'reuse', id: 8 })
})

test('leaves an already published version to electron-builder', () => {
  assert.deepEqual(decide([rel(3, 'v0.11.1', false)], '0.11.1'), { action: 'published', id: 3 })
})

test('refuses when the tag already has two drafts, naming both', () => {
  const d = decide([rel(5, 'v0.11.1', true), rel(6, 'v0.11.1', true)], '0.11.1')
  assert.equal(d.action, 'fail')
  assert.match(d.reason, /5, 6/)
})
