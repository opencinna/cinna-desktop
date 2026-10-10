/** Finding codes about skills — see {@link isSkillFinding}. */
const SKILL_FINDING_PREFIXES = ['skills.', 'manifest.catalog_skills']

/**
 * Whether a finding is about a skill: a `skills/<name>/SKILL.md` or the
 * agent's skill budget (`skills.*`), or a catalog pin
 * (`manifest.catalog_skills*`). `kit.py validate` reports the broken ones as
 * errors, and so does the validator; but **skills do not decide readiness**
 * — a broken skill is left out of every engine (it is not deliverable) and
 * the agent runs without it — so the scanner leaves these out when it decides
 * whether the agent is `invalid`, and the agent page does not count them as
 * a reason the folder is invalid.
 *
 * Shared, so main and renderer judge a finding the same way.
 */
export function isSkillFinding(finding: { code: string }): boolean {
  return SKILL_FINDING_PREFIXES.some((prefix) => finding.code.startsWith(prefix))
}
