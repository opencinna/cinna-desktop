/**
 * Cinna's `gh` wrapper, and the git credential wiring that sends github.com
 * through it (GitHub repos, G3/G4/G7/G9).
 *
 * `<userData>/gh-shim/gh` is a POSIX shell script whose directory goes first on
 * the `PATH` of every child `withDeveloperToolShims` builds an environment for
 * (engines, `/run:` and kit commands, schedules, dashboard endpoints, Run
 * Script windows, stdio MCP servers), on macOS and Linux, always. Without the
 * endpoint it falls through to the real `gh`, so that costs nothing. On each
 * call it decides the auth:
 *
 * 1. With the loopback endpoint in the env (`CINNA_GITHUB_URL` and
 *    `CINNA_GITHUB_BEARER`, a kit agent's child while a turn, command or run
 *    holds it), it asks `POST /github/token` for the repo when it can tell which one,
 *    and runs the real `gh` with the OpenCinna token in `GH_TOKEN` and an empty
 *    `GH_CONFIG_DIR`, so neither the user's login nor their gh config mixes in.
 * 2. Otherwise — no endpoint, a 401 (nothing holds the agent any more), or an
 *    answer that something is needed while the user's own `gh` login answers —
 *    the real `gh` runs untouched.
 * 3. Neither: it asks the app to show the row (`POST /github/needed`), prints the
 *    endpoint's sentence and exits 4, gh's own "authentication required" code.
 *
 * An endpoint that cannot be connected to at all means a sandbox without
 * network (Codex `workspace-write` blocks loopback too): the wrapper says so
 * and asks for the command to be run again escalated, rather than letting gh
 * report an outage the agent gives up on (curl exit 7, which a sandbox's
 * refused connect also gives, or 28 before connecting). An endpoint that took
 * the connection but did not answer in time (curl exit 28 after connecting: a
 * slow GitHub refresh), or whose answer broke off (52, 56), is not a sandbox:
 * try again in a moment.
 *
 * git reaches the same wrapper through `gh auth git-credential`: a child that
 * carries the endpoint gets, through `GIT_CONFIG_COUNT/KEY/VALUE`, the
 * github.com credential helper list reset to empty and then set to the
 * wrapper, plus `useHttpPath` so the request carries `path=owner/repo.git`.
 * That beats a user's osxkeychain and `gh auth setup-git` helpers (P0 check 4).
 * Only such a child: `engineCredentialEnv` adds the entries together with the
 * endpoint and strips them without it, and {@link createGhShim}'s `apply`
 * strips them too, so a bare agent, MCP server, Run Script or `/run:` keeps
 * the user's own keychain / GCM login for github.com.
 *
 * The real `gh` is the first `gh` on the caller's `PATH` past Cinna's own
 * directories, else the managed gh (`managedGh.ts`) once it has landed. The
 * token travels only in the env of the `gh` it runs and, for git, on the
 * helper's stdout; never on a command line, in a file or in a log. The bearer
 * reaches curl on stdin (`--config -`), never in its argv.
 *
 * Core module: no Electron. Paths come from the caller.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { createLogger } from '../logger/logger'
import { shellQuote } from './managedGit'
import { GITHUB_IDENTITY_DIR_NAME, withoutGithubGitConfig } from './githubGitConfig'

const logger = createLogger('gh-shim')

/** Under userData: the wrapper's directory, put first on `PATH`. */
export const GH_SHIM_DIR_NAME = 'gh-shim'
/** Under userData: the empty `GH_CONFIG_DIR` a token-served `gh` runs with. */
export const GH_CONFIG_DIR_NAME = 'gh-config'

/** The loopback endpoint's `/github` base, in a kit agent's child env. */
export const GH_ENDPOINT_URL_ENV = 'CINNA_GITHUB_URL'
/**
 * The agent's bearer for that endpoint. Its name must not read as a secret to an engine's own
 * env filter, or the wrapper never sees it and every gh and git call falls back to the user's
 * login: no AUTH, KEY, TOKEN, SECRET, PASS(WORD), PWD, JWT, CREDENTIAL(S) or COOKIE word.
 * `CINNA_GITHUB_AUTH` was stripped by Claude Code's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` (API
 * Token mode), whose name classifier matches `_AUTH` (2.1.318). Codex, OpenCode and
 * Antigravity passed every such name to their shell tools when probed on 25 Nov 2026. The
 * contract checks Claude (`claude.launch.subprocess-env-scrub-gh`).
 */
