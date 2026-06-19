# Boxdown Documentation

Boxdown is a CLI-first Dev Container runner. It lets a project use a shared
devcontainer setup without copying a `.devcontainer/` directory into every
repository.

## Guides

- [Development](./development.md) covers local setup, common commands, and how to
  run Boxdown from source.
- [Testing](./testing.md) describes the test strategy and verification commands.
- [Architecture](./architecture.md) explains the project structure, generated
  configuration flow, and important boundaries.
- [Conventions](./conventions.md) captures project-specific coding and
  maintenance expectations.
- [Todo and next plans](./todo.md) captures the post-v1 roadmap and fresh-session
  handoff context.

## Feature Docs

- [Feature index](./features/README.md)
- [Start command](./features/start-and-shell.md)
- [Lifecycle commands](./features/lifecycle.md)
- [SSH config and proxy workflow](./features/ssh-config-and-proxy.md)
- [GitHub auth refresh](./features/github-auth-refresh.md)
- [Generated config and state](./features/generated-config-and-state.md)

## Design Snapshot

Boxdown packages reusable devcontainer source under `assets/devcontainer/`.
At runtime it generates a per-workspace `devcontainer.json` outside the target
repository and invokes the Dev Containers CLI with `--override-config`. This
keeps consuming repositories clean while preserving normal Dev Container
lifecycle behavior.
