import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, realpath, stat, rm, access, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppServerBackend, PROFILE, EXPECTED_CLI } from './backend.mjs'
import { ProbeError, diagnostic } from './errors.mjs'
import { LocalErrorCapture } from './local-error.mjs'
const execute = promisify(execFile)
const fake = fileURLToPath(new URL('../../test/fake-zcode.cjs', import.meta.url))
const scenarios = ['inspect', 'session', 'smoke', 'deny', 'cancel', 'resume', 'all']

export function parseArgs(argv) {
  const options = { live: false, scenario: undefined, allowModel: false, allowFileTest: false }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (seen.has(key)) throw new ProbeError('E_ARGS')
    seen.add(key)
    if (key === '--live') options.live = true
    else if (key === '--mock') options.mock = true
    else if (key === '--allow-model') options.allowModel = true
    else if (key === '--allow-file-test') options.allowFileTest = true
    else if (key === '--local-error') options.localError = true
    else if (key === '--help') options.help = true
    else if (['--zcode', '--scenario', '--out'].includes(key)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new ProbeError('E_ARGS')
      options[key.slice(2)] = value
    } else throw new ProbeError('E_ARGS')
  }
  return validateOptions(options)
}

export function validateOptions(options) {
  if (typeof options.live !== 'boolean') throw new ProbeError('E_ARGS')
  if (options.live && options.mock) throw new ProbeError('E_ARGS')
  options.scenario ??= options.live ? 'inspect' : 'all'
  if (!scenarios.includes(options.scenario) || (!options.live && options.zcode)) throw new ProbeError('E_ARGS')
  if (options.localError !== undefined && typeof options.localError !== 'boolean') throw new ProbeError('E_ARGS')
  if (options.localError && (!options.live || options.scenario !== 'session' || options.allowModel || options.allowFileTest)) throw new ProbeError('E_LOCAL_ERROR_SCOPE')
  if (options.live && options.scenario === 'all') throw new ProbeError('E_ARGS')
  if (options.live && !['inspect', 'session'].includes(options.scenario) && options.allowModel !== true) throw new ProbeError('E_MODEL_OPT_IN')
  if (options.live && options.scenario === 'deny' && options.allowFileTest !== true) throw new ProbeError('E_FILE_OPT_IN')
  return options
}

function environment(home, live) {
  if (live) {
    // Native login/config remains the user's, read by ZCode, never by this probe.
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    delete env.NODE_PATH
    return env
  }
  const env = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home }
}

async function versionOf(entry, cwd, env) {
  let stdout
  try {
    ({ stdout } = await execute(process.execPath, [entry, '--version'], {
      cwd, env, timeout: 5000, maxBuffer: 65536, windowsHide: true, killSignal: 'SIGKILL',
    }))
  } catch { throw new ProbeError('E_VERSION_PROBE') }
  const match = /^(?:zcode(?: cli)?[ :]*v?|v)?(\d+\.\d+\.\d+)\s*$/i.exec(stdout.trim())
  if (!match) throw new ProbeError('E_VERSION_FORMAT')
  return match[1]
}

/** Run only against a fresh temporary workspace. No arbitrary cwd/prompt option.
 * Return an allowlisted report; raw frames and native stderr never enter it.
 */
