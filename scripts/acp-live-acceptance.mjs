// Live acceptance matrix through the ACP adapter against the real ZCode CLI.
//   node scripts/acp-live-acceptance.mjs --entry "/abs/zcode.cjs" [--config "/abs/config.json"]
// Scenarios: initialize / read file / approve write / deny write / long tool /
// cancel -> recycle -> continue. Prints a sanitized JSON verdict per scenario.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const flag = name => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const entry = flag('--entry') ?? process.env.ZCODE_CODEG_ENTRY ?? ''
const userConfig = flag('--config')
const bin = fileURLToPath(new URL('../bin/zcode-codeg-acp.js', import.meta.url))
if (!isAbsolute(entry)) { console.error('E_ENTRY'); process.exit(1) }

const liveEnv = (() => {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  return env
})()

function startAdapter(cwd, permission) {
  const adapter = spawn(process.execPath, [bin], {
    cwd,
    env: { ...liveEnv, ZCODE_CODEG_ENTRY: entry, ...(userConfig ? { ZCODE_CODEG_CONFIG: userConfig } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  adapter.stderr.on('data', () => {})
  let nextId = 10
  const pending = new Map()
  const toolEvents = []
  let sawPermission = false
  let chunkResolve = null
  const firstChunk = new Promise(resolve => { chunkResolve = resolve })
  const lines = createInterface({ input: adapter.stdout })
  lines.on('line', line => {
    let frame
    try { frame = JSON.parse(line) } catch { return }
    if (frame.id !== undefined && pending.has(frame.id)) { pending.get(frame.id)(frame); pending.delete(frame.id); return }
    if (frame.method === 'session/update') {
      const update = frame.params?.update
      if (update?.sessionUpdate === 'agent_message_chunk' && chunkResolve) { chunkResolve(); chunkResolve = null }
      if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
        toolEvents.push({ kind: update.sessionUpdate, status: update.status, title: update.title })
      }
    }
    if (frame.method === 'session/request_permission') {
      sawPermission = true
      const optionId = permission === 'allow' ? 'allow_once' : 'deny_once'
      adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id,
        result: { outcome: { outcome: 'selected', optionId } } }) + '\n')
    }
  })
  const request = (method, params, timeoutMs = 180000) => new Promise(resolve => {
    const id = nextId++
    const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { code: 'E_TIMEOUT' } }) } }, timeoutMs)
    pending.set(id, frame => { clearTimeout(timer); resolve(frame) })
    adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const notification = (method, params) => {
    adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  const close = () => adapter.kill('SIGKILL')
  return { request, notification, toolEvents, firstChunk, sawPermissionFlag: () => sawPermission, close }
}

const report = {}
const root = await mkdtemp(join(tmpdir(), 'zcode-accept-'))
const workspace = join(root, 'workspace')
await mkdir(workspace)

async function scenario(name, runOrOptions, maybeRun) {
  const run = typeof runOrOptions === 'function' ? runOrOptions : maybeRun
  const adapter = startAdapter(workspace, typeof runOrOptions === 'object' ? runOrOptions.permission : undefined)
  try {
    const init = await adapter.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 20000)
    const created = await adapter.request('session/new', { cwd: workspace, mcpServers: [] }, 60000)
    const sessionId = created.result?.sessionId
    if (!sessionId) throw new Error('session/new failed')
    const verdict = await run(adapter, sessionId, workspace)
    report[name] = { ...(typeof verdict === 'object' ? verdict : { pass: verdict === true }), tools: adapter.toolEvents }
  } catch (error) {
    report[name] = { pass: false, error: String(error?.message ?? error).slice(0, 160) }
  } finally {
    adapter.close()
  }
}

await scenario('initialize', async adapter => {
  const init = await adapter.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 20000)
  return { pass: init.result?.protocolVersion === 1 && init.result?.agentCapabilities?.loadSession === true }
})

await scenario('read-file', async (adapter, sessionId) => {
  await writeFile(join(workspace, 'notes.txt'), 'banana-42')
  const prompt = await adapter.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Read notes.txt in this directory and reply with exactly the word it contains. Do not use any other file.' }],
  })
  return { pass: prompt.result?.stopReason === 'end_turn' && adapter.toolEvents.some(e => e.status === 'completed') }
})

await scenario('approve-write', { permission: 'allow' }, async (adapter, sessionId, ws) => {
  await adapter.request('session/set_mode', { sessionId, modeId: 'build' })
  const prompt = await adapter.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'In this temporary workspace only, write the text approved-hello into approve.txt (create it). No other files.' }],
  })
  const content = await readFile(join(ws, 'approve.txt'), 'utf8').catch(() => null)
  return {
    pass: prompt.result?.stopReason === 'end_turn' && content?.includes('approved-hello') === true,
    fileWritten: content !== null,
    permissionAsked: adapter.sawPermissionFlag(),
  }
})

await scenario('deny-write', { permission: 'deny' }, async (adapter, sessionId, ws) => {
  await adapter.request('session/set_mode', { sessionId, modeId: 'build' })
  const prompt = await adapter.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'In this temporary workspace only, write the text denied-hello into deny.txt (create it). No other files.' }],
  })
  let exists = false
  try { await readFile(join(ws, 'deny.txt')); exists = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  return { pass: prompt.result?.stopReason === 'end_turn' && !exists, fileWritten: exists }
})

await scenario('long-tool', async (adapter, sessionId) => {
  const prompt = await adapter.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Run a shell command that sleeps 3 seconds and then prints done-77. Reply with done-77 after it finishes.' }],
  }, 240000)
  return {
    pass: prompt.result?.stopReason === 'end_turn' &&
      adapter.toolEvents.some(e => e.status === 'in_progress') &&
      adapter.toolEvents.some(e => e.status === 'completed'),
  }
})

await scenario('cancel-pending-approval', async (adapter, sessionId, ws) => {
  await adapter.request('session/set_mode', { sessionId, modeId: 'build' })
  // Deterministic suspension: the write waits on the client's permission
  // decision. Cancel while it is pending; the adapter settles the held
  // decision with an explicit deny so the turn can resolve. The file must
  // stay absent and the session must remain usable.
  const long = adapter.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'In this temporary workspace only, write the text cancelled-hello into cancel.txt (create it). No other files.' }],
  }, 120000)
  const deadline = Date.now() + 60000
  while (!adapter.sawPermissionFlag()) {
    if (Date.now() > deadline) throw new Error('permission never requested')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  adapter.notification('session/cancel', { sessionId })
  const cancelled = await long
  let exists = false
  try { await readFile(join(ws, 'cancel.txt')); exists = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  const settled = cancelled.result?.stopReason !== undefined || cancelled.error !== undefined
  const next = await adapter.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly ZCODE_PROBE_after_cancel. Do not use tools or access files.' }],
  }, 120000)
  const cancelledDetail = cancelled.error
    ? `${cancelled.error.message ?? ''} ${cancelled.error.data?.details ?? ''}`.trim().slice(0, 200)
    : null
  return {
    pass: settled && !exists && next.result?.stopReason === 'end_turn',
    settled,
    fileWritten: exists,
    cancelledStopReason: cancelled.result?.stopReason ?? null,
    cancelledError: cancelledDetail,
    nextOk: next.result?.stopReason === 'end_turn',
  }
})

console.log(JSON.stringify(report, null, 2))
const allPass = Object.values(report).every(entry => entry.pass === true)
process.exit(allPass ? 0 : 1)
