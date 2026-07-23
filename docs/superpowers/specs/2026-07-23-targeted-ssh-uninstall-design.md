# Targeted SSH Integration Uninstall

## Goal

Allow `boxdown ssh uninstall --target <name>` to remove only the selected
external-app SSH integration. The Boxdown-managed OpenSSH alias remains
installed and usable. Omitting `--target` continues to perform complete SSH
integration cleanup.

## Command Contract

`--target` is repeatable and accepts the same supported values as SSH install:
`codex` and `claude`.

```sh
boxdown ssh uninstall --target claude
boxdown ssh uninstall --target codex --target claude
boxdown ssh uninstall
```

When at least one `--target` is supplied, the command is in targeted mode:

- It removes only the selected target integrations.
- It does not remove or change the Boxdown-managed SSH alias block.
- It performs no target prompt and does not write workspace metadata.
- Repeating a target is idempotent after CLI parsing deduplicates it.

When no `--target` is supplied, the command remains in complete-cleanup mode:

- It removes the Boxdown-managed SSH alias block.
- It uninstalls every registered SSH integration target.
- It remains safe and informative if any managed artifact is already absent.

Supplying every known target is still targeted mode. For example,
`--target codex --target claude` leaves the SSH alias intact; omitting the flag
is the only signal for complete cleanup.

## Architecture

Extend the existing `SshInstallTargetDefinition` registry in
`src/ssh-install-targets.ts` so each target owns its full lifecycle:

- `install(context, alias, options)` retains its current responsibility.
- `uninstall(context, alias, options)` removes that target's own managed
  artifacts and reports the result.

Add a shared registry dispatcher for uninstall, analogous to
`installSshInstallTarget`. `main.ts` selects the targets to dispatch:

| Invocation | SSH alias block | Target handlers |
| --- | --- | --- |
| `ssh uninstall` | Remove | All registered targets |
| `ssh uninstall --target claude` | Preserve | Claude only |
| `ssh uninstall --target codex --target claude` | Preserve | Codex and Claude |

The Codex target handler removes both the managed app-config project and the
matching persisted sidebar entry, including legacy remote paths. The Claude
target handler removes the matching Claude SSH remote and its trusted-host
entry. This preserves current full-uninstall behavior while making future
targets self-contained.

`purge` continues to use full cleanup and does not accept `--target`; it is a
destructive workspace teardown command, not a targeted integration manager.

## CLI Parsing and Output

`ParsedCli.targets` continues to represent a deduplicated ordered list of
validated target names. Parsing permits it for `setup`, `ssh install`, and
`ssh uninstall`; other commands keep rejecting the flag. Help and validation
text describe `--target` as an optional SSH integration target and list all
three supported command forms.

Targeted mode prints only the selected target results and restart instruction.
For example, uninstalling Claude reports its configuration path, whether the
remote was removed or absent, an optional backup path, and tells the user to
restart Claude. Complete-cleanup mode prints the SSH alias result followed by
the corresponding results for all registered targets and tells the user to
restart only applications with registered integrations.

## Error Handling and Compatibility

Unknown target names and missing flag values fail during parsing, using the
same validation source as install. Existing `ssh uninstall` behavior is
preserved exactly in scope: it removes the alias and all current target
integrations. Target uninstalls are idempotent and do not infer target state
from the alias: a missing target entry is reported without failing or altering
the alias.

No migration or workspace-state schema change is required. External app files
remain independently owned and updated by their existing safe read/merge/write
helpers and backup behavior.

## Validation

Add tests that verify:

1. `ssh uninstall --target codex`, `--target claude`, and repeated targets
   parse into deduplicated target lists.
2. Targets remain rejected for unrelated commands, while the validation error
   names all supported command families.
3. Targeted Claude uninstall removes only Claude data and leaves the managed
   SSH config block plus Codex data unchanged.
4. Targeted Codex uninstall removes both Codex app config and sidebar state,
   including legacy paths, while leaving the SSH block plus Claude data
   unchanged.
5. Multi-target uninstall removes each selected integration while preserving
   the SSH alias.
6. Unqualified uninstall still removes the alias and all registered target
   integrations, including idempotent absent-artifact output.
7. Usage, README, and SSH feature documentation describe targeted versus
   complete cleanup precisely.

Run the focused test file, full test suite, TypeScript build, and Markdown
lint before implementation is considered complete.
