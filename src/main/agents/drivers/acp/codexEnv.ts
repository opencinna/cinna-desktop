import { shellEnvForChild } from '../../../shell/env'

/** Use the CLI's saved login and config, without shell API keys or adapter overrides. */
export function buildCodexEnv(input: {
  shellEnv: NodeJS.ProcessEnv
  processEnv?: NodeJS.ProcessEnv
}): Record<string, string> {
  const env = shellEnvForChild(input.shellEnv, undefined, input.processEnv)
  // CODEX_HOME selects the user's CLI profile. Never read or copy its credentials.
  const home = input.shellEnv.CODEX_HOME ?? input.processEnv?.CODEX_HOME ?? process.env.CODEX_HOME
  if (home) env.CODEX_HOME = home
  return env
}
