# Task 6 wrapper ownership fix

## Change

`is_owned_runtime_wrapper` now accepts only the full generated Boxdown runtime
wrapper format: the shell shebang, marker, `MISE_NO_CONFIG` export, each
expected current MISE state-directory export, and an exact `exec
/usr/local/bin/mise --no-config exec` line for the requested runtime and
command. A marker-bearing file that executes another path is not removable.

The lifecycle fixture includes a failed-upgrade case with a user-owned
`corepack` wrapper carrying the Boxdown marker and the expected-looking shape,
but executing `/tmp/not-mise`. It must survive cleanup while the literal
Boxdown-generated `node`, `npm`, and `npx` wrappers are removed.

## Verification

- `bash -n assets/devcontainer/utils/toolchains-bootstrap.sh` passed.
- A focused ownership harness sourced the bootstrap script with a safe temporary
  home and reported `generated=0 malicious=1`: the exact generated wrapper was
  accepted and the marker plus `/tmp/not-mise` wrapper was rejected.
- `git diff --check` passed.

## Lifecycle fixture limitation

The full lifecycle fixture was also invoked. It did not reach a clean terminal
result in this host environment. A direct invocation with a relative asset path
failed before ownership assertions with this exact error:

```
bash: assets/devcontainer/utils/deps-install.sh: No such file or directory
toolchains lifecycle fixture: legacy non-strict dependency failure returned nonzero
```

Using an absolute asset path advanced farther and emitted the fixture's expected
failure-path warnings (`node 1.2.3: mise install failed` and `node 26.5.0:
dependency synchronization failed`), but still did not return its final `ok`
line. This is recorded as a broader fixture execution issue, not attributed to
the ownership change.
