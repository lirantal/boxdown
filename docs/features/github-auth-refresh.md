# GitHub Auth Refresh

## Commands

```sh
boxdown refresh-gh-token
boxdown refresh-gh-token-running
```

Both commands copy host GitHub CLI auth into the container using the host token
from:

```sh
gh auth token
```

They do not start a browser login or device-code flow.

These commands are explicit on purpose. Normal `boxdown start`, coding-agent
launches, and SSH proxy connections do not copy GitHub credentials into the
container.

## refresh-gh-token

`refresh-gh-token` starts or reuses the devcontainer, then refreshes GitHub CLI
auth inside it.

Use this when the container might not already be running.

## refresh-gh-token-running

`refresh-gh-token-running` requires a running devcontainer for the workspace.
It fails early when no matching running container exists.

Use this when you want to refresh auth without accidentally starting a
container.

## Container Work

When a host token is available, Boxdown runs inside the container:

```sh
gh auth login --hostname github.com --git-protocol https --with-token --insecure-storage
```

It also configures this repository's local Git config so GitHub remotes use the
container's authenticated `gh` for `git fetch`, `git pull`, and `git push`.
For GitHub remotes, Boxdown:

- rewrites fetch and push URLs to `https://github.com/<owner>/<repo>.git`
- configures container-global GitHub HTTPS credentials through the container's
  `gh` auth store
- resets inherited `credential.https://github.com.helper` entries locally
- adds `!gh auth git-credential` as the local GitHub credential helper
- adds a repository-specific HTTPS self-rewrite so broader host rewrites like
  `url.git@github.com:.insteadOf=https://github.com/` do not force SSH inside
  the container

The local Git config changes are written to the workspace repository because the
host checkout is mounted into the devcontainer.

Separately, Boxdown snapshots the host `.gitconfig` into workspace state and
copies it to a writable `/home/node/.gitconfig` during container creation. That
container copy is sanitized so tools cloning from directories such as `/tmp` use
HTTPS GitHub auth and do not inherit host-only helpers, GitHub SSH rewrites, or
signing programs that are unavailable inside Linux.

If host `gh` is missing, logged out, or cannot return a token, the refresh is a
no-op.

`OP_SERVICE_ACCOUNT_TOKEN`, when present, is a 1Password service account token.
It is not a GitHub token and is not used by `gh` or GitHub Git operations.
