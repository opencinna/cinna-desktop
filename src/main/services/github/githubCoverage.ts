/**
 * Whether the OpenCinna installations a profile can see cover one repository, and where the user
 * goes to change that. Pure: the cache lives in the auth service.
 */
import { OPENCINNA_INSTALL_URL, type GithubCoverage } from '../../../shared/github'

export type CoverageAnswer = 'covered' | 'not_installed' | 'repo_not_selected'

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

/** `owner/repo` as a caller named it (a trailing `.git` dropped), or null when it is not one. */
export function parseRepo(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const repo = value.endsWith('.git') ? value.slice(0, -4) : value
  return REPO.test(repo) ? repo : null
}

export function ownerOf(repo: string): string { return repo.slice(0, repo.indexOf('/')) }

export function coverageOf(installs: readonly GithubCoverage[], repo: string): { answer: CoverageAnswer; install?: GithubCoverage } {
  const owner = ownerOf(repo).toLowerCase(), wanted = repo.toLowerCase()
  const install = installs.find(i => i.owner.toLowerCase() === owner)
  if (!install) return { answer: 'not_installed' }
  if (install.selection === 'all' || install.repos.some(r => r.toLowerCase() === wanted)) return { answer: 'covered', install }
  return { answer: 'repo_not_selected', install }
}

/**
 * Where Allow access sends the user: the installation's configure page when the app is installed
 * on the owner but not on this repository, else the app's install page (with the owner preselected
 * only when its id is known).
 */
export function installUrlFor(answer: CoverageAnswer, install?: GithubCoverage): string {
  if (answer === 'repo_not_selected' && install) {
    return install.ownerType === 'Organization'
      ? `https://github.com/organizations/${encodeURIComponent(install.owner)}/settings/installations/${install.installationId}`
      : `https://github.com/settings/installations/${install.installationId}`
  }
  return install?.ownerId ? `${OPENCINNA_INSTALL_URL}/permissions?target_id=${install.ownerId}` : OPENCINNA_INSTALL_URL
}
