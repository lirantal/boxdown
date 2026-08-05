# Shared-Image Purge and Docker Mount Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make purge remove an exact Docker image only when unused, retain shared images successfully, and make setup recover once from Docker Desktop's stale view of recreated Boxdown mount paths.

**Architecture:** Add typed Docker image-consumer and conditional-removal primitives in `src/devcontainer.ts`, then make `src/purge.ts` use those primitives for both preview and execution. Separately, refactor the doctor mount probe in `src/doctor.ts` into a classified helper that can refresh one stable Boxdown parent and retry the exact managed child once.

**Tech Stack:** TypeScript, Node.js 24, Docker CLI, Node's built-in test runner, pnpm, ESLint, markdownlint, Changesets.

## Global Constraints

- Remove an exact image only when no running or stopped container references that exact image ID.
- Never run `docker image rm --force` or `docker image rm -f`.
- Treat a known shared-image retention outcome as purge success.
- Treat inability to establish image usage, and unrelated Docker removal failures, as purge failures.
- Skip image removal when target-container removal fails.
- Recover only when the host child exists and Docker output contains `bind source path does not exist`.
- Refresh only through `<data-root>/workspaces` or `<runtime-root>/workspaces`, then retry the exact child once.
- Do not retry permission, file-sharing, mount-denial, or arbitrary Docker failures.
- Probe containers must use `/bin/true`, must never be started, and must be removed after successful creation.
- Preserve existing purge continuation behavior for independent app-integration and state cleanup.
- Use Node.js `>=24.0.0` and add no dependencies.

## File Structure

- Modify `src/devcontainer.ts`: exact image-consumer discovery, conditional image-removal result types, and Docker command injection for focused tests.
- Modify `src/purge.ts`: conditional preview entries, shared-image output, and image-removal gating after container cleanup.
- Modify `src/doctor.ts`: classified disposable mount probe and one-time stable-parent refresh.
- Modify `src/main.ts`: concise purge help describing unused-image removal.
- Modify `__tests__/app.test.ts`: primitive, CLI, preview, and doctor regressions; extend fake Docker for ancestor-image queries and the new inspect format.
- Modify `docs/features/lifecycle.md`: authoritative purge and doctor behavior.
- Modify `docs/features/generated-config-and-state.md`: conditional use of recorded image metadata.
- Create `.changeset/safe-images-refresh.md`: patch release note for both fixes.

---

### Task 1: Add Exact Image-Consumer Discovery and Conditional Removal

**Files:**

- Modify: `src/devcontainer.ts:170-212,286-308`
- Modify: `__tests__/app.test.ts:1-35` and add focused tests near the existing Docker image-policy tests

**Interfaces:**

- Consumes: `runBuffered(command, args, options): Promise<CommandResult>` from `src/process.ts`; `WorkspaceCommandLogger` from `src/logging.ts`.
- Produces:

```ts
export interface DockerImageConsumer {
  id: string
  name: string
}

export type DockerImageRemovalResult =
  | { status: 'removed' }
  | { status: 'absent' }
  | { status: 'retained-in-use', consumers: DockerImageConsumer[] }

export type DockerCommandRunner = (
  args: string[],
  logger?: WorkspaceCommandLogger
) => Promise<CommandResult>

export async function findDockerImageConsumers (
  imageId: string,
  options?: {
    excludeContainerIds?: readonly string[]
    logger?: WorkspaceCommandLogger
    runCommand?: DockerCommandRunner
  }
): Promise<DockerImageConsumer[]>

export async function removeDockerImageIfUnused (
  imageId: string,
  options?: {
    excludeContainerIds?: readonly string[]
    logger?: WorkspaceCommandLogger
    runCommand?: DockerCommandRunner
  }
): Promise<DockerImageRemovalResult>
```

- Supersedes: `removeDockerImage(imageId, options): Promise<boolean>`. Keep a
  temporary non-forcing compatibility wrapper through Task 1 so
  `src/purge.ts` still imports successfully; Task 2 updates the consumer and
  removes the wrapper.

- [ ] **Step 1: Write failing tests for exact consumer filtering**

Update the `src/devcontainer.ts` import in `__tests__/app.test.ts` to include `findDockerImageConsumers`, `removeDockerImageIfUnused`, and `type DockerCommandRunner`. Add this focused helper and test:

```ts
function sequenceDockerRunner (
  results: Array<{ code: number, stdout: string, stderr: string }>,
  calls: string[][]
): DockerCommandRunner {
  return async (args) => {
    calls.push(args)
    const result = results.shift()
    assert.ok(result !== undefined, `Unexpected Docker call: ${args.join(' ')}`)
    return result
  }
}

test('finds only containers using the exact Docker image ID', async () => {
  const calls: string[][] = []
  const runCommand = sequenceDockerRunner([
    { code: 0, stdout: 'exact-container\ndescendant-container\n', stderr: '' },
    {
      code: 0,
      stdout: '"exact-container"|"/exact-name"|"sha256:shared"\n',
      stderr: ''
    },
    {
      code: 0,
      stdout: '"descendant-container"|"/descendant-name"|"sha256:child"\n',
      stderr: ''
    }
  ], calls)

  assert.deepStrictEqual(await findDockerImageConsumers('sha256:shared', {
    excludeContainerIds: ['excluded-container'],
    runCommand
  }), [
    { id: 'exact-container', name: 'exact-name' }
  ])
  assert.deepStrictEqual(calls[0], [
    'ps', '-aq', '--filter', 'ancestor=sha256:shared'
  ])
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern='finds only containers using the exact Docker image ID' __tests__/app.test.ts
```

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement the exact consumer query**