export const GH_ENDPOINT_BEARER_ENV = 'CINNA_GITHUB_BEARER'

export const GITHUB_HELPER_KEY = 'credential.https://github.com.helper'
export const GITHUB_USE_HTTP_PATH_KEY = 'credential.https://github.com.useHttpPath'

/** What the wrapper prints when the loopback endpoint cannot be connected to (exit 4). */
export const GH_NETWORK_MESSAGE =
  'This GitHub command needs network access, which this sandbox blocks. Run the same command again with escalated permissions. It is not an internet outage.'
/** What the wrapper prints when the endpoint took the connection but did not answer in time (exit 1). */
export const GH_SLOW_MESSAGE = 'Cinna is taking too long to answer for GitHub. Try again in a moment.'
/** What the wrapper prints when the endpoint was connected to but the answer broke off (reset, empty reply; exit 1). */
export const GH_RETRY_MESSAGE = 'Cinna could not answer for GitHub just now. Try again in a moment.'
/**
 * The script's second line. The real-`gh` lookup skips any `gh` carrying it, so two Cinna
 * instances (or profiles of the dev and release apps) never run each other's wrapper in a loop.
 */
export const GH_WRAPPER_MARKER = '# cinna-gh-wrapper'
/** What the wrapper prints when a token is there but no `gh` yet and the managed install is running (exit 1). */
export const GH_INSTALLING_MESSAGE = 'Cinna is still installing gh, try again in a moment.'
/** What the wrapper prints when a token is there, no `gh`, and no managed install is running (exit 1). */
export const GH_NOT_INSTALLED_MESSAGE =
  "gh isn't installed and Cinna couldn't install it. Ask the user to install the GitHub CLI from https://cli.github.com, then run this command again."
/** curl's `--max-time` for `POST /github/token`: above the app's 20 s GitHub call timeout, so a slow refresh answers `unavailable` first. */
export const GH_TOKEN_MAX_TIME_S = 40

type Env = Record<string, string | undefined>

/**
 * The script's fixed part. Written as a raw string so its backslashes and
 * quotes are the shell's; `@{` stands for the shell's `${` (a raw template
 * would interpolate it), and the `__…__` placeholders take the quoted paths.
 */
