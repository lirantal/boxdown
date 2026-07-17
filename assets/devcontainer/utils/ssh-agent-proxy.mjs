#!/usr/bin/env node

import { chmodSync, chownSync, existsSync, unlinkSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'

function option (name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const source = option('--source')
const target = option('--target')
const uid = Number(option('--uid'))
const gid = Number(option('--gid'))

if (source === undefined || target === undefined || !Number.isInteger(uid) || !Number.isInteger(gid)) {
  process.stderr.write('ssh-agent-proxy: expected --source, --target, --uid, and --gid.\n')
  process.exit(2)
}

if (existsSync(target)) unlinkSync(target)

const server = createServer((client) => {
  const upstream = createConnection(source)
  client.pipe(upstream)
  upstream.pipe(client)
  client.on('error', () => upstream.destroy())
  upstream.on('error', () => client.destroy())
})

server.on('error', (error) => {
  process.stderr.write(`ssh-agent-proxy: ${error.message}\n`)
  process.exit(1)
})

server.listen(target, () => {
  chmodSync(target, 0o600)
  chownSync(target, uid, gid)
})
