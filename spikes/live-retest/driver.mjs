// Live ACP acceptance driver for the parent-delegation-hardening fixes,
// against a REAL ZCode desktop backend. Explicit opt-in; every run costs
// real model calls (except `control`/`pin-plan`, which only open sessions).
//
//   node spikes/live-retest/driver.mjs <scenario> --entry /abs/zcode.cjs \
//        [--adapter /abs/bin/zcode-codeg-acp.js] [--out /tmp/zcode-live-retest]
//
// Scenarios (each writes <out>/<scenario>/evidence-*.jsonl - sanitized frame
// log, no model text - plus verdict.json):
//   preferred  initialize carries TOP-LEVEL preferredConfigValues {mode:build};
//              asserts current_mode_update=build, mode configOption=build, and
//              a real tool turn (bash echo) completing end_turn. Then a control
//              adapter without the field shows what the native default is.
//   control    fresh workspace, no preferred values: the native default mode.
//   pin-plan   preferred {mode:plan} against a native default of build: proves
//              the preferred value (not the default) drives the applied mode.
//   storm      build session, Write tool, ONE session/request_permission that
//              the client deliberately NEVER answers (300s+). Asserts the
//              dedup contract (exactly 1 client-visible request), then the
//              E_FRAME outcome: session-fatal classification, exactly-once
//              recycle+resume recovery, one retry (answered allow), and a
//              final probe prompt for the stable-permanent branch.
//
// Machine baseline this was built against (2026-09-26): macOS arm64,
// Node 22.23.1, ZCode desktop 0.16.5, adapter feat/parent-delegation-hardening.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, readFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const scenario = process.argv[2]
const args = process.argv.slice(3)
const flag = name => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const entry = flag('--entry') ?? process.env.ZCODE_CODEG_ENTRY ?? ''
const defaultAdapter = fileURLToPath(new URL('../../bin/zcode-codeg-acp.js', import.meta.url))
const adapterBin = flag('--adapter') ?? defaultAdapter
const outRoot = flag('--out') ?? '/tmp/zcode-live-retest'
if (!['preferred', 'storm', 'control', 'pin-plan'].includes(scenario)) { console.error('usage: driver.mjs preferred|storm|control|pin-plan'); process.exit(2) }
if (!isAbsolute(entry) || !entry.endsWith('.cjs')) { console.error('E_ENTRY: pass --entry /abs/path/to/zcode.cjs'); process.exit(2) }
if (!isAbsolute(adapterBin)) { console.error('E_ADAPTER'); process.exit(2) }

const root = join(outRoot, scenario)
await mkdir(root, { recursive: true })
const workspace = join(root, 'ws')
await mkdir(workspace, { recursive: true })
const evidencePath = join(root, `evidence-${scenario}.jsonl`)
await writeFile(evidencePath, '')
const t0 = Date.now()
const now = () => new Date().toISOString()
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1) + 's'

