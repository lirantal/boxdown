# Supported Toolchain Picker Design

## Goal

Make interactive `boxdown setup` useful when a workspace has no recognizable
toolchain markers. The picker must expose Boxdown's complete supported runtime
catalog instead of collapsing to the single `No toolchains` action.

## User Experience

The picker always lists Node.js, Python, Go, and Rust in the canonical
`TOOLCHAIN_IDS` order.

- A safely resolved detected runtime is preselected and keeps its existing
  project evidence and resolved-version description.
- A detected runtime with an incompatible or unchecked declaration remains
  visible and unchecked with its existing diagnostic description.
- An undetected runtime is visible and unchecked. Its description states that
  no project markers were detected and names the exact Boxdown release default
  that will be used if selected.
- `No toolchains` remains the explicit empty-selection action.

For a workspace with no detections, focus begins on `No toolchains`, preserving
the safe default while still allowing the user to select any supported runtime.

## Implementation

`resolveSetupToolchains` continues to detect root-level project evidence once.
It constructs a lookup by toolchain ID, then maps over `TOOLCHAIN_IDS` to build
the prompt choices. Existing detected-toolchain descriptions remain unchanged;
an undetected choice uses `TOOLCHAIN_DEFAULTS` for its label and pinned version.

Initial values continue to contain only detected runtimes whose versions resolve
safely. Selecting an undetected runtime already follows the existing runtime
selector path in `resolveToolchainPlan`, which resolves it to the Boxdown default.
The persisted plan schema and provisioning lifecycle do not change.

## Testing

Add an interactive setup test for a workspace with no toolchain markers. It
must verify that all four supported choices and their pinned defaults are shown,
none begin selected, and choosing an undetected runtime persists the corresponding
Boxdown-default plan entry.

Keep the existing detected, incompatible, unresolved, non-interactive, and
explicit-selector coverage to ensure their behavior remains unchanged. Update
the user-facing toolchain documentation to say that interactive setup shows the
complete supported catalog and preselects only safely resolved detections.

## Non-goals

- Expanding the supported runtime list.
- Adding recursive or monorepo detection.
- Changing CLI selector semantics or release-pinned versions.
- Changing non-interactive setup behavior.
