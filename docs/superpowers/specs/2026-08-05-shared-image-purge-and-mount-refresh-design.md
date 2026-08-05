# Shared-Image Purge and Docker Mount Refresh Design

## Status

Approved 2026-08-05.

## Context

Two independent failures appeared when a workspace was purged and immediately
set up again on Docker Desktop for macOS.

First, Boxdown removed the workspace container and then ran
`docker image rm -f` for the exact recorded image ID. The published Boxdown
image was also used by other workspace containers, so Docker retained it.
Boxdown reported that expected shared-image protection as a purge failure even
though the target workspace container and state were removed successfully.

Second, purge deleted the workspace data and runtime directories. Setup then
recreated descendants of those directories and immediately asked Docker to
bind-mount them during its doctor preflight. The paths existed on the host, but
Docker Desktop temporarily retained a stale view of the deleted directory tree
and reported `bind source path does not exist`. Mounting the stable parent
directory once refreshed Docker Desktop's view, after which the exact child
mounts succeeded.

These failures are unrelated to Cursor integration state. They expose an
incorrect ownership assumption in image cleanup and a missing recovery path in
Docker bind-mount readiness checks.

## Goals

- Remove a purged workspace's exact Docker image only when no container still
  references it.
- Treat retention of a shared image as a successful, visible purge outcome.
- Stop using force for image removal.
- Keep genuine Docker cleanup failures visible and nonzero.
- Recover once from Docker Desktop's stale view of newly recreated
  Boxdown-managed mount paths.
- Continue probing the exact child paths setup will use.
- Keep mount recovery bounded, deterministic, and side-effect-free beyond
  disposable, never-started probe containers.
- Document and test the changed user-facing contracts.

## Non-goals

- Force-remove an image used by another running or stopped container.
- Remove all Boxdown images or implement a general Docker image-pruning
  command.
- Add a purge flag for image behavior.
- Change repository, SSH, app-integration, cache, data, or runtime ownership.
- Restart Docker Desktop or mutate Docker Desktop file-sharing configuration.
- Retry permission, file-sharing, or arbitrary Docker failures.
- Replace exact-path bind-mount checks with a weaker parent-only check.

## Design

### Conditional Docker image removal

An image recorded by one workspace is not workspace-owned. Multiple Boxdown
containers may legitimately reference the same published image ID.

Add a focused container-usage query in `src/devcontainer.ts`. It first narrows
all running and stopped containers with Docker's ancestor filter, then inspects
those candidates and compares each container's `.Image` field with the exact
image ID. It returns only exact matches with their container IDs and names:

```text
docker ps -aq --filter ancestor=<image-id>
docker inspect --format <id-name-and-image-fields> <candidate-ids...>
```

The inspect step prevents containers built from descendant images from being
misreported as exact consumers. Stopped containers count as consumers because
Docker also protects their images from deletion. Callers may exclude a known
container ID while building a pre-removal preview, but execution performs its
authoritative query only after the target container has been removed.

Replace unconditional forced removal with an operation that has explicit
outcomes:

- `removed`: no container referenced the image and normal
  `docker image rm <image-id>` succeeded;
- `absent`: Docker reported that the image no longer exists; or
- `retained-in-use`: one or more containers reference the image.

The operation first queries image consumers. If consumers exist, it returns
`retained-in-use` without invoking image removal. If no consumers exist, it
runs normal image removal without `--force`.

A container can begin using the image between the query and removal. If image
removal fails for a reason other than an absent image, Boxdown queries consumers
again. A newly discovered consumer converts the result to `retained-in-use`.
If there is still no consumer, or consumer discovery itself fails, the image
cleanup remains a real error. This avoids depending on Docker's conflict error
wording while preserving race safety.

If Boxdown cannot perform the initial consumer query, it retains the image,
does not attempt removal, and records an image-cleanup failure. It is safer to
leave an image behind than to delete one whose usage cannot be established.

### Purge execution

`src/purge.ts` tracks whether target-container removal succeeded.

When removal succeeds, or when the target container was already absent, purge
applies the conditional image-removal operation to the inspected or recorded
exact image ID. Its concise output is one of:

```text
Removed Docker image: <image-id>
Docker image already absent: <image-id>
Retained shared Docker image: <image-id> (used by: <container-names-or-ids>)
```

The output includes the recorded image name alongside the ID when available.
Shared-image retention is normal output and does not make purge fail.

When target-container removal fails, purge does not attempt image removal. It
reports that the image was retained because container cleanup was incomplete;
the existing container-removal failure keeps the purge exit status nonzero.
This avoids producing a second misleading image failure for the same resource.

