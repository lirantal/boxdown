# Devcontainer Node Image Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin Boxdown's packaged Node 24 devcontainer image to its verified multi-platform index digest and configure Renovate to refresh that digest through monthly pull requests.

**Architecture:** Keep the existing `node:24-trixie-slim` update track but append the immutable OCI index digest resolved from Docker Hub. Add a narrowly scoped Renovate configuration that enables only the devcontainer manager, covers Boxdown's nonstandard packaged-template path, disables Feature updates, and permits only the Node image digest rule.

**Tech Stack:** Dev Container JSONC, Renovate JSON, Node.js built-in test runner, TypeScript, Docker Buildx registry inspection, Markdown.

## Global Constraints

- The image tag remains exactly `node:24-trixie-slim`.
- The pinned digest is the multi-platform OCI index digest `sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573` resolved on 2026-07-18.
- Renovate manages only the packaged devcontainer and does not overlap with Dependabot's npm or GitHub Actions responsibilities.
- Dev Container Feature updates remain disabled in Renovate.
- Node image digest updates are eligible only on the first day of each month before 04:00 UTC.
- The Renovate GitHub app is an external operational prerequisite; no repository token or scheduled workflow is added.

---

### Task 1: Enforce and Pin the Multi-Platform Node Image

**Files:**

- Create: `__tests__/devcontainer-image-policy.test.ts`
- Modify: `assets/devcontainer/devcontainer.json:3`

**Interfaces:**

- Consumes: `parseJsonc<T>(input: string): T` from `src/jsonc.ts`.
- Produces: a static repository invariant requiring the exact Node 24 trixie slim tag plus a 64-hex-character SHA-256 digest.

- [ ] **Step 1: Write the failing image-policy test**

```ts
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { parseJsonc } from '../src/jsonc.ts'

const devcontainerPath = fileURLToPath(new URL('../assets/devcontainer/devcontainer.json', import.meta.url))

test('pins the packaged Node 24 devcontainer image to a SHA-256 digest', () => {
  const devcontainer = parseJsonc<{ image: string }>(readFileSync(devcontainerPath, 'utf8'))

  assert.match(devcontainer.image, /^node:24-trixie-slim@sha256:[a-f0-9]{64}$/)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test __tests__/devcontainer-image-policy.test.ts
```

Expected: FAIL because `node:24-trixie-slim` does not include `@sha256:` and a digest.

- [ ] **Step 3: Pin the verified OCI index digest**

Change the image property in `assets/devcontainer/devcontainer.json` to:

```jsonc
"image": "node:24-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573",
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test __tests__/devcontainer-image-policy.test.ts
```

Expected: PASS with 1 test and 0 failures.

- [ ] **Step 5: Reinspect the registry reference**

Run:

```bash
docker buildx imagetools inspect node:24-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573
```

Expected: `MediaType: application/vnd.oci.image.index.v1+json`, the same top-level digest, and platform manifests including `linux/amd64` and `linux/arm64/v8`.

- [ ] **Step 6: Commit the image pin**

```bash
git add __tests__/devcontainer-image-policy.test.ts assets/devcontainer/devcontainer.json
git commit -m "chore: pin devcontainer Node image digest"
```

### Task 2: Scope Renovate to Monthly Node Image Digest Updates

**Files:**

- Modify: `__tests__/devcontainer-image-policy.test.ts`
- Create: `renovate.json`

**Interfaces:**

- Consumes: the `devcontainer` manager's `image` and `feature` dependency types and the packaged template path from Task 1.
- Produces: Renovate configuration restricted to the Node image digest rule, with Feature management disabled and a monthly UTC schedule.

- [ ] **Step 1: Add the failing Renovate-policy test**

Append the following declarations and test to `__tests__/devcontainer-image-policy.test.ts`, adding `existsSync` to the existing `node:fs` import:

```ts
const renovatePath = fileURLToPath(new URL('../renovate.json', import.meta.url))

interface RenovatePackageRule {
  description?: string
  matchManagers?: string[]
  matchDepTypes?: string[]
  matchPackageNames?: string[]
  matchFileNames?: string[]
  pinDigests?: boolean
  schedule?: string[]
  enabled?: boolean
}

interface RenovateConfig {
  enabledManagers?: string[]
  devcontainer?: {
    managerFilePatterns?: string[]
  }
  packageRules?: RenovatePackageRule[]
}

test('scopes Renovate to monthly packaged Node image digest updates', () => {
  assert.equal(existsSync(renovatePath), true, 'renovate.json must exist')

  const renovate = JSON.parse(readFileSync(renovatePath, 'utf8')) as RenovateConfig
  assert.deepEqual(renovate.enabledManagers, ['devcontainer'])
  assert.deepEqual(renovate.devcontainer?.managerFilePatterns, [
    '/^assets\\/devcontainer\\/devcontainer\\.json$/'
  ])

  const featureRule = renovate.packageRules?.find(rule => rule.matchDepTypes?.includes('feature'))
  assert.deepEqual(featureRule?.matchManagers, ['devcontainer'])
  assert.equal(featureRule?.enabled, false)

  const imageRule = renovate.packageRules?.find(rule => rule.matchDepTypes?.includes('image'))
  assert.deepEqual(imageRule?.matchManagers, ['devcontainer'])
  assert.deepEqual(imageRule?.matchPackageNames, ['node'])
  assert.deepEqual(imageRule?.matchFileNames, ['assets/devcontainer/devcontainer.json'])
  assert.equal(imageRule?.pinDigests, true)
  assert.deepEqual(imageRule?.schedule, ['* 0-3 1 * *'])
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test __tests__/devcontainer-image-policy.test.ts
```

