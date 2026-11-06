import { getShellEnv, shellEnvForChild } from '../../shell/env'
import { withDeveloperToolShims } from '../../shell/developerToolShims'

/**
 * The environment a user command runs in: the login shell's, the developer-tool
 * stubs shadowed and the managed uv last on `PATH`, so a script's `uv run` works
 * before the user installs one. A first `uv run` downloads a Python and patches
 * it with `install_name_tool`, found by `PATH` lookup; on a Mac without the
 * command line tools that is the `/usr/bin` stub, which raises Apple's install
 * dialog, and the shim exits 127 instead.
 */
export async function userCommandShellEnv(): Promise<Record<string, string>> {
  return withDeveloperToolShims(shellEnvForChild(await getShellEnv()))
}
