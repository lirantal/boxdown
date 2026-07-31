# Dev container

Run this project in a **consistent Node.js 24 + TypeScript** environment without
installing toolchains on your machine. New containers pull the public,
release-matched `ghcr.io/lirantal/boxdown:<Boxdown-version>` image. Your repo
is mounted as the workspace after the image is pulled.

## Why use it?

- **Same stack for everyone** — The published image provides Node 24, Git,
  ripgrep, GitHub CLI, Codex, Claude Code, Snyk, 1Password, and AMD64 APM.
- **Fast onboarding** — Open the folder in a container. An uncached image pull
  needs network access, but no GHCR login; dependency installation and local
  git tweaks then run once for the workspace.
- **Host secrets, container dev** — `SNYK_TOKEN` is available when set locally;
  `ANTHROPIC_API_KEY` is available in the `auth` and `full` agent profiles (see
  below).
- **Optional CLI workflow** — Use `start.sh` if you prefer a terminal-driven container instead of only the editor.
- **Portless SSH workflow** — Install a normal SSH host alias that proxies into the devcontainer without publishing an SSH port.

## What’s here

| File | Role |
| ---- | ---- |
| `devcontainer.json` | Release-matched Boxdown image, Boxdown state mounts, lifecycle commands, and env forwarding. |
| `start.sh` | Brings the dev container up with the Dev Containers CLI, then opens a shell **inside** the container or acts as an SSH `ProxyCommand`. |
| `ssh-config-install.sh` | Installs/updates a host SSH config alias for Cursor, Claude, or plain `ssh`. |
| `hooks/initialize.sh` | Runs on the host before container create/start; refreshes private runtime secret files and host Git state. |
| `hooks/post-create.sh` | Runs once after the container is created to configure the workspace and SSH runtime. |
| `hooks/post-start.sh` | Runs on each container start; refreshes runtime state such as SSH host keys and authorized keys. |
| `utils/git-config-bootstrap.sh` | Container-side Git config copy/sanitization helper used by lifecycle scripts. |
| `utils/python-bootstrap.sh` | Container-side Debian Python runtime helper for explicit opt-in use. |
| `utils/ssh-bootstrap.sh` | Container-side OpenSSH install/runtime helper used by lifecycle scripts. |
| `utils/agent-profile-bootstrap.mjs` | Copies staged `auth` agent-profile sources into container-local writable homes. |
| `utils/coding-agent-cli-update.sh` | Shared install/update helper for Codex, OpenCode, Claude Code, and Antigravity CLI. |
| `utils/deps-install.sh` | Workspace dependency installation helper used by `hooks/post-create.sh`; bootstraps pnpm/yarn when required. |

## Published image

The image tag exactly follows the installed Boxdown package version. It is
public, so first use needs only network access and no registry credentials. It
contains the default Codex, Claude Code, Snyk, 1Password, and AMD64 APM tools;
OpenCode and Antigravity are installed lazily only when their Boxdown commands
are used. The image contains neither a workspace nor credentials. Boxdown adds
both only as per-workspace mounts and runtime state when it creates a container.

Codex and Claude retain throttled best-effort refreshes after startup. Snyk,
1Password, and AMD64 APM advance through a Boxdown release plus container
recreation. APM is deferred on ARM64 until you explicitly opt in to a
Python-based installation.

## Usage

### Editor (recommended)

1. Install the **Dev Containers** extension (VS Code) or use Cursor’s dev container support.
2. **Command Palette** → *Dev Containers: Reopen in Container* (or *Rebuild Container* after config changes).
3. Wait for create/start; the editor attaches when ready.

### Terminal only

From the **repository root** on your host:

```bash
bash .devcontainer/start.sh
```

Requires Docker running. The script resolves Boxdown's packaged `@devcontainers/cli` dependency and uses that binary to `up` the workspace and `exec` into `bash`; it does not install or use a host/global Dev Containers CLI package. Startup output is concise by default; pass `--verbose` to stream raw Docker, Dev Containers, and hook logs.

### GitHub CLI auth from host `gh`

If your host machine is already authenticated with the GitHub CLI, refresh the container's
GitHub CLI auth from the host token:

```bash
bash .devcontainer/start.sh --refresh-gh-token
```

This starts or reuses the dev container, reads the host token with:

```bash
gh auth token
```

and stores it using the container's own `gh auth login --with-token` flow. After that,
`gh` commands inside the container can use the normal GitHub CLI auth store without
sourcing an environment file:

```bash
gh auth status
gh pr status
```

The refresh also configures this repository's local Git config so GitHub remotes
use HTTPS and ask the container's `gh` for credentials during `git fetch`,
`git pull`, and `git push`. This is intentionally tied to the explicit refresh
command; regular SSH remote connections do not copy GitHub credentials.

