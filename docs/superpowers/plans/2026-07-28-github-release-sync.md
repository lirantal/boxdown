# GitHub Release Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize each published Boxdown npm version with an annotated Git tag and GitHub Release without weakening image-before-npm ordering.

**Architecture:** Changesets continues to create version PRs and publish npm, but it no longer creates a local tag. A focused TypeScript helper owns the release tag, changelog extraction, and GitHub Release creation. The release workflow tracks npm and GitHub Release state separately so later main-branch runs repair an incomplete release.

**Tech Stack:** GitHub Actions YAML, Node.js 24, TypeScript, Node test runner, Changesets, Git, GitHub CLI.

## Review adjustment

The initial plan proposed a workflow output for GitHub Release existence. Code
review identified that this would skip validation of an already-present but
mismatched tag. The final helper therefore runs on every successful workflow
run and owns release existence checks, tag-target validation, and missing
release repair. This adjustment supersedes the preliminary `releaseAction`
and conditional-step examples below.

## Global Constraints

- Preserve image publish, verification, attestation, and moving-tag updates before npm publication.
- Target release tags at `steps.release-state.outputs.release_revision`, never `github.sha`.
- Create annotated `v<exact-version>` tags and use the matching `CHANGELOG.md` section as the release body.
- Reject any existing remote tag that resolves to another commit.
- Treat npm publishing and GitHub Release creation as independently retryable.
- Accept only the package `boxdown` and exact SemVer values accepted by `validateReleaseIdentity`.

---

## File structure

- Create `scripts/create-github-release.ts`: release-state primitives plus the Git/GitHub CLI adapter.
- Create `__tests__/github-release.test.ts`: unit tests for release notes, retry decisions, and remote-tag parsing.
- Modify `__tests__/image-input-policy.test.ts`: workflow order and identity assertions.
- Modify `.github/workflows/release.yml`: independently check GitHub Release state, disable Changesets tags, and invoke the final helper.
- Modify `RELEASE.md`: document automated release creation and recovery.

### Task 1: Test and implement the GitHub Release helper

**Files:**

- Create: `scripts/create-github-release.ts`
- Create: `__tests__/github-release.test.ts`

**Interfaces:**

- Produces `releaseNotesForVersion(changelog: string, version: string): string`.
- Produces `releaseAction(npmPublished: boolean, githubReleaseExists: boolean): 'create' | 'skip'`.
- Produces `remoteAnnotatedTagTarget(lsRemoteOutput: string, tag: string): string | undefined`.
- Produces `ensureGitHubRelease(options: ReleaseOptions, command?: Command): void`.
- Consumes `validateReleaseIdentity` from `scripts/check-image-release.ts`.

- [ ] **Step 1: Write the failing helper test**

Create `__tests__/github-release.test.ts`:

```ts
import assert from 'node:assert'
import {test} from 'node:test'

import {
  releaseAction,
  releaseNotesForVersion,
  remoteAnnotatedTagTarget
} from '../scripts/create-github-release.ts'

const changelog = `# boxdown

## 2.1.0

### Minor Changes

- New release behavior.

## 2.0.0

### Major Changes

- Previous release behavior.
`

test('extracts only the requested changelog entry', () => {
  assert.equal(releaseNotesForVersion(changelog, '2.1.0'), '### Minor Changes\n\n- New release behavior.')
})

test('rejects a missing changelog entry', () => {
  assert.throws(() => releaseNotesForVersion(changelog, '9.9.9'), /could not find changelog entry/)
})

test('creates a release after publishing or when GitHub is missing it', () => {
  assert.equal(releaseAction(true, true), 'create')
  assert.equal(releaseAction(false, false), 'create')
})

test('skips an existing synchronized GitHub Release', () => {
  assert.equal(releaseAction(false, true), 'skip')
})

test('uses the peeled object for an annotated tag', () => {
  const output = ['tag-object\trefs/tags/v2.1.0', 'release-commit\trefs/tags/v2.1.0^{}'].join('\n')
  assert.equal(remoteAnnotatedTagTarget(output, 'v2.1.0'), 'release-commit')
})

test('rejects a lightweight tag', () => {
  assert.throws(() => remoteAnnotatedTagTarget('commit\trefs/tags/v2.1.0', 'v2.1.0'), /annotated tag/)
})
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node --import tsx --test __tests__/github-release.test.ts`

