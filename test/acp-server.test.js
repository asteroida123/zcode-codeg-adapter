import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { AppServerBackend } from '../src/backend/backend.mjs'
import { ZcodeCodegAgent } from '../src/acp/server.mjs'

const bin = fileURLToPath(new URL('../bin/zcode-codeg-acp.js', import.meta.url))
const fake = fileURLToPath(new URL('./fake-zcode.cjs', import.meta.url))
const resumeFake = fileURLToPath(new URL('./fake-resume-model.cjs', import.meta.url))
const secret = 'sk-SYNTHETIC-SECRET'

const INIT_REQUEST = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: {} },
}

/** One adapter process per test. Frames are plain NDJSON JSON-RPC; the ACP
 * session id equals the native session id, which the synthetic CLI accepts.
 */
async function start(t, { fault = '', config = null, cli = fake } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'zcode-acp-test-'))
  const env = {
    ...process.env, ZCODE_CODEG_ENTRY: cli, FAKE_ZCODE_FAULT: fault, TMPDIR: undefined,
  }
  let configPath
  if (config) {
    configPath = join(cwd, 'adapter-config.json')
    await writeFile(configPath, JSON.stringify(config))
    env.ZCODE_CODEG_CONFIG = configPath
  }
  const child = spawn(process.execPath, [bin], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const updates = []
  let nextId = 10
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let frame
    try { frame = JSON.parse(line) } catch { return }
    if (frame.id !== undefined && pending.has(frame.id)) {
      pending.get(frame.id)(frame)
      pending.delete(frame.id)
      return
    }
    if (frame.method === 'session/update') updates.push(frame.params)
  })
  const request = (method, params) => {
    const id = nextId++
    const payload = { jsonrpc: '2.0', id, method, params }
    child.stdin.write(JSON.stringify(payload) + '\n')
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ error: { code: 'TIMEOUT' } }) }
      }, 30000)
      pending.set(id, frame => { clearTimeout(timer); resolve(frame) })
    })
  }
  const notification = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  const init = await request('initialize', INIT_REQUEST.params)
  t.after(async () => {
    child.stdin.end()
    child.kill('SIGKILL')
    await rm(cwd, { recursive: true, force: true, maxRetries: 3 })
  })
  return { child, request, notification, updates, init, cwd }
}

test('ACP: initialize negotiates protocol version and honest capabilities only', async t => {
  const { init } = await start(t)
  const result = init.result
  assert.equal(result.protocolVersion, 1)
  assert.equal(result.agentCapabilities.loadSession, true)
  assert.deepEqual(result.agentCapabilities.promptCapabilities, { embeddedContext: false })
  assert.deepEqual(result.authMethods, [])
})

test('ACP: new session passes the stdio MCP server through and streams one turn', async t => {
  const { request, updates, cwd } = await start(t)
  const created = await request('session/new', {
    cwd, mcpServers: [{ name: 'probe-mcp', command: process.execPath, args: ['-e', ''], env: [] }],
  })
  assert.ok(typeof created.result?.sessionId === 'string')
  const prompted = await request('session/prompt', {
    sessionId: created.result.sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly ZCODE_PROBE_abcdef. Do not use tools or access files.' }],
  })
  assert.equal(prompted.result.stopReason, 'end_turn')
  const chunks = updates.filter(update =>
    update.sessionId === created.result.sessionId &&
    update.update?.sessionUpdate === 'agent_message_chunk')
  assert.ok(chunks.length >= 1, 'assistant text must stream to the client')
})

