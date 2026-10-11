import { homedir } from 'node:os'
import { join } from 'node:path'
import { shellEnvForChild } from '../../../shell/env'

/**
 * The child environment an Antigravity ACP server gets for the **user home**:
 * the login shell's environment, the way Codex's is built, with `GEMINI_HOME`
 * kept only when the user set one (it selects their Antigravity profile).
 * Never a credential copied in: the token stays where the server keeps it.
 *
 * The login and the auth probe use exactly this, so the login they see is the
 * one a native-folder turn sees. An isolated folder's own `GEMINI_HOME` is the
 * launcher's to add on top.
 */
export function buildAntigravityEnv(input: {
  shellEnv: NodeJS.ProcessEnv
  processEnv?: NodeJS.ProcessEnv
}): Record<string, string> {
  const env = shellEnvForChild(input.shellEnv, undefined, input.processEnv)
  const home = input.shellEnv.GEMINI_HOME ?? input.processEnv?.GEMINI_HOME ?? process.env.GEMINI_HOME
  if (home) env.GEMINI_HOME = home
  return env
}

/** The Antigravity home a child with `env` reads: its `GEMINI_HOME`, else `~/.gemini`. */
export function antigravityHome(env: Record<string, string | undefined>, home: string = homedir()): string {
  const set = env.GEMINI_HOME?.trim()
  return set ? set : join(home, '.gemini')
}

/**
 * The arguments the server starts with. **None on macOS**: its flags are absl
 * only and `--uid` is fatal there. Linux takes `--uid=`, as the ACP registry
 * lists it (not yet verified on a Linux build).
 */
export function antigravityServerArgs(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === 'linux' ? ['--uid='] : []
}

/** Said when the pinned server could not be installed and nothing more specific is known. */
export const ANTIGRAVITY_NOT_INSTALLED = 'Antigravity could not be installed. Try again in Settings → Agents → Runtime.'