Import `type CommandResult` from `src/process.ts`. Add the types above and use this production runner:

```ts
const runDockerCommand: DockerCommandRunner = async (args, logger) => {
  return await runBuffered('docker', args, {
    logger,
    mirrorStdout: false,
    mirrorStderr: false
  })
}
```

Implement strict candidate inspection and exact image comparison:

```ts
function parseDockerImageConsumer (
  output: string,
  containerId: string
): DockerImageConsumer & { imageId: string } {
  const [rawId, rawName, rawImageId] = output.trim().split('|')

  try {
    const id: unknown = JSON.parse(rawId ?? '')
    const name: unknown = JSON.parse(rawName ?? '')
    const imageId: unknown = JSON.parse(rawImageId ?? '')

    if (
      typeof id !== 'string' || id.length === 0 ||
      typeof name !== 'string' || name.length === 0 ||
      typeof imageId !== 'string' || imageId.length === 0
    ) {
      throw new Error('Docker inspect fields were incomplete')
    }

    return {
      id,
      name: name.replace(/^\//, ''),
      imageId
    }
  } catch (error) {
    throw new Error(`Could not parse Docker image usage for container ${containerId}`, { cause: error })
  }
}

export async function findDockerImageConsumers (
  imageId: string,
  options: {
    excludeContainerIds?: readonly string[]
    logger?: WorkspaceCommandLogger
    runCommand?: DockerCommandRunner
  } = {}
): Promise<DockerImageConsumer[]> {
  const runCommand = options.runCommand ?? runDockerCommand
  const candidates = await runCommand([
    'ps', '-aq', '--filter', `ancestor=${imageId}`
  ], options.logger)

  if (candidates.code !== 0) {
    throw new Error(`Could not find Docker containers using image ${imageId}`)
  }

  const excluded = new Set(options.excludeContainerIds ?? [])
  const consumers: DockerImageConsumer[] = []

  for (const containerId of candidates.stdout.split(/\r?\n/).filter(Boolean)) {
    if (excluded.has(containerId)) continue

    const inspected = await runCommand([
      'inspect',
      '--format',
      '{{json .Id}}|{{json .Name}}|{{json .Image}}',
      containerId
    ], options.logger)

    if (inspected.code !== 0) {
      throw new Error(`Could not inspect Docker image usage for container ${containerId}`)
    }

    const candidate = parseDockerImageConsumer(inspected.stdout, containerId)
    if (candidate.imageId === imageId) {
      consumers.push({ id: candidate.id, name: candidate.name })
    }
  }

  return consumers
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run the command from Step 2.

Expected: PASS; the logged first call is the all-container ancestor query and the descendant-image candidate is excluded.

- [ ] **Step 5: Write failing tests for removed, absent, retained, race, and discovery-failure outcomes**

Add tests using `sequenceDockerRunner`:

```ts
test('removes an unused Docker image without force', async () => {
  const calls: string[][] = []
  const result = await removeDockerImageIfUnused('sha256:unused', {
    runCommand: sequenceDockerRunner([
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: 'Deleted: sha256:unused\n', stderr: '' }
    ], calls)
  })

  assert.deepStrictEqual(result, { status: 'removed' })
  assert.deepStrictEqual(calls[1], ['image', 'rm', 'sha256:unused'])
})

test('retains a Docker image already used by another container', async () => {
  const calls: string[][] = []
  const result = await removeDockerImageIfUnused('sha256:shared', {
    runCommand: sequenceDockerRunner([
      { code: 0, stdout: 'consumer-1\n', stderr: '' },
      { code: 0, stdout: '"consumer-1"|"/peer"|"sha256:shared"\n', stderr: '' }
    ], calls)
  })

  assert.deepStrictEqual(result, {
    status: 'retained-in-use',
    consumers: [{ id: 'consumer-1', name: 'peer' }]
  })
  assert.strictEqual(calls.some(args => args[0] === 'image'), false)
})

test('classifies a race-time image consumer after removal fails', async () => {
  const calls: string[][] = []
  const result = await removeDockerImageIfUnused('sha256:raced', {
    runCommand: sequenceDockerRunner([
      { code: 0, stdout: '', stderr: '' },
      { code: 1, stdout: '', stderr: 'conflict' },
      { code: 0, stdout: 'late-container\n', stderr: '' },
      { code: 0, stdout: '"late-container"|"/late-peer"|"sha256:raced"\n', stderr: '' }
    ], calls)
  })

  assert.deepStrictEqual(result, {
    status: 'retained-in-use',
    consumers: [{ id: 'late-container', name: 'late-peer' }]
  })
})

test('does not attempt image removal when usage discovery fails', async () => {
  const calls: string[][] = []
  await assert.rejects(
    removeDockerImageIfUnused('sha256:unknown', {
      runCommand: sequenceDockerRunner([
        { code: 1, stdout: '', stderr: 'daemon error' }
      ], calls)
    }),
    /Could not find Docker containers using image sha256:unknown/
  )
  assert.strictEqual(calls.some(args => args[0] === 'image'), false)
})
```

Add the idempotent-absence and unrelated-failure cases explicitly:

```ts
test('treats an already absent unused Docker image as success', async () => {
  const calls: string[][] = []
  const result = await removeDockerImageIfUnused('sha256:absent', {
    runCommand: sequenceDockerRunner([
      { code: 0, stdout: '', stderr: '' },
      { code: 1, stdout: '', stderr: 'Error: No such image: sha256:absent' }
    ], calls)
  })

  assert.deepStrictEqual(result, { status: 'absent' })
})

