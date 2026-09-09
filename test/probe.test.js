import assert from 'node:assert/strict'
import test from 'node:test'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs, runProbe, saveReport } from '../spikes/backend-contract/probe.mjs'
const execute = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/probe-zcode.mjs', import.meta.url))
const fake = fileURLToPath(new URL('./fake-zcode.cjs', import.meta.url))

test('Probe: default is offline synthetic all-scenarios, never live', () => {
  assert.equal(parseArgs([]).live, false)
  assert.equal(parseArgs([]).scenario, 'all')
})
for (const args of [
  ['--live', '--scenario', 'smoke'], ['--live', '--scenario', 'cancel'],
  ['--live', '--scenario', 'resume'], ['--live', '--scenario', 'deny'],
  ['--live', '--allow-model', '--scenario', 'deny'],
  ['--live', '--mock'], ['--live', '--scenario', 'all'], ['--zcode', fake],
  ['--scenario', 'bad'], ['--scenario'], ['--mock', '--mock'], ['--secret-option'],
]) {
  test(`Probe: rejects unsafe or ambiguous arguments ${JSON.stringify(args)}`, () => {
    assert.throws(() => parseArgs(args))
  })
}
test('Probe: mock executes lifecycle, streaming, deny, cancel and real process restart', async () => {
  const report = await runProbe(parseArgs([]))
  assert.equal(report.status, 'pass')
  assert.equal(report.productionReady, false)
  assert.equal(report.evidence, 'synthetic')
  for (const name of ['session', 'smoke', 'deny', 'cancel', 'resume']) {
    assert.equal(report.checks.find(check => check.name === name)?.outcome, 'pass', name)
  }
  assert.deepEqual(report.cleanup, { processesClosed: true, workspaceRemoved: true })
  const text = JSON.stringify(report)
  for (const sensitive of ['SYNTHETIC-SECRET', 'ZCODE_PROBE_', 'sess_', '/private/path', 'workspacePath', 'requestId']) {
    assert.ok(!text.includes(sensitive), sensitive)
  }
})
test('Probe: CLI outputs only valid report JSON', async () => {
  const { stdout, stderr } = await execute(process.execPath, [script], { timeout: 15000 })
  assert.equal(JSON.parse(stdout).evidence, 'synthetic')
  assert.equal(stderr, '')
})
test('Probe: invalid CLI arguments are not echoed and no report is faked', async () => {
  await assert.rejects(execute(process.execPath, [script, '--sk-SECRET'], { timeout: 5000 }), error => {
    assert.equal(error.code, 2)
    assert.equal(error.stdout, '')
    assert.equal(error.stderr.includes('sk-SECRET'), false)
    assert.equal(JSON.parse(error.stderr).code, 'E_ARGS')
    return true
  })
})
test('Probe: --live alone inspects only, and refuses an unspecified runtime', async () => {
  const options = parseArgs(['--live'])
  assert.equal(options.scenario, 'inspect')
  // Explicit invalid path makes this independent of any developer ZCODE_BIN.
  const report = await runProbe({ ...options, zcode: 'relative-not-authorized.cjs' })
  assert.equal(report.status, 'fail')
  assert.equal(report.checks.at(-1).error.code, 'E_ZCODE_PATH')
})
test('Probe: live version mismatch stops before app-server or model dispatch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-version-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const entry = join(dir, 'version.cjs')
  const called = join(dir, 'unexpected-server')
  await writeFile(entry, `if(process.argv.includes('--version')) console.log('0.99.0'); else require('fs').writeFileSync(${JSON.stringify(called)}, 'bad')`)
  const report = await runProbe(parseArgs(['--live', '--zcode', entry, '--scenario', 'session']))
  assert.equal(report.status, 'fail')
  assert.equal(report.cliVersion, '0.99.0')
  assert.equal(report.checks.at(-1).error.code, 'E_VERSION_MISMATCH')
  await assert.rejects(stat(called), { code: 'ENOENT' })
})
test('Probe: deny checks filesystem effect, not only the policy reply', async () => {
  const old = process.env.FAKE_ZCODE_FAULT
  process.env.FAKE_ZCODE_FAULT = 'ignores-denial'
  try {
    // Test-only executable, isolated workspace; this is not real ZCode evidence.
    const report = await runProbe(parseArgs(['--live', '--zcode', fake, '--allow-model', '--allow-file-test', '--scenario', 'deny']))
    assert.equal(report.status, 'fail')
    assert.equal(report.checks.at(-1).error.code, 'E_PERMISSION_EFFECT')
  } finally {
    if (old === undefined) delete process.env.FAKE_ZCODE_FAULT
    else process.env.FAKE_ZCODE_FAULT = old
  }
})
test('Probe: report writes are exclusive and do not clobber existing data', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-report-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const out = join(dir, 'report.json')
  await saveReport(out, { example: 'synthetic' })
  await assert.rejects(saveReport(out, {}), { code: 'E_REPORT_WRITE' })
  assert.equal(JSON.parse(await readFile(out, 'utf8')).example, 'synthetic')
  if (process.platform !== 'win32') assert.equal((await stat(out)).mode & 0o777, 0o600)
})
test('Probe: already-aborted run never spawns a backend', async () => {
  const controller = new AbortController(); controller.abort()
  const report = await runProbe(parseArgs([]), { signal: controller.signal })
  assert.equal(report.status, 'fail')
  assert.equal(report.checks[0].error.code, 'E_ABORTED')
})

