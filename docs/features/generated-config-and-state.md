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

## Generated Changes

Boxdown starts from `assets/devcontainer/devcontainer.json` and rewrites:

- `name`, to include the workspace basename.
- `initializeCommand`, to call the host asset script with the target workspace.
- `postCreateCommand`, to call mounted container assets.
- `postStartCommand`, to call mounted container assets.
- `mounts`, to add the read-only asset mount, public-key mount, and host
  `~/.agents` mount when that directory exists.
- `containerEnv`, to point SSH bootstrap at the mounted public key and actual
  container workspace.

The target repository is still the Dev Container workspace via
`--workspace-folder`.

Mounts are create-time container settings. Use `boxdown start --recreate` after
creating or removing host `~/.agents` so Docker receives the updated mount set.
