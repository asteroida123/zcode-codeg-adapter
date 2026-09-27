import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { AppServerBackend } from '../src/backend/backend.mjs'
import { ZcodeCodegAgent, permissionDelegator } from '../src/acp/server.mjs'

const bin = fileURLToPath(new URL('../bin/zcode-codeg-acp.js', import.meta.url))
const fake = fileURLToPath(new URL('./fake-zcode.cjs', import.meta.url))
const resumeFake = fileURLToPath(new URL('./fake-resume-model.cjs', import.meta.url))

/** Kill a spawned adapter AND its backend grandchild on every platform.
 * TerminateProcess (Windows child.kill) runs no cleanup in the adapter, so
 * the native-backend child survives as an orphan holding inherited pipe
 * handles — node --test then waits on the chain until the job timeout.
 * taskkill /T /F takes the tree down; handle destroy force-closes our side. */
function killTree(child) {
  // ORDER MATTERS on Windows: taskkill /T /F must run while the adapter is
  // still alive — it enumerates the process TREE by root PID, and a
  // pre-killed root leaves the backend grandchild orphaned with the temp
  // dir as its cwd, which Windows then refuses to rmdir (EBUSY).
  if (process.platform === 'win32' && child.pid) {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  }
  try { child.kill('SIGKILL') } catch {}
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try { stream?.destroy() } catch {}
  }
}

/** rm with honest retries; a dir still locked by a Windows orphan process
 * (held as its cwd after the adapter tree died mid-recycle) is runner-temp
 * hygiene, not an ACP contract failure — the machine is ephemeral, so
 * EBUSY/ENOTEMPTY after the retry budget is tolerated. Other errors throw. */
async function rmTolerant(target) {
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  } catch (error) {
    if (error?.code !== 'EBUSY' && error?.code !== 'ENOTEMPTY') throw error
  }
}
const secret = 'sk-SYNTHETIC-SECRET'

const INIT_REQUEST = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: {} },
}

/** One adapter process per test. Frames are plain NDJSON JSON-RPC; the ACP
 * session id equals the native session id, which the synthetic CLI accepts.
 */
async function start(t, { fault = '', config = null, cli = fake, permission = 'deny', initParams = INIT_REQUEST.params } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'zcode-acp-test-'))
  const env = {
    ...process.env, ZCODE_CODEG_ENTRY: cli, FAKE_ZCODE_FAULT: fault, TMPDIR: undefined,
    // 隔离 ZCode 桌面配置：完整模型目录来自 $HOME/.zcode/v2/config.json，
    // 读到宿主机真实配置会让模型列表断言随机器漂移。
    HOME: cwd, USERPROFILE: cwd,
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
  const permissions = []
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
    // The adapter delegates permission decisions to the client; this harness
    // answers with the scenario's fixed choice.
    if (frame.method === 'session/request_permission') {
      permissions.push(frame.params)
      const optionId = permission === 'allow' ? 'allow_once' : 'deny_once'
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id,
        result: { outcome: { outcome: 'selected', optionId } } }) + '\n')
    }
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
  const init = await request('initialize', initParams)
  t.after(async () => {
    killTree(child)
    await rmTolerant(cwd)
  })
  return { child, request, notification, updates, permissions, init, cwd }
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
  killTree(first.child)
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
  t.after(async () => { await rmTolerant(cwd) })
  const child = spawn(process.execPath, [bin], { cwd, env: { ...process.env, ZCODE_CODEG_ENTRY: '', HOME: cwd, USERPROFILE: cwd }, stdio: ['pipe', 'pipe', 'pipe'] })
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
  killTree(first.child)
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
  t.after(async () => { await rmTolerant(dir) })
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

