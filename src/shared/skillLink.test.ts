import { describe, expect, it } from 'vitest'
import { formatSkillLink, parseSkillLink } from './skillLink'

/**
 * The skill-link grammar (plans README §3). A pasted string that is not
 * exactly one link must stay plain text, so each refusal is its own case: a
 * single "rejects bad input" test would pass with half the checks deleted.
 */
const ID = 'com.acme.skills.erp-lookup'

describe('parseSkillLink: the https form', () => {
  it.each([
    [`https://cinna.acme.com/get/skill/${ID}`, 'https://cinna.acme.com'],
    [`https://cinna.acme.com/get/skill/${ID}/`, 'https://cinna.acme.com'],
    [`https://cinna.acme.com:8443/get/skill/${ID}`, 'https://cinna.acme.com:8443'],
    [`https://cinna.acme.com:443/get/skill/${ID}`, 'https://cinna.acme.com'],
    [`HTTPS://Cinna.Acme.com/get/skill/${ID}`, 'https://cinna.acme.com'],
    [`http://localhost:8000/get/skill/${ID}`, 'http://localhost:8000'],
    [`http://127.0.0.1:8000/get/skill/${ID}`, 'http://127.0.0.1:8000'],
    [`  https://cinna.acme.com/get/skill/${ID}\n`, 'https://cinna.acme.com'],
    [`<https://cinna.acme.com/get/skill/${ID}>`, 'https://cinna.acme.com'],
    [` <https://cinna.acme.com/get/skill/${ID}/> `, 'https://cinna.acme.com']
  ])('accepts %s', (text, origin) => {
    expect(parseSkillLink(text)).toEqual({ origin, packageId: ID, form: 'https', serverGiven: true })
  })

  it.each([
    ['another path', `https://cinna.acme.com/get/agent/${ID}`],
    ['a deeper path', `https://cinna.acme.com/get/skill/${ID}/v2`],
    ['a path prefix', `https://cinna.acme.com/app/get/skill/${ID}`],
    ['the catalog page', `https://cinna.acme.com/catalog/skills/${ID}`],
    ['a path in another case', `https://cinna.acme.com/GET/SKILL/${ID}`],
    ['no package id', 'https://cinna.acme.com/get/skill/'],
    ['a query', `https://cinna.acme.com/get/skill/${ID}?x=1`],
    ['an empty query', `https://cinna.acme.com/get/skill/${ID}?`],
    ['a fragment', `https://cinna.acme.com/get/skill/${ID}#top`],
    ['a query after the slash', `https://cinna.acme.com/get/skill/${ID}/?ref=slack`],
    ['plain http off loopback', `http://cinna.acme.com/get/skill/${ID}`],
    ['another scheme', `ftp://cinna.acme.com/get/skill/${ID}`],
    ['userinfo', `https://user:pw@cinna.acme.com/get/skill/${ID}`],
    ['a user without a password', `https://user@cinna.acme.com/get/skill/${ID}`],
    ['two slashes at the end', `https://cinna.acme.com/get/skill/${ID}//`],
    ['a dot segment before the path', `https://cinna.acme.com/./get/skill/${ID}`],
    ['an encoded character in the id', 'https://cinna.acme.com/get/skill/com%2Eacme'],
    ['a space in the id', 'https://cinna.acme.com/get/skill/com acme'],
    ['a character outside the alphabet', 'https://cinna.acme.com/get/skill/com.acme+x'],
    ['a dot-only id', 'https://cinna.acme.com/get/skill/..'],
    ['an id over 255', `https://cinna.acme.com/get/skill/${'a'.repeat(256)}`],
    ['a link in prose', `see https://cinna.acme.com/get/skill/${ID}`],
    ['two links', `https://cinna.acme.com/get/skill/${ID} https://cinna.acme.com/get/skill/${ID}`],
    ['two pairs of brackets', `<<https://cinna.acme.com/get/skill/${ID}>>`],
    ['one bracket', `<https://cinna.acme.com/get/skill/${ID}`],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['an oversized input', `https://cinna.acme.com/get/skill/${ID}${' '.repeat(2048)}`]
  ])('refuses %s', (_label, text) => {
    expect(parseSkillLink(text)).toBeNull()
  })

  it('accepts an id of exactly 255', () => {
    expect(parseSkillLink(`https://cinna.acme.com/get/skill/${'a'.repeat(255)}`)?.packageId).toHaveLength(255)
  })
})

