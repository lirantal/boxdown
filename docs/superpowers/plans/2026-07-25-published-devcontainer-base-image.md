# Published Devcontainer Base Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a lean, release-matched AMD64/ARM64 Boxdown base image to public GHCR and make new workspaces pull it instead of locally applying Dev Container Features.

**Architecture:** A Dockerfile produces a Node 24 image containing Boxdown's shared runtime, Codex, Claude Code, Snyk, and 1Password CLI on both platforms, plus APM on AMD64. The packaged devcontainer points to the package-version GHCR tag and retains only workspace mounts and hooks. Pull requests build and smoke-test the image; releases publish, attest, verify, then publish npm.

**Tech Stack:** TypeScript, Node test runner, `tsx`, JSONC, Bash, Docker Buildx, GitHub Actions, GHCR, Changesets, npm lockfiles.

## Global Constraints

- Base every image on the existing digest-pinned `node:24-trixie-slim` OCI index.
- Publish `linux/amd64` and `linux/arm64` only. Boxdown consumes only `ghcr.io/lirantal/boxdown:<package-version>`, never `latest` or a major tag.
- Default tools: Git, sudo/common shell utilities, ripgrep, GitHub CLI, OpenSSH server, Codex, Claude Code, Snyk, and 1Password CLI on both platforms; APM on AMD64 only.
- Python/pipx/uv, OpenCode, Antigravity, and workspace dependencies remain lazy or workspace-specific. Do not add `boxdown tools update`.
- Retain throttled Codex/Claude refreshes and seed their image update stamps so first start does not update.
- Never auto-recreate a legacy container or fall back to a local build; print a one-time explicit recreation notice.
- Lock npm artifacts with exact versions/integrity entries; lock native archives with versioned URLs/SHA-256 values. Dockerfiles must not use a mutable installer URL.
- Preserve existing asset, auth, SSH, Git-config, agent-config, and secret mounts. Pin all Actions to full commit SHAs.

---

## File Structure

- `assets/image/Dockerfile` — final non-root image.
- `assets/image/npm/package.json`, `assets/image/npm/package-lock.json` — exact Codex, Claude Code, and Snyk inputs.
- `assets/image/tools.lock.json` — 1Password/APM per-architecture URL/checksum inputs.
- `assets/image/install-native-tools.sh`, `assets/image/smoke-test.sh` — verified native install and runtime command verification.
- `assets/image/image-size-budget.json` — accepted compressed image size and 10% growth cap.
- `scripts/sync-devcontainer-image.ts` — version-to-image JSONC synchronization.
- `scripts/check-image-release.ts`, `scripts/verify-image-manifest.ts` — immutable release-tag and manifest/size policy.
- `src/metadata.ts`, `src/devcontainer.ts` — one-time legacy migration notice.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml` — PR validation and release publication.
- `__tests__/image-input-policy.test.ts`, `__tests__/devcontainer-image-policy.test.ts`, `__tests__/app.test.ts` — policy, synchronization, lifecycle, and migration coverage.

### Task 1: Lock image inputs and assert the image policy

**Files:**

- Create: `assets/image/npm/package.json`
- Create: `assets/image/npm/package-lock.json`
- Create: `assets/image/tools.lock.json`
- Create: `assets/image/image-size-budget.json`
- Create: `__tests__/image-input-policy.test.ts`
- Modify: `__tests__/devcontainer-image-policy.test.ts`

**Interfaces:**

- Produces an npm lock whose root has exact versions of `@openai/codex`, `@anthropic-ai/claude-code`, and `snyk`.
- Produces `NativeToolLock`: `{ schemaVersion: 1, onepassword: DualPlatformTool, apm: Amd64Tool }`, where `Amd64Tool` has one AMD64 artifact and `deferredPlatforms: ['arm64']`; every stored artifact has an exact versioned URL and SHA-256 value.
- Produces `{ schemaVersion: 1, compressedBytes: number, allowedGrowthPercent: 10 }`.

- [ ] **Step 1: Write failing lock-policy tests**

```ts
test('locks image npm dependencies to exact versions with integrity metadata', () => {
  const manifest = JSON.parse(readFileSync(imageNpmPackagePath, 'utf8'))
  const lock = JSON.parse(readFileSync(imageNpmLockPath, 'utf8'))
  for (const name of ['@openai/codex', '@anthropic-ai/claude-code', 'snyk']) {
    assert.match(manifest.dependencies[name], /^\d+\.\d+\.\d+(?:-[\w.]+)?$/)
    assert.match(lock.packages[`node_modules/${name}`].integrity, /^sha512-/)
  }
})

