# Generated Config and State

## Why Generate Config

The reusable devcontainer source is packaged with Boxdown, not copied into
target repositories. A literal packaged `devcontainer.json` still contains
repo-local lifecycle paths, so Boxdown generates a workspace-specific override
config before starting a container.

The generated config lets Boxdown keep target repositories clean while still
using the Dev Containers CLI as the lifecycle owner.

## Config Location

Generated config is written under:

```text
~/.cache/boxdown/workspaces/<workspace-hash>/devcontainer.json
```

`BOXDOWN_CACHE_HOME` overrides the cache root. `XDG_CACHE_HOME` is honored when
the Boxdown-specific override is not set.

## Persistent State

Workspace data is written under:

```text
~/.local/share/boxdown/workspaces/<workspace-hash>/
```

`BOXDOWN_DATA_HOME` overrides the data root. `XDG_DATA_HOME` is honored when the
Boxdown-specific override is not set.

SSH private keys live in persistent data. A public-key-only runtime directory is
used for the container mount.

Each touched workspace also records inventory metadata at:

```text
~/.local/share/boxdown/workspaces/<workspace-hash>/metadata.json
```

`boxdown list` reads these metadata files as its source of truth, then enriches
entries with best-effort Docker state.

Metadata may also record the last inspected Docker image ID for the workspace so
`boxdown purge` can remove that exact image even after the container is gone.

## External App Config

External app integration config is not Boxdown workspace state. Boxdown writes
it only when an SSH install target is selected from an interactive
`boxdown setup` or `boxdown ssh install` prompt, or requested explicitly with
`boxdown setup --target <name>` or `boxdown ssh install --target <name>`.
Non-interactive runs without `--target` install only the SSH alias and leave
external app config unchanged.

When requested, Boxdown writes Codex's app config at:

```text
~/.codex/codex-app/config.json
```

`BOXDOWN_CODEX_APP_CONFIG` overrides this path for tests and local development.
The Codex entry refers to the Boxdown-managed SSH alias and the canonical
container-side workspace path `/workspaces/<repo-name>`. Codex owns later
global-state records and sidebar entries it creates from that config, but
`boxdown ssh uninstall` removes the matching Codex sidebar cache entry when
unregistering the project.

When requested, Boxdown writes Claude's SSH remote config at:

```text
~/Library/Application Support/Claude/ssh_configs.json
```

`BOXDOWN_CLAUDE_SSH_CONFIGS` overrides this path for tests and local
development. The Claude entry refers to the Boxdown-managed SSH alias and adds
that alias to Claude's trusted host list.

## Generated Changes

Boxdown starts from `assets/devcontainer/devcontainer.json` and rewrites:

- `name`, to include the workspace basename.
- `initializeCommand`, to call the host asset script with the target workspace
  and host Git config snapshot paths.
- `postCreateCommand`, to call mounted container assets.
- `postStartCommand`, to call mounted container assets.
- `mounts`, to add the read-only asset mount, public-key mount, host Git config
  snapshot mount, host `~/.agents` mount when that directory exists, and host
  `~/.codex/auth.json` read-only mount when that file exists.
- `containerEnv`, to point SSH bootstrap at the mounted public key and actual
  container workspace.

The target repository is still the Dev Container workspace via
`--workspace-folder`.

Mounts are create-time container settings. Use `boxdown start --recreate` after
creating or removing host `~/.agents` or `~/.codex/auth.json` so Docker
receives the updated mount set.