Expected: FAIL because `scripts/create-github-release.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure functions**

Start `scripts/create-github-release.ts` with:

```ts
export type Command = (program: string, arguments_: string[], input?: string) => string

export function releaseAction(npmPublished: boolean, githubReleaseExists: boolean): 'create' | 'skip' {
  return npmPublished || !githubReleaseExists ? 'create' : 'skip'
}

export function releaseNotesForVersion(changelog: string, version: string): string {
  const heading = `## ${version}`
  const start = changelog.indexOf(`${heading}\n`)
  if (start === -1) throw new Error(`could not find changelog entry for ${version}`)
  const contentStart = start + heading.length
  const nextHeading = changelog.indexOf('\n## ', contentStart)
  return changelog.slice(contentStart, nextHeading === -1 ? undefined : nextHeading).trim()
}

export function remoteAnnotatedTagTarget(lsRemoteOutput: string, tag: string): string | undefined {
  if (lsRemoteOutput.trim() === '') return undefined
  const peeledReference = `refs/tags/${tag}^{}`
  const peeledLine = lsRemoteOutput.split('\n').find(line => line.endsWith(`\t${peeledReference}`))
  if (peeledLine === undefined) throw new Error(`existing ${tag} must be an annotated tag`)
  return peeledLine.split('\t')[0]
}
```

Then add `ReleaseOptions` and `ensureGitHubRelease`. It must validate the identity, run `git ls-remote --tags origin refs/tags/<tag> refs/tags/<tag>^{}`, create and push `git tag --annotate <tag> <releaseRevision> --message <tag>` only when absent, reject a different existing target, and run:

```ts
command('gh', [
  'release', 'create', tag,
  '--repo', options.repository,
  '--verify-tag',
  '--title', tag,
  '--notes-file', '-'
], releaseNotes)
```

Read `RELEASE_PACKAGE_NAME`, `RELEASE_VERSION`, `RELEASE_REVISION`, `RELEASE_REPOSITORY`, and `GH_TOKEN` in `main()`; reject a missing variable before executing commands.

- [ ] **Step 4: Run the helper test to verify GREEN**

Run: `node --import tsx --test __tests__/github-release.test.ts`

Expected: all helper tests PASS.

- [ ] **Step 5: Commit the helper and its tests**

```sh
git add scripts/create-github-release.ts __tests__/github-release.test.ts
git commit -m "fix: synchronize GitHub releases with npm"
```

### Task 2: Wire ordered and retry-safe release creation into the workflow

**Files:**

- Modify: `.github/workflows/release.yml:36-81`
- Modify: `.github/workflows/release.yml:273-282`
- Modify: `__tests__/image-input-policy.test.ts:357-416`

**Interfaces:**

- Consumes `publish` and `github_release_exists` from `release-state`.
- Consumes the helper CLI entrypoint `node --import tsx scripts/create-github-release.ts`.
- Produces a final GitHub Release phase that can repair a release after npm is already published.

- [ ] **Step 1: Write the failing workflow-policy test**

Append this test to `__tests__/image-input-policy.test.ts`:

```ts
test('creates the GitHub Release after npm publication at the release revision', () => {
  const workflow = readFileSync(releaseWorkflowPath, 'utf8')
  const publishNpm = workflow.indexOf('- name: Publish to npm')
  const createRelease = workflow.indexOf('- name: Create GitHub Release')

  assert.equal(publishNpm >= 0 && createRelease > publishNpm, true)

  const releaseStep = workflow.slice(createRelease)
  assert.match(releaseStep, /RELEASE_REVISION: \$\{\{ steps\.release-state\.outputs\.release_revision \}\}/)
  assert.match(releaseStep, /RELEASE_REPOSITORY: \$\{\{ github\.repository \}\}/)
  assert.match(releaseStep, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/)
  assert.match(releaseStep, /scripts\/create-github-release\.ts/)
  assert.match(workflow, /pnpm exec changeset publish --no-git-tag/)
})
```

- [ ] **Step 2: Run the policy test to verify RED**

Run: `node --import tsx --test __tests__/image-input-policy.test.ts`

Expected: FAIL because the GitHub Release step and `--no-git-tag` are absent.

- [ ] **Step 3: Implement the workflow wiring**

In `Check release state`, query `gh release view "v${version}" --repo "${GITHUB_REPOSITORY}"`. Write `github_release_exists=true` when it succeeds, `github_release_exists=false` only for GitHub’s missing-release exit code, and otherwise fail.

Replace npm publication with:

```yaml
- name: Publish to npm
  if: steps.release-state.outputs.publish == 'true'
  run: pnpm exec changeset publish --no-git-tag
  env:
    NPM_CONFIG_PROVENANCE: true
    NPM_CONFIG_FORCE: true
    NPM_TOKEN: ''
