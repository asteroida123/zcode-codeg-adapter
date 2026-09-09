import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rm, stat, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { localErrorTexts, LocalErrorCapture } from '../spikes/backend-contract/local-error.mjs'
import { remoteIndicators } from '../spikes/backend-contract/diagnostics.mjs'
import { parseArgs, runProbe } from '../spikes/backend-contract/probe.mjs'
import { PrivateRpc } from '../spikes/backend-contract/rpc.mjs'
const execute = promisify(execFile)
const fake = fileURLToPath(new URL('./fake-zcode.cjs', import.meta.url))
const cli = fileURLToPath(new URL('../scripts/probe-zcode.mjs', import.meta.url))
const secret = 'sk-SYNTHETIC-SECRET'
function failingCreate(t) {
  const before = process.env.FAKE_ZCODE_FAULT
  process.env.FAKE_ZCODE_FAULT = 'remote-error:session/create'
  t.after(() => {
    if (before === undefined) delete process.env.FAKE_ZCODE_FAULT
    else process.env.FAKE_ZCODE_FAULT = before
  })
}
function clean(t, path) { t.after(() => rm(dirname(path), { recursive: true, force: true, maxRetries: 3 })) }

test('Local diagnostics: string data.details and cause are classified without copying text', () => {
  for (const field of ['detail', 'details', 'cause', 'error', 'data']) {
    const error = { code: -32603, message: 'Internal error', data: { [field]: `No model configured ${secret}` } }
    assert.deepEqual(remoteIndicators(error), { remoteMessagePresent: true, remoteHints: ['model-configuration'] })
    assert.ok(!JSON.stringify(remoteIndicators(error)).includes(secret))
  }
  assert.deepEqual(remoteIndicators({ arbitrary: { details: 'No model configured' } }),
    { remoteMessagePresent: false, remoteHints: [] })
  assert.deepEqual(remoteIndicators({ message: 'Internal error', data: { details: 'Unrecognised failure' } }).remoteHints, [])
})

test('Local diagnostics: local projection is bounded and excludes separate stack and arbitrary values', () => {
  const error = { message: `Internal error ${secret}`, stack: 'NEVER_STACK', token: 'NEVER_TOKEN',
    data: { details: 'native explanation', arbitrary: { message: 'NEVER_PAYLOAD' } } }
  const texts = localErrorTexts(error)
  assert.deepEqual(texts.map(x => x.location), ['error.message', 'error.data.details'])
  assert.ok(JSON.stringify(texts).includes(secret), 'Local text is explicitly NOT guaranteed sanitized')
  for (const absent of ['NEVER_STACK', 'NEVER_TOKEN', 'NEVER_PAYLOAD']) assert.ok(!JSON.stringify(texts).includes(absent))
  const big = { message: 'x'.repeat(100000), issues: Array.from({ length: 100 }, () => ({ message: 'y'.repeat(100000) })) }
  const bounded = localErrorTexts(big)
  assert.ok(bounded.length <= 8)
  assert.ok(bounded.every(x => x.text.length <= 2048 && x.truncated))
  assert.ok(JSON.stringify(bounded).length < 20000)
})

test('Local diagnostics: construction and unknown methods create no file', () => {
  const sink = new LocalErrorCapture()
  sink.capture('unknown/private-method', { message: secret })
  assert.equal(sink.path, undefined)
  assert.deepEqual(sink.status(), { enabled: true, attempted: false, saved: false, failed: false })
  assert.equal(JSON.stringify(sink), '{}')
})

test('Local diagnostics: first known error alone is saved in a private new directory', async t => {
  const sink = new LocalErrorCapture()
  sink.capture('session/create', { code: -32603, message: secret })
  assert.ok(sink.path)
  clean(t, sink.path)
  const before = await readFile(sink.path, 'utf8')
  assert.equal(JSON.parse(before).messages[0].text, secret)
  assert.equal(JSON.parse(before).rpcMethod, 'session/create')
  sink.capture('session/read', { code: -32603, message: 'must not overwrite' })
  assert.equal(await readFile(sink.path, 'utf8'), before)
  assert.ok(!JSON.stringify(sink.status()).includes(secret))
  assert.equal(JSON.stringify(sink), '{}')
  if (process.platform !== 'win32') {
    assert.equal((await stat(sink.path)).mode & 0o777, 0o600)
    assert.equal((await stat(dirname(sink.path))).mode & 0o777, 0o700)
  }
})

