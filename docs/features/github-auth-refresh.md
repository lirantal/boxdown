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

It also configures this repository's Git credential helper so HTTPS GitHub
remotes can delegate credentials to `gh`.

If host `gh` is missing, logged out, or cannot return a token, the refresh is a
no-op.
