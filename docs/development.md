# Development

## Requirements

- Node.js 24 or newer.
- pnpm 10.26 or newer.
- Docker for manual container workflow testing.
- OpenSSH tools for SSH config and proxy testing.
- GitHub CLI for `refresh-gh-token` workflow testing.

## Setup

Install dependencies from the Boxdown repository root:

```sh
pnpm install
```

Run the CLI from source:

```sh
pnpm run start -- --help
pnpm run start -- start --workspace /path/to/project
pnpm run start -- ssh install --workspace /path/to/project
```

The published binary is `boxdown`, but local development goes through
`tsx src/bin/cli.ts` via `pnpm run start`.

## Build

```sh
pnpm run build
```

The build emits both CommonJS and ESM files into `dist/`. The npm `bin` entry
points at `dist/bin/cli.cjs`, so run a build before testing the packed CLI.

## Local Runtime Assets

Reusable devcontainer source lives in `assets/devcontainer/`. This is copied
from the latest `gh-cp/.devcontainer` source, with generated `.ssh/` material
excluded.

Boxdown does not keep a root `.devcontainer/` directory. That is deliberate:
the package should not look like it has project-local Dev Container config.

## Running Against Another Project

Use `--workspace` while developing so you do not accidentally target the
Boxdown repo itself:

```sh
pnpm run start -- start --workspace ~/projects/repos/example
pnpm run start -- ssh install --workspace ~/projects/repos/example
```

Starting a real container writes Boxdown state under user cache/data directories
and may pull images or install the Dev Containers CLI.