describe('parseSkillLink: the cinna form', () => {
  it('reads the server out of the authority form', () => {
    expect(parseSkillLink(`cinna://skill/${ID}?server=https://cinna.acme.com`)).toEqual({
      origin: 'https://cinna.acme.com',
      packageId: ID,
      form: 'cinna',
      serverGiven: true
    })
  })

  it.each([
    `cinna:///skill/${ID}?server=https://cinna.acme.com`,
    `cinna://skill/${ID}/?server=https://cinna.acme.com`,
    `CINNA://Skill/${ID}?server=https://cinna.acme.com`,
    `cinna://skill/${ID}?server=https%3A%2F%2Fcinna.acme.com`,
    // Reduced to the origin, as the connect link's server is.
    `cinna://skill/${ID}?server=https://cinna.acme.com/some/path`
  ])('reads %s to the same link', (text) => {
    expect(parseSkillLink(text)).toMatchObject({ origin: 'https://cinna.acme.com', packageId: ID, form: 'cinna', serverGiven: true })
  })

  it.each([`cinna://skill/${ID}`, `cinna://skill/${ID}/`, `cinna:///skill/${ID}`])('%s without a server resolves against the active profile', (text) => {
    expect(parseSkillLink(text)).toEqual({ origin: null, packageId: ID, form: 'cinna', serverGiven: false })
  })

  it('keeps a loopback http server', () => {
    expect(parseSkillLink(`cinna://skill/${ID}?server=http://localhost:8000`)?.origin).toBe('http://localhost:8000')
  })

  it.each([
    ['another action', `cinna://connect/${ID}?server=https://cinna.acme.com`],
    ['an empty server', `cinna://skill/${ID}?server=`],
    ['plain http off loopback', `cinna://skill/${ID}?server=http://cinna.acme.com`],
    ['userinfo in the server', `cinna://skill/${ID}?server=https://u:p@cinna.acme.com`],
    ['another parameter', `cinna://skill/${ID}?server=https://cinna.acme.com&x=1`],
    ['only another parameter', `cinna://skill/${ID}?x=1`],
    ['the server named in another case', `cinna://skill/${ID}?SERVER=https://cinna.acme.com`],
    ['a fragment', `cinna://skill/${ID}#x`],
    ['a fragment after the server', `cinna://skill/${ID}?server=https://cinna.acme.com#x`],
    ['a deeper path', `cinna://skill/${ID}/more`],
    ['no package id', 'cinna://skill/'],
    ['a bad package id', 'cinna://skill/com.acme+x'],
    ['a dot-only id', 'cinna://skill/.'],
    ['a link in prose', `open cinna://skill/${ID}`],
    ['an oversized input', `cinna://skill/${ID}?server=https://${'a'.repeat(2100)}.com`]
  ])('refuses %s', (_label, text) => {
    expect(parseSkillLink(text)).toBeNull()
  })
})

describe('formatSkillLink', () => {
  it('writes the https form', () => {
    expect(formatSkillLink('https://cinna.acme.com', ID)).toBe(`https://cinna.acme.com/get/skill/${ID}`)
  })

  it('reduces what it is given to the origin', () => {
    expect(formatSkillLink('https://cinna.acme.com/', ID)).toBe(`https://cinna.acme.com/get/skill/${ID}`)
  })

  it('round-trips through the parser', () => {
    expect(parseSkillLink(formatSkillLink('http://localhost:8000', ID))).toEqual({
      origin: 'http://localhost:8000',
      packageId: ID,
      form: 'https',
      serverGiven: true
    })
  })
})