test('fails an unrelated Docker image-removal error with no consumers', async () => {
  const calls: string[][] = []
  await assert.rejects(
    removeDockerImageIfUnused('sha256:broken', {
      runCommand: sequenceDockerRunner([
        { code: 0, stdout: '', stderr: '' },
        { code: 1, stdout: '', stderr: 'unexpected daemon failure' },
        { code: 0, stdout: '', stderr: '' }
      ], calls)
    }),
    /Could not remove Docker image sha256:broken/
  )
})
```

- [ ] **Step 6: Run the new outcome tests and verify they fail**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern='Docker image|image consumer|image removal' __tests__/app.test.ts
```

Expected: FAIL because `removeDockerImageIfUnused` is not implemented.

- [ ] **Step 7: Implement conditional image removal**

Add the conditional operation:

```ts
export async function removeDockerImageIfUnused (
  imageId: string,
  options: {
    excludeContainerIds?: readonly string[]
    logger?: WorkspaceCommandLogger
    runCommand?: DockerCommandRunner
  } = {}
): Promise<DockerImageRemovalResult> {
  const runCommand = options.runCommand ?? runDockerCommand
  const consumerOptions = { ...options, runCommand }
  const consumers = await findDockerImageConsumers(imageId, consumerOptions)

  if (consumers.length > 0) {
    return { status: 'retained-in-use', consumers }
  }

  const result = await runCommand(['image', 'rm', imageId], options.logger)
  if (result.code === 0) return { status: 'removed' }
  if (dockerImageMissing(result.stderr)) return { status: 'absent' }

  const lateConsumers = await findDockerImageConsumers(imageId, consumerOptions)
  if (lateConsumers.length > 0) {
    return { status: 'retained-in-use', consumers: lateConsumers }
  }

  throw new Error(`Could not remove Docker image ${imageId}`)
}
```

Keep `dockerImageMissing` private and do not print from this primitive; Task 2
owns purge output. Replace the old forced implementation with this temporary
compatibility wrapper so the module graph and focused tests remain valid:

```ts
export async function removeDockerImage (
  imageId: string,
  options: { logger?: WorkspaceCommandLogger } = {}
): Promise<boolean> {
  const result = await removeDockerImageIfUnused(imageId, options)
  return result.status === 'removed'
}
```

This wrapper performs no forced removal. Delete it in Task 2 after
`src/purge.ts` imports the typed API.

- [ ] **Step 8: Run focused and existing Docker policy tests**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern='Docker image|image consumer|image removal|published image' __tests__/app.test.ts
```

Expected: PASS for the new primitive tests. Existing purge tests may fail to compile until Task 2 replaces the old import; do not weaken the primitive contract to preserve the old forced-removal API.

- [ ] **Step 9: Commit the primitive**

```bash
git add src/devcontainer.ts __tests__/app.test.ts
git commit -m "fix: make image cleanup usage-aware"
```

---

### Task 2: Integrate Shared-Image Policy into Purge Preview and Execution

**Files:**

- Modify: `src/purge.ts:1-116,203-280`
- Modify: `src/devcontainer.ts:286-360` (remove Task 1 compatibility wrapper)
- Modify: `__tests__/app.test.ts:45-235,4620-5010,5500-5570`

**Interfaces:**

- Consumes: `DockerImageConsumer`, `findDockerImageConsumers`, and `removeDockerImageIfUnused` from Task 1.
- Produces: purge preview strings that classify known shared images as kept and apparently unused images as conditional removals; purge execution messages for `removed`, `absent`, and `retained-in-use`.

- [ ] **Step 1: Extend fake Docker for exact image-consumer discovery**

In the fake Docker `ps` branch, add an `ancestor=` case before workspace-label handling:

```bash
if [[ "$filter" == ancestor=* ]]; then
  if [ "${BOXDOWN_FAKE_DOCKER_ANCESTOR_EXIT_CODE:-0}" != "0" ]; then
    exit "${BOXDOWN_FAKE_DOCKER_ANCESTOR_EXIT_CODE}"
  fi
  image_id="${filter#ancestor=}"
  while IFS="$(printf '\t')" read -r folder id container_state remove_exit_code recorded_image_id image_name inspect_exit_code image_remove_exit_code agent_profile_marker; do
    if [ "$recorded_image_id" = "$image_id" ]; then
      printf '%s\n' "$id"
    fi
  done < "${BOXDOWN_FAKE_DOCKER_STATE}"
  exit 0
fi
```

In the fake `inspect` branch, return the exact usage format when requested:

```bash
if [[ "$*" == *'{{json .Id}}|{{json .Name}}|{{json .Image}}'* ]]; then
  printf '"%s"|"/%s"|"%s"\n' "$container_id" "$container_id" "$image_id"
else
  printf '"%s"|"%s"\n' "$image_id" "$image_name"
