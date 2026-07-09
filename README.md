<!-- markdownlint-disable -->

<p align="center">
  <h1 align="center">
    boxdown
  </h1>
</p>

<p align="center">
  Start and SSH into a reusable Dev Container environment for any local project.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/boxdown"><img src="https://badgen.net/npm/v/boxdown" alt="npm version"/></a>
  <a href="https://www.npmjs.com/package/boxdown"><img src="https://badgen.net/npm/license/boxdown" alt="license"/></a>
  <a href="https://www.npmjs.com/package/boxdown"><img src="https://badgen.net/npm/dt/boxdown" alt="downloads"/></a>
  <a href="https://github.com/lirantal/boxdown/actions/workflows/ci.yml"><img src="https://github.com/lirantal/boxdown/actions/workflows/ci.yml/badge.svg?branch=main" alt="build"/></a>
  <a href="https://app.codecov.io/gh/lirantal/boxdown"><img src="https://badgen.net/codecov/c/github/lirantal/boxdown" alt="codecov"/></a>
  <a href="./SECURITY.md"><img src="https://img.shields.io/badge/Security-Responsible%20Disclosure-yellow.svg" alt="Responsible Disclosure Policy" /></a>
</p>

## Install

```sh
npm install -g boxdown
```

You can also run it without installing:

```sh
npx boxdown setup
```

## Usage

From any project repository on your host:

```sh
npx boxdown setup
```

Boxdown builds or reuses a Dev Container for the current directory and installs
an SSH alias for remote tools. The target repository stays clean; Boxdown writes
generated configuration and SSH keys under user cache/data directories instead
of copying `.devcontainer/` into the project.

Startup commands print concise progress by default and hide raw Docker,
Dev Containers, and lifecycle hook logs unless a step fails. Add `--verbose` to
stream the full command output while setup/start work runs. Boxdown also keeps
one append-only per-workspace command log under its data directory; `boxdown
status` shows the exact path. Interactive shell, agent, and tunnel session bytes
are not tee'd into the log.

Open an interactive shell inside the container when you need one:

```sh
npx boxdown start
```

Boxdown ships and invokes its own `@devcontainers/cli` dependency. It does not require a host/global Dev Containers CLI install.

### Portless SSH

`boxdown setup` installs an SSH alias for the current project. To only install
or update that alias without starting the devcontainer, use the lower-level SSH
command:

```sh
npx boxdown ssh install
```

This creates a `<repo-name>-devcontainer` SSH host. When run in an interactive
terminal, Boxdown also asks whether to install optional targets such as Codex
and Claude.
Non-interactive runs skip optional targets and print the explicit `--target`
form to use in scripts.

Validate the SSH alias with:

```sh
ssh <repo-name>-devcontainer 'whoami && pwd'
```

Use the same alias in Cursor, Claude, Codex, or any SSH-capable tool.

To also add the project to Codex's remote project sidebar or Claude's SSH
remote list, pass one or more targets during setup or select them from the
lower-level SSH prompt:

```sh
npx boxdown setup --target codex
npx boxdown setup --target claude
```

The lower-level SSH command also supports the same targets for scripts:

```sh
npx boxdown ssh install --target codex
npx boxdown ssh install --target claude
```

Restart the target app after installing it so it applies the updated remote
project config.

If an existing Codex remote project is connected but shows missing chats after
older `/home/node/<repo-name>` registration, inspect and repair the host/sidebar
and remote path identity with:

```sh
npx boxdown codex repair
npx boxdown codex repair --apply
```

From the target project directory, forward a dev server running inside the
container to your host browser:

```sh
npx boxdown tunnel --port 3030
```

If `--port` is omitted in an interactive terminal, Boxdown asks which port or
port mappings to forward and defaults to the generated devcontainer published
port when available. Non-interactive runs still require `--port`.

This keeps a foreground SSH tunnel open until you press Ctrl-C. The host and
Codex in-app browser can then open `http://localhost:3030/`. Repeat `--port`
or use `<local:remote>` mappings when needed:

```sh
npx boxdown tunnel --port 3030 --port 8080:3031
```

Use `--workspace <path>` only when running the command from a different
directory. Repeat it with `down` to remove multiple workspace containers in one
command. When `down` runs from a directory that is not a known Boxdown
workspace, interactive terminals show a workspace picker instead.

Remove Boxdown's managed SSH host block and matching Codex/Claude app entries
when you no longer need the alias:

```sh
npx boxdown ssh uninstall
```

### Commands

```sh
boxdown setup
boxdown start
boxdown codex
boxdown claude
boxdown opencode
boxdown antigravity
boxdown list
boxdown status
boxdown stop
boxdown down
boxdown purge
boxdown doctor
boxdown ssh install
boxdown ssh uninstall
boxdown codex repair
boxdown ssh-proxy
boxdown tunnel --port 3030
boxdown refresh-gh-token
boxdown refresh-gh-token-running
```

`boxdown shell` remains supported as an alias for `boxdown start`, but
documentation uses `start` as the canonical command.
`boxdown cc` remains supported as an alias for `boxdown claude`, but
documentation uses `claude` as the canonical command.

Container bring-up installs Codex and Claude Code by default. The OpenCode and
Antigravity commands stay available, but install/update those CLIs only when you
launch them. Use `--` to pass arguments to the selected agent:

```sh
boxdown claude -- --continue
```

List Boxdown-known devcontainer environments from any directory:

```sh
boxdown list
boxdown list --json
```

Shared options:

```sh
--workspace <path>  # target project directory, defaults to cwd; repeatable with down
--alias <name>      # SSH alias, defaults to <repo-name>-devcontainer
--target <name>     # with setup/ssh install, optional target; repeatable; supported: codex, claude
--port <port>       # tunnel port for `boxdown tunnel`; repeatable
--recreate          # recreate the devcontainer before starting
--json              # JSON output for status and list
```

Use `boxdown purge` when you want to remove the workspace's Boxdown-managed
environment residue: the devcontainer, its exact recorded Docker image, managed
SSH/Codex/Claude entries, command log, and Boxdown cache/data for that
workspace. It does not delete the local repository directory or files inside it.
Interactive terminals ask for confirmation before purging; non-interactive runs
keep the direct behavior.

## Contributing

Please consult [CONTRIBUTING](./CONTRIBUTING.md) for guidelines on contributing to this project.

## Author

**boxdown** © [Liran Tal](https://github.com/lirantal), Released under the [Apache-2.0](./LICENSE) License.