export async function runProbe(input, { signal, onLocalErrorFile = () => {} } = {}) {
  const options = validateOptions({ ...input })
  const localError = options.localError ? new LocalErrorCapture() : null
  const report = { schemaVersion: 1, diagnosticRevision: 3,
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch }, profile: PROFILE, evidence: options.live ? 'live-observation' : 'synthetic',
    scenario: options.scenario, status: 'pass', productionReady: false, checks: [],
    cleanup: { workspaceRemoved: false, processesClosed: true },
    unverified: ['codeg-ui', 'acp-mapping', 'client-mcp-delegation', 'os-sandbox', 'detached-grandchildren'] }
  let root
  const backends = []
  const stop = () => { for (const backend of backends) void backend.close() }
  signal?.addEventListener('abort', stop, { once: true })
  let phase = 'setup'
  try {
    if (signal?.aborted) throw new ProbeError('E_ABORTED')
    root = await mkdtemp(join(tmpdir(), 'zcode-contract-'))
    const cwd = join(root, 'workspace with spaces')
    const home = join(root, 'isolated-home')
    await mkdir(cwd)
    await mkdir(home)
    const env = environment(home, options.live)
    let entry = fake
    if (options.live) {
      entry = options.zcode ?? process.env.ZCODE_BIN
      if (!entry || !isAbsolute(entry) || extname(entry) !== '.cjs') throw new ProbeError('E_ZCODE_PATH')
      try { entry = await realpath(entry); if (!(await stat(entry)).isFile()) throw new Error() }
      catch { throw new ProbeError('E_ZCODE_PATH') }
    }
    phase = 'version'
    report.cliVersion = await versionOf(entry, cwd, env)
    if (report.cliVersion !== EXPECTED_CLI) throw new ProbeError('E_VERSION_MISMATCH')
    report.checks.push({ name: 'cli-version', outcome: 'pass' })
    const start = () => {
      if (signal?.aborted) throw new ProbeError('E_ABORTED')
      const backend = new AppServerBackend({ command: process.execPath, args: [entry, 'app-server', '--stdio'], cwd, env,
        onRemoteError: localError ? (method, error) => localError.capture(method, error) : undefined })
      backends.push(backend)
      return backend
    }
    const selected = options.scenario === 'all' ? ['session', 'smoke', 'deny', 'cancel', 'resume'] : [options.scenario]
    for (const scenario of selected) {
      if (scenario === 'inspect') continue
      phase = scenario
      let backend = start()
      const id = await backend.open(cwd, { mode: scenario === 'deny' ? 'build' : 'plan' })
      if (scenario === 'session') {
        const observed = await backend.inspect(id)
        report.checks.push({ name: scenario, outcome: 'pass', observed })
      } else if (scenario === 'deny') {
        const result = await backend.prompt(id,
          'In this temporary test workspace only, attempt once to write the text TEST to deny-sentinel.txt. Do not use any other files or tools. If permission is denied, stop; do not retry or find another way.',
          { timeoutMs: 60000 })
        let filePresent = false
        try { await access(join(cwd, 'deny-sentinel.txt')); filePresent = true } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (filePresent) throw new ProbeError('E_PERMISSION_EFFECT')
        const outcome = result.denied > 0 ? 'pass' : 'inconclusive'
        report.checks.push({ name: scenario, outcome, observed: { ...result, sentinelAbsent: true } })
        if (outcome === 'inconclusive') report.status = 'inconclusive'
      } else if (scenario === 'cancel') {
        const result = await backend.prompt(id,
          'Without tools or file access, write a long response counting integers from 1 to 10000, one per line.',
          { timeoutMs: 60000, cancelOnStream: true })
        const outcome = result.cancelSent && result.cancelled && result.terminalIdMatched ? 'pass' : 'inconclusive'
        report.checks.push({ name: scenario, outcome, observed: result })
        if (outcome === 'inconclusive') report.status = 'inconclusive'
      } else {
        const marker = `ZCODE_PROBE_${randomBytes(12).toString('hex')}`
        const result = await backend.prompt(id, `Reply with exactly ${marker}. Do not use tools or access files.`, { timeoutMs: 60000 })
        const before = await backend.inspect(id, marker)
        if (!result.streams || !before.lastAssistantHasMarker) throw new ProbeError('E_MODEL_EXPECTATION')
        if (scenario === 'resume') {
          const cleanup = await backend.close()
          if (!cleanup.closed) throw new ProbeError('E_CLEANUP')
          backend = start() // A genuinely different OS process, same native session.
          await backend.open(cwd, { sessionId: id })
          const restored = await backend.inspect(id, marker)
          if (restored.assistantMessages !== before.assistantMessages || !restored.lastAssistantHasMarker) throw new ProbeError('E_HISTORY')
          const continued = await backend.prompt(id, 'Reply with exactly the token you replied with earlier. Do not use tools or access files.', { timeoutMs: 60000 })
          const after = await backend.inspect(id, marker)
          if (after.assistantMessages <= before.assistantMessages || !after.lastAssistantHasMarker) throw new ProbeError('E_HISTORY')
          const outcome = result.terminalIdMatched && continued.terminalIdMatched ? 'pass' : 'inconclusive'
          report.checks.push({ name: scenario, outcome, observed: { historyRetained: true, secondTurnRetainedContext: true } })
          if (outcome === 'inconclusive') report.status = 'inconclusive'
        } else {
          const outcome = result.terminalIdMatched ? 'pass' : 'inconclusive'
          report.checks.push({ name: scenario, outcome, observed: result })
          if (outcome === 'inconclusive') report.status = 'inconclusive'
        }
      }
      report.checks.push({ name: `${scenario}-interactions`, outcome: 'observed', counts: { ...backend.metrics } })
      if (backend.metrics.unsupportedInteractions) throw new ProbeError('E_INTERACTION_UNSUPPORTED')
      const cleanup = await backend.close()
      if (!cleanup.closed) throw new ProbeError('E_CLEANUP')
    }
  } catch (error) {
    report.status = 'fail'
    report.checks.push({ name: phase, outcome: 'fail', error: diagnostic(error) })
    // Capture at failure time, before cleanup; no additional native requests.
    const backend = backends.at(-1)
    if (backend) report.failureContext = { ...backend.rpc.diagnostics(), interactions: { ...backend.metrics } }
  } finally {
    signal?.removeEventListener('abort', stop)
    for (const backend of backends) {
      const result = await backend.close()
      report.cleanup.processesClosed &&= result.closed
    }
    if (root) {
      try { await rm(root, { recursive: true, force: true, maxRetries: 3 }); report.cleanup.workspaceRemoved = true }
      catch { report.status = 'fail'; report.checks.push({ name: 'cleanup', outcome: 'fail', error: { code: 'E_CLEANUP' } }) }
    }
    if (!report.cleanup.processesClosed || signal?.aborted) report.status = 'fail'
  }
  if (localError) {
    report.localErrorCapture = localError.status()
    if (localError.path) onLocalErrorFile(localError.path)
  }
  return report
}

export async function saveReport(path, report) {
  // Never overwrite an existing report, follow a symlink, or persist native data.
  try { await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' }) }
  catch { throw new ProbeError('E_REPORT_WRITE') }
}
