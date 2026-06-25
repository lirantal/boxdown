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
npx boxdown start
```

## Usage

From any project repository on your host:

```sh
npx boxdown start
```

Boxdown builds or reuses a Dev Container for the current directory, then opens a shell inside it. The target repository stays clean; Boxdown writes generated configuration and SSH keys under user cache/data directories instead of copying `.devcontainer/` into the project.

Boxdown ships and invokes its own `@devcontainers/cli` dependency. It does not require a host/global Dev Containers CLI install.

### Portless SSH

Install an SSH alias for the current project:

```sh
npx boxdown ssh-config install
```

By default this creates a `<repo-name>-devcontainer` SSH host. Validate it with:

```sh
ssh <repo-name>-devcontainer 'whoami && pwd'
```

Use the same alias in Cursor, Claude, Codex, or any SSH-capable tool.

To also add the project to Codex's remote project sidebar, install the Codex
target:

```sh
npx boxdown ssh-config install --target codex
```

Restart Codex after installing the target so the app applies its updated remote
project config.

From the target project directory, forward a dev server running inside the
container to your host browser:

```sh
npx boxdown tunnel --port 3030
```

This keeps a foreground SSH tunnel open until you press Ctrl-C. The host and
Codex in-app browser can then open `http://localhost:3030/`. Repeat `--port`
or use `<local:remote>` mappings when needed:

```sh
npx boxdown tunnel --port 3030 --port 8080:3031
```

Use `--workspace <path>` only when running the command from a different
directory.

Remove Boxdown's managed SSH host block and matching Codex app project entry
when you no longer need the alias:

```sh
npx boxdown ssh-config uninstall
```

### Commands

```sh
boxdown start
boxdown codex
boxdown claude
boxdown cc
boxdown opencode
boxdown antigravity
boxdown list
boxdown status
boxdown stop
boxdown down
boxdown doctor
boxdown ssh-config install
boxdown ssh-config uninstall
boxdown ssh-proxy
boxdown tunnel --port 3030
boxdown refresh-gh-token
boxdown refresh-gh-token-running
```

`boxdown shell` remains supported as an alias for `boxdown start`, but
documentation uses `start` as the canonical command.

The coding-agent commands start or reuse the devcontainer, refresh the selected
CLI, then launch it directly inside the container. Use `--` to pass arguments to
the agent:

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
--workspace <path>  # target project directory, defaults to cwd
--alias <name>      # SSH alias, defaults to <repo-name>-devcontainer
--target codex      # also register the SSH alias as a Codex remote project
--port <port>       # tunnel port for `boxdown tunnel`; repeatable
--recreate          # recreate the devcontainer before starting
--json              # JSON output for status and list
```

## Contributing

Please consult [CONTRIBUTING](./CONTRIBUTING.md) for guidelines on contributing to this project.

## Author

**boxdown** © [Liran Tal](https://github.com/lirantal), Released under the [Apache-2.0](./LICENSE) License.
