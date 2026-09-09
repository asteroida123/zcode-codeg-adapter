// SYNTHETIC fixture, not a recorded ZCode transcript. Never launch against user data.
const { createInterface } = require('node:readline')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
if (process.argv.includes('--version')) { console.log('0.16.5'); process.exit(0) }
const fault = process.env.FAKE_ZCODE_FAULT || ''
const storage = path.join(process.cwd(), '.fake-native-sessions.json')
let sessions = {}
try { sessions = JSON.parse(fs.readFileSync(storage, 'utf8')) } catch {}
const active = new Map()
const backwards = new Map()
let heldAck
const heldResponses = []
let reverseId = 1 // Deliberately collides with the client's first request ID.
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n')
const reply = (id, result) => send({ id, result })
const error = (id, code = -32601) => send({ id, error: { code, message: 'sk-SYNTHETIC-SECRET /private/path' } })
function reverse(method, params) {
  const id = reverseId++
  return new Promise(resolve => { backwards.set(id, resolve); send({ id, method, params }) })
}
function persist() { fs.writeFileSync(storage, JSON.stringify(sessions)) }
function event(id, type, payload = {}, seq) {
  send({ method: 'session/event', params: { sessionId: id, type, seq: seq ?? ++sessions[id].seq, payload } })
}
function finish(id, resultType, text) {
  const task = active.get(id)
  if (!task) return
  clearTimeout(task.timer)
  active.delete(id)
  if (text) sessions[id].messages.push({ info: { role: 'assistant' }, parts: [{ type: 'text', text }] })
  event(id, 'turn.completed', { turnId: task.turnId, resultType })
  persist()
}
async function handle(frame) {
  if (!frame.method) {
    const done = backwards.get(frame.id)
    if (done) { backwards.delete(frame.id); done(frame.result) }
    return
  }
  const { id, method, params = {} } = frame
  if (frame.jsonrpc) { error(id, -32600); return }
  if (method === 'test/echo') { reply(id, params); return }
  if (method === 'test/error') { error(id, -32004); return }
  if (method === 'test/hold') { heldResponses.push(id); return }
  if (method === 'test/flush') { for (const held of heldResponses.splice(0)) reply(held, { late: true }); reply(id, {}); return }
  if (method === 'test/release-ack') { reply(heldAck, { accepted: true }); reply(id, {}); return }
  if (method === 'test/late') { setTimeout(() => reply(id, { late: true }), params.ms); return }
  if (method === 'test/exit') { process.exit(9) }
  if (method === 'test/frame') { process.stdout.write(params.text); return }
  if (method === 'test/fragment') {
    const buf = Buffer.from(JSON.stringify({ id, result: '你好' }) + '\n')
    const start = buf.indexOf(Buffer.from('你'))
    process.stdout.write(buf.subarray(0, start + 1))
    setTimeout(() => process.stdout.write(buf.subarray(start + 1)), 5)
    return
  }
  if (method === 'test/reverse') {
    const result = await reverse(params.method ?? 'unknown/reverse', {})
    reply(id, result ?? { denied: true }); return
  }
  if (method === 'test/oversize') { process.stdout.write('x'.repeat(4096)); return }
  if (method === 'test/utf8') { process.stdout.write(Buffer.from([255, 10])); return }
  if (method === 'test/truncated') {
    // stdout.end() alone does not reliably close a Windows process pipe.
    // Flush the incomplete frame, then exit so every OS observes a real EOF.
    process.stdout.write('{', () => process.exit(0))
    return
  }
  if (method === 'test/reverse-duplicate') {
    const reverse = { id: 'repeat', method: 'unknown/reverse', params: {} }
    send(reverse); send(reverse); return
  }
  if (method === 'test/hang') return
  if (method === 'session/create') {
    const prefs = await reverse('session/requestRuntimePreferences', {})
    if (prefs?.askUserQuestionAutoResolutionEnabled !== false) { error(id, -32602); return }
    const sid = `sess_${randomUUID()}`
    sessions[sid] = { cwd: params.workspace.workspacePath, messages: [], seq: 0 }
    persist()
    reply(id, { session: { sessionId: sid, workspace: params.workspace } }); return
  }
  if (method === 'session/resume') {
    const s = sessions[params.sessionId]
    if (!s) { error(id, -32004); return }
    reply(id, { session: { sessionId: fault === 'wrong-resume' ? 'wrong' : params.sessionId,
      workspace: { workspacePath: s.cwd, workspaceKey: s.cwd } } }); return
  }
  const s = sessions[params.sessionId]
  if (!s) { error(id, -32004); return }
  if (method === 'session/subscribe') {
    if (fault === 'subscribe-error') { error(id, -32602); return }
    // Historical terminal comes before the subscription reply: not this turn.
    event(params.sessionId, 'turn.completed', { turnId: 'old', resultType: 'success' })
    reply(id, { eventSeq: s.seq }); return
  }
  if (method === 'session/read') { reply(id, { projection: { status: active.has(params.sessionId) ? 'running' : 'idle' } }); return }
  if (method === 'session/messages') { reply(id, { messages: s.messages }); return }
  if (method === 'session/stop') {
    if (fault !== 'ignore-stop') finish(params.sessionId, fault === 'stop-natural' ? 'success' : 'cancelled')
    if (id !== undefined) reply(id, {})
    return
  }
  if (method !== 'session/send') { error(id); return }
  if (active.has(params.sessionId)) { error(id, -32010); return }
  const sid = params.sessionId
  const turnId = `turn_${randomUUID()}`
  const previous = s.messages.filter(m => m.info.role === 'assistant').at(-1)?.parts[0].text ?? ''
  s.messages.push({ info: { role: 'user' }, parts: [{ type: 'text', text: params.content }] })
  const task = { turnId, timer: null }
  active.set(sid, task)
  event(sid, 'turn.started', { turnId })
  event(sid, 'model.streaming', { turnId, kind: 'text_delta', text: 'sk-SYNTHETIC-SECRET' })
  if (fault === 'stale-terminal') event(sid, 'turn.completed', { turnId: 'different-old-turn', resultType: 'success' })
  if (fault === 'duplicate-seq') event(sid, 'model.streaming', { turnId, kind: 'text_delta', text: 'duplicate' }, s.seq)
  if (fault === 'send-error') { error(id, -32010); return }
  if (fault === 'early-terminal') {
    finish(sid, 'success', 'early')
    heldAck = id
    return
  }
  reply(id, { accepted: true })
  if (params.content.includes('deny-sentinel.txt')) {
    if (fault === 'no-permission') { finish(sid, 'success', 'no action'); return }
    const permission = await reverse('interaction/requestPermission', { sessionId: sid, requestId: 'test', toolCallId: 'write' })
    event(sid, 'tool.updated', { turnId, status: permission?.decision === 'deny' ? 'error' : 'result' })
    if (permission?.decision !== 'deny' || fault === 'ignores-denial') fs.writeFileSync('deny-sentinel.txt', 'unexpected write')
    finish(sid, 'success', 'denied'); return
  }
  const marker = params.content.match(/ZCODE_PROBE_[a-f0-9]+/)?.[0] ?? previous
  task.timer = setTimeout(() => finish(sid, 'success', marker), params.content.includes('long response') ? 10000 : 30)
}
process.stderr.write('synthetic log sk-SYNTHETIC-SECRET /private/path\n')
const input = createInterface({ input: process.stdin })
input.on('line', line => {
  try { Promise.resolve(handle(JSON.parse(line))).catch(() => process.exit(2)) } catch { process.exit(2) }
})
input.on('close', () => {
  if (fault === 'ignore-eof') {
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 1000)
  } else process.exit(0)
})