```

Append after it:

```yaml
- name: Create GitHub Release
  if: >-
    steps.release-state.outputs.publish == 'true' ||
    steps.release-state.outputs.github_release_exists == 'false'
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    RELEASE_PACKAGE_NAME: ${{ steps.release-state.outputs.package_name }}
    RELEASE_VERSION: ${{ steps.release-state.outputs.version }}
    RELEASE_REVISION: ${{ steps.release-state.outputs.release_revision }}
    RELEASE_REPOSITORY: ${{ github.repository }}
  run: node --import tsx scripts/create-github-release.ts
```

Keep `contents: write`; update its comment to identify explicit tag and GitHub Release creation. Do not move any existing image or npm step.

- [ ] **Step 4: Run the policy test to verify GREEN**

Run: `node --import tsx --test __tests__/image-input-policy.test.ts`

Expected: all policy tests PASS.

- [ ] **Step 5: Commit the workflow integration**

```sh
git add .github/workflows/release.yml __tests__/image-input-policy.test.ts
git commit -m "fix: create releases after npm publication"
```

### Task 3: Document automation and perform complete verification

**Files:**

- Modify: `RELEASE.md:84-96`

**Interfaces:**

- Documents the behavior delivered in Tasks 1 and 2.
- Produces a safe maintainer recovery path: rerun the workflow instead of republishing npm.

- [ ] **Step 1: Replace manual publishing documentation**

Replace the current `Version and publish` section with:

```md
## Automated publishing

Merging the Changesets version pull request to `main` starts the release
workflow. It publishes and verifies the release-matched image, publishes the
npm package, then creates the matching annotated Git tag and GitHub Release
from the version's `CHANGELOG.md` entry.

If npm publication succeeds but GitHub Release creation fails, re-run the
release workflow from GitHub Actions. It detects the published npm version and
repairs only the missing GitHub Release; it never republishes that npm version.
```

- [ ] **Step 2: Run focused tests, the full suite, and build**

Run:

```sh
node --import tsx --test __tests__/github-release.test.ts __tests__/image-input-policy.test.ts
pnpm test
pnpm run build
```

Expected: every command exits with status 0.

- [ ] **Step 3: Inspect the final tree**

Run:

```sh
git diff --check
git status --short
```

Expected: no whitespace errors and only `RELEASE.md` unstaged before the documentation commit.

- [ ] **Step 4: Commit the documentation**

```sh
git add RELEASE.md
git commit -m "docs: explain automated release synchronization"
```

- [ ] **Step 5: Re-run final verification**

Run:

```sh
pnpm test
pnpm run build
git status --short --branch
```

Expected: test and build commands exit with status 0 and the worktree is clean.

## Backfill runbook

After merging the repair, run the helper in a trusted clone with a `GH_TOKEN` authorized for `contents:write`. This creates releases but never republishes npm:

```sh
RELEASE_PACKAGE_NAME=boxdown RELEASE_VERSION=2.0.0 \
RELEASE_REVISION=29363c0b778cede34d0fa2ed591ddb3e7bed3cb5 \
RELEASE_REPOSITORY=lirantal/boxdown GH_TOKEN="$GH_TOKEN" \
node --import tsx scripts/create-github-release.ts

RELEASE_PACKAGE_NAME=boxdown RELEASE_VERSION=2.1.0 \
RELEASE_REVISION=cc8a7ea3998066e1f4f7327e998220f68721163f \
RELEASE_REPOSITORY=lirantal/boxdown GH_TOKEN="$GH_TOKEN" \
node --import tsx scripts/create-github-release.ts
```

The helper must skip a matching existing release and fail rather than retarget a mismatched annotated tag.