Boxdown snapshots your host `.gitconfig` into workspace state before container
creation, mounts that snapshot read-only, and copies it to a normal writable
`/home/node/.gitconfig` during `postCreateCommand`. The container copy is then
sanitized to neutralize incompatible host-only helpers such as
`/opt/homebrew/bin/gh`, broad rewrites such as
`url.git@github.com:.insteadOf=https://github.com/`, and host-only signing
settings.

If the container is already running and you only want to refresh its GitHub auth:

```bash
bash .devcontainer/start.sh --refresh-gh-token-running
```

The refresh is intentionally non-interactive. It does not start a browser login or ask
for a device code. If host `gh` is missing, logged out, or cannot return a token, the
refresh is skipped so container startup is not blocked. Run `gh auth login` on the host
first when you need to repair host GitHub auth.

### Portless SSH alias

From the **repository root** on your host, install or update the SSH alias:

```bash
bash .devcontainer/start.sh ssh install
```

By default, this creates:

- A repo-local SSH identity at `.devcontainer/.ssh/id_ed25519`.
- A marked `Host <repo-name>-devcontainer` block in `~/.ssh/config`, where `<repo-name>` is the local repository directory name.
- A `ProxyCommand` that runs `.devcontainer/start.sh --ssh-proxy`.

Validate with plain OpenSSH first:

```bash
ssh <repo-name>-devcontainer 'whoami && pwd'
```

Then use the same host alias in Cursor, Claude, or any other SSH client:

- **SSH Host:** `<repo-name>-devcontainer`
- **SSH Port:** leave empty
- **Identity File:** leave empty if the client reads `~/.ssh/config`; otherwise use `.devcontainer/.ssh/id_ed25519`
- **Remote Folder:** enter `/workspaces/<repo-name>`

To customize the alias, run:

```bash
bash .devcontainer/ssh-config-install.sh --alias my-project-devcontainer
```

This workflow does not publish an SSH port. OpenSSH talks to `sshd -i` over `docker exec`, while `@devcontainers/cli up` still owns the devcontainer lifecycle. The installer is idempotent and `start.sh --ssh-proxy` quietly refreshes the generated SSH config before proxying.

### Coding agents over SSH

If you are a coding agent running on the host OS, prefer the SSH alias workflow. It gives Claude, Cursor, Codex, and plain OpenSSH a normal SSH host while preserving this repo's devcontainer lifecycle.

From the repository root on the host:

```bash
bash .devcontainer/start.sh ssh install
ssh <repo-name>-devcontainer 'whoami && pwd'
```

Use the generated host alias when configuring the agent:

- **SSH Host:** `<repo-name>-devcontainer`
- **SSH Port:** leave empty
- **Identity File:** leave empty if the agent honors `~/.ssh/config`; otherwise use `.devcontainer/.ssh/id_ed25519`
- **Remote Folder:** enter `/workspaces/<repo-name>`

`start.sh` has two modes:

- `bash .devcontainer/start.sh` starts or reuses the devcontainer and opens an interactive shell. Use this for a local terminal session.
- `bash .devcontainer/start.sh ssh install` installs or refreshes the host SSH alias and exits.
- `bash .devcontainer/start.sh --ssh-proxy` refreshes the SSH alias, starts or reuses the devcontainer, and then bridges SSH over `docker exec`. Do not keep this running manually in a terminal; it is meant to be launched by OpenSSH as the `ProxyCommand` in the generated SSH config.
- `bash .devcontainer/start.sh --refresh-gh-token` starts or reuses the devcontainer, then refreshes container `gh` auth from host `gh` when a token is available.
- `bash .devcontainer/start.sh --refresh-gh-token-running` refreshes container `gh` auth from host `gh` only when the devcontainer is already running.
- Add `--verbose` to any startup mode when debugging raw devcontainer, Docker, or hook output.

If the devcontainer does not exist yet, the first SSH connection through
`<repo-name>-devcontainer` creates it with `@devcontainers/cli up`, including
the image pull, mounts, `initializeCommand`, `postCreateCommand`, and
`postStartCommand`. The first connection may take longer while the image is
pulled and the container is created.

## Environment variables (host → container)

Set these **on your machine** before opening/rebuilding the container so they appear inside:

```bash
export ANTHROPIC_API_KEY=sk-...
export SNYK_TOKEN=...
```

Boxdown writes available values to owner-only files in per-workspace runtime
state outside the repository, then mounts that directory read-only. Bash
sessions export the values as ordinary environment variables, but Docker
container configuration and `docker inspect` do not contain their values.

