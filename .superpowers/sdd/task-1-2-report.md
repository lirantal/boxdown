# Tasks 1–2: usage-aware Docker image purge

## Implementation summary

- Added exact Docker image-consumer discovery that filters `docker ps --filter ancestor=...` candidates by inspecting each container's exact image ID.
- Added typed, non-forcing conditional image removal with `removed`, `absent`, and `retained-in-use` results, including a second consumer lookup after a removal race.
- Updated purge preview to classify known shared images as retained, otherwise describe removal as conditional, and report uncertain discovery conservatively.
- Updated purge execution to skip image removal after a failed container removal and to report every typed image-removal outcome.
- Extended fake Docker and CLI coverage for exact image matching, shared images, discovery failures, races, idempotent absence, and non-forcing removal.

## TDD evidence

- Tests were added before the production implementation: exact-consumer filtering; removed, absent, retained, race, discovery-error outcomes; preview classifications; shared purge execution; and container-removal gating.
- The prescribed initial RED commands used `pnpm`, but this environment rejected its locked package-manager signature before Node started the tests: `Refusing to run pnpm@11.8.0: its npm registry signature could not be verified`.
- GREEN verification used the already-resolved `tsx` loader directly with Node:
  - `node --import tsx --test --test-name-pattern='purge plan|Docker image|image consumer|image removal' __tests__/app.test.ts` — 14 passed.
  - `node --import tsx --test --test-name-pattern='purge|CLI execution' __tests__/app.test.ts` — 90 passed.

## Full verification

- `node --import tsx --test __tests__/**/*.test.ts` — 592 passed, 1 failed, duration 124.46s.
- The sole failure is unrelated to these changes and sandbox-specific: existing SSH-agent proxy test at `__tests__/app.test.ts:10981` cannot create its Unix socket, reporting `listen EPERM: operation not permitted /tmp/boxdown-ssh-agent-proxy-.../source.sock`.
- `git diff --check` passed.
- `rg -n "image rm -f|removeDockerImage(?!IfUnused)\\b" src __tests__ --pcre2` produced no matches (exit 1 because no matches).

## Files changed

- `src/devcontainer.ts`
- `src/purge.ts`
- `__tests__/app.test.ts`

## Self-review

- Consumer detection verifies the exact image ID rather than trusting Docker's ancestor filter, so descendant candidates cannot cause a shared image to be retained incorrectly.
- Image removal is never forced, excludes the target container only after its successful removal, and rechecks consumers if Docker reports a non-absence removal failure.
- Preview and execution both retain shared images without treating the expected retention as a purge failure.
- No obsolete forced image-removal invocation or obsolete `removeDockerImage` import remains.

## Concerns

- The repository's prescribed `pnpm` test command is unavailable in this environment due package-manager signature verification, and the full suite has the pre-existing sandbox Unix-socket limitation noted above. The focused image-policy and purge suites are green through direct Node/tsx execution.