const SCRIPT_BODY = String.raw`#!/bin/sh
__MARKER__
# Cinna's gh wrapper. Generated by Cinna Desktop and rewritten whenever it differs: do not edit.
# Decides gh's (and, through "gh auth git-credential", git's) GitHub auth for Cinna's agents:
# the OpenCinna token from the app's loopback endpoint, else the user's own gh login, else a
# sentence and exit 4. The token goes only into the env of the gh it runs, or to git on stdout.
cinna_config=__CONFIG__
cinna_managed=__MANAGED__
cinna_nl='
'
# The real gh: the first on PATH past Cinna's own directories and any Cinna wrapper (another
# instance's, recognised by the marker on its second line), else the managed one.
cinna_gh=
set -f
IFS=:
for cinna_dir in $PATH; do
  case "$cinna_dir" in __SKIP__|'') continue ;; esac
  if [ -f "$cinna_dir/gh" ] && [ -x "$cinna_dir/gh" ]; then
    head -n 5 "$cinna_dir/gh" 2>/dev/null | grep -q __MARKER_RE__ && continue
    cinna_gh=$cinna_dir/gh
    break
  fi
done
unset IFS
if [ -z "$cinna_gh" ] && [ -x "$cinna_managed" ]; then cinna_gh=$cinna_managed; fi

cinna_say() { printf '%s\n' "$1" >&2; }

cinna_network() {
  cinna_say __NETWORK__
  exit 4
}

# No endpoint, or the user's own gh login: the real gh as it is.
cinna_untouched() {
  if [ -n "$cinna_gh" ]; then exec "$cinna_gh" "$@"; fi
  cinna_say 'gh: command not found'
  exit 127
}

# A kit agent's child, with curl to call the endpoint.
cinna_endpoint() {
  [ -n "$CINNA_GITHUB_URL" ] && [ -n "$CINNA_GITHUB_BEARER" ] || return 1
  case "$CINNA_GITHUB_BEARER" in *'"'*|*'\'*|*"$cinna_nl"*) return 1 ;; esac
  command -v curl >/dev/null 2>&1
}

# POST $2 to the endpoint's $1 within $3 seconds. Sets cinna_status (000: nothing answered),
# cinna_body, cinna_slow when curl connected but timed out (exit 28 with a connect time), and
# cinna_blocked when it could not connect at all (exit 7, which is also what a sandbox's refusal of
# the connect gives, or 28 before connecting). Neither: the answer broke off (52, 56, ...).
# The bearer reaches curl on stdin, never on its command line.
cinna_post() {
  cinna_out=$(printf 'header = "Authorization: Bearer %s"\n' "$CINNA_GITHUB_BEARER" |
    curl -sS --noproxy '*' --max-time "$3" --config - -X POST -H 'Content-Type: application/json' \
      --data-binary "$2" -w '\n%{time_connect} %{http_code}' "$CINNA_GITHUB_URL$1" 2>/dev/null)
  cinna_rc=$?
  cinna_tail=@{cinna_out##*"$cinna_nl"}
  cinna_body=@{cinna_out%"$cinna_nl"*}
  cinna_status=@{cinna_tail##* }
  cinna_slow=
  cinna_blocked=
  case "$cinna_status" in [1-5][0-9][0-9]) ;; *) cinna_status=000 ;; esac
  if [ "$cinna_status" = 000 ]; then
    case "$cinna_rc" in
      7) cinna_blocked=1 ;;
      28) case "@{cinna_tail% *}" in *[1-9]*) cinna_slow=1 ;; *) cinna_blocked=1 ;; esac ;;
    esac
  fi
}

# A string field of the answer (its values hold no quote, backslash or newline).
cinna_field() {
  printf '%s\n' "$cinna_body" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# owner/repo from a name, github.com/OWNER/REPO, a github.com URL or remote, or nothing.
cinna_repo_of() {
  cinna_r=$1
  case "$cinna_r" in
    https://github.com/*) cinna_r=@{cinna_r#https://github.com/} ;;
    github.com/*) cinna_r=@{cinna_r#github.com/} ;;
    git@github.com:*) cinna_r=@{cinna_r#git@github.com:} ;;
    ssh://git@github.com/*) cinna_r=@{cinna_r#ssh://git@github.com/} ;;
    *:*|*@*) return 0 ;;
  esac
  cinna_r=@{cinna_r%/}
  cinna_r=@{cinna_r%.git}
  case "$cinna_r" in
    */*/*|/*|*/|*[!A-Za-z0-9_./-]*) return 0 ;;
    */*) printf '%s' "$cinna_r" ;;
  esac
}

# The value of -R/--repo (before --), as written, or nothing.
cinna_repo_flag_value() {
  cinna_prev=
  for cinna_a in "$@"; do
    [ "$cinna_a" = -- ] && return 0
    case "$cinna_prev" in -R|--repo) printf '%s' "$cinna_a"; return 0 ;; esac
    case "$cinna_a" in
      --repo=*) printf '%s' "@{cinna_a#--repo=}"; return 0 ;;
      -R?*) printf '%s' "@{cinna_a#-R}"; return 0 ;;
    esac
    cinna_prev=$cinna_a
  done
}

# Whether -R/--repo names a host other than github.com (HOST/OWNER/REPO, a URL, an scp-style remote).
cinna_foreign_repo_flag() {
  cinna_v=$(cinna_repo_flag_value "$@")
  case "$cinna_v" in
    ''|https://github.com/*|http://github.com/*|github.com/*|git@github.com:*|ssh://git@github.com/*) return 1 ;;
    *://*|*@*:*|*/*/*) return 0 ;;
  esac
  return 1
}

# "write" for a gh command known to change something on GitHub (an uncovered repo then needs Allow
# access even when public: GitHub refuses the app's writes there), else "gh". Explicit and
# conservative: anything not listed is "gh".
cinna_via_of() {
  case "$1 $2" in
    'pr create'|'pr edit'|'pr merge'|'pr comment'|'pr close'|'pr reopen'|'pr review'|'pr ready'|'pr lock'|'pr unlock'|\
    'issue create'|'issue edit'|'issue comment'|'issue close'|'issue reopen'|'issue delete'|'issue lock'|'issue unlock'|'issue transfer'|'issue pin'|'issue unpin'|\
    'release create'|'release edit'|'release delete'|'release upload'|'release delete-asset'|\
    'repo edit'|'repo delete'|'repo archive'|'repo unarchive'|'repo rename'|'repo fork'|'repo sync'|\
    'label create'|'label edit'|'label delete'|'label clone'|'secret set'|'secret delete'|'variable set'|'variable delete'|\
    'workflow run'|'workflow enable'|'workflow disable'|'run rerun'|'run cancel'|'run delete'|'cache delete')
      printf write; return 0 ;;
    'repo deploy-key') case "$3" in add|delete) printf write; return 0 ;; esac ;;
  esac
  if [ "$1" = api ]; then
    cinna_prev=
    for cinna_a in "$@"; do
      case "$cinna_prev" in
        -X|--method) case "$cinna_a" in GET|get|Get) ;; *) printf write; return 0 ;; esac ;;
      esac
      case "$cinna_a" in
        -f|-F|--field|--raw-field|--input|-f?*|-F?*|--field=*|--raw-field=*|--input=*) printf write; return 0 ;;
        --method=*) case "@{cinna_a#--method=}" in GET|get|Get) ;; *) printf write; return 0 ;; esac ;;
        -X?*) case "@{cinna_a#-X}" in GET|get|Get) ;; *) printf write; return 0 ;; esac ;;
      esac
      cinna_prev=$cinna_a
    done
  fi
  printf gh
}

# Whether the command has -R/--repo (before --): the repo it names, if any, is the one.
cinna_has_repo_flag() {
  for cinna_a in "$@"; do
    case "$cinna_a" in --) return 1 ;; -R|--repo|--repo=*|-R?*) return 0 ;; esac
  done
  return 1
}

# The first argument after "repo <sub>" that is not a flag or a flag's value, as written.
cinna_repo_positional() {
  shift 2
  cinna_skip=
  for cinna_a in "$@"; do
    if [ -n "$cinna_skip" ]; then cinna_skip=; continue; fi
    case "$cinna_a" in
      --) return 0 ;;
      -u|--upstream-remote-name|--fork-name|--remote-name|--org|-s|--source|--state|-b|--branch|--body|-B|--base|-H|--head|-t|--title|--template|-F|--body-file|-l|--label|-a|--assignee|-r|--reviewer|-m|--milestone|-q|--jq|--json|-L|--limit|-S|--search|-d|--description|-h|--homepage|--default-branch|--add-topic|--remove-topic|--visibility) cinna_skip=1; continue ;;
      -*) continue ;;
    esac
    printf '%s' "$cinna_a"
    return 0
  done
}

# The repo a gh command names: -R/--repo (OWNER/REPO, github.com/OWNER/REPO or a github.com URL;
# another host names none), repo clone|view|edit|fork|sync|set-default|archive|unarchive|delete
# <repo>, api repos/<o>/<r>/...
cinna_repo_from_args() {
  cinna_prev=
  for cinna_a in "$@"; do
    [ "$cinna_a" = -- ] && break
    case "$cinna_prev" in -R|--repo) cinna_repo_of "$cinna_a"; return 0 ;; esac
    case "$cinna_a" in
      --repo=*) cinna_repo_of "@{cinna_a#--repo=}"; return 0 ;;
      -R?*) cinna_repo_of "@{cinna_a#-R}"; return 0 ;;
    esac
    cinna_prev=$cinna_a
  done
  case "$1" in
    repo)
      case "$2" in clone|view|edit|fork|sync|set-default|archive|unarchive|delete) ;; *) return 0 ;; esac
      cinna_repo_of "$(cinna_repo_positional "$@")" ;;
    api)
      shift
      for cinna_a in "$@"; do
        case "$cinna_a" in
          repos/*|/repos/*)
            cinna_a=@{cinna_a#/}
            cinna_a=@{cinna_a#repos/}
            case "$cinna_a" in */*) ;; *) return 0 ;; esac
            cinna_o=@{cinna_a%%/*}
            cinna_n=@{cinna_a#*/}
            cinna_n=@{cinna_n%%[/?#]*}
            cinna_repo_of "$cinna_o/$cinna_n"
            return 0 ;;
        esac
      done ;;
  esac
}

# Whether the folder's origin is the repo of this gh command: only for commands that act on the
# current repository and name none themselves (no -R/--repo; for repo view|edit|..., no repo
# argument). Never for auth, api, search, gist, repo clone|list|create, status, or anything unknown.
cinna_origin_applies() {
  cinna_has_repo_flag "$@" && return 1
  case "$1" in
    pr|issue|release|run|workflow|browse|cache|secret|variable|label|ruleset|attestation) return 0 ;;
    repo)
      case "$2" in
        rename|deploy-key) return 0 ;;
        view|edit|sync|fork|set-default|archive|unarchive|delete) [ -z "$(cinna_repo_positional "$@")" ] ;;
        *) return 1 ;;
      esac ;;
    *) return 1 ;;
  esac
}

# The repo of the current folder's origin, when it is on github.com. Quiet without git or a repo.
cinna_repo_from_origin() {
  cinna_url=$(git remote get-url origin 2>/dev/null </dev/null) || return 0
  case "$cinna_url" in
    https://github.com/*|git@github.com:*|ssh://git@github.com/*) cinna_repo_of "$cinna_url" ;;
  esac
}

# Ask for a token for repo $1 (or none), via $2 (gh or git). Not connected at all: the sandbox
# sentence (exit 4). Connected but no answer in time, or an answer that broke off: try again (exit 1).
cinna_ask() {
  if [ -n "$1" ]; then cinna_post /token "{\"repo\":\"$1\",\"via\":\"$2\"}" __TOKEN_MAX_TIME__; else cinna_post /token "{\"via\":\"$2\"}" __TOKEN_MAX_TIME__; fi
  if [ "$cinna_status" = 000 ]; then
    if [ -n "$cinna_slow" ]; then cinna_say __SLOW__; exit 1; fi
    if [ -n "$cinna_blocked" ]; then cinna_network; fi
    cinna_say __RETRY__
    exit 1
  fi
  return 0
}

# Tell the app what is needed ($1 kind, $2 repo or nothing). Only gh_missing reads the answer.
cinna_need() {
  if [ -n "$2" ]; then cinna_post /needed "{\"kind\":\"$1\",\"repo\":\"$2\"}" 10; else cinna_post /needed "{\"kind\":\"$1\"}" 10; fi
}

# The user's own gh login answers (offline: no API call).
cinna_own_login() {
  [ -n "$cinna_gh" ] && "$cinna_gh" auth token --hostname github.com >/dev/null 2>&1 </dev/null
}

# The directory "gh repo clone <repo> [<dir>]" made: the explicit one, else the repo's name.
cinna_clone_dir() {
  shift 2
  cinna_first=
  cinna_skip=
  for cinna_a in "$@"; do
    if [ -n "$cinna_skip" ]; then cinna_skip=; continue; fi
    case "$cinna_a" in
      --) break ;;
      -u|--upstream-remote-name) cinna_skip=1; continue ;;
      -*) continue ;;
    esac
    if [ -z "$cinna_first" ]; then cinna_first=$cinna_a; else printf '%s' "$cinna_a"; return 0; fi
  done
  cinna_d=@{cinna_first%/}
  cinna_d=@{cinna_d##*/}
  cinna_d=@{cinna_d##*:}
  printf '%s' "@{cinna_d%.git}"
}

# git's side: gh auth git-credential get|store|erase, with git's request on stdin.
cinna_pass() {
  [ -n "$cinna_gh" ] || exit 0
  printf '%s\n' "$cinna_req" | "$cinna_gh" auth git-credential "$1"
  exit $?
}

cinna_credential() {
  cinna_op=$1
  cinna_req=
  while IFS= read -r cinna_line || [ -n "$cinna_line" ]; do
    [ -z "$cinna_line" ] && break
    cinna_req=$cinna_req$cinna_line$cinna_nl
  done
  cinna_host=$(printf '%s' "$cinna_req" | sed -n 's/^host=//p' | head -n 1)
  cinna_proto=$(printf '%s' "$cinna_req" | sed -n 's/^protocol=//p' | head -n 1)
  if [ "$cinna_host" != github.com ] || [ "$cinna_proto" != https ] || ! cinna_endpoint; then cinna_pass "$cinna_op"; fi
  # A token this wrapper served is not the user's to store or erase.
  [ "$cinna_op" = get ] || exit 0
  cinna_repo=$(cinna_repo_of "$(printf '%s' "$cinna_req" | sed -n 's/^path=//p' | head -n 1)")
  cinna_ask "$cinna_repo" git
  [ "$cinna_status" = 200 ] || cinna_pass get
  cinna_token=$(cinna_field token)
  if [ -n "$cinna_token" ]; then
    printf 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=%s\n' "$cinna_token"
    exit 0
  fi
  cinna_needed=$(cinna_field needed)
  cinna_message=$(cinna_field message)
  cinna_own_login && cinna_pass get
  case "$cinna_needed" in
    sign_in|reconnect|install)
      cinna_need_repo=$(cinna_repo_of "$(cinna_field repo)")
      cinna_need "$cinna_needed" "@{cinna_need_repo:-$cinna_repo}" ;;
  esac
  [ -n "$cinna_message" ] && cinna_say "$cinna_message"
  exit 0
}

if [ "$1" = auth ] && [ "$2" = git-credential ]; then cinna_credential "$3"; fi

cinna_endpoint || cinna_untouched "$@"
# -R naming another host: not GitHub's, the user's own gh and config as they are.
cinna_foreign_repo_flag "$@" && cinna_untouched "$@"
cinna_repo=$(cinna_repo_from_args "$@")
if [ -z "$cinna_repo" ] && cinna_origin_applies "$@"; then cinna_repo=$(cinna_repo_from_origin); fi
cinna_ask "$cinna_repo" "$(cinna_via_of "$@")"
[ "$cinna_status" = 200 ] || cinna_untouched "$@"
cinna_token=$(cinna_field token)
if [ -n "$cinna_token" ]; then
  if [ -z "$cinna_gh" ]; then
    # The app answers whether a managed gh install is running (or was just started).
    cinna_need gh_missing ''
    case "$cinna_body" in *'"installing":true'*) cinna_say __INSTALLING__; exit 1 ;; esac
    cinna_say __NO_GH__
    exit 1
  fi
  cinna_name=$(cinna_field name)
  cinna_email=$(cinna_field email)
  unset GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_HOST
  GH_TOKEN=$cinna_token
  GH_CONFIG_DIR=$cinna_config
  GH_PROMPT_DISABLED=1
  export GH_TOKEN GH_CONFIG_DIR GH_PROMPT_DISABLED
  cinna_token=
  cinna_body=
  cinna_out=
  if [ "$1" != repo ] || [ "$2" != clone ]; then exec "$cinna_gh" "$@"; fi
  "$cinna_gh" "$@"
  cinna_rc=$?
  unset GH_TOKEN
  if [ "$cinna_rc" = 0 ] && [ -n "$cinna_name" ] && [ -n "$cinna_email" ]; then
    # Commits are the user's (G7): the noreply identity kept in the clone, only where the user's
    # own git config has none. Asked without Cinna's identity config (GIT_CONFIG_GLOBAL under
    # github-identity/), which already answers the noreply for a github.com clone.
    cinna_dir=$(cinna_clone_dir "$@")
    if [ -n "$cinna_dir" ] && [ -d "$cinna_dir" ] && [ -z "$(case "$GIT_CONFIG_GLOBAL" in (*/__IDENTITY_DIR__/*.gitconfig) unset GIT_CONFIG_GLOBAL ;; esac; git -C "$cinna_dir" config user.email 2>/dev/null </dev/null)" ]; then
      git -C "$cinna_dir" config user.name "$cinna_name" >/dev/null 2>&1 </dev/null
      git -C "$cinna_dir" config user.email "$cinna_email" >/dev/null 2>&1 </dev/null
    fi
  fi
  exit "$cinna_rc"
fi
cinna_needed=$(cinna_field needed)
cinna_message=$(cinna_field message)
cinna_own_login && exec "$cinna_gh" "$@"
case "$cinna_needed" in
  sign_in|reconnect|install)
    cinna_need_repo=$(cinna_repo_of "$(cinna_field repo)")
    cinna_need "$cinna_needed" "@{cinna_need_repo:-$cinna_repo}"
    cinna_say "@{cinna_message:-GitHub is not connected in Cinna. Ask the user to sign in to GitHub under the message box, then run this command again.}"
    exit 4 ;;
esac
cinna_say "@{cinna_message:-GitHub could not be reached. Try again in a moment.}"
exit 1
`