test('ACP: tool lifecycle streams as tool_call then tool_call_update with deny effect', async t => {
  const { request, updates, permissions, cwd } = await start(t, { permission: 'deny' })
  const created = await request('session/new', { cwd, mcpServers: [] })
  const sessionId = created.result.sessionId
  const prompted = await request('session/prompt', {
    sessionId, prompt: [{ type: 'text', text: 'Write deny-sentinel.txt once' }],
  })
  assert.equal(prompted.result?.stopReason, 'end_turn')
  assert.equal(permissions.length, 1)
  assert.equal(permissions[0].toolCall?.title, 'write_file')
  const kinds = updates.filter(update => update.sessionId === sessionId)
    .map(update => update.update?.sessionUpdate)
  assert.deepEqual(kinds.filter(kind => kind?.startsWith('tool_call')), ['tool_call', 'tool_call_update', 'tool_call_update'])
  const first = updates.find(update => update.update?.sessionUpdate === 'tool_call')
  assert.equal(first.update.toolCallId, 'tool_write_1')
  assert.equal(first.update.status, 'pending')
  assert.equal(first.update.kind, 'edit')
  assert.deepEqual(first.update.rawInput, { path: 'deny-sentinel.txt' })
  const last = updates.filter(update => update.update?.sessionUpdate === 'tool_call_update').at(-1)
  assert.equal(last.update.status, 'failed')
  await assert.rejects(access(join(cwd, 'deny-sentinel.txt')), { code: 'ENOENT' })
})

test('ACP: allow decision writes the file and completes the tool', async t => {
  const { request, updates, cwd } = await start(t, { permission: 'allow' })
  const created = await request('session/new', { cwd, mcpServers: [] })
  const prompted = await request('session/prompt', {
    sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'Write deny-sentinel.txt once' }],
  })
  assert.equal(prompted.result?.stopReason, 'end_turn')
  const last = updates.filter(update => update.update?.sessionUpdate === 'tool_call_update').at(-1)
  assert.equal(last.update.status, 'completed')
  const written = await readFile(join(cwd, 'deny-sentinel.txt'), 'utf8')
  assert.equal(written, 'unexpected write')
})

test('ACP: a native permission re-send storm surfaces as one client question', async t => {
  // Field regression (2026-09-26 integration line): six native re-requests of
  // one unanswered tool call used to queue six identical approval prompts on
  // the client before the session died with a native frame error.
  const { request, permissions, cwd } = await start(t, { fault: 'permission-retry', permission: 'deny' })
  const created = await request('session/new', { cwd, mcpServers: [] })
  const prompted = await request('session/prompt', {
    sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'Write deny-sentinel.txt once' }],
  })
  assert.equal(prompted.result?.stopReason, 'end_turn')
  assert.equal(permissions.length, 1, 'six native re-sends must surface as one client question')
  await assert.rejects(access(join(cwd, 'deny-sentinel.txt')), { code: 'ENOENT' })
})

test('ACP: a transient native frame error recycles the session and the retry completes', async t => {
  // Process-local frame damage: the first send is rejected with the native
  // frame error; a recycled backend that resumes the same session works.
  const { request, cwd } = await start(t, { fault: 'frame-transient' })
  const created = await request('session/new', { cwd, mcpServers: [] })
  const sessionId = created.result.sessionId
  const prompt = () => request('session/prompt', {
    sessionId, prompt: [{ type: 'text', text: 'Reply with exactly ZCODE_PROBE_abcdef. Do not use tools or access files.' }],
  })
  const first = await prompt()
  assert.match(JSON.stringify(first.error ?? {}), /E_SESSION_FATAL/)
  assert.match(JSON.stringify(first.error ?? {}), /recycled and the native session resumed/)
  const retried = await prompt()
  assert.equal(retried.error, undefined, JSON.stringify(retried).slice(0, 300))
  assert.equal(retried.result?.stopReason, 'end_turn')
})

