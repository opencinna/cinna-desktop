/**
 * Skill links: a catalog skill shared by copy-paste.
 *
 *   https://<origin>/get/skill/<package_id>          the shared form (what both products copy)
 *   cinna://skill/<package_id>?server=<origin>       the deep-link form (the public page's button)
 *
 * `<package_id>` is core's reverse-DNS package id (`[A-Za-z0-9._-]`, at most
 * 255). `<origin>` is `https`, or `http` on loopback for development, reduced
 * to its origin. The link carries no revision: it always means the latest
 * version, and the offer names the version the person would get.
 *
 * Parsing is strict, like `componentReference.ts`: an input that is not exactly
 * one link (after trimming whitespace and surrounding `<>`) is plain text. Pure,
 * shared by main (the deep link) and the renderer (paste, transcript click).
 */

import type { CatalogSkillRefusal } from './catalogSkills'
import { MAX_URL_LENGTH, normalizeServerOrigin } from './serverOrigin'

export const SKILL_LINK_PATH_PREFIX = '/get/skill/'
export const SKILL_LINK_CINNA_PREFIX = 'cinna://skill/'

/** Main → renderer push when a `cinna://skill/…` link arrives while a window is open. */
export const SKILL_LINK_INTENT_CHANNEL = 'skill-link:intent'

export interface SkillLink {
  /**
   * The server's origin. Null only for the `cinna://` form without `server=`,
   * which resolves against the active profile (and the offer says so).
   */
  origin: string | null
  packageId: string
  form: 'https' | 'cinna'
  serverGiven: boolean
}

/** A `cinna://skill/…` deep link the OS delivered, as it crosses into the renderer. */
export interface SkillLinkIntent {
  link: SkillLink
  /** `Date.now()` when it arrived; `consume(receivedAt)` drops only this one. */
  receivedAt: number
}

/** Why the composer's agent cannot take the skill. `no_agent`: no single agent is picked. */
export type SkillLinkTargetRefusal = 'not_kit_agent' | 'read_only' | 'access_unknown' | 'clash' | 'no_agent'

/** The skill as the fresh catalog listing describes it. */
export interface SkillLinkSkill {
  packageUuid: string
  packageId: string
  /** The listing's `display_name`, else its `name`. */
  title: string
  /** The skill's folder name (what a pin is called). */
  name: string
  revisionNumber: number
  /** The latest version's label (`1.2.0`, `beta`), when it has one. */
  versionLabel: string | null
  publisher: string | null
  description: string | null
  /** The listing item's `required_credential_specs`, verbatim; the renderer reads them with `catalogCredentialSpecs`. */
  requiredCredentialSpecs: Record<string, unknown>[]
}

/** Whether the skill can go on the composer's agent. */
export type SkillLinkTarget =
  | { agentId: string; agentName: string; verdict: 'ok' }
  | {
      agentId: string
      agentName: string
      verdict: 'already_added'
      /** The pin's folder name, for Update. */
      pinName: string
      pinnedRevision: number | null
      behind: boolean
    }
  | { agentId: string | null; agentName: string | null; verdict: SkillLinkTargetRefusal }

/**
 * `skill-link:resolve`'s answer (README §4). Data, never a thrown code: a
 * thrown `DomainError.code` does not reach the renderer. `host` is the
 * origin's host for display (null only for a server-less `cinna://` link with
 * no Cinna profile active).
 */
export type SkillLinkResolution =
  | { state: 'ok'; host: string; origin: string; serverGiven: boolean; skill: SkillLinkSkill; target: Exclude<SkillLinkTarget, { verdict: 'already_added' }> }
  | { state: 'already_added'; host: string; origin: string; serverGiven: boolean; skill: SkillLinkSkill; target: Extract<SkillLinkTarget, { verdict: 'already_added' }> }
  | {
      state: 'other_profile'
      host: string
      origin: string
      profileId: string
      profileName: string
      /** From that profile's cached listing when it has the package; never used to answer access. */
      title: string | null
    }
  | { state: 'not_connected'; host: string | null; origin: string | null }
  | { state: 'no_access'; host: string; origin: string }
  | { state: 'offline'; host: string; origin: string }
  /** The active profile's Cinna session is gone; main has raised the sign-in prompt. */
  | { state: 'reauth_required'; host: string; origin: string }

