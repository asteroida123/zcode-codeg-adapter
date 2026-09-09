import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrivateRpc } from '../spikes/backend-contract/rpc.mjs'
import { AppServerBackend } from '../spikes/backend-contract/backend.mjs'
import { diagnostic, ProbeError } from '../spikes/backend-contract/errors.mjs'
const fake = fileURLToPath(new URL('./fake-zcode.cjs', import.meta.url))
async function fixture(t, fault = '', backend = false, extra = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'zcode backend test '))
  const env = { HOME: cwd, USERPROFILE: cwd, FAKE_ZCODE_FAULT: fault }
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TMP', 'TEMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const options = { command: process.execPath, args: [fake], cwd, env, timeoutMs: 1000, ...extra }
  const client = backend ? new AppServerBackend(options) : new PrivateRpc(options)
  t.after(async () => { await client.close(); await rm(cwd, { recursive: true, force: true, maxRetries: 3 }) })
  return { client, cwd, options }
}
const code = expected => error => error instanceof ProbeError && error.code === expected

// Real subprocess transport tests. No real ZCode or network access.
test('RPC: preserves Unicode split within a UTF-8 codepoint', async t => {
  const { client } = await fixture(t)
  assert.equal(await client.request('test/fragment'), '你好')
})
test('RPC: reverse request ID cannot resolve a same-ID outgoing request', async t => {
  let callbacks = 0
  const { client } = await fixture(t, '', false, { onRequest: () => { callbacks++; return { actual: 'callback' } } })
  assert.deepEqual(await client.request('test/reverse'), { actual: 'callback' })
  assert.equal(callbacks, 1)
})
test('RPC: rejects remote errors without retaining backend message or paths', async t => {
  const { client } = await fixture(t)
  await assert.rejects(client.request('test/error'), error => {
    assert.deepEqual(diagnostic(error), { code: 'E_REMOTE', rpcCode: -32004, remoteMessagePresent: true, remoteHints: [] })
    assert.ok(!JSON.stringify(error).includes('SYNTHETIC-SECRET'))
    return true
  })
})
test('RPC: timeout removes waiter; late response cannot fulfil a later call', async t => {
  const { client } = await fixture(t)
  await client.request('test/echo') // Wait for process startup before short deadlines.
  await assert.rejects(client.request('test/hold', {}, { timeoutMs: 15 }), code('E_TIMEOUT'))
  assert.deepEqual(await client.request('test/echo', { next: true }), { next: true })
  await client.request('test/flush')
  assert.equal(client.pending.size, 0)
  assert.equal(client.stats.lateResponses, 1)
})
test('RPC: abort is local cancellation, removes waiter and ignores late result', async t => {
  const { client } = await fixture(t)
  await client.request('test/echo')
  const controller = new AbortController()
  const pending = client.request('test/hold', {}, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, code('E_ABORTED'))
  await client.request('test/flush')
  assert.equal(client.pending.size, 0)
  assert.equal(client.stats.lateResponses, 1)
})
test('RPC: already aborted requests are not written', async t => {
  const { client } = await fixture(t)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(client.request('test/exit', {}, { signal: controller.signal }), code('E_ABORTED'))
  assert.deepEqual(await client.request('test/echo', { alive: true }), { alive: true })
})
for (const [name, text] of [
  ['non-JSON', 'banner sk-SYNTHETIC-SECRET\n'],
  ['array', '[]\n'], ['null', 'null\n'],
  ['wrong protocol', '{"jsonrpc":"2.0","id":1,"result":{}}\n'],
  ['two result branches', '{"id":1,"result":{},"error":{}}\n'],
  ['invalid ID', '{"id":{},"result":{}}\n'],
  ['invalid params', '{"method":"event","params":[]}\n'],
  ['missing result', '{"id":1}\n'],
]) {
  test(`RPC: ${name} fails closed and rejects pending calls`, async t => {
    const { client } = await fixture(t)
    await assert.rejects(client.request('test/frame', { text }), code('E_FRAME'))
    assert.equal(client.pending.size, 0)
    assert.equal((await client.close()).closed, true)
  })
}
for (const method of ['test/utf8', 'test/truncated']) {
  test(`RPC: ${method} fails without hanging`, async t => {
    const { client } = await fixture(t)
    await assert.rejects(client.request(method), code('E_FRAME'))
  })
}
test('RPC: oversized unterminated output is bounded', async t => {
  const { client } = await fixture(t, '', false, { maxFrameBytes: 1024 })
  await assert.rejects(client.request('test/oversize'), code('E_LIMIT'))
})
test('RPC: duplicate reverse IDs fail rather than replying twice', async t => {
  const { client } = await fixture(t)
  await assert.rejects(client.request('test/reverse-duplicate'), code('E_DUPLICATE_ID'))
})
test('RPC: child death settles all waiters', async t => {
  const { client } = await fixture(t)
  const hanging = client.request('test/hang')
  const dying = client.request('test/exit')
  const results = await Promise.allSettled([hanging, dying])
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'E_EXIT'))
  assert.equal(client.pending.size, 0)
})
test('RPC: missing executable produces structured spawn failure', async t => {
  const { client } = await fixture(t, '', false, { command: join(tmpdir(), 'does-not-exist-zcode-probe'), args: [] })
  await assert.rejects(client.request('test/echo'), code('E_SPAWN'))
})
test('RPC: close is idempotent and escalates if EOF is ignored', async t => {
  const { client } = await fixture(t, 'ignore-eof')
  await client.request('test/echo')
  const first = client.close()
  assert.equal(first, client.close())
  const result = await first
  assert.equal(result.closed, true)
  assert.equal(result.escalated, true)
  await assert.rejects(client.request('test/echo'), code('E_CLOSED'))
})
test('RPC: stderr is drained but not stored as diagnostic text', async t => {
  const { client } = await fixture(t)
  await client.request('test/echo')
  assert.ok(client.stats.stderrBytes > 0)
  assert.ok(!JSON.stringify(client.stats).includes('SYNTHETIC-SECRET'))
})