fi
```

Change fake and test expectations from `image rm -f <id>` to `image rm <id>`. Keep the fake state static: execution passes the successfully removed target ID in `excludeContainerIds`, while other exact consumers remain visible.

- [ ] **Step 2: Write failing preview tests for conditional removal and known sharing**

Update the existing concrete purge-plan assertion to expect:

```ts
assert.match(
  text,
  /Docker image if still unused during removal: boxdown-plan:latest \(sha256:purge-plan-image\)/
)
```

Add a second workspace with the same image to that fixture and assert the shared case separately:

```ts
assert.match(
  text,
  /Shared Docker image retained: boxdown-plan:latest \(sha256:purge-plan-image\) \(used by: purge-plan-peer\)/
)
assert.doesNotMatch(text, /Docker image if still unused during removal/)
```

Add a preview-discovery failure fixture with
`BOXDOWN_FAKE_DOCKER_ANCESTOR_EXIT_CODE: '42'` in the environment and assert:

```ts
assert.match(
  text,
  /Docker image usage could not be checked; purge will verify before removal/
)
```

- [ ] **Step 3: Run preview tests and verify they fail**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern='purge plan' __tests__/app.test.ts
```

Expected: FAIL because preview still lists the image as an unconditional removal.

- [ ] **Step 4: Implement conditional preview classification**

Import the Task 1 primitives and types. Introduce one formatter:

```ts
function formatDockerImageConsumers (consumers: DockerImageConsumer[]): string {
  return consumers.map(consumer => consumer.name || consumer.id).join(', ')
}
```

Track the live container ID and one `DockerImageInfo` selected from inspection or metadata. Initialize `kept` before Docker discovery:

```ts
const kept = [
  `Your repository and files: ${context.workspaceFolder}`,
  'Your Git history and original host Git configuration',
  'Other Docker containers, images, volumes, and Boxdown workspaces'
]
```

After resolving the image, classify it:

```ts
try {
  const consumers = await findDockerImageConsumers(image.id, {
    excludeContainerIds: liveContainerId === undefined ? [] : [liveContainerId]
  })
  const formatted = formatPurgePlanImage(image.id, image.name)

  if (consumers.length > 0) {
    kept.push(`Shared Docker image retained: ${formatted} (used by: ${formatDockerImageConsumers(consumers)})`)
  } else {
    removals.push(`Docker image if still unused during removal: ${formatted}`)
  }
} catch {
  removals.push(`Docker image usage could not be checked; purge will verify before removal: ${formatPurgePlanImage(image.id, image.name)}`)
}
```

Return the accumulated `kept` array. Do not print the old unconditional `Docker image used by this workspace` or `Recorded Docker image used by this workspace` entries.

- [ ] **Step 5: Run preview tests and verify they pass**

Run the command from Step 3.

Expected: PASS for unused, shared, metadata fallback, and unavailable-usage preview cases.

- [ ] **Step 6: Write failing purge-execution tests**

Add or update CLI tests for these contracts:

```ts
test('purge retains an image shared by another Boxdown workspace', async () => {
  const targetWorkspace = tempDir('purge-shared-target')
  const peerWorkspace = tempDir('purge-shared-peer')
  const env = {
    HOME: tempDir('purge-shared-home'),
    BOXDOWN_CACHE_HOME: tempDir('purge-shared-cache'),
    BOXDOWN_DATA_HOME: tempDir('purge-shared-data'),
    BOXDOWN_RUNTIME_HOME: tempDir('purge-shared-runtime'),
    BOXDOWN_SSH_CONFIG: join(tempDir('purge-shared-ssh'), 'config')
  }
  const context = createWorkspaceContext({
    workspace: targetWorkspace,
    env,
    assetsDevcontainerDir
  })
  writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

  await withFakeDocker([
    {
      workspace: targetWorkspace,
      id: 'target-container',
      imageId: 'sha256:shared',
      imageName: 'boxdown-shared:latest'
    },
    {
      workspace: peerWorkspace,
      id: 'peer-container',
      containerState: 'exited',
      imageId: 'sha256:shared',
      imageName: 'boxdown-shared:latest'
    }
  ], async (logPath, dockerEnv) => {
    const result = runCliProcess(['purge', '--workspace', targetWorkspace], {
      ...dockerEnv,
      ...env
    })
    const calls = fakeDockerCalls(logPath)

    assert.strictEqual(result.code, 0)
    assert.match(result.stdout, /Retained shared Docker image: .*sha256:shared.*used by: peer-container/)
    assert.ok(calls.includes('rm -f -v target-container'))
    assert.strictEqual(calls.some(call => call === 'image rm sha256:shared'), false)
  })
})

test('purge skips image removal when target container removal fails', async () => {
  const workspace = tempDir('purge-container-failure')
  const env = {
    HOME: tempDir('purge-container-failure-home'),
    BOXDOWN_CACHE_HOME: tempDir('purge-container-failure-cache'),
    BOXDOWN_DATA_HOME: tempDir('purge-container-failure-data'),
    BOXDOWN_SSH_CONFIG: join(tempDir('purge-container-failure-ssh'), 'config')
  }
  const context = createWorkspaceContext({ workspace, env, assetsDevcontainerDir })
  writeWorkspaceMetadata(context, defaultSshAlias(context.workspaceBasename))

  await withFakeDocker([{
    workspace,
    id: 'failed-target-container',
    removeExitCode: 37,
    imageId: 'sha256:retained-after-container-failure'
  }], async (logPath, dockerEnv) => {
    const result = runCliProcess(['purge', '--workspace', workspace], {
      ...dockerEnv,
      ...env
    })
    const calls = fakeDockerCalls(logPath)

    assert.strictEqual(result.code, 1)
    assert.match(result.stdout, /Retained Docker image after failed container removal/)
    assert.strictEqual(calls.some(call => call.startsWith('image rm ')), false)
  })
})
```

Update the existing successful purge and recorded-image tests to expect `image rm <id>` without force. Update the unrelated Docker failure test so container removal succeeds, image removal exits nonzero, the second usage query finds no consumers after excluding the target, and purge exits one.

