# Architecture-Aware 1Password Installer Design

## Goal

Install the pinned 1Password CLI archive that matches the devcontainer's Linux
architecture, and add fast CI coverage for both supported architecture paths.

## Current Problem

`assets/devcontainer/hooks/post-create.sh` always downloads the 1Password
`op_linux_arm64` archive. On amd64 devcontainers this installs an incompatible
binary. The existing CI job runs on amd64, but its tests never execute the
installer's architecture selection, so the mismatch is not detected.

## Design

Keep the existing pinned 1Password CLI version and prebuilt zip installation
flow. Inside `install_1password_cli`, map the value from `uname -m` to the
1Password archive architecture:

- `x86_64` and `amd64` select `amd64`.
- `aarch64` and `arm64` select `arm64`.
- Any other value prints a warning and returns successfully without downloading
  or installing a binary.

The selected architecture becomes part of the existing archive URL. No source
build, Buildx configuration, QEMU emulation, version change, or installer
refactor is required.

## Test Coverage

Add behavioral smoke tests that source the real post-create hook and invoke
`install_1password_cli` with controlled command shims. The shims replace
network and privileged filesystem operations while recording the requested
download URL.

The tests cover:

- `x86_64` selecting the `op_linux_amd64` archive.
- `aarch64` selecting the `op_linux_arm64` archive.
- An unsupported architecture returning successfully, warning, and performing
  no download.

These tests run in the existing `pnpm run test` CI step on `ubuntu-latest`.
This gives the amd64 CI runner explicit coverage of both supported selection
branches without downloading 1Password or building a multi-architecture
container.

## Scope

- Modify `assets/devcontainer/hooks/post-create.sh` only for 1Password archive
  selection and unsupported-architecture handling.
- Add focused tests to `__tests__/app.test.ts` using the repository's existing
  shell-script test conventions.
- Do not alter the Snyk installer, devcontainer image, CI runner matrix, or
  other lifecycle behavior.

## Verification

Use test-driven development: add the focused architecture tests and confirm
they fail against the hard-coded arm64 URL, implement the minimum shell change,
then rerun the focused tests. Finish with the repository's full test, lint,
build, shell syntax, and diff checks.