/**
 * The wrapper's content. It embeds the gh config directory, the managed gh's
 * location and the directories the real-`gh` lookup skips (the wrapper's own,
 * `tool-shims/`, `git-shim/`), so it changes only when those do.
 */
export function ghShimScript(options: { configDir: string; managedGh: string; ownDirs: readonly string[] }): string {
  const skip = options.ownDirs.map(shellQuote).join('|')
  // Function replacers: a `$` in a path is never read as a replacement pattern.
  return SCRIPT_BODY.replace('__MARKER__', () => GH_WRAPPER_MARKER)
    .replace('__MARKER_RE__', () => shellQuote(`^${GH_WRAPPER_MARKER}$`))
    .replace('__CONFIG__', () => shellQuote(options.configDir))
    .replace('__MANAGED__', () => shellQuote(options.managedGh))
    .replace('__SKIP__', () => skip)
    .replace('__NETWORK__', () => shellQuote(GH_NETWORK_MESSAGE))
    .replace('__SLOW__', () => shellQuote(GH_SLOW_MESSAGE))
    .replace('__RETRY__', () => shellQuote(GH_RETRY_MESSAGE))
    .replace('__INSTALLING__', () => shellQuote(GH_INSTALLING_MESSAGE))
    .replace('__NO_GH__', () => shellQuote(GH_NOT_INSTALLED_MESSAGE))
    .replaceAll('__TOKEN_MAX_TIME__', () => String(GH_TOKEN_MAX_TIME_S))
    .replace('__IDENTITY_DIR__', () => GITHUB_IDENTITY_DIR_NAME)
    .replaceAll('@{', '${')
}