test('Backend: preferences handshake, subscribe-before-send and complete turn', async t => {
  const { client, cwd } = await fixture(t, '', true)
  const id = await client.open(cwd)
  const result = await client.prompt(id, 'ZCODE_PROBE_abcdef')
  assert.equal(result.streams, 1)
  assert.equal(result.terminalObserved, true)
  assert.equal(client.metrics.preferences, 1)
  assert.equal((await client.inspect(id, 'ZCODE_PROBE_abcdef')).lastAssistantHasMarker, true)
})
test('Backend: terminal before send acknowledgement cannot settle early', async t => {
  const { client, cwd } = await fixture(t, 'early-terminal', true)
  const id = await client.open(cwd)
  let settled = false
  const prompt = client.prompt(id, 'hi').then(result => { settled = true; return result })
  await client.rpc.request('test/echo')
  assert.equal(settled, false)
  await client.rpc.request('test/release-ack')
  assert.equal((await prompt).terminalObserved, true)
})
test('Backend: send rejection cannot be disguised as success', async t => {
  const { client, cwd } = await fixture(t, 'send-error', true)
  const id = await client.open(cwd)
  await assert.rejects(client.prompt(id, 'hi'), code('E_REMOTE'))
})
test('Backend: permission denial has a tested negative filesystem effect', async t => {
  const { client, cwd } = await fixture(t, '', true)
  const id = await client.open(cwd, { mode: 'build' })
  const result = await client.prompt(id, 'Write deny-sentinel.txt once')
  assert.equal(result.denied, 1)
  assert.equal(result.tools, 1)
  await assert.rejects(access(join(cwd, 'deny-sentinel.txt')), { code: 'ENOENT' })
})
test('Backend: concurrent prompt in one session is rejected', async t => {
  const { client, cwd } = await fixture(t, '', true)
  const id = await client.open(cwd)
  const prompt = client.prompt(id, 'hi')
  await assert.rejects(client.prompt(id, 'second'), code('E_BUSY'))
  await prompt
})
test('Backend: separate sessions route streams independently', async t => {
  const { client, cwd } = await fixture(t, '', true)
  const a = await client.open(cwd)
  const b = await client.open(cwd)
  const results = await Promise.all([client.prompt(a, 'ZCODE_PROBE_aaaa'), client.prompt(b, 'ZCODE_PROBE_bbbb')])
  assert.ok(results.every(result => result.streams === 1))
  assert.equal((await client.inspect(a, 'ZCODE_PROBE_aaaa')).lastAssistantHasMarker, true)
  assert.equal((await client.inspect(b, 'ZCODE_PROBE_bbbb')).lastAssistantHasMarker, true)
})
test('Backend: duplicate event sequence is not counted twice', async t => {
  const { client, cwd } = await fixture(t, 'duplicate-seq', true)
  const id = await client.open(cwd)
  assert.equal((await client.prompt(id, 'hi')).streams, 1)
  assert.equal(client.metrics.staleEvents, 1)
})
test('Backend: unrelated terminal cannot complete a current turn', async t => {
  const { client, cwd } = await fixture(t, 'stale-terminal', true)
  const id = await client.open(cwd)
  await client.prompt(id, 'ZCODE_PROBE_aaaa')
  assert.equal(client.metrics.staleEvents, 1)
  assert.equal((await client.inspect(id, 'ZCODE_PROBE_aaaa')).lastAssistantHasMarker, true)
})
test('Backend: cancel is sent once and waits for terminal observation', async t => {
  const { client, cwd } = await fixture(t, '', true)
  const id = await client.open(cwd)
  const result = await client.prompt(id, 'long response', { cancelOnStream: true })
  assert.equal(result.cancelSent, true)
  assert.equal(result.cancelled, true)
  assert.equal(client.cancel(id), false)
})
test('Backend: ignored stop fails, poisons process, does not fake cancelled', async t => {
  const { client, cwd } = await fixture(t, 'ignore-stop', true)
  const id = await client.open(cwd)
  await assert.rejects(client.prompt(id, 'long response', { cancelOnStream: true, cancelTimeoutMs: 50 }), code('E_CANCEL_UNCONFIRMED'))
  await assert.rejects(client.prompt(id, 'retry'), code('E_CLOSED'))
})
test('Backend: turn deadline is bounded even if no terminal arrives', async t => {
  const { client, cwd } = await fixture(t, '', true)
  const id = await client.open(cwd)
  await assert.rejects(client.prompt(id, 'long response', { timeoutMs: 50 }), code('E_TURN_TIMEOUT'))
})
test('Backend: failed subscribe does not leave a promptable session', async t => {
  const { client, cwd } = await fixture(t, 'subscribe-error', true)
  await assert.rejects(client.open(cwd), code('E_REMOTE'))
  assert.equal(client.sessions.size, 0)
})
test('Backend: missing resume never creates a fresh substitute session', async t => {
  const { client, cwd } = await fixture(t, '', true)
  await assert.rejects(client.open(cwd, { sessionId: 'missing' }), code('E_REMOTE'))
  assert.equal(client.sessions.size, 0)
  await assert.rejects(readFile(join(cwd, '.fake-native-sessions.json')), { code: 'ENOENT' })
})
test('Backend: cross-process resume preserves native identity and history', async t => {
  const { client, cwd, options } = await fixture(t, '', true)
  const id = await client.open(cwd)
  await client.prompt(id, 'ZCODE_PROBE_aaaa')
  await client.close()
  const second = new AppServerBackend(options)
  try {
    assert.equal(await second.open(cwd, { sessionId: id }), id)
    assert.equal((await second.inspect(id, 'ZCODE_PROBE_aaaa')).lastAssistantHasMarker, true)
  } finally { await second.close() }
})
test('Backend: resume returning a different ID is rejected', async t => {
  const { client, cwd, options } = await fixture(t, '', true)
  const id = await client.open(cwd)
  await client.close()
  const second = new AppServerBackend({ ...options, env: { ...options.env, FAKE_ZCODE_FAULT: 'wrong-resume' } })
  try { await assert.rejects(second.open(cwd, { sessionId: id }), code('E_SESSION_ID')) }
  finally { await second.close() }
})

