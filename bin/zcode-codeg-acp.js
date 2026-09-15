#!/usr/bin/env node
// ZCode ACP adapter entry: speaks ACP over stdio, drives the native ZCode
// app-server privately. The CLI entry path comes only from the environment
// the launcher (or Codeg) provides; this binary never searches for it.
import { isAbsolute } from 'node:path'
import { stat, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { serveOverStdio } from '../src/acp/server.mjs'

const require = createRequire(import.meta.url)

const args = process.argv.slice(2)
if (args.includes('--version')) { console.log(require('../package.json').version); process.exit(0) }
if (args.includes('--help')) {
  console.log('zcode-codeg-acp — ACP adapter for the ZCode app-server (stdio).\n' +
    'Environment: ZCODE_CODEG_ENTRY must point at the ZCode CLI .cjs entry.\n' +
    'The working directory and MCP stdio servers come from each ACP session.')
  process.exit(0)
}

function fail(code, message) {
  console.error(`[zcode-codeg-acp] ${code}: ${message}`)
  process.exit(1)
}

function liveEnvironment() {
  // The user's own ZCode configuration stays theirs; the adapter only strips
  // variables that would redirect the child's module resolution.
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  return env
}

const entry = process.env.ZCODE_CODEG_ENTRY ?? ''
if (!isAbsolute(entry) || !entry.endsWith('.cjs')) fail('E_ENTRY', 'Set ZCODE_CODEG_ENTRY to the absolute path of the ZCode CLI .cjs entry.')
try {
  const resolved = await realpath(entry)
  if (!(await stat(resolved)).isFile()) throw new Error('not a file')
} catch {
  fail('E_ENTRY', 'ZCODE_CODEG_ENTRY does not resolve to a readable file.')
}

serveOverStdio({ command: process.execPath, entry, env: liveEnvironment() })