export interface SkillLinkResolveInput {
  origin: string | null
  packageId: string
  /** The composer's directly addressed agent; absent → `no_agent`. */
  agentId?: string | null
}

/** Re-exported so the renderer can phrase Add's own refusal without importing two files. */
export type { CatalogSkillRefusal }

/**
 * A pattern matching `word` in any letter case. Schemes and the deep link's
 * action are case-insensitive, as `URL` and `connectIntentService` read them;
 * the https path and the `server` parameter name are not.
 */
const anyCase = (word: string): string => [...word].map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join('')

/** Core's `package_id` alphabet. A dot-only id (`.`, `..`) is a path segment, not a package. */
const PACKAGE_ID = /^(?!\.+$)[A-Za-z0-9._-]{1,255}$/

/**
 * The https form, whole-string: scheme, authority, exactly `/get/skill/<id>`,
 * an optional trailing slash. No query or fragment. The authority is checked
 * by {@link normalizeServerOrigin} (https, loopback http, no userinfo).
 */
const HTTPS_FORM = new RegExp(`^(${anyCase('http')}[Ss]?://[^/?#\\\\]+)/get/skill/([^/?#]+)/?$`)

/**
 * The deep-link form: the action read from the authority (`cinna://skill/…`)
 * or the first path segment (`cinna:///skill/…`), as `connectIntentService`
 * reads `connect`. An optional trailing slash and one optional `server=`
 * parameter, nothing else.
 */
const CINNA_FORM = new RegExp(`^${anyCase('cinna')}:///?${anyCase('skill')}/([^/?#]+)/?(?:\\?server=([^&#]*))?$`)

/**
 * A whole string that is exactly one skill link, or null. Surrounding
 * whitespace and one pair of `<>` (how mail clients wrap a link) are
 * tolerated; nothing else is guessed.
 */
export function parseSkillLink(text: string): SkillLink | null {
  if (typeof text !== 'string' || text.length > MAX_URL_LENGTH) return null
  let candidate = text.trim()
  if (candidate.startsWith('<') && candidate.endsWith('>')) candidate = candidate.slice(1, -1)
  // Anything with whitespace inside is prose, or more than one link.
  if (candidate === '' || /\s/.test(candidate)) return null

  const https = HTTPS_FORM.exec(candidate)
  if (https) {
    const [, authority, packageId] = https
    if (!PACKAGE_ID.test(packageId)) return null
    const origin = normalizeServerOrigin(authority)
    if (!origin.ok) return null
    return { origin: origin.origin, packageId, form: 'https', serverGiven: true }
  }

  const cinna = CINNA_FORM.exec(candidate)
  if (cinna) {
    const [, packageId, server] = cinna
    if (!PACKAGE_ID.test(packageId)) return null
    if (server === undefined) return { origin: null, packageId, form: 'cinna', serverGiven: false }
    // Decoded as `URLSearchParams` decodes it, which is how the connect link's `server` is read.
    const decoded = new URLSearchParams(`server=${server}`).get('server') ?? ''
    const origin = normalizeServerOrigin(decoded)
    if (!origin.ok) return null
    return { origin: origin.origin, packageId, form: 'cinna', serverGiven: true }
  }

  return null
}

/** The shared https form, `<origin>/get/skill/<package_id>`: what Copy install link writes. */
export function formatSkillLink(origin: string, packageId: string): string {
  const normalized = normalizeServerOrigin(origin)
  const base = normalized.ok ? normalized.origin : origin.trim().replace(/\/+$/, '')
  return `${base}${SKILL_LINK_PATH_PREFIX}${packageId}`
}