let loggedBadCount = false

/**
 * The env's `GIT_CONFIG_COUNT`: 0 when unset or empty, null when it is not a non-negative integer
 * (of at most four digits), in which case the env's `GIT_CONFIG_*` entries are left as they are.
 */
function gitConfigCount(env: Env): number | null {
  const raw = env.GIT_CONFIG_COUNT?.trim()
  if (raw === undefined || raw === '') return 0
  return /^\d{1,4}$/.test(raw) ? Number(raw) : null
}

/**
 * `env` with git's github.com credential helper list reset and pointed at the
 * wrapper, plus `useHttpPath`, appended through `GIT_CONFIG_COUNT/KEY/VALUE`
 * after any entries the env already carries. Unchanged when the wrapper's
 * helper entry is already there (a second application), and when the env's
 * `GIT_CONFIG_COUNT` is not a number (the user's entries are kept as they are).
 */
export function withGithubCredentialHelper<T extends Env>(env: T, wrapper: string): T {
  const helper = `!${shellQuote(wrapper)} auth git-credential`
  const count = gitConfigCount(env)
  if (count === null) {
    // Renumbering over a count git itself would refuse could lose the user's entries: add nothing.
    if (!loggedBadCount) { loggedBadCount = true; logger.debug('GIT_CONFIG_COUNT is not a number: the github.com credential helper is not added') }
    return env
  }
  for (let i = 0; i < count; i++) {
    if (env[`GIT_CONFIG_KEY_${i}`] === GITHUB_HELPER_KEY && env[`GIT_CONFIG_VALUE_${i}`] === helper) return env
  }
  const entries: Array<[string, string]> = [
    [GITHUB_HELPER_KEY, ''],
    [GITHUB_HELPER_KEY, helper],
    [GITHUB_USE_HTTP_PATH_KEY, 'true']
  ]
  const next: Env = { ...env }
  entries.forEach(([key, value], offset) => {
    next[`GIT_CONFIG_KEY_${count + offset}`] = key
    next[`GIT_CONFIG_VALUE_${count + offset}`] = value
  })
  next.GIT_CONFIG_COUNT = String(count + entries.length)
  return next as T
}