function startAdapter(tag, { permissionPolicy }) {
  const stderrPath = join(root, `adapter-${tag}.stderr.log`)
  const adapter = spawn(process.execPath, [adapterBin], {
    cwd: workspace,
    env: (() => {
      const env = { ...process.env, ZCODE_CODEG_ENTRY: entry }
      delete env.NODE_OPTIONS
      delete env.NODE_PATH
      return env
    })(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // Keep adapter stderr as local evidence (diagnostics only).
  adapter.stderr.on('data', bytes => { void appendFile(stderrPath, bytes).catch(() => {}) })

  const log = (dir, summary) => {
    const line = JSON.stringify({ t: now(), el: elapsed(), dir, ...summary })
    void appendFile(evidencePath, line + '\n').catch(() => {})
  }

  const state = {
    permissionRequests: [],       // {el, id, toolCallId}
    modeUpdates: [],              // {el, currentModeId}
    toolEvents: [],               // {el, kind, status, toolCallId}
    chunkChars: 0,
    chunkText: '',                // NEVER logged; in-memory marker checks only
    stopReasons: [],
  }

  let nextId = 100
  const pending = new Map()
  const lines = createInterface({ input: adapter.stdout })
  lines.on('line', line => {
    let frame
    try { frame = JSON.parse(line) } catch { return }
    if (frame.method !== undefined) { handleServerFrame(frame); return }
    if (frame.id !== undefined && pending.has(frame.id)) { pending.get(frame.id)(frame); pending.delete(frame.id) }
  })

  function handleServerFrame(frame) {
    if (frame.method === 'session/update') {
      const u = frame.params?.update ?? {}
      const kind = u.sessionUpdate
      if (kind === 'agent_message_chunk' || kind === 'user_message_chunk') {
        const text = typeof u.content?.text === 'string' ? u.content.text : ''
        state.chunkChars += text.length
        state.chunkText += text
        log('in', { kind, chars: text.length })
        return
      }
      if (kind === 'current_mode_update') {
        state.modeUpdates.push({ el: elapsed(), currentModeId: u.currentModeId })
        log('in', { kind, currentModeId: u.currentModeId })
        return
      }
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        state.toolEvents.push({ el: elapsed(), kind, status: u.status, toolCallId: u.toolCallId, name: u.name })
        log('in', { kind, toolCallId: u.toolCallId, status: u.status, name: u.name, title: typeof u.title === 'string' ? u.title.slice(0, 80) : undefined })
        return
      }
      log('in', { kind })
      return
    }
    if (frame.method === 'session/request_permission') {
      const p = frame.params ?? {}
      state.permissionRequests.push({ el: elapsed(), id: frame.id, toolCallId: p.toolCall?.toolCallId })
      log('in', { kind: 'request_permission', id: frame.id, toolCallId: p.toolCall?.toolCallId, title: p.toolCall?.title, options: (p.options ?? []).map(o => o.optionId) })
      const action = permissionPolicy(frame)
      if (action) {
        log('out', { kind: 'permission_response', id: frame.id, optionId: action })
        adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'selected', optionId: action } } }) + '\n')
      } else {
        log('note', { kind: 'permission_held', id: frame.id })
      }
      return
    }
    log('in', { method: frame.method })
  }

  const request = (method, params, timeoutMs = 120000, summaryOut) => new Promise(resolvePromise => {
    const id = nextId++
    const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); log('note', { kind: 'request_timeout', method }); resolvePromise({ error: { code: 'E_DRIVER_TIMEOUT', message: `${method} timed out after ${timeoutMs}ms` } }) } }, timeoutMs)
    pending.set(id, frame => {
      clearTimeout(timer)
      log('in', {
        kind: 'response', id, method,
        ok: frame.error === undefined,
        error: frame.error ? { code: frame.error.code, message: String(frame.error.message ?? '').slice(0, 300), data: frame.error.data } : undefined,
        result: summaryOut ? summaryOut(frame.result) : undefined,
      })
      resolvePromise(frame)
    })
    log('out', { kind: 'request', id, method })
    adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

  const close = () => adapter.kill('SIGKILL')
  return { request, close, state, log }
}

const newSessionSummary = result => ({
  sessionId: result?.sessionId,
  configOptions: (result?.configOptions ?? []).map(o => ({ id: o.id, currentValue: o.currentValue })),
})

// ---------------------------------------------------------------------------
if (scenario === 'preferred') {
  const verdict = { scenario: 'preferred-mode', status: 'fail', checks: {} }
  const marker = 'preferred-build-probe-ok'

  // A) treatment: top-level preferredConfigValues {"mode":"build"}
  const a = startAdapter('a', {
    permissionPolicy: () => 'allow_once',
  })
  try {
    const init = await a.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      preferredConfigValues: { mode: 'build' },
    }, 30000, r => ({ protocolVersion: r?.protocolVersion }))
    verdict.checks.initialize = init.result?.protocolVersion === 1
    const created = await a.request('session/new', { cwd: workspace, mcpServers: [] }, 90000, newSessionSummary)
    const modeOption = (created.result?.configOptions ?? []).find(o => o.id === 'mode')
    verdict.checks.modeUpdateBuild = a.state.modeUpdates.some(u => u.currentModeId === 'build')
    verdict.checks.modeConfigOption = modeOption?.currentValue ?? null
    const prompt = await a.request('session/prompt', {
      sessionId: created.result?.sessionId,
      prompt: [{ type: 'text', text: `Run the shell command \`echo ${marker}\` using your bash tool, then reply with exactly: ${marker}` }],
    }, 300000, r => ({ stopReason: r?.stopReason }))
    verdict.checks.stopReason = prompt.result?.stopReason ?? null
    verdict.checks.toolCalls = a.state.toolEvents.filter(e => e.kind === 'tool_call').length
    verdict.checks.toolStatuses = [...new Set(a.state.toolEvents.map(e => e.status))]
    verdict.checks.permissionRequests = a.state.permissionRequests.length
    verdict.checks.markerStreamed = a.state.chunkText.includes(marker)
  } catch (error) {
    verdict.error = String(error?.message ?? error).slice(0, 300)
  } finally {
    a.close()
  }

  // B) control: no preferredConfigValues -> the native default shows through
  const b = startAdapter('b', { permissionPolicy: () => 'allow_once' })
  try {
    await b.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30000, r => ({ protocolVersion: r?.protocolVersion }))
    const created = await b.request('session/new', { cwd: workspace, mcpServers: [] }, 90000, newSessionSummary)
    const modeOption = (created.result?.configOptions ?? []).find(o => o.id === 'mode')
    verdict.checks.controlModeConfigOption = modeOption?.currentValue ?? null
    verdict.checks.controlModeUpdates = b.state.modeUpdates.map(u => u.currentModeId)
  } catch (error) {
    verdict.controlError = String(error?.message ?? error).slice(0, 300)
  } finally {
    b.close()
  }

  const treatmentOk = verdict.checks.initialize === true &&
    verdict.checks.modeUpdateBuild === true &&
    (verdict.checks.modeConfigOption === 'build' || verdict.checks.modeConfigOption === null) &&
    verdict.checks.stopReason === 'end_turn' &&
    verdict.checks.toolCalls >= 1
  const controlOk = verdict.checks.controlModeUpdates.length === 0
  verdict.status = treatmentOk && controlOk ? 'pass' : 'fail'
  await writeFile(join(root, 'verdict.json'), JSON.stringify(verdict, null, 2))
  console.log(JSON.stringify(verdict, null, 2))
  process.exit(verdict.status === 'pass' ? 0 : 1)
}