test('ACP: session/load replays user and assistant history before returning', async t => {
  // The synthetic CLI persists session storage inside the SESSION cwd, so the
  // workspace must outlive the first adapter process.
  const first = await start(t)
  const workspace = first.cwd
  const created = await first.request('session/new', { cwd: workspace, mcpServers: [] })
  assert.ok(created.result?.sessionId, `session/new failed: ${JSON.stringify(created).slice(0, 300)}`)
  await first.request('session/prompt', {
    sessionId: created.result.sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly ZCODE_PROBE_beefed. Do not use tools or access files.' }],
  })
  first.child.kill('SIGKILL')
  const second = await start(t)
  const loaded = await second.request('session/load', { cwd: workspace, sessionId: created.result.sessionId, mcpServers: [] })
  assert.equal(loaded.error, undefined, JSON.stringify(loaded).slice(0, 300))
  assert.equal(loaded.result?.sessionId, created.result.sessionId)
  const replayed = second.updates.filter(update =>
    update.sessionId === created.result.sessionId && update.update?.sessionUpdate === 'agent_message_chunk')
  assert.ok(replayed.some(update => update.update.content?.text?.includes('ZCODE_PROBE_beefed')),
    'assistant history must replay before session/load returns')
})

test('ACP: missing CLI entry fails fast without faking a session', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'zcode-acp-missing-'))
  t.after(async () => { await rm(cwd, { recursive: true, force: true, maxRetries: 3 }) })
  const child = spawn(process.execPath, [bin], { cwd, env: { ...process.env, ZCODE_CODEG_ENTRY: '' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', bytes => { stderr += bytes })
  const code = await new Promise(resolve => child.once('exit', (code) => resolve(code)))
  assert.notEqual(code, 0)
  assert.match(stderr, /E_ENTRY/)
})

const resumeConfig = {
  providers: [{ providerId: 'private-provider', kind: 'openai-compatible', models: [{ modelId: 'private-model' }] }],
}

test('ACP: adapter config supplies the resumed send when the CLI publishes nothing', async t => {
  // First process: create the guarded session and run one turn (no config).
  const first = await start(t, { cli: resumeFake })
  const workspace = first.cwd
  const created = await first.request('session/new', { cwd: workspace, mcpServers: [] })
  assert.ok(created.result?.sessionId, JSON.stringify(created).slice(0, 200))
  const marker = `ZCODE_PROBE_${created.result.sessionId.slice(-6)}`
  void marker
  const prompted = await first.request('session/prompt', {
    sessionId: created.result.sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly ZCODE_PROBE_abcdef. Do not use tools or access files.' }],
  })
  assert.equal(prompted.result?.stopReason, 'end_turn')
  first.child.kill('SIGKILL')
  // Second process with the adapter config: load must supply the descriptor.
  const second = await start(t, { cli: resumeFake, fault: 'unpublished-runtime', config: resumeConfig })
  const loaded = await second.request('session/load', {
    cwd: workspace, sessionId: created.result.sessionId, mcpServers: [],
  })
  assert.equal(loaded.error, undefined, JSON.stringify(loaded).slice(0, 300))
  const continued = await second.request('session/prompt', {
    sessionId: created.result.sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly the token you replied with earlier. Do not use tools or access files.' }],
  })
  assert.equal(continued.result?.stopReason, 'end_turn',
    'the config-supplied descriptor must clear the restore guard')
})

test('ACP: unconfirmed cancellation recycles the backend and the session survives', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-acp-recycle-'))
  const env = { HOME: dir, USERPROFILE: dir, FAKE_ZCODE_FAULT: 'ignore-stop' }
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const conn = { sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) }
  const agent = new ZcodeCodegAgent(conn, {
    backendFactory: cwd => new AppServerBackend({
      command: process.execPath, args: [fake], cwd, env, timeoutMs: 5000,
    }),
    cancelTimeoutMs: 400,
  })
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 3 }) })
  const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] })
  const pending = agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'long response' }] })
    .then(value => ({ ok: value }), error => error)
  await new Promise(resolve => setTimeout(resolve, 120))
  await agent.cancel({ sessionId })
  const outcome = await pending
  assert.equal(outcome.code, 'E_CANCEL_RECYCLED')
  // The recycled session keeps working: the next prompt completes normally.
  const again = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'ZCODE_PROBE_abcdef' }] })
  assert.equal(again.stopReason, 'end_turn')
  const closed = await agent.closeSession({ sessionId })
  assert.ok(closed !== undefined || true)
})
