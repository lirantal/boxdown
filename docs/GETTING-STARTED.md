# Getting Started with Boxdown

Boxdown turns a local project checkout into a reusable, agent-ready Dev
Container without adding Dev Container plumbing to the repository. It gives a
developer, a terminal coding agent, and supported desktop apps access to the
same containerized workspace while keeping Boxdown's generated configuration
and state outside the project.

That boundary matters more as coding agents become increasingly autonomous.
An agent can inspect a repository, run package-manager commands, execute build
scripts, and modify files at machine speed. Auto-approve and "YOLO" modes can
remove the human checkpoint before those actions. Boxdown cannot make
untrusted code safe, but it can reduce how much of the native host environment
the workload can reach.

This guide explains the motivation, the first-run workflow, and the Boxdown
commands that build on one another.

## Why Run Agentic Workloads Outside the Native Host OS?

A coding agent operates on more than source code. In a typical native-host
session, it can inherit the developer's shell environment, language runtimes,
package-manager configuration, credentials, SSH setup, global tools, and access
to unrelated files. A mistaken command or malicious dependency can therefore
have consequences beyond the current repository.

Supply chain security is one reason to narrow that reach. Package installation
may execute lifecycle scripts, build tools consume repository configuration,
and downloaded binaries execute with the current user's permissions. An agent
can trigger all of those paths without understanding every package or script it
encounters. The faster and more autonomous the workflow becomes, the less
useful "I would have noticed the dangerous command" is as a security control.

A Dev Container provides a useful separation layer:

- Project tooling runs in a Linux container instead of directly on the host.
- Runtime and dependency state can remain container-local.
- Host credentials and configuration can be exposed selectively.
- The environment can be removed and recreated without removing the checkout.
- Humans and agents can use the same runtime instead of debugging different
  host setups.

