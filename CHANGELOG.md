# boxdown

## 1.3.0

### Minor Changes

- [`6250ffd`](https://github.com/lirantal/boxdown/commit/6250ffde708704d92457dbef2d52eaa57fe3827d) Thanks [@lirantal](https://github.com/lirantal)! - fixes for setup and start readiness checks

## 1.2.1

### Patch Changes

- [`b8a8700`](https://github.com/lirantal/boxdown/commit/b8a8700053995e7c03f910e2ba44f8219502851c) Thanks [@lirantal](https://github.com/lirantal)! - Resolve configured SSH signing-key paths and report actionable non-blocking commit-signing diagnostics.

- [`3ed7745`](https://github.com/lirantal/boxdown/commit/3ed774502b29ed32503617b4d27dc5082db12b64) Thanks [@lirantal](https://github.com/lirantal)! - Keep Boxdown-provided secrets out of workspace files, Docker inspection, and lifecycle logs while preserving Bash-session environment variables.

- [`b336e41`](https://github.com/lirantal/boxdown/commit/b336e41d55cc1d5dff15031250a31f540fda8b09) Thanks [@lirantal](https://github.com/lirantal)! - Fix SSH commit signing for non-root Boxdown container users by relaying the forwarded agent socket safely.

## 1.2.0

### Minor Changes

- [`b28ce5e`](https://github.com/lirantal/boxdown/commit/b28ce5ed0ed9c382c62601afbd98873ce7632d10) Thanks [@lirantal](https://github.com/lirantal)! - Run blocking host-readiness checks before setup and report Docker bind-mount
  configuration problems before starting a devcontainer.

- [#10](https://github.com/lirantal/boxdown/pull/10) [`5800ee0`](https://github.com/lirantal/boxdown/commit/5800ee0fb8cfe19cc7ff2f3d472f304e29386287) Thanks [@lirantal](https://github.com/lirantal)! - Enable best-effort SSH commit signing in new Boxdown environments.

## 1.1.1

### Patch Changes

- [`4bd19cc`](https://github.com/lirantal/boxdown/commit/4bd19cce45aed6f8e1b43b4a0e8a451face4d93a) Thanks [@lirantal](https://github.com/lirantal)! - Add `boxdown --version` and `boxdown -v` for semver-only version output.

## 1.1.0

### Minor Changes

- [`d761452`](https://github.com/lirantal/boxdown/commit/d761452b5f547d0992da8d0cad1235903606109e) Thanks [@lirantal](https://github.com/lirantal)! - Add append-only per-workspace lifecycle command logs and expose the log path in `boxdown status`.

## 1.0.0

### Major Changes

- [#2](https://github.com/lirantal/boxdown/pull/2) [`f44cc89`](https://github.com/lirantal/boxdown/commit/f44cc89cbdf6c9448f4356ceac4a7ccdbdcf90a5) Thanks [@lirantal](https://github.com/lirantal)! - Release Boxdown 1.0.0 as the first stable CLI version.

### Patch Changes

- [`ed74021`](https://github.com/lirantal/boxdown/commit/ed7402131e3ad5f213c4929567d1ad06fd3e9a1c) Thanks [@lirantal](https://github.com/lirantal)! - Add the Boxdown CLI for starting shared devcontainer environments and installing portless SSH aliases from any project directory.
