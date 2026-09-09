import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
export const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
)
export const upstreamName = 'zcode-acp-server'
export const upstreamVersion = manifest.dependencies[upstreamName]

export class LauncherError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LauncherError'
    this.code = code
  }
}

export function parseArgs(args) {
  if (args.length === 0) return 'server'
  if (args.length !== 1) {
    throw new LauncherError('E_ARGS', 'Use --help for the supported commands.')
  }
  const commands = new Map([
    ['server', 'server'], ['doctor', 'doctor'],
    ['--version', 'version'], ['--help', 'help'], ['-h', 'help'],
  ])
  const command = commands.get(args[0])
  if (!command) throw new LauncherError('E_ARGS', 'Unknown command. Use --help.')
  return command
}

export function assertNode(versions = process.versions) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(versions.node ?? '')
  if (versions.bun || !match || ![22, 24].includes(Number(match[1])) ||
      (Number(match[1]) === 22 && Number(match[2]) < 16)) {
    throw new LauncherError('E_NODE', 'Use real Node.js 22 (>=22.16.0) or 24 with node:sqlite; Bun is not supported by this launch profile.')
  }
}

/** Strip only remote/TUI boot routing. Never relax permissions or sandboxing. */
export function codegEnvironment(input) {
  const env = { ...input }
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    if (upper === 'ZCODE_ACP_REMOTE' || upper === 'ZCODE_ACP_RUNTIME' ||
        upper.startsWith('ZCODE_ACP_REMOTE_') || upper.startsWith('ZCODE_ACP_HUB_') ||
        upper === 'ZCODE_ACP_RESUME_SESSION' || upper === 'ZCODE_ACP_BOOT_CREATE_SESSION') {
      delete env[key]
    }
  }
  env.ZCODE_ACP_REMOTE = '0'
  env.ZCODE_ACP_RUNTIME = 'node'
  return env
}

/** Upstream gives its own remote config priority over environment variables. */
export function assertLocalConfig(env = process.env, home = homedir()) {
  const base = (env.XDG_CONFIG_HOME ?? '').trim() || join(home, '.config')
  const file = join(base, 'zcode-acp', 'config.json')
  let raw
  try { raw = readFileSync(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return
    throw new LauncherError('E_CONFIG', 'Cannot read the upstream bridge config. Check zcode-acp/config.json under XDG_CONFIG_HOME or ~/.config.')
  }
  let data
  try { data = JSON.parse(raw) } catch {
    throw new LauncherError('E_CONFIG', 'The upstream bridge config is invalid JSON. Fix it before starting this local-only profile.')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      (data.remote !== undefined && (!data.remote || typeof data.remote !== 'object' || Array.isArray(data.remote)))) {
    throw new LauncherError('E_CONFIG', 'The upstream bridge config and its remote section must be JSON objects.')
  }
  if (data.remote?.enabled !== undefined && data.remote.enabled !== false) {
    throw new LauncherError('E_REMOTE_CONFIG', 'This profile requires remote.enabled=false (or absent) in the upstream zcode-acp/config.json. Environment REMOTE=0 does not override that file. The file has not been modified.')
  }
}

/** Check the one version/layout contract we rely on, before importing code. */
export function resolveUpstream(resolve = require.resolve) {
  let upstream
  let entry
  try {
    const path = resolve(`${upstreamName}/package.json`)
    upstream = JSON.parse(readFileSync(path, 'utf8'))
    entry = resolve(upstreamName)
  } catch {
    throw new LauncherError('E_DEPENDENCY', 'Upstream is missing or incomplete. Run npm ci --ignore-scripts in the adapter repository.')
  }
  if (!/^\d+\.\d+\.\d+$/.test(upstreamVersion) ||
      upstream.name !== upstreamName || upstream.version !== upstreamVersion ||
      upstream.main !== 'dist/index.js' || upstream.type !== 'module') {
    throw new LauncherError('E_UPSTREAM_CONTRACT', `Expected the reviewed ${upstreamName}@${upstreamVersion} ESM entry. Reinstall the pinned dependency; do not override its version.`)
  }
  return { name: upstreamName, version: upstreamVersion, entry }
}

export async function checkLauncher() {
  assertNode()
  assertLocalConfig()
  try {
    const sqlite = await import('node:sqlite')
    if (typeof sqlite.DatabaseSync !== 'function') throw new Error('missing API')
  } catch {
    throw new LauncherError('E_SQLITE', 'This Node.js build lacks node:sqlite. Use a standard Node.js 22 (>=22.16.0) or 24 installation.')
  }
  return resolveUpstream()
}

/** No RPC proxy and no extra child process: upstream owns stdio and shutdown. */
export async function startServer() {
  const upstream = await checkLauncher()
  const env = codegEnvironment(process.env)
  for (const key of Object.keys(process.env)) {
    if (!(key in env)) delete process.env[key]
  }
  Object.assign(process.env, env)
  // Keep this bin named zcode-codeg.js. Upstream uses an entry-path heuristic
  // for auto-start; dist/index.js or src/index.ts would double-start main().
  let server
  try {
    server = await import(pathToFileURL(upstream.entry).href)
  } catch {
    throw new LauncherError('E_UPSTREAM_IMPORT', 'Unable to import the pinned ACP server. Reinstall with the lockfile and run npm run test:upstream.')
  }
  if (typeof server.main !== 'function') {
    throw new LauncherError('E_UPSTREAM_CONTRACT', 'The pinned package must export main(). Review the upstream entry contract before upgrading.')
  }
  assertLocalConfig() // Recheck after async import; never silently edit user preferences.
  try {
    await server.main()
  } catch {
    // Do not echo upstream exceptions, credentials, paths, or environment.
    throw new LauncherError('E_UPSTREAM_START', 'The ACP server failed during startup. Check the ZCode installation and run the upstream smoke test.')
  }
}
