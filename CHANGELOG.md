# boxdown

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