Boxdown builds on the open [Development Containers
specification](https://containers.dev/implementors/spec/) and invokes the Dev
Containers CLI itself. It does not introduce a competing container format.

> [!WARNING]
> A Dev Container is not a hardened security sandbox. The project checkout is
> mounted writable, Docker is a privileged host capability, and credentials
> intentionally supplied to the container remain usable there. Treat Boxdown
> as defense in depth: expose the minimum profile and secrets required, review
> important changes, and avoid running untrusted workloads with unnecessary
> host access.

## From a `.devcontainer` in Every Project to Boxdown

Boxdown grew out of maintaining project-local Dev Container setups. The
[npq repository](https://github.com/lirantal/npq) is a concrete example: its
`.devcontainer` directory contains a `devcontainer.json`, lifecycle scripts,
tool installation, secret forwarding, and a terminal-oriented startup script.
That setup makes one repository convenient to develop in, but copying and
maintaining the same machinery across many projects creates a new problem.

Each copy can drift. A fix to authentication, SSH, terminal behavior, or agent
installation must be propagated to every repository. Infrastructure files also
become mixed with the product's own files even when the environment policy is
personal or shared across many unrelated projects.

Boxdown moves the reusable layer into one CLI package. At a high level, it:

1. Resolves the target workspace from the current directory or `--workspace`.
2. Detects and confirms the project's supported toolchains.
3. Generates a per-workspace `devcontainer.json` outside the repository.
4. Starts or reuses a release-matched Boxdown container image.
5. Mounts the host checkout at `/workspaces/<repo-name>`.
6. Exposes selected agent data, credentials, and app integrations.
7. Records enough state to inspect, stop, recreate, or remove the environment.

The repository remains the source of truth for code. Boxdown owns the reusable
environment around it.

```text
host checkout (writable files)
          │
          ▼
Boxdown-generated configuration ──► Dev Container
          │                              │
          ├── human shell                ├── Codex CLI
          ├── SSH alias                  ├── other agent CLIs
          └── desktop app registration   └── project toolchains
```

See [Generated configuration and state](./docs/features/generated-config-and-state.md)
for the exact cache, data, runtime-secret, and mount boundaries.

## Install Boxdown

Boxdown requires Node.js 24 or newer, Docker, and OpenSSH tools. Install the
published CLI globally:

```sh
npm install --global boxdown
```

You can also run it without a global installation:

```sh
npx boxdown --help
```

The examples below use the installed `boxdown` command. Run them from the root
of the project you want to use, or add `--workspace /path/to/project`.

## Check the Host with `boxdown doctor`

Before creating an environment, verify that the host can support it:

```sh
boxdown doctor
```

`doctor` checks the required Node.js, Docker, SSH, packaged assets, and bundled
Dev Containers CLI dependencies. When a suitable local image exists, it also
uses disposable containers to test whether Docker can bind-mount the workspace
and Boxdown state paths. That catches common Docker Desktop file-sharing
problems before a longer setup attempt.

GitHub CLI authentication is optional, so a missing or logged-out `gh` command
appears as a warning rather than a required-check failure.

Quick check: resolve failures before setup. Warnings describe optional
capabilities and do not necessarily prevent the workspace from starting. The
full behavior is documented under [`doctor`](./docs/features/lifecycle.md#doctor).

## Prepare a Workspace with `boxdown setup`

A new workspace needs a confirmed toolchain plan before Boxdown can launch a
coding-agent CLI. Run the interactive setup once:

```sh
boxdown setup
```

Setup is where you choose how much control and integration the environment
needs. It can:

- Detect supported Node.js, Python, Go, and Rust declarations at the repository
  root.
- Ask you to confirm or override the exact toolchain versions to provision.
- Select how much host user-scoped agent data enters the container.
- Create an SSH alias for the workspace.
- Register the workspace with supported agent applications.
- Start the Dev Container without opening an interactive shell or agent.

For an explicit, repeatable Codex setup, run:

```sh
boxdown setup \
  --target codex \
  --agent-profile auth \
  --toolchain auto
```

`--toolchain auto` approves only high-confidence detections. Boxdown does not
execute project scripts to guess a runtime. It reads documented root-level
markers, resolves them against release-pinned defaults, and records the
confirmed plan outside the repository. If there is no supported toolchain to
provision, choose `No toolchains` interactively or use `--toolchain none`.

See [Workspace toolchains](./docs/features/toolchains.md) for the supported
markers, version precedence, compatibility checks, and provisioning behavior.

### Choose an Agent Profile Deliberately

Agent profiles control host user-scoped agent data. Repository-scoped files
such as `AGENTS.md`, `.agents`, `.codex`, and `.mcp.json` remain visible through
the normal workspace mount with every profile.

| Profile | Host user-scoped data | Recommended use |
| --- | --- | --- |
| `none` | No host agent profile or Claude API key | Untrusted projects or minimal exposure |
| `auth` | File-backed auth, Claude API key when available, and a copied `~/.agents` tree | Normal agent work; this is the default |
| `full` | Live, read-write host Codex and Claude homes plus `~/.agents` | Trusted workspaces that require complete host configuration |

The default `auth` profile stages host sources read-only and creates a writable,
container-local copy. The complete `~/.agents` copy makes user-scoped agent
assets such as portable skills available without exposing the full live Codex
or Claude home.

The `full` profile is intentionally different: changes made inside the
container can immediately modify the corresponding host profiles. Use it only
when the workspace genuinely needs host-level MCP or agent configuration, and
never as a casual fix for missing configuration.

Changing a profile or refreshing an `auth` copy requires recreation because
these mounts and copies are established when the container is created:

```sh
boxdown setup --recreate --agent-profile auth
```

### Register Agent Applications

`setup` can register the same Boxdown workspace with multiple applications:

```sh
boxdown setup \
  --target codex \
  --target claude \
  --target cursor
```

Each target uses the Boxdown-managed SSH alias and canonical
`/workspaces/<repo-name>` path. Registration is idempotent: rerunning setup
updates the existing mapping rather than intentionally creating duplicates.

Boxdown writes configuration but does not launch the application or claim that
an SSH connection succeeded. Restart ChatGPT after registering the `codex`
target so the app reloads the remote-project entry. Claude and Cursor may also
need a restart or refresh as described in the printed **Next step**.

If the container is already prepared and only remote access needs updating,
use the lower-level command:

```sh
boxdown ssh install --target codex
```

The details and cleanup rules are covered in [SSH config and proxy
workflow](./docs/features/ssh-config-and-proxy.md).

## Launch Codex with `boxdown codex`

After the one-time setup, the shortest daily path is:

```sh
boxdown codex
```

Boxdown starts or reuses the workspace Dev Container, checks the container-side
Codex CLI, and launches Codex inside the mounted project. The same pattern is
available for other bundled or supported agents:

```sh
boxdown claude
boxdown opencode
boxdown antigravity
```

Use `--` to separate agent-specific arguments from Boxdown options:

```sh
boxdown codex -- --help
boxdown claude -- --continue
```

If `boxdown codex` reports that no workspace toolchain plan is configured, run
`boxdown setup` and confirm a selection first. This is deliberate: a coding
agent should not silently decide the initial environment policy for a new
workspace.

For a human shell in the same container, run:

```sh
boxdown start
```

Edits made by either the shell, a terminal agent, or a connected desktop app
appear in the host checkout because they all use the same writable workspace
mount.

## Give the Container GitHub CLI Access When Needed

Boxdown does not copy the host GitHub token during ordinary setup, start, agent,
or SSH-proxy operations. Credential transfer is explicit because many coding
tasks do not need permission to query private GitHub data or push changes.

First verify the host GitHub CLI session using the official [`gh auth
status`](https://cli.github.com/manual/gh_auth_status) command:

```sh
gh auth status --hostname github.com
```

Then copy that authentication into this workspace's running container:

```sh
boxdown refresh-gh-token
```

If the container is not running, Boxdown starts it first. It obtains the token
through `gh auth token`, logs the container-side GitHub CLI in for HTTPS use,
and configures this repository's local Git credential behavior so `git fetch`,
`git pull`, and `git push` can use `gh` inside the container. It does not open a
browser or start a device-code login.

A practical sequence for an agent that needs to inspect pull requests or push
a branch is:

```sh
boxdown refresh-gh-token
boxdown codex
```

Validate from a Boxdown shell when necessary:

```sh
boxdown start
gh auth status --hostname github.com
```

The token is now available to processes in that container, including an agent.
Only perform this refresh when the task requires that authority. See [GitHub
auth refresh](./docs/features/github-auth-refresh.md) for the exact host-token
and Git configuration flow.

## Inspect and Control the Workspace Lifecycle

Starting the environment is only one part of its lifecycle. Boxdown provides
commands that explain and clean up the state it owns:

```sh
boxdown status
boxdown list --details
boxdown stop
boxdown down
boxdown purge
```

`status` is read-only and shows the current workspace, generated paths, SSH
alias, toolchain state, agent profile, and matching Docker state. `list` shows
all Boxdown-known workspaces from any directory.

The cleanup commands have intentionally different boundaries:

| Command | Container | Persistent Boxdown state | Repository files |
| --- | --- | --- | --- |
| `stop` | Stops and retains it | Retained | Untouched |
| `down` | Removes it | Cache, metadata, generated config, and SSH keys retained | Untouched |
| `purge` | Removes it | Managed workspace state and app integrations removed | Untouched |

Interactive `purge` prints a resource-level removal plan before asking for
confirmation. It also avoids forcing removal of an image still used by another
container. The repository and Git history are outside the purge boundary.

## A Complete First Tour

From a project root, the complete progression is:

```sh
# 1. Check the host and Docker boundary.
boxdown doctor

# 2. Confirm toolchains, use copied auth, and register the ChatGPT app project.
boxdown setup --target codex --agent-profile auth --toolchain auto

# 3. Inspect the resulting workspace state.
boxdown status

# 4. Launch the Codex CLI inside the reusable container.
boxdown codex

# 5. Remove the container when the task is complete.
boxdown down
```

Quick check: after `down`, `git status` and `git diff` on the host still show
the work produced in the container. Running `boxdown codex` later recreates or
reuses the workspace environment from retained Boxdown state.

The command progression expresses the Boxdown model:

```text
doctor → setup → status → codex/start → stop/down/purge
```

## Trade-offs and Alternatives

Boxdown is useful when the same developer wants a consistent agent-oriented
environment across many local projects. It is not the only valid workflow.

| Approach | Strength | Main trade-off |
| --- | --- | --- |
| Native-host agent | Lowest startup overhead and direct access to existing tools | Broad host exposure and environment drift |
| Project-local `.devcontainer` | Repository-owned and highly project-specific | Repeated configuration and maintenance across repositories |
| Boxdown | Reusable policy, external generated state, agent and app integrations | Opinionated shared environment and a Docker dependency |
| Remote VM or hosted workspace | Stronger host separation and centralized policy options | Network dependency, cost, and remote-state management |

The key trade-off is ownership. Choose project-local Dev Container files when
the environment is part of the repository's contributor contract. Choose
Boxdown when the environment is a reusable local capability that should not
become repository content. Choose a dedicated VM or stronger isolation boundary
when the workload is actively hostile or requires stronger containment than a
developer container can provide.

## Common Problems

### `boxdown codex` Says No Toolchain Plan Exists

The workspace has not completed the current setup flow. Run:

```sh
boxdown setup
```

Confirm detected toolchains or choose `No toolchains`. Then rerun
`boxdown codex`.

### Docker Cannot Mount the Workspace

Run `boxdown doctor` and follow the reported Docker Desktop file-sharing
guidance. Setup performs the same required preflight before it writes workspace
metadata or starts the container.

### The Codex Project Does Not Appear in ChatGPT

Register it explicitly and restart ChatGPT:

```sh
boxdown ssh install --target codex
```

The command updates configuration; it does not launch or restart the app.

### GitHub Commands Are Unauthenticated Inside the Container

Confirm that the host `gh` session works, then refresh the container copy:

```sh
gh auth status --hostname github.com
boxdown refresh-gh-token
```

Normal `boxdown start` and `boxdown codex` commands do not perform this
credential transfer automatically.

## Frequently Asked Questions

### Does Boxdown Modify My Repository?

Boxdown keeps its generated Dev Container configuration, metadata, SSH keys,
logs, toolchain plan, and runtime-secret state outside the repository. The host
checkout itself is mounted writable, so developer and agent edits intentionally
modify it. `refresh-gh-token` also updates repository-local Git configuration
for GitHub HTTPS credentials.

### Is It Safe to Enable Every Agent Auto-approval Option?

No container wrapper turns unrestricted execution into a risk-free operation.
Boxdown narrows the default environment and makes host exposure selectable, but
an agent can still edit the mounted repository, access credentials you provide,
and execute code inside the container. Prefer `none` or `auth`, minimize
credentials, and retain human review for high-impact operations.

### Why Are `setup` and `codex` Separate?

`setup` establishes workspace policy: toolchains, profile exposure, SSH, and
optional app registration. `codex` is the repeatable daily action that reuses
that policy and launches the agent. Separating them prevents a first agent run
from silently choosing security- and environment-sensitive defaults.

### Does `boxdown down` Delete Agent Changes?

No. It removes the workspace container and runtime-secret state, not the host
checkout. Code changes remain visible through `git status` and `git diff`.
Use `boxdown purge` only when you also want Boxdown's persistent workspace state
and managed integrations removed.

## Continue Exploring

Start with a trusted, disposable repository and use the default `auth` profile.
Inspect `boxdown status` after setup so the generated-state boundary is
concrete. Add GitHub authentication only when a task needs it, and compare
`stop`, `down`, and `purge` before adopting Boxdown across more workspaces.

When you are comfortable with the core workflow, explore `boxdown tunnel` for
container-local web servers, `boxdown list --json` for automation, and the
[Boxdown feature documentation](./docs/features/README.md) for the complete
command behavior.