test('locks 1Password for both platforms and APM for AMD64 only', () => {
  const lock = JSON.parse(readFileSync(nativeToolLockPath, 'utf8'))
  for (const arch of ['amd64', 'arm64']) assert.match(lock.onepassword.artifacts[arch].sha256, /^[a-f0-9]{64}$/)
  assert.match(lock.apm.artifacts.amd64.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(lock.apm.deferredPlatforms, ['arm64'])
})
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --import tsx --test __tests__/image-input-policy.test.ts`

Expected: FAIL because the image input files do not exist.

- [ ] **Step 3: Create committed exact locks**

```bash
mkdir -p assets/image/npm && cd assets/image/npm
npm init -y
npm pkg set private=true engines.node='>=24 <25'
npm pkg set dependencies.'@openai/codex'="$(npm view @openai/codex version)"
npm pkg set dependencies.'@anthropic-ai/claude-code'="$(npm view @anthropic-ai/claude-code version)"
npm pkg set dependencies.snyk="$(npm view snyk version)"
npm install --package-lock-only --ignore-scripts
```

Resolve stable vendor release assets for 1Password on AMD64/ARM64 and APM on AMD64, calculate `shasum -a 256`, and commit the exact versioned URL/checksum output. Record `apm.deferredPlatforms: ['arm64']`; tests must reject an ARM64 APM binary, `/latest`, `/stable`, unversioned installers, ranges, and an image size budget other than 10%.

- [ ] **Step 4: Verify and commit**

Run: `node --import tsx --test __tests__/image-input-policy.test.ts __tests__/devcontainer-image-policy.test.ts`

Expected: PASS.

```bash
git add assets/image/npm assets/image/tools.lock.json assets/image/image-size-budget.json __tests__/image-input-policy.test.ts __tests__/devcontainer-image-policy.test.ts
git commit -m "chore: lock devcontainer image tools"
```

### Task 2: Build and smoke-test the lean runtime image

**Files:**

- Create: `assets/image/Dockerfile`
- Create: `assets/image/install-native-tools.sh`
- Create: `assets/image/smoke-test.sh`
- Modify: `assets/devcontainer/utils/coding-agent-cli-update.sh`
- Modify: `__tests__/image-input-policy.test.ts`

**Interfaces:**

- `install-native-tools.sh <amd64|arm64> <lock-path>` fails for unknown architecture, malformed lock values, failed downloads, or checksum mismatch.
- `smoke-test.sh` succeeds only when default commands are executable as `node`; it requires `apm` on AMD64 and the ARM64-deferred marker on ARM64.
- Existing `install`, `update-now`, `maybe-update`, and `ensure` actions remain public; image-installed npm agents use npm updates while legacy standalone agents retain their existing fallback.

- [ ] **Step 1: Add failing Dockerfile policy tests**

```ts
test('uses the pinned Node image and has no mutable installer or lazy tools', () => {
  const dockerfile = readFileSync(dockerfilePath, 'utf8')
  assert.match(dockerfile, /^FROM node:24-trixie-slim@sha256:[a-f0-9]{64}/m)
  assert.match(dockerfile, /apt-get install -y --no-install-recommends/)
  assert.match(dockerfile, /USER node/)
  assert.doesNotMatch(dockerfile, /\b(latest|stable)\b/i)
  assert.doesNotMatch(dockerfile, /python3|pipx|\buv\b|opencode|antigravity/)
})
```

- [ ] **Step 2: Confirm failure**

Run: `node --import tsx --test __tests__/image-input-policy.test.ts`

Expected: FAIL because `assets/image/Dockerfile` does not exist.

- [ ] **Step 3: Implement the Dockerfile and verified native installer**

Use the exact digest already in `assets/devcontainer/devcontainer.json`. Install only Git, sudo/common utilities, ripgrep, GitHub CLI, OpenSSH server, `curl`, CA certificates, and archive tools with `--no-install-recommends`; remove apt lists in the same layer. Install npm tools from the committed lock, then native artifacts for BuildKit's `TARGETARCH`.

```dockerfile
FROM node:24-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573
ARG TARGETARCH
COPY assets/image/npm /opt/boxdown/image-npm
RUN npm ci --omit=dev --ignore-scripts --prefix /opt/boxdown/image-npm \
 && ln -s /opt/boxdown/image-npm/node_modules/.bin/codex /usr/local/bin/codex \
 && ln -s /opt/boxdown/image-npm/node_modules/.bin/claude /usr/local/bin/claude \
 && ln -s /opt/boxdown/image-npm/node_modules/.bin/snyk /usr/local/bin/snyk
COPY assets/image/tools.lock.json assets/image/install-native-tools.sh /opt/boxdown/image-tools/
RUN /opt/boxdown/image-tools/install-native-tools.sh "$TARGETARCH" /opt/boxdown/image-tools/tools.lock.json
USER node
```

The installer must parse JSON with Node, use `curl --fail --location`, validate `sha256sum --check --status`, install only the expected binary, and clean its `mktemp -d` directory with `trap`.

- [ ] **Step 4: Preserve safe agent updates**

Use `/opt/boxdown/image-npm/package-lock.json` as the image marker. When it exists, update the selected agent's npm package; otherwise run the current standalone updater. During the image build create `/home/node/.cache/boxdown/coding-agent-clis/{codex,claude}.stamp` and `chown -R node:node /home/node/.cache`, so first `maybe-update` is skipped.

- [ ] **Step 5: Add and run the smoke test**

```bash
#!/usr/bin/env bash
set -euo pipefail
for command in node git gh rg sshd codex claude snyk op; do command -v "$command" >/dev/null; done
if [ "$(uname -m)" = x86_64 ]; then apm --version; else test -f /opt/boxdown/image-tools/apm-arm64-deferred; fi
node --version; git --version; codex --version; claude --version; snyk --version; op --version
```

Run:

```bash
docker buildx build --load --platform linux/amd64 -t boxdown-image-test:local -f assets/image/Dockerfile .
docker run --rm --user node --entrypoint bash boxdown-image-test:local /opt/boxdown/image-tools/smoke-test.sh
```

Expected: both commands exit 0.

- [ ] **Step 6: Verify and commit**

Run: `node --import tsx --test __tests__/image-input-policy.test.ts && bash -n assets/image/install-native-tools.sh assets/image/smoke-test.sh assets/devcontainer/utils/coding-agent-cli-update.sh`

Expected: PASS.

```bash
git add assets/image assets/devcontainer/utils/coding-agent-cli-update.sh __tests__/image-input-policy.test.ts
git commit -m "feat: build Boxdown devcontainer base image"
```

### Task 3: Switch devcontainer lifecycle to the published image

**Files:**

- Modify: `assets/devcontainer/devcontainer.json`
- Modify: `assets/devcontainer/hooks/post-create.sh`
- Modify: `assets/devcontainer/hooks/post-start.sh`
- Modify: `__tests__/app.test.ts`
- Modify: `__tests__/devcontainer-image-policy.test.ts`

**Interfaces:**

- The template has `image: ghcr.io/lirantal/boxdown:<package-version>` and neither Feature field.
- Post-create performs Git/signing/secrets/workspace Git, SSH runtime, and dependency setup only.

- [ ] **Step 1: Add failing lifecycle tests**

```ts
test('post-create does not install image-owned tools', () => {
  const script = readFileSync(postCreatePath, 'utf8')
  assert.doesNotMatch(script, /install_(openssh_server|python_runtime|apm|1password_cli|snyk_cli)/)
  assert.doesNotMatch(script, /coding-agent-cli-update\.sh" install/)
  assert.match(script, /ssh-bootstrap\.sh" runtime/)
  assert.match(script, /deps-install\.sh/)
})
```

- [ ] **Step 2: Confirm failure**

Run: `node --import tsx --test __tests__/devcontainer-image-policy.test.ts __tests__/app.test.ts`

Expected: FAIL because Features and shared-tool installation remain.

- [ ] **Step 3: Remove local image construction**

Delete `features` and `overrideFeatureInstallOrder`. Replace the Node image with the release image. Remove post-create functions for OpenSSH installation, Python, APM, coding-agent installation, 1Password, and Snyk. Retain Git/signing/secrets/workspace Git/dependency work; use `ssh-bootstrap.sh runtime` in post-create and keep post-start's SSH runtime plus throttled `maybe-update`.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --import tsx --test __tests__/devcontainer-image-policy.test.ts __tests__/app.test.ts
bash -n assets/devcontainer/hooks/post-create.sh assets/devcontainer/hooks/post-start.sh
```

Expected: PASS.

```bash
git add assets/devcontainer __tests__/app.test.ts __tests__/devcontainer-image-policy.test.ts
git commit -m "feat: use published Boxdown devcontainer image"
```

### Task 4: Synchronize package and image versions

**Files:**

- Create: `scripts/sync-devcontainer-image.ts`
- Modify: `package.json`
- Modify: `__tests__/devcontainer-image-policy.test.ts`

**Interfaces:**

- `syncDevcontainerImage(packageJsonPath: string, devcontainerPath: string): void` replaces only the top-level JSONC image string with `ghcr.io/lirantal/boxdown:<package.version>`.
- `pnpm run version` runs Changesets and then the synchronizer.

- [ ] **Step 1: Write a failing comment-preservation test**

```ts
writeFileSync(packagePath, '{"version":"9.8.7"}\n')
writeFileSync(configPath, '{\n // retain\n "image":"old",\n "name":"Keep"\n}\n')
syncDevcontainerImage(packagePath, configPath)
assert.match(readFileSync(configPath, 'utf8'), /retain/)
assert.match(readFileSync(configPath, 'utf8'), /ghcr\.io\/lirantal\/boxdown:9\.8\.7/)
```

- [ ] **Step 2: Confirm failure**

Run: `node --import tsx --test __tests__/devcontainer-image-policy.test.ts`

Expected: FAIL because the synchronizer is absent.

- [ ] **Step 3: Implement and wire the synchronizer**

```ts
const imageLine = /^(\s*"image"\s*:\s*)"[^"]*"(\s*,?\s*)$/m
if (!imageLine.test(source)) throw new Error(`Packaged devcontainer image is missing: ${devcontainerPath}`)
writeFileSync(devcontainerPath, source.replace(imageLine, `$1"ghcr.io/lirantal/boxdown:${version}"$2`))
```

Set `"version": "changeset version && pnpm run sync:devcontainer-image"` and add `"sync:devcontainer-image": "tsx scripts/sync-devcontainer-image.ts"`.

- [ ] **Step 4: Verify and commit**

Run: `node --import tsx --test __tests__/devcontainer-image-policy.test.ts && pnpm run sync:devcontainer-image && git diff --exit-code -- assets/devcontainer/devcontainer.json`

Expected: PASS and no current-version diff.

```bash
git add package.json scripts/sync-devcontainer-image.ts __tests__/devcontainer-image-policy.test.ts
git commit -m "chore: synchronize Boxdown image release tag"
```

### Task 5: Warn once for legacy locally-built containers

**Files:**

- Modify: `src/metadata.ts`
- Modify: `src/devcontainer.ts`
- Modify: `__tests__/app.test.ts`

**Interfaces:**

- `isPublishedBoxdownImage(image?: DockerImageInfo): boolean` is true only for `ghcr.io/lirantal/boxdown:<nonempty-tag>`.
- `recordLegacyImageMigrationNotice(context): boolean` persists `legacyImageMigrationNotifiedAt` and returns true only on first notice.

- [ ] **Step 1: Add failing migration tests**

```ts
const image = { id: 'sha256:legacy', name: 'vsc-example-legacy-uid' }
assert.equal(isPublishedBoxdownImage(image), false)
assert.equal(recordLegacyImageMigrationNotice(context), true)
assert.equal(recordLegacyImageMigrationNotice(context), false)
assert.match(stderr, /Run `boxdown start --recreate` to switch to the published Boxdown image\./)
assert.ok(!calls.some(call => call.startsWith('docker rm') || call.startsWith('docker image rm')))
```

- [ ] **Step 2: Confirm failure**

Run: `node --import tsx --test --test-name-pattern='legacy.*image|migration' __tests__/app.test.ts`

Expected: FAIL because detection and metadata do not exist.

- [ ] **Step 3: Implement post-inspection notice behavior**

After the existing `inspectContainerImage`/metadata record path, identify non-GHCR images and emit only once:

```text
This workspace uses Boxdown's legacy locally-built devcontainer image.
Run `boxdown start --recreate` to switch to the published Boxdown image.
```

Do not add remove commands, modify `--recreate`, or change purge behavior.

- [ ] **Step 4: Verify and commit**

Run: `node --import tsx --test --test-name-pattern='legacy.*image|migration|records and preserves workspace Docker image metadata' __tests__/app.test.ts && pnpm test`

Expected: PASS.

```bash
git add src/metadata.ts src/devcontainer.ts __tests__/app.test.ts
git commit -m "feat: guide legacy containers to published image"
```

### Task 6: Validate PR images and publish release images before npm

**Files:**

- Create: `scripts/check-image-release.ts`
- Create: `scripts/verify-image-manifest.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `__tests__/image-input-policy.test.ts`

**Interfaces:**

- `verifyImageManifest({ manifest, labels, compressedBytes, budget })` throws for absent AMD64/ARM64, source/revision/version labels, or size greater than budget × 1.10.
- `checkImageRelease(version, revision, inspect)` returns `publish` for a missing tag, `reuse` only for matching source/revision/version labels, and throws for a mismatched occupied tag.

- [ ] **Step 1: Write failing workflow-helper tests**

```ts
assert.throws(() => verifyImageManifest({ manifest: amd64Only, labels, compressedBytes: 1, budget }), /linux\/arm64/)
assert.throws(() => verifyImageManifest({ manifest: dual, labels, compressedBytes: 111, budget: { schemaVersion: 1, compressedBytes: 100, allowedGrowthPercent: 10 } }), /size budget/)
await assert.rejects(() => checkImageRelease('1.4.0', 'abc', async () => ({ ...matchingLabels, 'org.opencontainers.image.revision': 'other' })), /refusing to overwrite/)
```

- [ ] **Step 2: Confirm failure**

Run: `node --import tsx --test __tests__/image-input-policy.test.ts`

Expected: FAIL because the helper modules are absent.

- [ ] **Step 3: Add the read-only PR image job**

In `ci.yml`, add `image` with `contents: read` only and path filtering for image assets, devcontainer/lifecycle image inputs, tests, scripts, and workflow files. Use full-SHA pins for current signed releases of Docker QEMU, Buildx, and build-push actions. Build/load AMD64, run smoke as `node`, then export a dual-platform OCI image and validate it with `verifyImageManifest`. Do not log into GHCR or push.

- [ ] **Step 4: Change release ordering**

Keep `changesets/action` only for its `version` command. Add a release-state step that checks whether `package.json`'s version is missing from npm. When missing, set up QEMU/Buildx; use `docker/login-action` with `${{ github.actor }}` and `${{ secrets.GITHUB_TOKEN }}`; smoke-test AMD64; then push the dual-platform image. Use pinned `actions/attest` after push and before `pnpm exec changeset publish`. Grant only existing Changesets permissions plus `packages: write`, `attestations: write`, and `id-token: write`.

```yaml
tags: |
  ghcr.io/lirantal/boxdown:${{ steps.release-state.outputs.version }}
  ghcr.io/lirantal/boxdown:1
  ghcr.io/lirantal/boxdown:latest
labels: |
  org.opencontainers.image.source=https://github.com/lirantal/boxdown
  org.opencontainers.image.revision=${{ github.sha }}
  org.opencontainers.image.version=${{ steps.release-state.outputs.version }}
provenance: mode=max
sbom: true
```

Run `check-image-release.ts` before push. It must not overwrite a mismatched version tag; for an identical retry it verifies/reuses the image. Validate manifest/size, attest with the build digest, and only then publish npm.

- [ ] **Step 5: Verify and commit**

Run: `node --import tsx --test __tests__/image-input-policy.test.ts && pnpm lint && git diff --check`

Expected: PASS.

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml scripts/check-image-release.ts scripts/verify-image-manifest.ts __tests__/image-input-policy.test.ts
git commit -m "ci: publish Boxdown image before npm release"
```

### Task 7: Document the image and verify end-to-end publication

**Files:**

- Modify: `README.md`
- Modify: `assets/devcontainer/README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/features/start-and-shell.md`
- Modify: `docs/features/setup.md`

- [ ] **Step 1: Update user documentation**

State that new containers pull public `ghcr.io/lirantal/boxdown:<Boxdown-version>` rather than build Features locally; first uncached use needs network access but no GHCR login; default and lazy tool lists; credentials/workspaces never enter the image; Codex/Claude retain throttled refresh; Snyk/1Password and AMD64 APM advance through a Boxdown release plus recreation; APM is deferred on ARM64 until explicit Python opt-in; legacy workspaces switch only through `boxdown start --recreate` or `boxdown setup --recreate`. Remove claims that Features or shared tools run from post-create.

- [ ] **Step 2: Run repository verification**

```bash
pnpm test
pnpm lint
pnpm build
bash -n assets/image/install-native-tools.sh assets/image/smoke-test.sh assets/devcontainer/hooks/post-create.sh assets/devcontainer/hooks/post-start.sh assets/devcontainer/utils/coding-agent-cli-update.sh
node --import tsx --test __tests__/image-input-policy.test.ts __tests__/devcontainer-image-policy.test.ts
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Smoke a maintainer-controlled prerelease**

```bash
docker logout ghcr.io
docker pull ghcr.io/lirantal/boxdown:1.4.0-rc.0
docker buildx imagetools inspect ghcr.io/lirantal/boxdown:1.4.0-rc.0
docker run --rm --user node --entrypoint bash ghcr.io/lirantal/boxdown:1.4.0-rc.0 /opt/boxdown/image-tools/smoke-test.sh
```

Expected: anonymous pull succeeds, the manifest lists AMD64/ARM64, and smoke exits 0. Set GHCR package visibility to Public once if required.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md assets/devcontainer/README.md docs/architecture.md docs/features/start-and-shell.md docs/features/setup.md
git commit -m "docs: explain published Boxdown devcontainer image"
```

## Final Review Checklist

- [ ] New containers contain no Feature/local build input and pull only their exact package-version tag.
- [ ] CI cannot push from PRs and cannot publish npm before image, dual-platform manifest, size, and attestation checks pass.
- [ ] The image is non-root and contains neither secrets/workspaces nor Python, uv, OpenCode, or Antigravity; APM is present only on AMD64.
- [ ] Codex/Claude refreshes work for new npm-backed images and legacy standalone containers.
- [ ] Migration is one-time, informative, and non-destructive.
- [ ] An anonymous public GHCR pull is manually verified before the first stable release.
