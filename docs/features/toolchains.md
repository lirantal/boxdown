# Workspace Toolchains

Boxdown can detect, confirm, and provision the development runtimes a workspace
needs inside its Dev Container. The first release supports Node.js, Python, Go,
and Rust. It reads only known marker files at the workspace root; it does not
scan monorepos, create Boxdown files in the repository, or run repository
configuration, hooks, tasks, scripts, or builds to determine a runtime.

## Release-pinned Defaults

Each Boxdown release pins these exact defaults. Provisioning never performs a
floating version lookup.

| Runtime | Boxdown default | Default source |
| --- | --- | --- |
| node | 24.17.0 | Boxdown release default |
| python | 3.14.6 | Boxdown release default |
| go | 1.26.5 | Boxdown release default |
| rust | 1.97.1 | Boxdown release default |

One valid exact project declaration resolves the runtime instead of the default.
For a compatible constraint, Boxdown uses the release-pinned default only when
it satisfies the constraint. A constraint that excludes that default, or a
declaration with diagnostics, remains visible but unchecked in interactive
setup; Boxdown never silently chooses another version.

## Detection Sources

Detection is root-only. The exact-version and constraint sources below are all
checked; they are not a first-wins precedence list.

| Runtime | Exact-version sources | Constraint source |
| --- | --- | --- |
| Node.js | `volta.node` in `package.json`; `.nvmrc`; `.node-version`; `.tool-versions` | `engines.node` in `package.json` |
| Python | `.python-version`; `.tool-versions` | `requires-python` in `pyproject.toml` |
| Go | `toolchain` in `go.mod`; `.go-version`; `.tool-versions` | `go` directive in `go.mod` |
| Rust | `rust-toolchain.toml`; `rust-toolchain`; `.tool-versions` | `package.rust-version` in `Cargo.toml` |

Repeated or conflicting exact declarations, repeated or conflicting
constraints, malformed declarations, and unsupported constraints are rejected
with actionable diagnostics; they are never approximated or resolved by taking
the first declaration. Ruby and PHP are not detected or provisioned in this
release.

## Select Toolchains

`--toolchain` is repeatable and is available only with `setup` and `start`.

```sh
boxdown setup --toolchain auto
boxdown setup --toolchain node@24.17.0 --toolchain python@3.14.6
boxdown setup --toolchain node@24 --toolchain go@1.27
boxdown setup --toolchain none
```

- Omit selectors in an interactive `boxdown setup` to review an editable
  multi-select of every supported runtime. Compatible, fully resolved detections
  begin selected. Incompatible or unchecked detections and runtimes without
  project markers remain visible but unchecked; undetected runtimes show the
  exact Boxdown default used when selected. Setup requires you to confirm the
  final selection. Choosing `No toolchains` writes an explicit empty plan.
- `auto` explicitly approves every high-confidence detection.
- `<runtime>` selects a supported runtime only when its project declaration can
  be resolved safely; with no declaration it uses the Boxdown default. An
  incompatible constraint or unchecked declaration requires an explicit
  `<runtime>@<version>` selector.
- `<runtime>@<version>` is an explicit version override. It takes precedence
  over a repository declaration; setup and status show a compatibility note
  when it differs.
- `none` persists an explicit empty selection and cannot be combined with other
  selectors.

In a non-interactive command, omitted selectors report detections but select
nothing and write no plan. This makes CI and scripts explicit. A direct
`boxdown start` reuses an existing confirmed plan; when no plan exists it does
not prompt, so supply a selector or run interactive `boxdown setup` first.

## Provisioning and Safety

The release image includes a release-pinned `mise` binary. Boxdown invokes it
only with resolved versions and configuration loading disabled. Project
`mise.toml`, `.tool-versions`, environment files, hooks, and tasks are neither
loaded nor executed by the runtime manager.

Container-local state holds the installed runtimes and activation wrappers;
neither is written into the target repository or host runtime state. The Node
24 runtime already in the image is used only when it exactly matches the
selected version. Otherwise, Boxdown provisions the selected Node.js, Python,
Go, or Rust version in container-local state.

After provisioning, Boxdown performs only these declared dependency
synchronizations:

| Runtime | Synchronization |
| --- | --- |
| Node.js | Existing detected package-manager installation behavior |
| Python | `uv sync` for a `pyproject.toml` plus lockfile workflow, otherwise declared requirements installation |
| Go | `go mod download` |
| Rust | `cargo fetch` |

Boxdown does not infer or run package scripts itself, task runners, arbitrary
project commands, `go get`, Cargo builds, or repository-defined mise actions.

## Status, Retry, and Recreation

`boxdown status` reports each selected runtime and resolved version, its source,
any override note, the last synchronization result, and whether recreation is
needed. The states are:

- `active`: a non-empty selected plan exists and either no container exists yet,
  or a container exists, the generated configuration records both toolchain
  mounts, and the result fingerprint matches the plan.
- `disabled`: an explicit empty plan exists, unless an existing container lacks
  either toolchain mount in the generated configuration.
- `not-selected`: no plan exists.
- `recreate-required`: a container exists but the generated configuration lacks
  either required mount, or a non-empty plan's result is missing or has a
  different fingerprint. A failed result with the matching fingerprint remains
  `active`; its synchronization state is reported separately and retried on a
  later start.

Provisioning or dependency synchronization failures are recorded with the
runtime and operation, warn without making the container unusable, and retry on
a later start. Check the workspace command log shown by `boxdown status` for
the command output.

Plans introduce create-time mounts. A legacy workspace gains its first plan
only after recreation:

```sh
boxdown setup --recreate --toolchain auto
# or
boxdown start --recreate --toolchain node@24.17.0 --toolchain python@3.14.6
```

Existing legacy workspaces with no plan remain valid and retain their current
behavior.

## Stored State

Boxdown stores a selected plan and lifecycle result outside the target
repository:

```text
~/.local/share/boxdown/workspaces/<workspace-hash>/toolchains/plan.json
~/.local/share/boxdown/workspaces/<workspace-hash>/toolchains/result/result.json
```

The generated Dev Container configuration makes the plan file available
read-only at `/opt/boxdown/state/toolchains/plan/plan.json` and the result file
available read-write at `/opt/boxdown/state/toolchain-results/result.json`. The
plan records selected runtimes, versions, evidence, sources, and a fingerprint;
the result records the last bounded provisioning outcome. See [Generated config
and state](./generated-config-and-state.md) for the full state-boundary details.
