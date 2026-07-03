# Feature Index

This directory explains Boxdown's user-facing capabilities and the main internal
flows behind them.

- [Start command](./start-and-shell.md)
- [Setup command](./setup.md)
- [Lifecycle commands](./lifecycle.md)
- [SSH config and proxy workflow](./ssh-config-and-proxy.md)
- [GitHub auth refresh](./github-auth-refresh.md)
- [Generated config and state](./generated-config-and-state.md)

Most features share the same first step: resolve a target workspace, derive
workspace-specific state paths, generate a devcontainer override config, and
delegate container lifecycle work to the Dev Containers CLI.