/** A helper value this module wrote: `!'<…>/gh-shim/gh' auth git-credential`, whatever the userData path. */
function isOurHelper(value: string | undefined): boolean {
  return value !== undefined && value.startsWith("!'") && value.endsWith(`/${GH_SHIM_DIR_NAME}/gh' auth git-credential`)
}

/**
 * `env` without the three entries {@link withGithubCredentialHelper} appended (the reset, our
 * helper, `useHttpPath`), the remaining entries renumbered from 0 so `GIT_CONFIG_COUNT` still
 * matches the user's own; `GIT_CONFIG_COUNT` itself goes when nothing is left. The same object
 * when there is nothing of ours. A child without the loopback endpoint must keep the user's own
 * github.com helpers (osxkeychain, GCM, `gh auth setup-git`).
 */
export function withoutGithubCredentialHelper<T extends Env>(env: T): T {
  const count = gitConfigCount(env) ?? 0
  const entries: Array<[string | undefined, string | undefined]> = []
  for (let i = 0; i < count; i++) entries.push([env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]])
  const kept: Array<[string | undefined, string | undefined]> = []
  let removed = false
  for (let i = 0; i < entries.length; i++) {
    const [k0, v0] = entries[i], [k1, v1] = entries[i + 1] ?? [], [k2, v2] = entries[i + 2] ?? []
    if (k0 === GITHUB_HELPER_KEY && v0 === '' && k1 === GITHUB_HELPER_KEY && isOurHelper(v1) && k2 === GITHUB_USE_HTTP_PATH_KEY && v2 === 'true') {
      i += 2
      removed = true
      continue
    }
    kept.push(entries[i])
  }
  if (!removed) return env
  const next: Env = { ...env }
  for (let i = 0; i < count; i++) {
    delete next[`GIT_CONFIG_KEY_${i}`]
    delete next[`GIT_CONFIG_VALUE_${i}`]
  }
  kept.forEach(([key, value], i) => {
    if (key !== undefined) next[`GIT_CONFIG_KEY_${i}`] = key
    if (value !== undefined) next[`GIT_CONFIG_VALUE_${i}`] = value
  })
  if (kept.length > 0) next.GIT_CONFIG_COUNT = String(kept.length)
  else delete next.GIT_CONFIG_COUNT
  return next as T
}

