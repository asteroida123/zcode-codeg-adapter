// Live ACP smoke against the real ZCode CLI. Explicit opt-in:
//   node scripts/acp-live-smoke.mjs --entry "/path/to/zcode.cjs" [--cwd /tmp/dir]
// Sends ONE prompt, prints a sanitized JSON summary, never model text.
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
const flag = name => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const entry = flag('--entry') ?? process.env.ZCODE_CODEG_ENTRY ?? ''
const bin = fileURLToPath(new URL('../bin/zcode-codeg-acp.js', import.meta.url))
if (!isAbsolute(entry)) { console.error('E_ENTRY: --entry must be absolute'); process.exit(1) }

const workspace = flag('--cwd') ? resolve(flag('--cwd')) : await mkdtemp(join(tmpdir(), 'zcode-acp-live-'))
const adapter = spawn(process.execPath, [bin], { cwd: workspace, env: { ...process.env, ZCODE_CODEG_ENTRY: entry } })
adapter.stderr.on('data', bytes => { /* drained, never printed */ })

let nextId = 10
const pending = new Map()
const updates = []
const lines = createInterface({ input: adapter.stdout })
lines.on('line', line => {
  let frame
  try { frame = JSON.parse(line) } catch { return }
  if (frame.id !== undefined && pending.has(frame.id)) { pending.get(frame.id)(frame); pending.delete(frame.id); return }
  if (frame.method === 'session/update' && frame.params?.update?.sessionUpdate === 'agent_message_chunk') {
    const text = frame.params.update.content?.text ?? ''
    updates.push({ sessionId: frame.params.sessionId, chars: typeof text === 'string' ? text.length : 0 })
  }
})
const request = (method, params, timeoutMs = 120000) => new Promise(resolve => {
  const id = nextId++
  const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { code: 'E_TIMEOUT' } }) } }, timeoutMs)
  pending.set(id, frame => { clearTimeout(timer); resolve(frame) })
  adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})

const report = { entry: '<provided>', cli: 'unverified', status: 'fail', checks: {} }
try {
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 15000)
  report.checks.initialize = init.result?.protocolVersion === 1
  const created = await request('session/new', { cwd: workspace, mcpServers: [] })
  report.checks.sessionNew = created.result?.sessionId !== undefined
  const sessionId = created.result?.sessionId
  if (!sessionId) throw new Error(`session/new failed: ${JSON.stringify(created).slice(0, 200)}`)
  const marker = `ZCODE_PROBE_${randomBytes(8).toString('hex')}`
  const prompt = await request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: `Reply with exactly ${marker}. Do not use tools or access files.` }],
  })
  report.checks.prompt = prompt.result?.stopReason === 'end_turn'
  report.checks.streamChunks = updates.filter(update => update.sessionId === sessionId).length
  report.status = report.checks.initialize && report.checks.sessionNew && report.checks.prompt ? 'pass' : 'fail'
} catch (error) {
  report.error = String(error?.message ?? error).slice(0, 200)
} finally {
  adapter.kill('SIGKILL')
  console.log(JSON.stringify(report, null, 2))
}