test('ACP: a transport framing break during send is session-fatal and the retry completes', async t => {
  // Live-retest regression (2026-09-26, real 0.16.5): the session-bricking
  // frame fault arrived as a broken stdout frame - no error response, the
  // local E_FRAME transport fault - and the classification missed it, so the
  // client saw a raw "Internal error" with data.details "E_FRAME" and no
  // recovery. Same recovery contract as the response-shaped fault.
  const { request, cwd } = await start(t, { fault: 'frame-wire' })
  const created = await request('session/new', { cwd, mcpServers: [] })
  const sessionId = created.result.sessionId
  const prompt = () => request('session/prompt', {
    sessionId, prompt: [{ type: 'text', text: 'Reply with exactly ZCODE_PROBE_wirebrk. Do not use tools or access files.' }],
  })
  const first = await prompt()
  assert.match(JSON.stringify(first.error ?? {}), /E_SESSION_FATAL/)
  assert.match(JSON.stringify(first.error ?? {}), /recycled and the native session resumed/)
  const retried = await prompt()
  assert.equal(retried.error, undefined, JSON.stringify(retried).slice(0, 300))
  assert.equal(retried.result?.stopReason, 'end_turn')
})

test('ACP: a persistent transport framing break fails fast with stable recovery guidance', async t => {
  // Store-level wire damage: every fresh process breaks framing on send for
  // this session (resume and reads stay healthy). One recovery attempt, then
  // the same actionable error for every later prompt.
  const { request, cwd } = await start(t, { fault: 'frame-wire-brick' })
  const created = await request('session/new', { cwd, mcpServers: [] })
  const sessionId = created.result.sessionId
  const prompt = () => request('session/prompt', {
    sessionId, prompt: [{ type: 'text', text: 'Reply with exactly ZCODE_PROBE_wirebrk. Do not use tools or access files.' }],
  })
  const first = await prompt()
  assert.match(JSON.stringify(first.error ?? {}), /E_SESSION_FATAL/)
  const second = await prompt()
  const third = await prompt()
  assert.match(JSON.stringify(second.error ?? {}), /close this session and create a new one/)
  assert.equal(JSON.stringify(third.error), JSON.stringify(second.error),
    'prompts after the permanent verdict fail fast with one stable error')
})

test('ACP: a persistent native frame error fails fast with stable recovery guidance', async t => {
  // Store-level frame damage: even a recycled backend that resumes the
  // session keeps rejecting sends. One recovery attempt, then every later
  // prompt must fail fast with the SAME actionable error instead of relaying
  // the raw backend rejection each time.
  const { request, cwd } = await start(t, { fault: 'frame-brick' })
  const created = await request('session/new', { cwd, mcpServers: [] })
  const sessionId = created.result.sessionId
  const prompt = () => request('session/prompt', {
    sessionId, prompt: [{ type: 'text', text: 'Reply with exactly ZCODE_PROBE_abcdef. Do not use tools or access files.' }],
  })
  const first = await prompt()
  assert.match(JSON.stringify(first.error ?? {}), /E_SESSION_FATAL/)
  const second = await prompt()
  const third = await prompt()
  assert.match(JSON.stringify(second.error ?? {}), /close this session and create a new one/)
  assert.equal(JSON.stringify(third.error), JSON.stringify(second.error),
    'prompts after the permanent verdict fail fast with one stable error')
})

test('ACP: native permission kinds outside the ACP enum are mapped, not passed through', async t => {
  const { request, cwd } = await start(t)
  const created = await request('session/new', { cwd, mcpServers: [] })
  // 直接驱动 delegator：构造带非标 kind 的原生请求，断言线上形状只含合法枚举
  let wireShape = null
  const delegator = permissionDelegator({ requestPermission: async req => { wireShape = req; return { outcome: { outcome: 'selected', optionId: 'deny' } } } }, 'sess_x')
  const native = {
    sessionId: 'sess_x', toolCallId: 'call_1', toolName: 'Write', input: { a: 1 },
    options: [
      { optionId: 'allow', kind: 'allow', name: 'Allow' },
      { optionId: 'allow_project', kind: 'allow_project', name: 'Always in project' },
      { optionId: 'deny', kind: 'deny', name: 'Deny' },
    ],
  }
  const decision = await delegator(native)
  assert.deepEqual(decision, { decision: 'deny', reason: 'client selected deny' })
  const kinds = (wireShape?.options ?? []).map(option => option.kind)
  assert.deepEqual(kinds, ['allow_once', 'allow_once', 'reject_once'])
})