When the host `op` CLI can read Boxdown's configured service-account item,
Boxdown provides `OP_SERVICE_ACCOUNT_TOKEN` through the same runtime mount. A
missing host value or failed 1Password lookup is non-blocking; the variable is
simply absent. This token is not a GitHub token and does not authenticate `gh`
or GitHub Git remotes.

Boxdown never creates, modifies, reads, or deletes a project
`.env.development` file. Existing containers created by an older Boxdown need
`boxdown start --recreate` to stop receiving legacy Docker environment values.
If an older version left a service-account token in `.env.development` or
`boxdown.log`, remove it manually and rotate the token.

## Agent profiles and optional customization

Boxdown supports `none`, `auth`, and `full` agent profiles; `auth` is the
default. Only `auth` mounts selected host sources read-only in the staging tree
at `/opt/boxdown/agent-profile-source`; `post-create.sh` copies them into
container-local homes before Git setup, runtime-secret setup, SSH runtime
preparation, agent refresh state, and dependency installation. `full` is not
staged: it mounts its host profiles directly at canonical agent homes.

The `auth` bootstrap copies staged sources to writable `/home/node/.agents`,
`/home/node/.codex`, `/home/node/.claude`, and `/home/node/.claude.json` as
needed, then writes the applied-profile marker at
`/opt/boxdown/state/agent-profile`. The state parent is a root-owned sticky
directory so a UID-remapped non-root remote user can safely create its
owner-only marker. Canonical `auth` profile copies and the marker are owned by
that active remote user and are container-local: no copy is synchronized back
to the host.

Source-file failures for missing or unreadable individual `auth` credentials are
non-fatal. A failed `~/.agents` copy is fatal; the error identifies only the
top-level source and never prints profile or credential contents. Static symlinks
observed during traversal are reproduced as links, and a final-component regular
file changed to a symlink after classification fails closed. Recursive directory
traversal is path-based: concurrent host replacement of a traversed parent
directory during container creation is outside the isolation guarantee and may
fail or copy best-effort from the replacement. Do not mutate selected `auth`
source trees while a container is being created. Special files are skipped with a
warning.

Select the profile with `--agent-profile none|auth|full` when creating or
recreating. `auth` stages and copies file-backed authentication and complete
`~/.agents`; `full` directly mounts live, read-write Codex and Claude homes as
well. `full` host writes are intentional and persist immediately. On macOS,
Claude Keychain credentials are not mounted. Repository-scoped agent
configuration remains available through the workspace mount in every tier.

If a custom mount is at, above, or below one of the canonical profile
destinations, that destination is externally managed. Boxdown skips its `auth`
staging and copy or its `full` live mount; the custom mount owner controls its
contents and write policy. Recreate after changing a profile, custom mount, or
full-profile mount configuration. Host changes do not update an existing `auth`
copy, while `full` host changes are immediately visible.

A malformed CSV string mount, or any unresolved `${...}` expression anywhere
in a string mount, makes all canonical profile destinations externally managed.
For a structured mount, every present serialized `type`, `src`/`source`, and
`dst`/`target`/`destination` field is checked. A non-string value, unresolved
`${...}`, comma, double quote, carriage return, line feed, or NUL makes all
canonical profile destinations externally managed. This includes substitutions
confined to the type or source fields. Opaque unknown fields are not interpreted
as mount grammar. The original mount is preserved unchanged. Status reports
only canonical destination names and never reports substitution values.

The previous direct host mounts, Codex config forwarding, and Claude MCP
projection no longer apply to `auth`. `full` intentionally uses direct host
mounts and is unsuitable for untrusted workspaces. Put portable MCP
configuration in the repository whenever possible.

- **Other agent config on the host** — Uncomment the generic `mounts` entries
  in `devcontainer.json` to bind other agent configuration directories such as
  `~/.gemini`. Such a custom canonical mount is externally managed.
- **Coding-agent defaults** — The published image provides Codex and Claude
  Code. OpenCode and Antigravity remain available through `boxdown opencode`
  and `boxdown antigravity`, but install lazily only when those commands run.
- **Agent CLI cleanup** — After a successful coding-agent CLI install/update,
  Boxdown removes stale agent artifacts: old Codex standalone releases, old
  Claude Code versions, OpenCode installer temp directories, and Antigravity
  staging cache. Codex keeps only the active standalone release by default; set
  `BOXDOWN_CODEX_STANDALONE_RELEASES_KEEP_PREVIOUS` to keep extra rollback
  releases.
- **Image migration** — Existing workspaces keep their legacy container until
  you run `boxdown start --recreate` or `boxdown setup --recreate`. Recreation
  is the only migration step and does not change the workspace.

---

After scaffolding, edit paths and secrets to match your team’s policies; this folder is yours to extend.
