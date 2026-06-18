# Conventions

## Coding

- Keep the CLI dependency-light and prefer Node.js built-ins.
- Keep process execution isolated in the process/devcontainer helpers so pure
  behavior remains easy to test.
- Prefer typed helper functions over shell string manipulation in TypeScript.
- Keep shell scripts POSIX-ish Bash and compatible with the original
  devcontainer workflow.
- Preserve backwards-compatible fallbacks in asset scripts when possible, so the
  same scripts can still run from a copied `.devcontainer/` layout.

## Documentation

- Update feature docs when changing command behavior.
- Update architecture docs when changing state locations, generated config
  shape, asset mounting, or SSH boundaries.
- Keep examples copy-pasteable and explicit about `--workspace` when a command
  may affect another repository.

## Maintenance

- Copy only tracked devcontainer source files from `gh-cp/.devcontainer`.
- Never copy generated `.devcontainer/.ssh/` material.
- Run `npm pack --dry-run --json` after changing `package.json.files` or
  package assets.
- Add a changeset for published CLI behavior changes.
- Treat Docker-starting workflows as manual acceptance tests, not unit tests.
