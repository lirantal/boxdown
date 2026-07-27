# Legacy Dev Container Image FAQ Design

## Purpose

Explain the legacy locally-built Dev Container image notice without making an
existing workspace sound broken.

## README change

Add a short FAQ subsection directly after `Published devcontainer image`.
The entry will:

- identify the image as one created by an older Boxdown release that built
  its Dev Container image locally;
- state that the workspace remains usable and is not changed automatically;
- direct users to `boxdown setup --recreate` or `boxdown start --recreate` to
  opt into the current published image.

## Scope and validation

This is documentation-only. Preserve the existing published-image guidance,
commands, and behavior; validate the rendered Markdown structure and confirm
the working-tree diff contains only the FAQ and this design record.