For the recorded-image shared case, omit the target container, keep a peer container on the recorded exact image, and assert successful retention.

- [ ] **Step 7: Run purge execution tests and verify they fail**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern='purge.*image|shared Docker image|Docker cleanup failures' __tests__/app.test.ts
```

Expected: FAIL because `purgeWorkspace` still invokes the removed forced-removal API and does not distinguish container-removal failure.

- [ ] **Step 8: Implement typed purge execution output and gating**

Replace the `removeDockerImage` import with `removeDockerImageIfUnused`, then
delete Task 1's temporary `removeDockerImage` compatibility wrapper from
`src/devcontainer.ts`. Track both the image name and container-removal result:

```ts
let dockerImageId: string | undefined
let dockerImageName: string | undefined
let containerRemovalFailed = false
```

Populate the name from metadata and live inspect. Replace the container-removal assignment with a local result:

```ts
containerRemovalFailed = await runPurgeStep(`Docker container ${currentContainer.id}`, async () => {
  await removeContainerById(currentContainer.id, {
    volumes: true,
    logger: options.logger,
    resourceName: 'Docker container'
  })
  process.stdout.write(`Removed Docker container with volumes: ${currentContainer.id}\n`)
})
failed = containerRemovalFailed || failed
```

Replace unconditional image removal with:

```ts
if (dockerImageId === undefined) {
  process.stdout.write('Docker image absent: no inspected or recorded image ID\n')
} else if (containerRemovalFailed) {
  process.stdout.write(`Retained Docker image after failed container removal: ${formatPurgePlanImage(dockerImageId, dockerImageName)}\n`)
} else {
  const imageId = dockerImageId
  const imageName = dockerImageName
  failed = await runPurgeStep(`Docker image ${imageId}`, async () => {
    const result = await removeDockerImageIfUnused(imageId, {
      excludeContainerIds: currentContainer === undefined ? [] : [currentContainer.id],
      logger: options.logger
    })
    const formatted = formatPurgePlanImage(imageId, imageName)

    if (result.status === 'removed') {
      process.stdout.write(`Removed Docker image: ${formatted}\n`)
    } else if (result.status === 'absent') {
      process.stdout.write(`Docker image already absent: ${formatted}\n`)
    } else {
      process.stdout.write(`Retained shared Docker image: ${formatted} (used by: ${formatDockerImageConsumers(result.consumers)})\n`)
    }
  }) || failed
}
```

Do not change cleanup ordering after the image step.

- [ ] **Step 9: Run focused purge tests and then all CLI execution tests**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern='purge|CLI execution' __tests__/app.test.ts
```

Expected: PASS. Specifically verify there is no remaining fake-Docker expectation containing `image rm -f`.

Run:

```bash
rg -n "image rm -f|removeDockerImage(?!IfUnused)\b" src __tests__ --pcre2
```

Expected: no matches.

- [ ] **Step 10: Commit purge integration**

```bash
git add src/devcontainer.ts src/purge.ts __tests__/app.test.ts
git commit -m "fix: retain shared images during purge"
```

---

### Task 3: Recover Docker Desktop Visibility for Recreated Mount Paths

**Files:**

- Modify: `src/doctor.ts:1-2,323-426`
- Modify: `__tests__/app.test.ts:7527-7639`

**Interfaces:**

- Consumes: `DoctorCommandRunner` and `DoctorCommandResult` already defined in `src/doctor.ts`; `WorkspaceContext.workspaceDataDir`, `workspaceRuntimeDir`, and `workspaceSecretEnvDir`.
- Produces: internal `DockerMountProbeResult` and `probeDockerBindMount`; extends internal `DockerMountSource` with `refreshParent?: string`.

- [ ] **Step 1: Write the failing successful-refresh regression**

Add a doctor test that fails the first exact workspace-data child mount, succeeds for its stable parent, then succeeds for the exact retry:

```ts
test('refreshes a stable parent and retries a stale managed Docker mount once', async () => {
  const workspace = tempDir('doctor-stale-mount-workspace')
  const context = createWorkspaceContext({
    workspace,
    env: {
      BOXDOWN_CACHE_HOME: tempDir('doctor-stale-mount-cache'),
      BOXDOWN_DATA_HOME: tempDir('doctor-stale-mount-data'),
      BOXDOWN_RUNTIME_HOME: tempDir('doctor-stale-mount-runtime')
    },
    assetsDevcontainerDir
  })
  const createSources: string[] = []
  const createdProbeIds: string[] = []
  let managedChildAttempts = 0

  const checks = await runDoctorChecks(context, {
    includeOptional: false,
    containerRuntimeReady: true,
    runCommand: async (command, args) => {
      if (command === 'docker' && args[0] === 'image') {
        return { code: 0, stdout: 'example:latest\n', stderr: '' }
      }
      if (command === 'docker' && args[0] === 'create') {
        const mount = args.find(arg => arg.startsWith('type=bind,')) ?? ''
        const source = mount.match(/source=([^,]+)/)?.[1] ?? ''
        createSources.push(source)
        if (source.startsWith(`${context.workspaceDataDir}/doctor-mount-probe-`)) {
          managedChildAttempts += 1
          if (managedChildAttempts === 1) {
            return { code: 1, stdout: '', stderr: 'invalid mount config for type "bind": bind source path does not exist' }
          }
        }
        const containerId = `probe-${createSources.length}`
        createdProbeIds.push(containerId)
        return { code: 0, stdout: `${containerId}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
  })

  assert.strictEqual(checks.find(check => check.name === 'docker-bind-mounts')?.level, 'ok')
  assert.strictEqual(managedChildAttempts, 2)
  assert.ok(createSources.includes(dirname(context.workspaceDataDir)))
  assert.ok(createdProbeIds.every(containerId => calls.includes(`docker rm -f ${containerId}`)))
})
```

- [ ] **Step 2: Run the refresh test and verify it fails**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern='refreshes a stable parent' __tests__/app.test.ts
```

