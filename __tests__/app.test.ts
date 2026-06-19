import assert from 'node:assert'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { buildGeneratedDevcontainerConfig, publishContainerPortFromConfig } from '../src/config.ts'
import { parseJsonc } from '../src/jsonc.ts'
import { parseCliArgs } from '../src/main.ts'
import { createWorkspaceContext } from '../src/paths.ts'
import { DEFAULT_TTY_MAX_COLUMNS, interactiveShellEnvArgs, interactiveShellScript } from '../src/shell.ts'
import { buildSshConfigBlock, defaultSshAlias, replaceSshConfigBlock } from '../src/ssh-config.ts'

const assetsDevcontainerDir = fileURLToPath(new URL('../assets/devcontainer', import.meta.url))

function tempDir (name: string): string {
  return mkdtempSync(join(tmpdir(), `boxdown-${name}-`))
}

describe('CLI parsing', () => {
  test('parses start options', () => {
    assert.deepStrictEqual(parseCliArgs(['start', '--workspace', '/tmp/project', '--recreate']), {
      command: 'start',
      workspace: '/tmp/project',
      alias: undefined,
      recreate: true
    })
  })

  test('maps shell to start and install-ssh-config to ssh-config install', () => {
    assert.strictEqual(parseCliArgs(['shell']).command, 'start')
    assert.deepStrictEqual(parseCliArgs(['install-ssh-config', '--alias', 'demo-devcontainer']), {
      command: 'ssh-config-install',
      workspace: undefined,
      alias: 'demo-devcontainer',
      recreate: false
    })
  })

  test('rejects unknown commands', () => {
    assert.throws(() => parseCliArgs(['ssh-config', 'remove']), /Unknown command/)
  })
})

describe('workspace state', () => {
  test('resolves workspace and XDG-style state paths', () => {
    const workspace = tempDir('workspace')
    const cache = tempDir('cache')
    const data = tempDir('data')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: cache,
        BOXDOWN_DATA_HOME: data
      },
      assetsDevcontainerDir
    })

    assert.strictEqual(context.workspaceFolder, realpathSync(workspace))
    assert.strictEqual(context.workspaceBasename, realpathSync(workspace).split('/').at(-1))
    assert.match(context.workspaceId, /^[a-f0-9]{16}$/)
    assert.ok(context.generatedConfigPath.startsWith(cache))
    assert.ok(context.sshKeyPath.startsWith(data))
    assert.strictEqual(context.assetsDevcontainerDir, assetsDevcontainerDir)
  })
})

describe('devcontainer config generation', () => {
  test('rewrites lifecycle paths to Boxdown assets and mounted runtime', () => {
    const workspace = tempDir('config-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('config-cache'),
        BOXDOWN_DATA_HOME: tempDir('config-data')
      },
      assetsDevcontainerDir
    })

    const config = buildGeneratedDevcontainerConfig(context)

    assert.match(config.initializeCommand ?? '', /BOXDOWN_WORKSPACE_FOLDER=/)
    assert.match(config.initializeCommand ?? '', /assets\/devcontainer\/hooks\/initialize\.sh/)
    assert.strictEqual(config.postCreateCommand, "bash '/opt/boxdown/devcontainer/hooks/post-create.sh'")
    assert.strictEqual(config.postStartCommand, "bash '/opt/boxdown/devcontainer/hooks/post-start.sh'")
    assert.ok(config.mounts?.some((mount) => mount.includes(`source=${assetsDevcontainerDir}`)))
    assert.ok(config.mounts?.some((mount) => mount.includes(`source=${context.sshPublicKeyRuntimeDir}`)))
    assert.ok(!config.mounts?.some((mount) => mount.startsWith(`type=bind,source=${context.sshKeyDir},`)))
    assert.strictEqual(config.containerEnv?.DEVCONTAINER_SSH_PUBLIC_KEY_FILE, '/opt/boxdown/state/ssh/id_ed25519.pub')
    assert.strictEqual(publishContainerPortFromConfig(config), '3000')
  })

  test('parses JSONC without stripping URLs inside strings', () => {
    const parsed = parseJsonc<{ url: string }>('{ "url": "https://example.com/path" // keep string URL\n }')
    assert.strictEqual(parsed.url, 'https://example.com/path')
  })
})

describe('interactive shell setup', () => {
  test('defaults to conservative TTY width normalization', () => {
    assert.deepStrictEqual(interactiveShellEnvArgs({ TERM: 'xterm-kitty' }), [
      'TERM=xterm-kitty',
      'COLORTERM=truecolor',
      'BOXDOWN_TTY_NORMALIZE=1',
      `BOXDOWN_TTY_MAX_COLUMNS=${DEFAULT_TTY_MAX_COLUMNS}`
    ])
  })

  test('allows terminal width normalization overrides', () => {
    assert.deepStrictEqual(interactiveShellEnvArgs({
      TERM: 'xterm-256color',
      BOXDOWN_TTY_NORMALIZE: '0',
      BOXDOWN_TTY_MAX_COLUMNS: '180'
    }), [
      'TERM=xterm-256color',
      'COLORTERM=truecolor',
      'BOXDOWN_TTY_NORMALIZE=0',
      'BOXDOWN_TTY_MAX_COLUMNS=180'
    ])
  })

  test('clamps only oversized interactive TTY columns before opening bash', () => {
    const script = interactiveShellScript()

    assert.match(script, /stty size/)
    assert.match(script, /stty cols "\$max_columns"/)
    assert.match(script, /BOXDOWN_TTY_NORMALIZE/)
    assert.match(script, /exec bash -i/)
  })
})

describe('SSH config generation', () => {
  test('builds default alias and npx proxy command', () => {
    const workspace = tempDir('ssh-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-data')
      },
      assetsDevcontainerDir
    })

    const alias = defaultSshAlias(context.workspaceBasename)
    const block = buildSshConfigBlock(context, alias)

    assert.strictEqual(alias, `${context.workspaceBasename}-devcontainer`)
    assert.ok(block.includes(`Host ${alias}`))
    assert.match(block, /ProxyCommand npx --yes boxdown ssh-proxy/)
    assert.match(block, /--workspace '/)
    assert.match(block, /IdentityFile "/)
  })

  test('replaces managed block idempotently', () => {
    const workspace = tempDir('ssh-replace-workspace')
    const context = createWorkspaceContext({
      workspace,
      env: {
        BOXDOWN_CACHE_HOME: tempDir('ssh-replace-cache'),
        BOXDOWN_DATA_HOME: tempDir('ssh-replace-data')
      },
      assetsDevcontainerDir
    })
    const alias = defaultSshAlias(context.workspaceBasename)
    const block = buildSshConfigBlock(context, alias)

    const first = replaceSshConfigBlock('Host github.com\n  User git\n', alias, block)
    const second = replaceSshConfigBlock(first, alias, block)

    assert.strictEqual(second, first)
    assert.match(second, /Host github.com/)
    assert.strictEqual(second.split(`# BEGIN ${alias} boxdown`).length - 1, 1)
  })
})

describe('packaged assets', () => {
  test('does not include generated SSH key material', () => {
    assert.strictEqual(existsSync(join(assetsDevcontainerDir, '.ssh')), false)
  })
})
