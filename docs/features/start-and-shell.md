# Start and Shell Commands

## Commands

```sh
boxdown start
boxdown shell
```

`shell` is an alias for `start`. Both commands target the current directory by
default and accept:

```sh
--workspace <path>
--recreate
```

## Flow

1. Resolve the workspace to a real absolute path.
2. Ensure per-workspace SSH key material exists.
3. Generate a Boxdown-owned devcontainer config.
4. Install or reuse the pinned Dev Containers CLI.
5. Run `devcontainer up --workspace-folder <repo> --override-config <config>`.
6. Print a dynamic port hint when the configured published port is mapped.
7. Run `devcontainer exec ... bash` to open an interactive shell.

## Recreate

`--recreate` passes `--remove-existing-container` to the Dev Containers CLI.
Use it when changing create-time settings such as image, features, mounts, or
Docker `runArgs`.

## Port Hint

The v1 asset config publishes container port `3000` with a dynamic host port.
After `up`, Boxdown asks Docker for the mapped host binding and prints the
result as an HTTP URL when available.