/**
 * The env of a child that carries the loopback endpoint gets the github.com helper entries,
 * any other env loses ours: what `engineCredentialEnv` applies last. Idempotent, and the same
 * input always gives the same output (a pool launch key built from it stays stable).
 */
export function githubCredentialHelperFor<T extends Env>(env: T, wrapper: string | null): T {
  const stripped = withoutGithubCredentialHelper(env)
  return wrapper && stripped[GH_ENDPOINT_URL_ENV] && stripped[GH_ENDPOINT_BEARER_ENV] ? withGithubCredentialHelper(stripped, wrapper) : stripped
}

export interface GhShimDeps {
  platform: NodeJS.Platform
  /** `<userData>/gh-shim`. */
  shimDir: () => string
  /** `<userData>/gh-config`. */
  configDir: () => string
  /** Where the managed gh is, or will be (`managedGh.binaryLocation()`). */
  managedGh: () => string
  /** Cinna's other `PATH` directories the real-`gh` lookup skips (`tool-shims/`, `git-shim/`). */
  otherOwnDirs: () => string[]
}

export function createGhShim(deps: GhShimDeps) {
  /** Writes are serialised, so two applications at once never race a rename. */
  let queue: Promise<unknown> = Promise.resolve()

  async function publish(): Promise<string> {
    const dir = deps.shimDir()
    const path = join(dir, 'gh')
    const content = ghShimScript({ configDir: deps.configDir(), managedGh: deps.managedGh(), ownDirs: [dir, ...deps.otherOwnDirs()] })
    await mkdir(dir, { recursive: true, mode: 0o755 })
    await mkdir(deps.configDir(), { recursive: true, mode: 0o700 })
    const current = await readFile(path, 'utf8').catch(() => null)
    if (current === content) {
      await chmod(path, 0o755)
      return path
    }
    const temp = join(dir, `.gh.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`)
    await writeFile(temp, content, { mode: 0o755 })
    await chmod(temp, 0o755)
    await rename(temp, path)
    return path
  }

  return {
    /**
     * `env` with the wrapper's directory first on `PATH`, on macOS and Linux,
     * and without any github.com helper entries or identity `GIT_CONFIG_GLOBAL` of ours (only
     * `engineCredentialEnv` adds them, with the endpoint). Idempotent. Never
     * throws: a wrapper that could not be written leaves `PATH` unchanged.
     */
    async apply<T extends Env>(env: T): Promise<T> {
      if (deps.platform !== 'darwin' && deps.platform !== 'linux') return env
      const stripped = withoutGithubGitConfig(withoutGithubCredentialHelper(env))
      try {
        const run = queue.then(publish)
        queue = run.catch(() => undefined)
        await run
        const dir = deps.shimDir()
        const rest = (stripped.PATH ?? '').split(delimiter).filter((entry) => entry !== '' && entry !== dir)
        return { ...stripped, PATH: [dir, ...rest].join(delimiter) }
      } catch (error) {
        logger.warn('could not write the gh wrapper', { error: String(error) })
        return stripped
      }
    }
  }
}
