# Command-line Agents

## Purpose

Connect an ACP command to a conversation, including an agent reached through SSH. The same ACP driver handles folder engines and these commands; a command-line agent requires no local Agents Home or scanned folder.

## Core Concepts

- **Custom launcher** — `acp` with `driver_config.launcher = custom`, selecting an executable and arguments supplied by the user. It does not add another transport or driver.
- **Working directory** — the absolute directory sent to the agent in its ACP session, potentially on another machine.
- **Local process directory** — where the local child starts, such as the SSH client's directory. Optional; defaults to the user's home and must exist locally.
- **Test receipt** — a short-lived proof that this exact command configuration initialized under this profile. Save consumes it once; it does not prove authentication or permission to execute a future prompt.
- **Binding** — the profile, owned agent and configuration revision that may reuse sessions and remembered permissions. Changing it cannot inherit another configuration's grants.

## User Stories / Flows

1. Open **Agents**, press **+**, and choose **Command-line agent**.
2. Enter the executable and arguments as a JSON array, and the agent's **Working directory**. **More options** provides a display name and separate **Local process directory**.
3. Press **Test**. Cinna starts the command, exchanges ACP initialize and closes the process. It shows the advertised agent name/version and authentication methods. It sends no session or chat message and performs no sign-in.
4. If initialization succeeds, press **Add agent** to save and open a chat. An edit to command or directories requires a fresh Test. Failed Test or Save retains the dialog and its values.
5. Send a message. The shared ACP driver starts or reuses the process, creates or loads the session, streams output and handles permission/question requests.
6. **Always allow** remembers a permission for this binding in Cinna, while the remote ACP answer is still once. Reopen the Command-line entry and use **Remembered permissions → Revoke** to remove a rule. **Start chat** opens the saved agent; Test then Save edits it.

## Business Rules

- Test runs an executable as the user. There is no command sandbox or implicit local shell. Each JSON array element becomes one local argument, so spaces, dollar signs and semicolons stay literal unless the user explicitly chooses a shell.
- SSH introduces its own remote command interpretation. Cinna preserves argv into the local SSH client; SSH's remote command may be interpreted by the remote login shell. Local array boundaries are not a promise of remote argv boundaries. Quote remote command text for that shell or use a controlled remote wrapper.
- SSH uses existing keys, SSH agent and host configuration. Configure CLI authentication separately. No password form, stored SSH password or ACP authenticate flow is supplied; advertised authentication methods are information, not a successful login. The command must run without interactive terminal input.
- Only ACP protocol output belongs on stdout. Diagnostics belong on stderr; login banners or wrapper chatter on stdout can break initialization.
- The app sends the working directory to the remote session; it neither scans nor verifies that path on the local machine. It checks the separate local process directory before spawning.
- Ordinary agent-list/readiness refreshes never execute the user's command. Explicit Test or **Check again** initializes it; a turn performs its own handshake. A failed explicit check remains failed until a later successful check, rather than being overwritten by an older cached success.
- Save requires an unexpired exact-config Test receipt and unchanged profile/agent identity, and refuses while the agent is busy. Successful save retires its previous process. A changed configuration starts with separate sessions/grants; a chat with an old session refuses silent reuse and asks for a new chat.
- Permissions and answers use the runtime captured when the ask was raised. Profile/configuration changes, disable/re-enable, deletion or changed ownership invalidate that authority before grants, replies or session writes. A deleted external command cannot use the folder-agent orphan-answer fallback.
- Stop settles silent initialization/session setup as well as a running prompt. It preserves partial output and reports canceled. A running agent gets session/cancel; if its prompt never acknowledges within the grace period, Cinna retires the local process and warns that the remote stop was not confirmed. A turn ceiling remains an error. Closing SSH alone cannot establish that remote work ended.
- Commands expose permission and question support, resumable sessions and cancellation. They do not expose desktop file/terminal access, attachments, catalog commands, local folder status, desktop MCP injection, managed credentials or kit-authorized coordinator handback. The remote CLI remains responsible for its own tools and authentication.

## Architecture Overview

Agents → Custom command dialog → typed IPC → configuration/probe service → custom launcher → shared ACP driver/process pool → user command → local or remote ACP agent.

## Integration Points

- [Agent Drivers](../drivers/drivers.md) owns transport dispatch and readiness capabilities.
- [ACP Contract](../local_agents/acp_contract.md) describes the shared wire protocol.
- [Permissions](../local_agents/permissions.md) defines Cinna's once/remembered grant policy.
- [Inbox](../../jobs/tasks/inbox.md) commits replies without changing synchronous ACP continuation ordering.
- [Technical details](custom_agents_tech.md) covers state binding, receipts, argv/environment and startup cancellation.