Expected: the image-policy test passes and the Renovate-policy test fails with `renovate.json must exist`.

- [ ] **Step 3: Add the scoped Renovate configuration**

Create `renovate.json` with:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "enabledManagers": [
    "devcontainer"
  ],
  "devcontainer": {
    "managerFilePatterns": [
      "/^assets\\/devcontainer\\/devcontainer\\.json$/"
    ]
  },
  "packageRules": [
    {
      "description": "Keep digest-pinned Dev Container Features outside Renovate",
      "matchManagers": [
        "devcontainer"
      ],
      "matchDepTypes": [
        "feature"
      ],
      "enabled": false
    },
    {
      "description": "Refresh the Boxdown Node 24 devcontainer image digest monthly",
      "matchManagers": [
        "devcontainer"
      ],
      "matchDepTypes": [
        "image"
      ],
      "matchPackageNames": [
        "node"
      ],
      "matchFileNames": [
        "assets/devcontainer/devcontainer.json"
      ],
      "pinDigests": true,
      "schedule": [
        "* 0-3 1 * *"
      ]
    }
  ]
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test __tests__/devcontainer-image-policy.test.ts
```

Expected: PASS with 2 tests and 0 failures.

- [ ] **Step 5: Validate the Renovate JSON and schema URL**

Run:

```bash
node -e "const fs=require('node:fs'); const config=JSON.parse(fs.readFileSync('renovate.json','utf8')); if (config['$schema'] !== 'https://docs.renovatebot.com/renovate-schema.json') process.exit(1)"
```

Expected: exit 0 with no output.

- [ ] **Step 6: Commit the automation policy**

```bash
git add __tests__/devcontainer-image-policy.test.ts renovate.json
git commit -m "chore: automate devcontainer image digest updates"
```

### Task 3: Document Reproducibility and Verify the Complete Change

**Files:**

- Modify: `assets/devcontainer/README.md:25-45`

**Interfaces:**

- Consumes: the pinned index digest and Renovate scope delivered by Tasks 1 and 2.
- Produces: contributor-facing explanation of the immutable cross-platform image reference and automated PR update path.

- [ ] **Step 1: Update the Base image documentation**

Replace the first paragraph under `## Base image` with:

```markdown
Boxdown uses `node:24-trixie-slim` as the base-image update track to keep the
shared image smaller than the full Dev Containers TypeScript/Node image. The
template appends the upstream multi-platform OCI index digest, making rebuilds
immutable while allowing AMD64 and ARM64 hosts to select the matching platform
manifest from the same pinned release set. Renovate checks the packaged
template monthly and opens a pull request when that tag's index digest changes,
so base-image updates remain explicit and auditable.

The devcontainer then installs the required operating-system tools through
pinned Dev Container features. `common-utils` and `git` run first so later
features and lifecycle hooks can rely on shell basics, `sudo`, package
metadata, Git, and related utilities.
```

- [ ] **Step 2: Run focused policy and documentation checks**

Run:

```bash
node --test __tests__/devcontainer-image-policy.test.ts
./node_modules/.bin/markdownlint -c .github/.markdownlint.yml assets/devcontainer/README.md docs/superpowers/plans/2026-07-18-devcontainer-node-image-digest.md
git diff --check
```

Expected: 2 tests pass, Markdown lint exits 0, and `git diff --check` exits 0.

- [ ] **Step 3: Run the full test suite outside the socket-restricted sandbox**

Run:

```bash
node --test __tests__/**/*.test.ts
```

Expected: 203 tests pass with 0 failures. This uses Node's built-in TypeScript support because the host Node 26 runtime is incompatible with the installed `c8`/`tsx` execution path; the test contents are unchanged.

- [ ] **Step 4: Run lint and build using installed binaries**

Run:

```bash
./node_modules/.bin/eslint .
./node_modules/.bin/markdownlint -c .github/.markdownlint.yml -i 'apm_modules/**' -i '.git' -i '__tests__' -i '.github' -i '.changeset' -i 'CODE_OF_CONDUCT.md' -i 'CHANGELOG.md' -i 'node_modules' -i 'dist' '**/**.md'
./node_modules/.bin/tsc
./node_modules/.bin/tsdown
```

Expected: every command exits 0. `tsdown` reports successful ESM and CJS builds.

- [ ] **Step 5: Reverify the pinned registry object and final diff**

Run:

```bash
docker buildx imagetools inspect node:24-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573
git diff --check
git status --short
```

Expected: the registry object is an OCI image index with AMD64 and ARM64 manifests, whitespace validation exits 0, and status lists only the planned documentation change before its commit.

- [ ] **Step 6: Commit the documentation**

```bash
git add assets/devcontainer/README.md
git commit -m "docs: explain devcontainer image digest updates"
```

- [ ] **Step 7: Confirm branch state**

Run:

```bash
git status --short --branch
git log --oneline --decorate -4
```

Expected: a clean `work/devcontainer-node-digest` branch with the implementation-plan commit followed by the three implementation commits.