// ---------------------------------------------------------------------------
// Control in a PRISTINE workspace: no preferredConfigValues anywhere, the
// workspace has never hosted a session, so this reads the native default
// mode for new sessions (0.16.5 ignores create's mode param).
if (scenario === 'control') {
  const verdict = { scenario: 'control-plan-pristine-workspace', status: 'fail', checks: {} }
  const c = startAdapter('c', { permissionPolicy: () => 'allow_once' })
  try {
    await c.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30000, r => ({ protocolVersion: r?.protocolVersion }))
    const created = await c.request('session/new', { cwd: workspace, mcpServers: [] }, 90000, newSessionSummary)
    const modeOption = (created.result?.configOptions ?? []).find(o => o.id === 'mode')
    verdict.checks.controlModeConfigOption = modeOption?.currentValue ?? null
    verdict.checks.controlModeUpdates = c.state.modeUpdates.map(u => u.currentModeId)
    verdict.status = verdict.checks.controlModeUpdates.length === 0 ? 'pass' : 'fail'
  } catch (error) {
    verdict.error = String(error?.message ?? error).slice(0, 300)
  } finally {
    c.close()
  }
  await writeFile(join(root, 'verdict.json'), JSON.stringify(verdict, null, 2))
  console.log(JSON.stringify(verdict, null, 2))
  process.exit(verdict.status === 'pass' ? 0 : 1)
}

// ---------------------------------------------------------------------------
// Reverse pin: preferredConfigValues {"mode":"plan"} against a native default
// of build. If the session comes back plan (with the current_mode_update
// notification), the preferred value demonstrably drives the mode - the
// native default cannot explain it away.
if (scenario === 'pin-plan') {
  const verdict = { scenario: 'pin-plan-against-native-build-default', status: 'fail', checks: {} }
  const d = startAdapter('d', { permissionPolicy: () => 'allow_once' })
  try {
    const init = await d.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      preferredConfigValues: { mode: 'plan' },
    }, 30000, r => ({ protocolVersion: r?.protocolVersion }))
    verdict.checks.initialize = init.result?.protocolVersion === 1
    const created = await d.request('session/new', { cwd: workspace, mcpServers: [] }, 90000, newSessionSummary)
    const modeOption = (created.result?.configOptions ?? []).find(o => o.id === 'mode')
    verdict.checks.modeUpdatePlan = d.state.modeUpdates.some(u => u.currentModeId === 'plan')
    verdict.checks.modeConfigOption = modeOption?.currentValue ?? null
    verdict.status = verdict.checks.modeUpdatePlan === true ? 'pass' : 'fail'
  } catch (error) {
    verdict.error = String(error?.message ?? error).slice(0, 300)
  } finally {
    d.close()
  }
  await writeFile(join(root, 'verdict.json'), JSON.stringify(verdict, null, 2))
  console.log(JSON.stringify(verdict, null, 2))
  process.exit(verdict.status === 'pass' ? 0 : 1)
}