Expected: FAIL because doctor returns `fail` after the first missing-source result.

- [ ] **Step 3: Extract a classified disposable mount-probe helper**

Change the path import to include `dirname`. Add:

```ts
type DockerMountProbeResult =
  | { status: 'ok' }
  | { status: 'create-failed', output: string }
  | { status: 'missing-container-id' }
  | { status: 'cleanup-failed', output: string }

async function probeDockerBindMount (
  sourcePath: string,
  image: string,
  runCommand: DoctorCommandRunner
): Promise<DockerMountProbeResult> {
  const created = await runCommand('docker', [
    'create',
    '--pull=never',
    '--entrypoint',
    '/bin/true',
    '--mount',
    `type=bind,source=${sourcePath},target=/boxdown-preflight,readonly`,
    image
  ])

  if (created.code !== 0) {
    return { status: 'create-failed', output: `${created.stderr}\n${created.stdout}` }
  }

  const containerId = created.stdout.trim().split(/\r?\n/)[0]
  if (containerId === undefined || containerId.length === 0) {
    return { status: 'missing-container-id' }
  }

  const removed = await runCommand('docker', ['rm', '-f', containerId])
  if (removed.code !== 0) {
    return { status: 'cleanup-failed', output: removed.stderr }
  }

  return { status: 'ok' }
}
```

Replace the inline create/remove block with this helper while preserving current `fail` and `warn` messages for each status. Run the existing doctor mount tests before adding recovery.

- [ ] **Step 4: Verify the refactor preserves existing behavior**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern='Docker bind-mount|Docker mount probe|disposable probes' __tests__/app.test.ts
```

Expected: existing tests PASS; the new stale-parent test still FAILS.

- [ ] **Step 5: Add the narrow missing-source classifier and refresh metadata**

Add:

```ts
function dockerBindSourceMissing (output: string): boolean {
  return /bind source path does not exist/i.test(output)
}

interface DockerMountSource {
  label: string
  path: string
  refreshParent?: string
}
```

Configure only managed recreated paths:

```ts
const sources: DockerMountSource[] = [
  { label: 'workspace', path: context.workspaceFolder },
  { label: 'Boxdown devcontainer assets', path: context.assetsDevcontainerDir },
  {
    label: 'Boxdown runtime state',
    path: runtimeProbeDir,
    refreshParent: dirname(context.workspaceDataDir)
  },
  {
    label: 'Boxdown runtime secret state',
    path: context.workspaceSecretEnvDir,
    refreshParent: dirname(context.workspaceRuntimeDir)
  }
]
```

- [ ] **Step 6: Implement one stable-parent refresh and exact retry**

Start each source with an exact probe and recover only with this gate:

```ts
let probe = await probeDockerBindMount(source.path, image, runCommand)

if (
  probe.status === 'create-failed' &&
  source.refreshParent !== undefined &&
  existsSync(source.path) &&
  dockerBindSourceMissing(probe.output)
) {
  const refreshed = await probeDockerBindMount(source.refreshParent, image, runCommand)
  if (refreshed.status !== 'ok') {
    return {
      name: 'docker-bind-mounts',
      level: 'fail',
      message: `Docker could not refresh bind-mount visibility for ${source.label} path (${source.path}) through ${source.refreshParent}: ${mountProbeDetail(refreshed)}`
    }
  }
  probe = await probeDockerBindMount(source.path, image, runCommand)
}
```

Add the detail helper:

```ts
function mountProbeDetail (probe: DockerMountProbeResult): string {
  switch (probe.status) {
    case 'create-failed':
    case 'cleanup-failed':
      return compactOutput(probe.output) || 'Docker mount probe failed'
    case 'missing-container-id':
      return 'Docker did not return a container ID'
    case 'ok':
      return ''
  }
}
```

After the optional refresh, handle the final exact result with the existing
severity contract:

```ts
if (probe.status === 'create-failed') {
  if (dockerMountError(probe.output)) {
    return {
      name: 'docker-bind-mounts',
      level: 'fail',
      message: `Docker cannot bind-mount the ${source.label} path (${source.path}). Check Docker Desktop file sharing and host-folder permissions.`
    }
  }
  return {
    name: 'docker-bind-mounts',
    level: 'warn',
    message: `Docker bind-mount readiness could not be checked for ${source.label}: ${mountProbeDetail(probe)}`
  }
}
if (probe.status === 'missing-container-id') {
  return {
    name: 'docker-bind-mounts',
    level: 'warn',
    message: `Docker bind-mount readiness could not be checked for ${source.label}: ${mountProbeDetail(probe)}`
  }
}
if (probe.status === 'cleanup-failed') {
  return {
    name: 'docker-bind-mounts',
    level: 'warn',
    message: `Docker bind-mount readiness was checked, but the disposable probe container could not be removed: ${mountProbeDetail(probe)}`
  }
}
```

Do not add a loop or sleep.

- [ ] **Step 7: Run the successful-refresh test and verify it passes**

Run the command from Step 2.

Expected: PASS; the create sequence contains exact child, stable parent, exact child, and every successful probe ID has a matching `docker rm -f` call.

- [ ] **Step 8: Write failure-boundary regressions**

Add the shared runner and four tests:

```ts
function mountRefreshTestContext (name: string): ReturnType<typeof createWorkspaceContext> {
  return createWorkspaceContext({
    workspace: tempDir(`${name}-workspace`),
    env: {
      BOXDOWN_CACHE_HOME: tempDir(`${name}-cache`),
      BOXDOWN_DATA_HOME: tempDir(`${name}-data`),
      BOXDOWN_RUNTIME_HOME: tempDir(`${name}-runtime`)
    },
    assetsDevcontainerDir
  })
}