// Diagnostics are observations, not guessed repairs. These tests use only fake errors.
test('Diagnostics: categories never retain message, cause, paths, tokens or arbitrary keys', async t => {
  const { client } = await fixture(t)
  const nativeError = { code: -32603,
    message: 'No model configured sk-SYNTHETIC-SECRET /private/path',
    data: { cause: { code: 'MISSING_CREDENTIAL', message: 'api key is missing sk-OTHER-SECRET' },
      'sk-KEY-SECRET': 'sk-VALUE-SECRET' },
    stack: '/Users/private-name/secret.cjs:99',
  }
  await assert.rejects(client.request('test/error-details', { error: nativeError }), error => {
    assert.deepEqual(diagnostic(error), { code: 'E_REMOTE', rpcCode: -32603,
      remoteMessagePresent: true, remoteHints: ['authentication', 'model-configuration'] })
    assert.ok(!JSON.stringify(error).includes('SECRET'))
    assert.ok(!JSON.stringify(error).includes('/private'))
    assert.equal(error.cause, undefined)
    return true
  })
})

test('Diagnostics: unknown backend text remains unknown, not automatically an auth failure', async t => {
  const { client } = await fixture(t)
  for (const message of ['Internal error', 'sk-SECRET /private/path', '', undefined, { secret: 'no model configured' }]) {
    await assert.rejects(client.request('test/error-details', { error: { code: -32603, message } }), error => {
      assert.deepEqual(diagnostic(error), { code: 'E_REMOTE', rpcCode: -32603,
        remoteMessagePresent: typeof message === 'string' && message.length > 0, remoteHints: [] })
      return true
    })
  }
})