As today, purge continues independent integration and state cleanup after
Docker failures. Missing images remain idempotent success. Failures unrelated
to shared usage continue to produce a nonzero final exit status.

### Purge preview

The pre-purge plan no longer promises unconditional image deletion.

After inspecting the target container or reading recorded metadata, the planner
queries other consumers of the image. When other consumers are known, the plan
places the image under `This will keep` as a shared image and names the
containers using it. When no other consumer is found, the plan places a
conditional entry under `This will remove`, stating that the exact image will
be removed only if it is still unused during execution.

If consumer usage cannot be inspected, the plan says that Boxdown will verify
usage during removal. The plan remains a read-only snapshot; purge repeats all
Docker discovery after confirmation.

### Exact bind-mount probe helper

Refactor `src/doctor.ts` so one helper owns a disposable Docker mount probe. The
helper:

1. creates a never-started container with a read-only bind mount;
2. returns the container ID or a classified failure; and
3. attempts to remove every successfully created probe container before
   returning, preserving the existing cleanup-warning behavior when Docker
   cannot remove one.

The existing workspace, packaged-assets, workspace-data descendant, and
runtime-secret descendant checks continue to probe their exact source paths.
The temporary workspace-data probe directory continues to be removed in a
`finally` block.

Split Docker's missing-bind-source condition from other mount failures. A
refresh is eligible only when:

- the exact source path exists according to the host filesystem; and
- Docker's output contains `bind source path does not exist`.

Permissions, file-sharing denial, mount denial, and unrelated Docker errors
remain immediate, actionable failures.

### Stable-parent refresh and retry

The recreated Boxdown-managed sources identify parents that survive a normal
workspace purge:

- workspace-data descendants refresh through
  `<data-root>/workspaces`; and
- runtime-state descendants refresh through
  `<runtime-root>/workspaces`.

On an eligible exact-path failure, doctor performs one read-only mount probe of
the stable parent using the same local image. If that succeeds and its probe
container is removed, doctor retries the original exact path once.

A successful exact retry yields the existing `docker-bind-mounts` `ok` result.
Normal setup output does not add another checklist item, while verbose command
logging may record that a parent refresh occurred.

If the parent refresh fails or the exact retry fails, doctor returns a blocking,
path-specific failure. There is no sleep, polling loop, Docker Desktop restart,
or second refresh attempt.

## Error handling and safety

- Image consumer discovery uses exact image IDs and includes stopped
  containers.
- Image removal never uses `--force`.
- A failed usage query cannot authorize image deletion.
- Shared-image retention is success; inability to establish usage is failure.
- A target-container removal failure prevents the following image-removal
  attempt.
- Mount refresh is allowed only for an existing Boxdown-managed child path and
  its configured stable parent.
- Parent refresh does not replace the final exact-child verification.
- Probe containers never start user or image code because Docker `create` uses
  `/bin/true` as the entrypoint and the containers are removed without start.
- Every successfully created probe container is removed on success and failure
  paths.

## User-facing documentation

Update the CLI help and lifecycle documentation to replace “exact Docker image”
and “force-removes” with the conditional unused-image contract.

Update:

- `src/main.ts`;
- `docs/features/lifecycle.md`; and
- `docs/features/generated-config-and-state.md`.

Add a release changeset describing both visible fixes: shared images are
retained without failing purge, and setup can recover from Docker Desktop's
stale view after state recreation.

## Verification

Add regression coverage in `__tests__/app.test.ts` for:

1. Two workspaces sharing an image: purging one removes its container, retains
   the image, names the remaining consumer, and exits zero.
2. An unused exact image is removed with `docker image rm <id>` and never with
   `--force`.
3. A recorded image is retained when the original workspace container is
   absent but another container references it.
4. Failed target-container removal skips image removal and keeps the purge
   result nonzero.
5. A race-time image-removal failure followed by discovery of a new consumer is
   classified as successful shared-image retention.
6. An unrelated image-removal failure with no consumers remains nonzero.
7. The purge preview puts a known shared image under retained resources and
   describes an apparently unused image conditionally.
8. An exact managed-child probe initially reports a missing bind source, its
   stable-parent refresh succeeds, its one exact retry succeeds, and doctor
   returns `ok`.
9. Permission and file-sharing failures do not trigger a parent refresh.
10. Parent-refresh failure and exact-retry failure each remain blocking and
    identify the affected child path.
11. Every successful exact or parent probe container and the temporary probe
    directory are removed.

Run focused purge and doctor tests first. Then run the full test suite, ESLint,
Markdown lint, build, and `git diff --check` with the repository's supported
Node 24 toolchain.