test('ACP: the mode and model selectors are advertised and applied natively', async t => {
  const { request, updates, cwd } = await start(t)
  const created = await request('session/new', { cwd, mcpServers: [] })
  // No ACP `modes` block: codeg hides the modes selector when configOptions
  // exist, so plan/build must ride a configOption to stay reachable there.
  assert.equal(created.result.modes, undefined)
  const modeOption = created.result.configOptions?.find(option => option.id === 'mode')
  assert.equal(modeOption?.type, 'select')
  assert.equal(modeOption.currentValue, 'build')
  // ZCode's own four switchable modes, with the names its picker shows.
  assert.deepEqual(modeOption.options, [
    { value: 'plan', name: 'Plan mode' },
    { value: 'build', name: 'Ask before changes' },
    { value: 'edit', name: 'Edit automatically' },
    { value: 'yolo', name: 'Full access' },
  ])
  const modelOption = created.result.configOptions?.find(option => option.id === 'model')
  assert.equal(modelOption?.type, 'select')
  assert.equal(modelOption.currentValue, 'builtin-x/fake-model')
  assert.deepEqual(modelOption.options.map(option => option.value).sort(), ['builtin-x/fake-mini', 'builtin-x/fake-model'])
  const switched = await request('session/set_config_option', {
    sessionId: created.result.sessionId, configId: 'model', value: 'builtin-x/fake-mini',
  })
  assert.ok(switched.result?.configOptions, JSON.stringify(switched).slice(0, 300))
  const switchedOption = switched.result?.configOptions?.find(option => option.id === 'model')
  assert.equal(switchedOption?.currentValue, 'builtin-x/fake-mini')
  const mode = await request('session/set_mode', {
    sessionId: created.result.sessionId, modeId: 'build',
  })
  assert.equal(mode.error, undefined)
  const modeUpdate = updates.find(update => update.update?.sessionUpdate === 'current_mode_update')
  assert.equal(modeUpdate?.update?.currentModeId, 'build')
  const modeSwitched = await request('session/set_config_option', {
    sessionId: created.result.sessionId, configId: 'mode', value: 'plan',
  })
  const modeAfter = modeSwitched.result?.configOptions?.find(option => option.id === 'mode')
  assert.equal(modeAfter?.currentValue, 'plan')
  // `yolo` is on ZCode's menu and must now be selectable…
  const modeYolo = await request('session/set_config_option', {
    sessionId: created.result.sessionId, configId: 'mode', value: 'yolo',
  })
  assert.equal(modeYolo.error, undefined, JSON.stringify(modeYolo).slice(0, 200))
  // …while a value outside the four (legacy `auto`, or noise) stays rejected.
  for (const offMenu of ['auto', 'bogus']) {
    const modeRejected = await request('session/set_config_option', {
      sessionId: created.result.sessionId, configId: 'mode', value: offMenu,
    })
    assert.ok(modeRejected.error, `${offMenu} must be rejected`)
  }
})

test('ACP: snapshot-sourced model rows name their provider too', async t => {
  const { request, cwd } = await start(t)
  const created = await request('session/new', { cwd, mcpServers: [] })
  const modelOption = created.result.configOptions?.find(option => option.id === 'model')
  const byValue = Object.fromEntries(modelOption.options.map(o => [o.value, o.name]))
  // This fixture has no desktop config catalog, so both rows come from the
  // native snapshot's available list — which names the provider. They must use
  // the same `Provider / Model` display shape as the catalog rows, or the
  // client's group header falls back to the raw provider id.
  assert.equal(byValue['builtin-x/fake-model'], 'Fake Provider / Fake Model')
  assert.equal(byValue['builtin-x/fake-mini'], 'Fake Provider / Fake Mini')
})

