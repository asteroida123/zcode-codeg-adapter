// Live resume-continuation experiment through the REAL production path:
//   process 1 (backend): create + one turn + capture the native model reference
//   adapter  (ACP bin + adapter config): session/load + continued send
//   process 2 (backend): read history and verify the recalled marker
//   node scripts/acp-live-resume.mjs --entry "/abs/zcode.cjs"
// Prints a sanitized JSON summary. Model text and native ids stay local.
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { AppServerBackend } from '../src/backend/backend.mjs'

const args = process.argv.slice(2)
const flag = name => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const entry = flag('--entry') ?? process.env.ZCODE_CODEG_ENTRY ?? ''
const bin = fileURLToPath(new URL('../bin/zcode-codeg-acp.js', import.meta.url))
if (!isAbsolute(entry)) { console.error('E_ENTRY: --entry must be absolute'); process.exit(1) }

const liveEnv = (() => {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  delete env.ZCODE_CODEG_CONFIG
  return env
})()
const workspace = await mkdtemp(join(tmpdir(), 'zcode-acp-resume-'))
const marker = `ZCODE_PROBE_${randomBytes(8).toString('hex')}`
const report = {
  status: 'fail',
  checks: { firstTurn: false, nativeReference: false, acpLoad: false, continuedTurn: false, contextRetained: false },
}

function liveBackend() {
  return new AppServerBackend({
    command: process.execPath, args: [entry, 'app-server', '--stdio'],
    cwd: workspace, env: liveEnv, timeoutMs: 15000,
  })
}

async function acpLoadAndContinue(configPath) {
  const adapter = spawn(process.execPath, [bin], {
    cwd: workspace,
    env: { ...liveEnv, ZCODE_CODEG_ENTRY: entry, ZCODE_CODEG_CONFIG: configPath },
  })
  adapter.stderr.on('data', () => {})
  let nextId = 10
  const pending = new Map()
  const updates = []
  const lines = createInterface({ input: adapter.stdout })
  lines.on('line', line => {
    let frame
    try { frame = JSON.parse(line) } catch { return }
    if (frame.id !== undefined && pending.has(frame.id)) { pending.get(frame.id)(frame); pending.delete(frame.id); return }
    if (frame.method === 'session/update' && frame.params?.update?.sessionUpdate === 'agent_message_chunk') {
      updates.push(typeof frame.params.update.content?.text === 'string' ? frame.params.update.content.text.length : 0)
    }
  })
  const request = (method, params, timeoutMs = 180000) => new Promise(resolve => {
    const id = nextId++
    const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { code: 'E_TIMEOUT' } }) } }, timeoutMs)
    pending.set(id, frame => { clearTimeout(timer); resolve(frame) })
    adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 20000)
    if (init.result?.protocolVersion !== 1) throw new Error('initialize failed')
    const loaded = await request('session/load', { cwd: workspace, sessionId: sessionId, mcpServers: [] }, 60000)
    if (loaded.error) throw new Error(`session/load failed: ${JSON.stringify(loaded.error).slice(0, 160)}`)
    report.checks.acpLoad = true
    const continued = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with exactly the token you replied with earlier. Do not use tools or access files.' }],
    })
    if (continued.error) {
      report.continuedError = String(continued.error.data?.details ?? continued.error.message ?? 'error').slice(0, 160)
      return false
    }
    report.checks.continuedTurn = continued.result?.stopReason === 'end_turn'
    report.streamChunks = updates.length
    return report.checks.continuedTurn
  } finally {
    adapter.kill('SIGKILL')
  }
}

let sessionId
let backend
try {
  backend = liveBackend()
  sessionId = await backend.open(workspace)
  const first = await backend.prompt(sessionId,
    `Reply with exactly ${marker}. Do not use tools or access files.`, { timeoutMs: 120000 })
  const before = await backend.inspect(sessionId, marker)
  report.checks.firstTurn = first.terminalObserved === true && before.lastAssistantHasMarker === true
  const reference = backend.originalModelReference(sessionId)
  report.checks.nativeReference = reference.providerId.length > 0 && reference.modelId.length > 0
  const configPath = join(workspace, 'adapter-config.json')
  await writeFile(configPath, JSON.stringify({
    providers: [{
      providerId: reference.providerId, kind: 'openai-compatible',
      models: [{ modelId: reference.modelId }],
    }],
  }))
  await backend.close()
  backend = null
  await acpLoadAndContinue(configPath)
  const verifier = liveBackend()
  try {
    await verifier.open(workspace, { sessionId })
    const after = await verifier.inspect(sessionId, marker)
    report.checks.contextRetained = after.assistantMessages === before.assistantMessages + 1 &&
      after.lastAssistantHasMarker === true
  } finally {
    await verifier.close()
  }
  report.status = Object.values(report.checks).every(Boolean) ? 'pass' : 'fail'
} catch (error) {
  report.error = String(error?.code ?? error?.message ?? error).slice(0, 160)
  if (backend) void backend.close()
} finally {
  console.log(JSON.stringify(report, null, 2))
}
