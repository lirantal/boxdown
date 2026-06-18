#!/usr/bin/env node
import { runCli } from '../main.ts'

runCli().then((exitCode) => {
  process.exitCode = exitCode
}, (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