test('Diagnostics: structured symbols distinguish files, dependencies, state and schema', async t => {
  const { client } = await fixture(t)
  for (const [symbol, hint] of [['ENOENT', 'file-missing'], ['EACCES', 'filesystem-access'],
    ['ERR_MODULE_NOT_FOUND', 'runtime-dependency'], ['SQLITE_BUSY', 'state-store'],
    ['invalid_union', 'request-schema'], ['ECONNREFUSED', 'network']]) {
    await assert.rejects(client.request('test/error-details', { error: { code: -32603, data: { code: symbol } } }), error => {
      assert.deepEqual(diagnostic(error).remoteHints, [hint])
      assert.equal(diagnostic(error).remoteMessagePresent, false)
      return true
    })
  }
})

test('Diagnostics: error text inspection is bounded, not a payload traversal', async t => {
  const { client } = await fixture(t)
  await assert.rejects(client.request('test/error-details', { error: { code: -32603,
    message: 'x'.repeat(3000) + ' no model configured',
    arbitraryPayload: { message: 'authentication failed' },
  } }), error => {
    assert.deepEqual(diagnostic(error).remoteHints, [])
    return true
  })
})

test('Diagnostics: extra fields and forged operation labels cannot enter public output', () => {
  const error = new ProbeError('E_REMOTE', -32603, { rpcMethod: '/private/SECRET',
    remoteHints: ['authentication', 'authentication', 'sk-SECRET', { secret: true }],
    remoteMessagePresent: 'sk-SECRET', stack: '/private/SECRET', message: 'sk-SECRET' })
  assert.deepEqual(diagnostic(error), { code: 'E_REMOTE', rpcCode: -32603, remoteHints: ['authentication'] })
  error.details.rpcMethod = 'session/create'
  error.details.secret = 'sk-SECRET'
  error.details.remoteHints.push('sk-SECRET')
  assert.deepEqual(diagnostic(error), { code: 'E_REMOTE', rpcCode: -32603,
    rpcMethod: 'session/create', remoteHints: ['authentication'] })
})

test('Diagnostics: one transport fault gives each concurrent request its own operation', async t => {
  const { client } = await fixture(t)
  const first = client.request('session/read', {})
  const second = client.request('session/messages', {})
  client.fail(new ProbeError('E_PIPE'))
  const results = await Promise.allSettled([first, second])
  assert.equal(diagnostic(results[0].reason).rpcMethod, 'session/read')
  assert.equal(diagnostic(results[1].reason).rpcMethod, 'session/messages')
  assert.notEqual(results[0].reason, results[1].reason)
})

test('Diagnostics: context counts reverse calls without exposing unknown names', async t => {
  const { client } = await fixture(t)
  await client.request('test/reverse', { method: 'interaction/requestOfficialMcpAuthHeaders' })
  await client.request('test/reverse', { method: 'sk-SECRET/private' })
  const context = client.diagnostics()
  assert.deepEqual(context.reverseRpcMethods, [{ method: 'interaction/requestOfficialMcpAuthHeaders', count: 1 }])
  assert.equal(context.unknownReverseRequests, 1)
  assert.equal(context.transport.reverseRequests, 2)
  assert.ok(!JSON.stringify(context).includes('SECRET'))
})
