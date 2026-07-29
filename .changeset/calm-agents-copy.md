---
"boxdown": major
---

Add isolated `none`, `auth`, and `full` agent profiles. The new `auth`
default copies file-backed authentication and `~/.agents` into each
container; user-scoped Codex config and Claude MCP projection now require
`full` or repository-scoped configuration.
