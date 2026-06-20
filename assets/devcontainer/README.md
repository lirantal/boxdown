# Dev container

Run this project in a **consistent Node.js 24 + TypeScript** environment without installing toolchains on your machine. Dependencies install automatically; your repo is the workspace inside the container.

## Why use it?

- **Same stack for everyone** — Node 24, pnpm, and tooling match CI and collaborators.
- **Fast onboarding** — Open the folder in a container; `pnpm install` and local git tweaks run once after create.
- **Host secrets, container dev** — `ANTHROPIC_API_KEY` and `SNYK_TOKEN` are passed from your Mac/Linux session into the container when set locally (see below).
- **Optional CLI workflow** — Use `start.sh` if you prefer a terminal-driven container instead of only the editor.
- **Portless SSH workflow** — Install a normal SSH host alias that proxies into the devcontainer without publishing an SSH port.

## What’s here

| File | Role |
| ---- | ---- |
| `devcontainer.json` | Image, mounts (e.g. your `~/.gitconfig`), lifecycle commands, env forwarding. |
| `start.sh` | Brings the dev container up with the Dev Containers CLI, then opens a shell **inside** the container or acts as an SSH `ProxyCommand`. |
| `ssh-config-install.sh` | Installs/updates a host SSH config alias for Cursor, Claude, or plain `ssh`. |
| `hooks/initialize.sh` | Runs on the host before container create/start; prepares the env file and optional secrets. |
| `hooks/post-create.sh` | Runs once after the container is created — e.g. installs [APM](https://github.com/microsoft/apm) (Agent Package Manager), coding-agent CLIs, and OpenSSH server. |
| `hooks/post-start.sh` | Runs on each container start; refreshes runtime state such as SSH host keys and authorized keys. |
| `utils/ssh-bootstrap.sh` | Container-side OpenSSH install/runtime helper used by lifecycle scripts. |
| `utils/coding-agent-cli-update.sh` | Shared install/update helper for Codex, OpenCode, Claude Code, and Antigravity CLI. |
| `utils/deps-install.sh` | Dependency installation helper used by `hooks/post-create.sh`. |

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

Requires Docker running. The script resolves Boxdown's packaged `@devcontainers/cli` dependency and uses that binary to `up` the workspace and `exec` into `bash`; it does not install or use a host/global Dev Containers CLI package.

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

If your host `.gitconfig` is mounted into the container, Boxdown adds local
repository settings that neutralize incompatible host-only helpers such as
`/opt/homebrew/bin/gh` and broad rewrites such as
`url.git@github.com:.insteadOf=https://github.com/`.

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
bash .devcontainer/start.sh ssh-config install
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
- **Remote Folder:** select `<repo-name>` from the default home folder, or enter `/workspaces/<repo-name>`

To customize the alias, run:

```bash
bash .devcontainer/ssh-config-install.sh --alias my-project-devcontainer
```

This workflow does not publish an SSH port. OpenSSH talks to `sshd -i` over `docker exec`, while `@devcontainers/cli up` still owns the devcontainer lifecycle. The installer is idempotent and `start.sh --ssh-proxy` quietly refreshes the generated SSH config before proxying.

### Coding agents over SSH

If you are a coding agent running on the host OS, prefer the SSH alias workflow. It gives Claude, Cursor, Codex, and plain OpenSSH a normal SSH host while preserving this repo's devcontainer lifecycle.

From the repository root on the host:

```bash
bash .devcontainer/start.sh ssh-config install
ssh <repo-name>-devcontainer 'whoami && pwd'
```

Use the generated host alias when configuring the agent:

- **SSH Host:** `<repo-name>-devcontainer`
- **SSH Port:** leave empty
- **Identity File:** leave empty if the agent honors `~/.ssh/config`; otherwise use `.devcontainer/.ssh/id_ed25519`
- **Remote Folder:** select `<repo-name>` from the default home folder, or enter `/workspaces/<repo-name>`

`start.sh` has two modes:

- `bash .devcontainer/start.sh` starts or reuses the devcontainer and opens an interactive shell. Use this for a local terminal session.
- `bash .devcontainer/start.sh ssh-config install` installs or refreshes the host SSH alias and exits.
- `bash .devcontainer/start.sh --ssh-proxy` refreshes the SSH alias, starts or reuses the devcontainer, and then bridges SSH over `docker exec`. Do not keep this running manually in a terminal; it is meant to be launched by OpenSSH as the `ProxyCommand` in the generated SSH config.
- `bash .devcontainer/start.sh --refresh-gh-token` starts or reuses the devcontainer, then refreshes container `gh` auth from host `gh` when a token is available.
- `bash .devcontainer/start.sh --refresh-gh-token-running` refreshes container `gh` auth from host `gh` only when the devcontainer is already running.

If the devcontainer does not exist yet, the first SSH connection through `<repo-name>-devcontainer` will create it with `@devcontainers/cli up`, including `initializeCommand`, features, mounts, `postCreateCommand`, and `postStartCommand`. The first connection may take longer while the container is created.

## Environment variables (host → container)

Set these **on your machine** before opening/rebuilding the container so they appear inside:

```bash
export ANTHROPIC_API_KEY=sk-...
export SNYK_TOKEN=...
```

They are wired in `devcontainer.json` under `containerEnv` via `localEnv`.

If `OP_SERVICE_ACCOUNT_TOKEN` is present, it authenticates the 1Password CLI.
It is not a GitHub token and does not authenticate `gh` or GitHub Git remotes.

## Optional customization

- **Agent config on the host** — Uncomment the `mounts` entries in `devcontainer.json` to bind `~/.claude`, `~/.gemini`, or `~/.codex` into the container so coding agents see your existing settings.
- **1Password / other CLIs** — Follow the commented blocks in `devcontainer.json` and `hooks/post-create.sh` if you need them; keep the image lean by default.

---

After scaffolding, edit paths and secrets to match your team’s policies; this folder is yours to extend.
