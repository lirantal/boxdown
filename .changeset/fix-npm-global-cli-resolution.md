---
"boxdown": patch
---

Use a stable npm global prefix so user-installed CLIs take precedence over image tools across shells, container restarts, and Node toolchain changes. Preserve image fallbacks at the same executable paths so cached shell commands also pick up global upgrades.