test('Probe: programmatic entry cannot bypass model opt-in', async () => {
  await assert.rejects(runProbe({ live: true, scenario: 'smoke', zcode: fake }), { code: 'E_MODEL_OPT_IN' })
})
for (const [fault, scenario] of [['stop-natural', 'cancel'], ['no-permission', 'deny']]) {
  test(`Probe: ${fault} is inconclusive, not a successful safety test`, async () => {
    const old = process.env.FAKE_ZCODE_FAULT
    process.env.FAKE_ZCODE_FAULT = fault
    try {
      const report = await runProbe(parseArgs(['--live', '--zcode', fake, '--allow-model', '--allow-file-test', '--scenario', scenario]))
      assert.equal(report.status, 'inconclusive')
      assert.equal(report.checks.find(check => check.name === scenario).outcome, 'inconclusive')
    } finally {
      if (old === undefined) delete process.env.FAKE_ZCODE_FAULT
      else process.env.FAKE_ZCODE_FAULT = old
    }
  })
}

for (const [method, completed] of [
  ['session/create', []],
  ['session/subscribe', ['session/create']],
  ['session/read', ['session/create', 'session/subscribe']],
  ['session/messages', ['session/create', 'session/subscribe', 'session/read']],
]) {
  test(`Probe: -32603 at ${method} reports exact failing operation and completed calls`, async t => {
    const old = process.env.FAKE_ZCODE_FAULT
    process.env.FAKE_ZCODE_FAULT = `remote-error:${method}`
    t.after(() => {
      if (old === undefined) delete process.env.FAKE_ZCODE_FAULT
      else process.env.FAKE_ZCODE_FAULT = old
    })
    // The live-mode code path uses our fake executable; it is NOT ZCode evidence.
    const report = await runProbe(parseArgs(['--live', '--zcode', fake, '--scenario', 'session']))
    assert.equal(report.status, 'fail')
    assert.equal(report.diagnosticRevision, 2)
    assert.deepEqual(report.checks.at(-1).error, { code: 'E_REMOTE', rpcCode: -32603,
      rpcMethod: method, remoteMessagePresent: true, remoteHints: ['model-configuration'] })
    assert.deepEqual(report.failureContext.completedRpcMethods, completed)
    assert.equal(report.failureContext.interactions.preferences, 1)
    assert.deepEqual(report.failureContext.reverseRpcMethods, [{ method: 'session/requestRuntimePreferences', count: 1 }])
    assert.deepEqual(report.cleanup, { workspaceRemoved: true, processesClosed: true })
    const text = JSON.stringify(report)
    for (const privateText of ['SYNTHETIC-SECRET', 'No model configured', '/private/path', 'workspacePath', 'sess_']) {
      assert.ok(!text.includes(privateText), privateText)
    }
  })
}

test('Probe: failure retains evidence of unsupported auth callback, without returning its token', async t => {
  const old = process.env.FAKE_ZCODE_FAULT
  process.env.FAKE_ZCODE_FAULT = 'unsupported-auth'
  t.after(() => {
    if (old === undefined) delete process.env.FAKE_ZCODE_FAULT
    else process.env.FAKE_ZCODE_FAULT = old
  })
  const report = await runProbe(parseArgs(['--live', '--zcode', fake, '--scenario', 'session']))
  assert.equal(report.status, 'fail')
  assert.equal(report.checks.at(-1).error.rpcMethod, 'session/create')
  // Generic -32603 remains unclassified even when a callback preceded it.
  assert.deepEqual(report.checks.at(-1).error.remoteHints, [])
  assert.equal(report.failureContext.interactions.unsupportedInteractions, 1)
  assert.deepEqual(report.failureContext.reverseRpcMethods, [{ method: 'interaction/requestOfficialMcpAuthHeaders', count: 1 }])
  assert.ok(!JSON.stringify(report).includes('SYNTHETIC-SECRET'))
})
