// Synthetic CLI; models a restore guard, not a captured vendor transcript.
// Tests launch it only in the probe's disposable workspace/isolated fixture.
const fs = require('node:fs')
const path = require('node:path')
const { createInterface } = require('node:readline')
if (process.argv.includes('--version')) { console.log('0.16.5'); process.exit(0) }
const fault = process.env.FAKE_RESUME_FAULT || 'guard'
const file = path.join(process.cwd(), '.synthetic-resume.json')
let saved = null
try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
let restored = false
let rebound = false
let seq = 0
let prefsId = 1000
const pending = new Map()
const out = frame => process.stdout.write(JSON.stringify(frame) + '\n')
const reply = (id, result) => out({ id, result })
const error = (id, code = -32031) => out({ id, error: { code,
  message: fault === 'unknown-code' ? 'Unclassified vendor error' : 'ZCODE_RUNTIME_MODEL_UNAVAILABLE',
  data: { path: '/private/SYNTHETIC-SECRET', token: 'sk-SYNTHETIC-SECRET' } } })
async function preferences() {
  const id = prefsId++
  await new Promise(resolve => {
    pending.set(id, resolve)
    out({ id, method: 'session/requestRuntimePreferences', params: {} })
  })
}
function snapshot() {
  let model = { providerId: 'private-provider', modelId: 'private-model' }
  if (fault === 'missing-reference' || (restored && fault === 'missing-restored-reference')) model = { modelId: 'private-model' }
  if ((restored && fault === 'pre-rebind-drift') || (rebound && fault === 'post-rebind-drift')) model.modelId = 'other-model'
  // Mirrors the observed native layout: the restore warning lives INSIDE the
  // projection (session/read), until a model runtime is applied again.
  const guarded = restored && (!rebound || fault === 'still-guarded')
  return { projection: { status: fault === 'busy' && restored ? 'running' : 'idle',
      ...(guarded ? { lastError: { message: '历史任务使用的模型已不可用', type: 'ZCODE_RUNTIME_MODEL_UNAVAILABLE' } } : {}) },
    settings: { model: { current: model }, mode: { current: rebound && fault === 'mode-drift' ? 'build' : 'plan' } } }
}
function event(type, payload = {}) {
  out({ method: 'session/event', params: { sessionId: saved.id, seq: ++seq, type, payload } })
}
async function handle(frame) {
  if (!frame.method) { pending.get(frame.id)?.(); pending.delete(frame.id); return }
  const { id, method, params = {} } = frame
  if (frame.jsonrpc) { error(id, -32600); return }
  if (method === 'session/create') {
    await preferences()
    saved = { id: 'sess-private-fixture', workspace: params.workspace, messages: [], sends: 0 }
    fs.writeFileSync(file, JSON.stringify(saved))
    reply(id, { session: { sessionId: saved.id, workspace: saved.workspace } }); return
  }
  if (method === 'session/resume') {
    await preferences()
    if (!saved || saved.id !== params.sessionId) { error(id, -32004); return }
    restored = true
    reply(id, { session: { sessionId: saved.id, workspace: saved.workspace } }); return
  }
  if (!saved || params.sessionId !== saved.id) { error(id, -32004); return }
  if (method === 'session/subscribe') { reply(id, { eventSeq: seq }); return }
  if (method === 'session/read') { reply(id, snapshot()); return }
  if (method === 'session/messages') {
    reply(id, { messages: restored && fault === 'missing-history' || rebound && fault === 'lost-history' ? [] : saved.messages }); return
  }
  if (method === 'session/setModel') {
    if (!restored || rebound || params.model?.providerId !== 'private-provider' || params.model?.modelId !== 'private-model' ||
        params.persistAsWorkspaceLastUsed !== false || params.runtimeModel !== undefined || Object.keys(params).length !== 3) {
      error(id, -32602); return
    }
    if (fault === 'rebind-rejected') { error(id); return }
    rebound = true
    reply(id, {}); return
  }
  if (method === 'session/send') {
    await preferences()
    // Mirrors the hypothesized native contract under test: a restored session
    // refuses the continued send unless it carries the same runtimeModel, and
    // still-guarded refuses even then. Verified against real ZCode separately.
    const expectedRuntime = { providerId: 'private-provider', modelId: 'private-model' }
    if (restored && (!rebound || fault === 'still-guarded' ||
        JSON.stringify(params.runtimeModel) !== JSON.stringify(expectedRuntime))) { error(id); return }
    const marker = params.content.match(/ZCODE_PROBE_[a-f0-9]+/)?.[0] || saved.messages.at(-1)?.parts[0].text
    if (!marker) { error(id, -32602); return }
    const turnId = `private-turn-${++saved.sends}`
    const identity = fault === 'no-ids' ? {} : { turnId }
    reply(id, { accepted: true })
    event('turn.started', identity)
    event('model.streaming', { ...identity, kind: 'text_delta', delta: marker })
    saved.messages.push({ info: { role: 'assistant' }, parts: [{ type: 'text', text: marker }] })
    fs.writeFileSync(file, JSON.stringify(saved))
    event('turn.completed', { ...identity, resultType: 'success' }); return
  }
  error(id, -32601)
}
createInterface({ input: process.stdin }).on('line', line => {
  try { Promise.resolve(handle(JSON.parse(line))).catch(() => process.exit(2)) } catch { process.exit(2) }
}).on('close', () => process.exit(0))
