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
let runtimeApplied = false
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
// Synthetic full runtime descriptor in the observed native send-schema shape
// (revision/generatedAt/model/provider). Real 0.16.5 publishes none.
const RUNTIME = { revision: 'catalog-1', generatedAt: 1,
  model: { providerId: 'private-provider', modelId: 'private-model' },
  provider: { providerId: 'private-provider', kind: 'openai-compatible', models: [{ modelId: 'private-model' }] } }
function snapshot() {
  let model = { providerId: 'private-provider', modelId: 'private-model' }
  if (fault === 'missing-reference' || (restored && fault === 'missing-restored-reference')) model = { modelId: 'private-model' }
  if ((restored && fault === 'pre-rebind-drift') || (rebound && fault === 'post-rebind-drift')) model.modelId = 'other-model'
  // Mirrors the observed native layout AND live behavior: the restore warning
  // lives INSIDE the projection and survives same-model reselection; only a
  // send that carries the full published runtime descriptor clears it.
  const guarded = restored && !runtimeApplied
  return { projection: { status: fault === 'busy' && restored ? 'running' : 'idle',
      ...(guarded ? { lastError: { message: '历史任务使用的模型已不可用', type: 'ZCODE_RUNTIME_MODEL_UNAVAILABLE' } } : {}) },
    settings: { model: { current: model },
      runtimeModel: fault === 'unpublished-runtime' ? undefined : RUNTIME,
      mode: { current: rebound && fault === 'mode-drift' ? 'build' : 'plan' } } }
}
function event(type, payload = {}) {
  // Envelope-level turnId mirrors the verified real-CLI identity layout.
  const { turnId, ...rest } = payload
  const params = { sessionId: saved.id, seq: ++seq, type, payload: rest }
  if (turnId !== undefined) params.turnId = turnId
  out({ method: 'session/event', params })
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
    // Mirrors the native contract: a restored session refuses every send
    // until reselection is paired with a schema-valid FULL runtime descriptor
    // for the original model; still-guarded refuses even that.
    const rm = params.runtimeModel
    const runtimeValid = rm !== null && typeof rm === 'object' && !Array.isArray(rm) &&
      typeof rm.revision === 'string' && rm.revision.length > 0 &&
      typeof rm.generatedAt === 'number' && Number.isFinite(rm.generatedAt) &&
      rm.model?.providerId === 'private-provider' && rm.model?.modelId === 'private-model' &&
      rm.provider?.providerId === 'private-provider' &&
      ['anthropic', 'openai', 'openai-compatible'].includes(rm.provider?.kind) &&
      Array.isArray(rm.provider?.models) && rm.provider.models.some(m => m?.modelId === 'private-model')
    if (restored && (fault === 'still-guarded' || !runtimeValid)) { error(id); return }
    runtimeApplied = true
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