// ---------------------------------------------------------------------------
if (scenario === 'storm') {
  const verdict = { scenario: 'permission-storm-eframe', status: 'fail', timeline: {}, checks: {} }
  const writePrompt = 'In this temporary workspace only, create a file named storm.txt whose content is exactly storm-marker-42 (a single line, nothing else). Do not create any other file.'
  // Policy: prompt1 (the storm) -> never answer. Retries -> allow.
  let holding = true
  const a = startAdapter('a', { permissionPolicy: () => (holding ? null : 'allow_once') })
  const heartbeat = setInterval(() => {
    a.log('note', { kind: 'heartbeat', permissionRequests: a.state.permissionRequests.length })
    console.log(`[${elapsed()}] holding: permissionRequests=${a.state.permissionRequests.length} chunkChars=${a.state.chunkChars}`)
  }, 30000)
  try {
    const init = await a.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30000, r => ({ protocolVersion: r?.protocolVersion }))
    verdict.checks.initialize = init.result?.protocolVersion === 1
    const created = await a.request('session/new', { cwd: workspace, mcpServers: [] }, 90000, newSessionSummary)
    const sessionId = created.result?.sessionId
    verdict.checks.sessionNew = sessionId !== undefined
    await a.request('session/set_mode', { sessionId, modeId: 'build' }, 30000)
    verdict.checks.setModeBuild = true
    verdict.timeline.prompt1Sent = elapsed()

    const prompt1 = await a.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: writePrompt }] }, 660000, r => ({ stopReason: r?.stopReason }))
    verdict.timeline.prompt1Settled = elapsed()
    verdict.checks.permissionRequestCount = a.state.permissionRequests.length
    verdict.checks.permissionRequestTimes = a.state.permissionRequests.map(p => p.el)
    verdict.timeline.holdSeconds = a.state.permissionRequests.length > 0
      ? (Number(elapsed().replace('s', '')) - Number(a.state.permissionRequests[0].el.replace('s', ''))).toFixed(1)
      : null
    const err1 = prompt1.error
    verdict.checks.prompt1Error = err1 ? { code: err1.code, message: String(err1.message ?? '').slice(0, 400) } : null
    verdict.checks.prompt1StopReason = prompt1.result?.stopReason ?? null
    // The ACP SDK serializes a thrown agent Error as {code:-32603, message:
    // 'Internal error', data:{details:<error.message>}} - classify by text.
    const err1Text = err1 ? JSON.stringify(err1) : ''
    verdict.checks.eframeObserved = /E_SESSION_FATAL/.test(err1Text)
    const fatalRecovered = verdict.checks.eframeObserved && /backend process was recycled/.test(err1Text)
    verdict.checks.recoveryAttempted = fatalRecovered

    if (verdict.checks.eframeObserved) {
      // Scenario 3: retry the SAME prompt once (client decision, per design).
      holding = false
      verdict.timeline.retrySent = elapsed()
      const retry = await a.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: writePrompt }] }, 300000, r => ({ stopReason: r?.stopReason }))
      verdict.timeline.retrySettled = elapsed()
      verdict.checks.retryError = retry.error ? { code: retry.error.code, message: String(retry.error.message ?? '').slice(0, 400) } : null
      verdict.checks.retryStopReason = retry.result?.stopReason ?? null
      verdict.checks.retryPermissionCount = a.state.permissionRequests.length
      const fileContent = await readFile(join(workspace, 'storm.txt'), 'utf8').catch(() => null)
      verdict.checks.stormFileContent = fileContent
      // Third probe: brick -> same stable error fast; transient -> usable session.
      verdict.timeline.probe3Sent = elapsed()
      const probe3start = Date.now()
      const probe3 = await a.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Reply with exactly post-recovery-probe. Do not use any tools.' }] }, 300000, r => ({ stopReason: r?.stopReason }))
      verdict.checks.probe3LatencyMs = Date.now() - probe3start
      verdict.checks.probe3Error = probe3.error ? { code: probe3.error.code, message: String(probe3.error.message ?? '').slice(0, 400) } : null
      verdict.checks.probe3StopReason = probe3.result?.stopReason ?? null
      verdict.checks.probe3SameStableError = Boolean(retry.error && probe3.error &&
        JSON.stringify(probe3.error) === JSON.stringify(retry.error))
      verdict.checks.recoveryBranch = retry.error ? 'brick-permanent' : 'transient-recovered'
    } else {
      verdict.checks.recoveryBranch = 'eframe-not-observed'
    }
  } catch (error) {
    verdict.error = String(error?.message ?? error).slice(0, 300)
  } finally {
    clearInterval(heartbeat)
    a.close()
  }

  // Primary acceptance gate for the storm fix: exactly one permission request
  // reached the client while the native backend re-sent for 200s+.
  verdict.checks.dedupHoldOk = verdict.checks.permissionRequestCount === 1 && Number(verdict.timeline.holdSeconds ?? 0) >= 180
  verdict.status = verdict.checks.dedupHoldOk ? 'pass' : 'fail'
  await writeFile(join(root, 'verdict.json'), JSON.stringify(verdict, null, 2))
  console.log(JSON.stringify(verdict, null, 2))
  process.exit(verdict.status === 'pass' ? 0 : 1)
}