test('Local diagnostics: private temporary output inside the checkout is rejected', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const dir = await mkdtemp(join(root, 'zcode-test-private-'))
  const before = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].map(key => [key, process.env[key]]))
  try {
    for (const key of Object.keys(before)) process.env[key] = dir
    const sink = new LocalErrorCapture()
    sink.capture('session/create', { message: secret })
    assert.deepEqual(sink.status(), { enabled: true, attempted: true, saved: false, failed: true })
    assert.equal(sink.path, undefined)
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('Local diagnostics: explicit live session scope is enforced by CLI and programmatic entry', async () => {
  for (const args of [ ['--local-error'], ['--live', '--local-error'],
    ['--live', '--allow-model', '--scenario', 'smoke', '--local-error'],
    ['--live', '--allow-model', '--scenario', 'session', '--local-error'] ]) {
    assert.throws(() => parseArgs(args), error => error.code === 'E_LOCAL_ERROR_SCOPE')
  }
  await assert.rejects(runProbe({ live: false, scenario: 'all', localError: true }), error => error.code === 'E_LOCAL_ERROR_SCOPE')
  await assert.rejects(runProbe({ live: true, scenario: 'session', localError: 'yes' }), error => error.code === 'E_ARGS')
})

test('Local diagnostics: default failure still produces no private capture', async t => {
  failingCreate(t)
  let called = false
  const report = await runProbe(parseArgs(['--live', '--zcode', fake, '--scenario', 'session']),
    { onLocalErrorFile: path => { called = true; clean(t, path) } })
  assert.equal(report.status, 'fail')
  assert.equal(called, false)
  assert.equal(report.localErrorCapture, undefined)
  assert.ok(!JSON.stringify(report).includes(secret))
})

test('Local diagnostics: opt-in preserves exact explanation locally while report stays codes-only', async t => {
  failingCreate(t)
  let path
  const report = await runProbe(parseArgs(['--live', '--zcode', fake, '--scenario', 'session', '--local-error']),
    { onLocalErrorFile: value => { path = value; clean(t, path) } })
  assert.equal(report.status, 'fail', 'Diagnostics must not convert a native error into success')
  assert.equal(report.diagnosticRevision, 3)
  assert.deepEqual(report.localErrorCapture, { enabled: true, attempted: true, saved: true, failed: false })
  const local = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(local.rpcMethod, 'session/create')
  assert.equal(local.messages[0].text, `No model configured ${secret} /private/path`)
  for (const privateText of [secret, '/private/path', 'No model configured', path]) assert.ok(!JSON.stringify(report).includes(privateText))
  assert.deepEqual(report.cleanup, { workspaceRemoved: true, processesClosed: true })
})

test('Local diagnostics: unmatched late errors never reach the local sink', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-private-late-'))
  let calls = 0
  const rpc = new PrivateRpc({ command: process.execPath, args: [fake], cwd: dir,
    onRemoteError: () => { calls++ } })
  t.after(async () => { await rpc.close(); await rm(dir, { recursive: true, force: true, maxRetries: 3 }) })
  rpc.route({ id: 999, error: { code: -32603, message: secret } })
  await assert.rejects(rpc.request('test/error-details', { error: { code: -32603, message: secret } }))
  assert.equal(calls, 0, 'Unreviewed local method names do not reach the sink either')
})

test('Local diagnostics: CLI reports only a path on stderr, never the original explanation', async t => {
  let result
  try {
    await execute(process.execPath, [cli, '--live', '--zcode', fake, '--scenario', 'session', '--local-error'],
      { env: { ...process.env, FAKE_ZCODE_FAULT: 'remote-error:session/create' }, timeout: 15000 })
    assert.fail('native error must remain exit 1')
  } catch (error) { result = error }
  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.stdout).status, 'fail')
  const line = result.stderr.split('\n').find(line => line.startsWith('本机错误文件'))
  assert.ok(line)
  const path = JSON.parse(line.slice(line.indexOf('：') + 1))
  clean(t, path)
  assert.ok((await readFile(path, 'utf8')).includes(secret))
  for (const text of [result.stdout, result.stderr]) {
    assert.ok(!text.includes(secret))
    assert.ok(!text.includes('No model configured'))
  }
})


test('Local diagnostics: opt-in successful session creates no private error file', async t => {
  let path
  const report = await runProbe(parseArgs(['--live', '--zcode', fake, '--scenario', 'session', '--local-error']),
    { onLocalErrorFile: value => { path = value; clean(t, path) } })
  assert.equal(report.status, 'pass')
  assert.equal(path, undefined)
  assert.deepEqual(report.localErrorCapture, { enabled: true, attempted: false, saved: false, failed: false })
})