function doctorMountTestRunner (
  onCreate: (
    source: string,
    attempt: number
  ) => DoctorCommandResult | undefined
): { createSources: string[], runCommand: DoctorCommandRunner } {
  const createSources: string[] = []
  const attempts = new Map<string, number>()

  return {
    createSources,
    runCommand: async (command, args) => {
      if (command === 'docker' && args[0] === 'image') {
        return { code: 0, stdout: 'example:latest\n', stderr: '' }
      }
      if (command === 'docker' && args[0] === 'create') {
        const mount = args.find(arg => arg.startsWith('type=bind,')) ?? ''
        const source = mount.match(/source=([^,]+)/)?.[1] ?? ''
        const attempt = (attempts.get(source) ?? 0) + 1
        attempts.set(source, attempt)
        createSources.push(source)
        return onCreate(source, attempt) ?? {
          code: 0,
          stdout: `probe-${createSources.length}\n`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
  }
}

test('does not refresh a stable parent for permission or file-sharing failures', async () => {
  for (const [name, error] of [
    ['permission', 'permission denied'],
    ['file-sharing', 'mounts denied: file sharing is disabled']
  ] as const) {
    const context = mountRefreshTestContext(`doctor-${name}-mount`)
    const fake = doctorMountTestRunner(source =>
      source.startsWith(`${context.workspaceDataDir}/doctor-mount-probe-`)
        ? { code: 1, stdout: '', stderr: error }
        : undefined
    )
    const checks = await runDoctorChecks(context, {
      includeOptional: false,
      containerRuntimeReady: true,
      runCommand: fake.runCommand
    })

    assert.strictEqual(checks.find(check => check.name === 'docker-bind-mounts')?.level, 'fail')
    assert.strictEqual(fake.createSources.includes(dirname(context.workspaceDataDir)), false)
  }
})

test('refreshes the runtime parent before retrying stale secret state', async () => {
  const context = mountRefreshTestContext('doctor-runtime-secret-refresh')
  let secretAttempts = 0
  const fake = doctorMountTestRunner((source) => {
    if (source === context.workspaceSecretEnvDir) {
      secretAttempts += 1
      if (secretAttempts === 1) {
        return { code: 1, stdout: '', stderr: 'bind source path does not exist' }
      }
    }
    return undefined
  })
  const checks = await runDoctorChecks(context, {
    includeOptional: false,
    containerRuntimeReady: true,
    runCommand: fake.runCommand
  })

  assert.strictEqual(checks.find(check => check.name === 'docker-bind-mounts')?.level, 'ok')
  assert.strictEqual(secretAttempts, 2)
  assert.strictEqual(fake.createSources.includes(dirname(context.workspaceRuntimeDir)), true)
})

test('reports a blocking failure when stable-parent refresh fails', async () => {
  const context = mountRefreshTestContext('doctor-parent-refresh-failure')
  let exactChild = ''
  const fake = doctorMountTestRunner(source => {
    if (source.startsWith(`${context.workspaceDataDir}/doctor-mount-probe-`)) {
      exactChild = source
      return { code: 1, stdout: '', stderr: 'bind source path does not exist' }
    }
    if (source === dirname(context.workspaceDataDir)) {
      return { code: 1, stdout: '', stderr: 'mount denied' }
    }
    return undefined
  })
  const checks = await runDoctorChecks(context, {
    includeOptional: false,
    containerRuntimeReady: true,
    runCommand: fake.runCommand
  })
  const mountCheck = checks.find(check => check.name === 'docker-bind-mounts')

  assert.strictEqual(mountCheck?.level, 'fail')
  assert.ok(mountCheck?.message.includes(exactChild))
  assert.ok(mountCheck?.message.includes(dirname(context.workspaceDataDir)))
  assert.strictEqual(fake.createSources.filter(source => source === exactChild).length, 1)
})

test('reports the exact child when its post-refresh retry still fails', async () => {
  const context = mountRefreshTestContext('doctor-child-retry-failure')
  let exactChild = ''
  const fake = doctorMountTestRunner(source => {
    if (source.startsWith(`${context.workspaceDataDir}/doctor-mount-probe-`)) {
      exactChild = source
      return { code: 1, stdout: '', stderr: 'bind source path does not exist' }
    }
    return undefined
  })
  const checks = await runDoctorChecks(context, {
    includeOptional: false,
    containerRuntimeReady: true,
    runCommand: fake.runCommand
  })
  const mountCheck = checks.find(check => check.name === 'docker-bind-mounts')

  assert.strictEqual(mountCheck?.level, 'fail')
  assert.ok(mountCheck?.message.includes(exactChild))
  assert.strictEqual(fake.createSources.filter(source => source === exactChild).length, 2)
  assert.strictEqual(fake.createSources.includes(dirname(context.workspaceDataDir)), true)
})
```

Extend the test import from `src/doctor.ts` with `type DoctorCommandResult` and
`type DoctorCommandRunner` for the shared runner above.

- [ ] **Step 9: Run all doctor mount tests**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern='Docker bind-mount|Docker mount probe|stable parent|runtime parent|post-refresh|permission|file-sharing' __tests__/app.test.ts
```

Expected: PASS. Confirm the existing assets-path missing-source test still fails immediately without a parent refresh because assets are not Boxdown-managed recreated state.

- [ ] **Step 10: Commit mount recovery**

```bash
git add src/doctor.ts __tests__/app.test.ts
git commit -m "fix: refresh stale Docker mount paths"
```

---

### Task 4: Update User Contract, Release Note, and Run Full Verification

**Files:**

- Modify: `src/main.ts:120-123`
- Modify: `docs/features/lifecycle.md:105-125,197-210`
- Modify: `docs/features/generated-config-and-state.md:60-65`
- Create: `.changeset/safe-images-refresh.md`
- Test: `__tests__/app.test.ts:1350-1365`

**Interfaces:**

- Consumes: the user-visible behavior completed in Tasks 1-3.
- Produces: CLI help, durable lifecycle documentation, metadata documentation, and a patch release note matching the implementation.

- [ ] **Step 1: Update the CLI help assertion first**

Replace the unconditional help assertion with:

```ts
assert.match(
  USAGE,
  /purge\s+Remove the workspace devcontainer, unused Docker/
)
```

- [ ] **Step 2: Run the help test and verify it fails**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern='CLI parsing' __tests__/app.test.ts
```

Expected: FAIL because help still says `exact Docker image`.

- [ ] **Step 3: Update CLI help copy**

Change the purge description in `src/main.ts` to:

```text
purge                     Remove the workspace devcontainer, its Docker image
                          when unused, managed SSH/app config, and Boxdown
                          cache/data for this workspace. Prompts for
                          tracked workspaces from untracked directories.
```

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 4: Update lifecycle and metadata documentation**

In `docs/features/lifecycle.md`, replace the force-removal contract with these requirements:

```markdown
`purge` removes the workspace Docker container and its attached anonymous
volumes. It removes the exact inspected or recorded Docker image only when no
other running or stopped container references that image ID. A shared image is
retained as a normal successful outcome and purge names its remaining container
consumers. Image removal never uses force.
```

Update the purge-preview paragraph to say shared images appear under retained resources and apparently unused images are described conditionally. Update the doctor section to document the one-time stable-parent refresh for an existing Boxdown-managed child that Docker Desktop incorrectly reports as missing; explicitly state that permission and file-sharing failures are not retried.

In `docs/features/generated-config-and-state.md`, replace “can remove that exact image” with:

```markdown
Metadata may also record the last inspected Docker image ID and name for the
workspace. `boxdown purge` uses that record after the workspace container is
gone, but removes the image only when no other container references the exact
ID.
```

- [ ] **Step 5: Add the patch changeset**

Create `.changeset/safe-images-refresh.md`:

```markdown
---
"boxdown": patch
---

Retain Docker images shared by other workspace containers during purge, and
recover setup from Docker Desktop's stale view of recreated Boxdown mount
paths.
```

- [ ] **Step 6: Run focused regression suites**

Run:

```bash
pnpm exec node --import tsx --test --test-name-pattern='purge|Docker image|Docker bind-mount|stable parent|CLI parsing' __tests__/app.test.ts
```

Expected: PASS with no failures.

- [ ] **Step 7: Run the full project verification**

Run each command independently and stop on the first failure:

```bash
pnpm test
pnpm lint
pnpm build
pnpm exec markdownlint -c .github/.markdownlint.yml docs/features/lifecycle.md docs/features/generated-config-and-state.md docs/superpowers/specs/2026-08-05-shared-image-purge-and-mount-refresh-design.md docs/superpowers/plans/2026-08-05-shared-image-purge-and-mount-refresh.md .changeset/safe-images-refresh.md
git diff --check
```

Expected:

- `pnpm test`: all tests pass and c8 reports coverage without threshold failure.
- `pnpm lint`: ESLint and configured Markdown lint pass.
- `pnpm build`: TypeScript and tsdown complete successfully.
- explicit Markdown lint: no output and exit zero.
- `git diff --check`: no output and exit zero.

- [ ] **Step 8: Inspect the final diff for scope and forbidden behavior**

Run:

```bash
git diff HEAD~3 --stat
git diff HEAD~3 -- src/devcontainer.ts src/purge.ts src/doctor.ts src/main.ts __tests__/app.test.ts docs/features/lifecycle.md docs/features/generated-config-and-state.md .changeset/safe-images-refresh.md
rg -n "docker.*image.*rm.*(-f|--force)|image rm -f" src __tests__ docs
git status --short
```

Expected:

- Only the planned source, tests, docs, and one new changeset are modified.
- The force-removal search has no matches.
- Unrelated untracked documentation present at execution start remains
  untouched and unstaged.

- [ ] **Step 9: Commit documentation and release note**

```bash
git add src/main.ts __tests__/app.test.ts docs/features/lifecycle.md docs/features/generated-config-and-state.md .changeset/safe-images-refresh.md
git commit -m "docs: describe safe purge image cleanup"
```

- [ ] **Step 10: Verify the committed series is clean and complete**

Run:

```bash
git log -4 --oneline
git status --short
git diff HEAD~4 --check
```

Expected: four focused implementation commits appear in task order; only
unrelated untracked paths present at execution start remain in status; diff
check emits no output.