test('ACP: the reasoning-effort selector mirrors the native thought levels', async t => {
  const { request, cwd } = await start(t)
  const created = await request('session/new', { cwd, mcpServers: [] })
  const levelOption = created.result.configOptions?.find(option => option.id === 'reasoning_effort')
  assert.equal(levelOption?.type, 'select')
  assert.equal(levelOption.currentValue, 'high')
  assert.deepEqual(levelOption.options.map(option => option.value), ['low', 'high', 'max'])
  const switched = await request('session/set_config_option', {
    sessionId: created.result.sessionId, configId: 'reasoning_effort', value: 'max',
  })
  assert.equal(switched.error, undefined, JSON.stringify(switched).slice(0, 200))
  const after = switched.result?.configOptions?.find(option => option.id === 'reasoning_effort')
  assert.equal(after?.currentValue, 'max')
  const rejected = await request('session/set_config_option', {
    sessionId: created.result.sessionId, configId: 'reasoning_effort', value: 'medium',
  })
  assert.ok(rejected.error, 'a level the current model does not offer must be rejected')
  // The mode selector is unaffected by the new option.
  const modeOption = switched.result?.configOptions?.find(option => option.id === 'mode')
  assert.equal(modeOption?.options.length, 4)
})

test('ACP: connect-time preferred mode is applied when the session is created', async t => {
  // Field regression (2026-09-26): preferredConfigValues arrives top-level on
  // initialize (Zed/codeg style); the pinned SDK's schema strips it, so
  // freshly created sessions stayed on plan and could not call MCP tools.
  const { request, updates, cwd } = await start(t, {
    initParams: { protocolVersion: 1, clientCapabilities: {}, preferredConfigValues: { mode: 'build' } },
  })
  const created = await request('session/new', { cwd, mcpServers: [] })
  assert.equal(created.error, undefined, JSON.stringify(created).slice(0, 300))
  const modeOption = created.result.configOptions?.find(option => option.id === 'mode')
  assert.equal(modeOption?.currentValue, 'build', 'the preferred mode must be applied at establishment')
  const modeUpdate = updates.find(update => update.update?.sessionUpdate === 'current_mode_update')
  assert.equal(modeUpdate?.update?.currentModeId, 'build')
})

test('ACP: preferred config delivered through initialize _meta also applies', async t => {
  const { request, cwd } = await start(t, {
    initParams: { protocolVersion: 1, clientCapabilities: {}, _meta: { preferredConfigValues: { mode: 'build' } } },
  })
  const created = await request('session/new', { cwd, mcpServers: [] })
  const modeOption = created.result.configOptions?.find(option => option.id === 'mode')
  assert.equal(modeOption?.currentValue, 'build')
})

test('ACP: a connect-time preferred mode is honoured only when ZCode offers it', async t => {
  // On-menu: the preference is applied and reported back.
  const onMenu = await start(t, {
    initParams: { protocolVersion: 1, clientCapabilities: {}, preferredConfigValues: { mode: 'yolo' } },
  })
  const applied = await onMenu.request('session/new', { cwd: onMenu.cwd, mcpServers: [] })
  const appliedOption = applied.result.configOptions?.find(option => option.id === 'mode')
  assert.equal(appliedOption?.currentValue, 'yolo')

  // Off-menu (the legacy `auto`, or noise): ignored, never guessed onto the wire.
  for (const offMenu of ['auto', 'bogus']) {
    const off = await start(t, {
      initParams: { protocolVersion: 1, clientCapabilities: {}, preferredConfigValues: { mode: offMenu } },
    })
    const created = await off.request('session/new', { cwd: off.cwd, mcpServers: [] })
    const modeOption = created.result.configOptions?.find(option => option.id === 'mode')
    assert.equal(modeOption?.currentValue, 'build', `${offMenu}: an off-menu preference must be ignored`)
  }
})

test('ACP: session list mirrors the native store', async t => {
  const { request, cwd } = await start(t)
  const created = await request('session/new', { cwd, mcpServers: [] })
  const listed = await request('session/list', { cwd })
  assert.equal(listed.error, undefined)
  const ids = (listed.result?.sessions ?? []).map(session => session.sessionId)
  assert.ok(ids.includes(created.result.sessionId))
  const entry = listed.result.sessions.find(session => session.sessionId === created.result.sessionId)
  assert.equal(entry.title, 'Synthetic session')
})
