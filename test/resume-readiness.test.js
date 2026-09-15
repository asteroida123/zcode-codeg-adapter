import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runProbe, parseArgs, validateOptions } from '../spikes/backend-contract/probe.mjs'
import { rebindOriginalModel, modelReferenceFromSnapshot } from '../spikes/backend-contract/resume-model.mjs'
import { AppServerBackend } from '../spikes/backend-contract/backend.mjs'
import { diagnostic, ProbeError } from '../spikes/backend-contract/errors.mjs'
import { remoteIndicators } from '../spikes/backend-contract/diagnostics.mjs'

const fake = fileURLToPath(new URL('./fake-resume-model.cjs', import.meta.url))
const original = { providerId: 'private-provider', modelId: 'private-model' }
const snapshot = (model = original, status = 'idle', mode = 'plan') => ({
  settings: { model: { current: model }, mode: { current: mode } }, projection: { status },
})
const hasCode = code => error => error instanceof ProbeError && error.code === code
async function probe(t, fault = 'guard', rebind = false) {
  const old = process.env.FAKE_RESUME_FAULT
  process.env.FAKE_RESUME_FAULT = fault
  t.after(() => {
    if (old === undefined) delete process.env.FAKE_RESUME_FAULT
    else process.env.FAKE_RESUME_FAULT = old
  })
  // Exercise the live code path with a synthetic executable, NOT real ZCode.
  return runProbe(parseArgs(['--live', '--zcode', fake, '--allow-model', '--scenario', 'resume',
    ...(rebind ? ['--rebind-resume-model'] : [])]))
}

test('Resume: original selection is extracted without copying provider secrets', () => {
  assert.deepEqual(modelReferenceFromSnapshot(snapshot({ ...original, apiKey: 'sk-PRIVATE' })), original)
  for (const value of [undefined, { modelId: 'x' }, { providerId: '', modelId: 'x' }, { providerId: 'x', modelId: 1 }]) {
    assert.equal(modelReferenceFromSnapshot(snapshot(value ?? null)), null)
  }
})

for (const args of [[], ['--mock'], ['--live'], ['--live', '--allow-model', '--scenario', 'smoke'],
  ['--live', '--scenario', 'resume'], ['--live', '--allow-model', '--allow-file-test', '--scenario', 'resume']]) {
  test(`Resume: rebind scope rejects ${JSON.stringify(args)}`, () => {
    assert.throws(() => parseArgs([...args, '--rebind-resume-model']), hasCode('E_REBIND_SCOPE'))
  })
}
test('Resume: rebind may combine with opt-in local error capture', () => {
  const options = parseArgs(['--live', '--allow-model', '--local-error', '--scenario', 'resume', '--rebind-resume-model'])
  assert.equal(options.localError, true)
  assert.equal(options.rebindResumeModel, true)
})
test('Resume: programmatic callers cannot bypass opt-in or scope', async () => {
  assert.throws(() => validateOptions({ live: true, scenario: 'resume', allowModel: true, rebindResumeModel: 'true' }), hasCode('E_ARGS'))
  const subject = Object.create(AppServerBackend.prototype)
  subject.sessions = new Map([['s', { ready: true, resumed: true, modelRebindAttempted: false }]])
  subject.rpc = { request: () => assert.fail('must not dispatch') }
  await assert.rejects(subject.rebindResumedModel('s', original), hasCode('E_REBIND_SCOPE'))
  subject.sessions.get('s').resumed = false
  await assert.rejects(subject.rebindResumedModel('s', original, { allowRebind: true }), hasCode('E_REBIND_SCOPE'))
  subject.sessions.get('s').resumed = true
  subject.sessions.get('s').modelRebindAttempted = true
  await assert.rejects(subject.rebindResumedModel('s', original, { allowRebind: true }), hasCode('E_REBIND_ALREADY_ATTEMPTED'))
})

test('Resume: same-model request has no provider overlay, secrets or global persistence', async () => {
  const calls = []
  const rpc = { request: async (method, params) => { calls.push({ method, params }); return snapshot() } }
  const result = await rebindOriginalModel(rpc, 's', { ...original, apiKey: 'sk-PRIVATE' })
  assert.equal(result.verified, true)
  assert.deepEqual(calls, [
    { method: 'session/read', params: { sessionId: 's' } },
    { method: 'session/setModel', params: { sessionId: 's', model: original, persistAsWorkspaceLastUsed: false } },
    { method: 'session/read', params: { sessionId: 's' } },
  ])
  assert.ok(!JSON.stringify({ calls, result }).includes('sk-PRIVATE'))
})

for (const [state, errorCode] of [
  [snapshot({ ...original, modelId: 'other' }), 'E_RESUME_MODEL_CHANGED'],
  [snapshot(null), 'E_RESUME_MODEL_REFERENCE'],
  [snapshot(original, 'running'), 'E_RESUME_NOT_IDLE'],
  [snapshot(original, 'idle', 'build'), 'E_RESUME_MODE_CHANGED'],
]) {
  test(`Resume: precondition ${errorCode} forbids model mutation`, async () => {
    const methods = []
    await assert.rejects(rebindOriginalModel({ request: async method => { methods.push(method); return state } }, 's', original), hasCode(errorCode))
    assert.deepEqual(methods, ['session/read'])
  })
}

test('Resume: continued send relays only an explicit published runtime descriptor', async () => {
  const runtime = { revision: 'catalog-1', generatedAt: 1,
    model: { modelId: 'm' }, provider: { providerId: 'p' } }
  const build = () => {
    const subject = Object.create(AppServerBackend.prototype)
    subject.sessions = new Map([['s', { ready: true, active: null, finished: new Set() }]])
    subject.metrics = { staleEvents: 0, permissionsDenied: 0 }
    subject.heldPermissions = new Map()
    subject.rpc = { failure: null, closing: false,
      request: (method, params) => { subject.captured = { method, params }; return Promise.reject(new ProbeError('E_REMOTE', -32031)) },
      close: async () => ({ closed: true, escalated: false }) }
    return subject
  }
  const subject = build()
  await assert.rejects(subject.prompt('s', 'hello', { runtimeModel: runtime }), hasCode('E_REMOTE'))
  assert.equal(subject.captured.method, 'session/send')
  assert.deepEqual(subject.captured.params, { sessionId: 's', content: 'hello', runtimeModel: runtime })
  const invalid = build()
  await assert.rejects(invalid.prompt('s', 'hello', { runtimeModel: 'provider' }), hasCode('E_SEND_RUNTIME_MODEL'))
  assert.equal(invalid.captured, undefined)
  const bare = build()
  await assert.rejects(bare.prompt('s', 'hello'), hasCode('E_REMOTE'))
  assert.deepEqual(bare.captured.params, { sessionId: 's', content: 'hello' })
})

test('Resume: baseline failure preserves first answer and restored history, without automatic rebind', async t => {
  const report = await probe(t)
  assert.equal(report.status, 'fail')
  assert.equal(report.checks.at(-1).error.rpcMethod, 'session/send')
  assert.equal(report.checks.at(-1).error.rpcCode, -32031)
  assert.equal(report.resumeProgress.firstTurn.responseMarkerMatched, true)
  assert.equal(report.resumeProgress.historyRetained, true)
  assert.equal(report.resumeProgress.nativeResumeAccepted, true)
  assert.equal(report.resumeProgress.stage, 'continued-send')
  assert.equal(report.resumeProgress.rebindRequested, false)
  assert.equal(report.resumeProgress.runtimeModelRelayed, false)
  assert.equal(report.resumeProgress.modelRebind, undefined)
  assert.equal(report.resumeProgress.secondTurnRetainedContext, undefined)
  assert.ok(!report.failureContext.completedRpcMethods.includes('session/setModel'))
  assert.deepEqual(report.checks.at(-1).error.remoteHints, ['runtime-model-unavailable'])
  assert.deepEqual(report.cleanup, { workspaceRemoved: true, processesClosed: true })
})

test('Resume: guarded restore surfaces the native warning before the paid send', async t => {
  const report = await probe(t)
  assert.equal(report.resumeEvidenceRevision, 2)
  assert.equal(report.resumeProgress.restoreWarningBeforeSend, 'runtime-model-unavailable')
  for (const raw of ['ZCODE_RUNTIME_MODEL_UNAVAILABLE', '历史任务使用的模型已不可用']) {
    assert.ok(!JSON.stringify(report).includes(raw))
  }
})

test('Resume: opt-in reselection permits continued response in the synthetic guarded backend', async t => {
  const report = await probe(t, 'guard', true)
  assert.equal(report.status, 'pass')
  assert.equal(report.productionReady, false)
  assert.equal(report.resumeProgress.modelRebind.originalSelectionRetained, true)
  assert.equal(report.resumeProgress.modelRebind.planModeRetained, true)
  assert.equal(report.resumeProgress.historyRetainedAfterRebind, true)
  // Live 0.16.5 behavior: the warning survives same-model reselection; only a
  // send carrying the published runtime descriptor clears it.
  assert.equal(report.resumeProgress.restoreWarningBeforeSend, 'runtime-model-unavailable')
  assert.equal(report.resumeProgress.runtimeModelRelayed, true)
  assert.equal(report.resumeProgress.secondTurnRetainedContext, true)
  assert.equal(report.resumeProgress.stage, 'complete')
  for (const privateText of ['private-provider', 'private-model', 'sess-private', 'ZCODE_PROBE_', 'SYNTHETIC-SECRET',
    'ZCODE_RUNTIME_MODEL_UNAVAILABLE', '历史任务使用的模型已不可用']) {
    assert.ok(!JSON.stringify(report).includes(privateText))
  }
})

test('Resume: successful rebind never manufactures missing turn identity', async t => {
  const report = await probe(t, 'no-ids', true)
  assert.equal(report.status, 'inconclusive')
  assert.equal(report.resumeProgress.secondTurnRetainedContext, true)
  assert.equal(report.resumeProgress.firstTurn.terminalIdMatched, false)
  assert.equal(report.resumeProgress.continuedTurn.terminalIdMatched, false)
})

for (const [fault, errorCode, stage] of [
  ['missing-reference', 'E_RESUME_MODEL_REFERENCE', 'capture-original-model'],
  ['missing-restored-reference', 'E_RESUME_MODEL_REFERENCE', 'rebind-original-model'],
  ['pre-rebind-drift', 'E_RESUME_MODEL_CHANGED', 'rebind-original-model'],
  ['post-rebind-drift', 'E_RESUME_MODEL_CHANGED', 'rebind-original-model'],
  ['mode-drift', 'E_RESUME_MODE_CHANGED', 'rebind-original-model'],
  ['busy', 'E_RESUME_NOT_IDLE', 'rebind-original-model'],
  ['rebind-rejected', 'E_REMOTE', 'rebind-original-model'],
  ['still-guarded', 'E_REMOTE', 'continued-send'],
  ['unpublished-runtime', 'E_REMOTE', 'continued-send'],
  ['missing-history', 'E_HISTORY', 'read-restored-history'],
  ['lost-history', 'E_HISTORY', 'rebind-original-model'],
]) {
  test(`Resume: ${fault} remains a failure, not a repaired session`, async t => {
    const report = await probe(t, fault, true)
    assert.equal(report.status, 'fail')
    assert.equal(report.checks.at(-1).error.code, errorCode)
    assert.equal(report.resumeProgress.stage, stage)
    assert.equal(report.resumeProgress.firstTurn.responseMarkerMatched, true)
    assert.notEqual(report.resumeProgress.secondTurnRetainedContext, true)
    if (fault === 'rebind-rejected') assert.equal(report.checks.at(-1).error.rpcMethod, 'session/setModel')
    // A guard that survives reselection is reported, never silently cleared.
    if (fault === 'still-guarded' || fault === 'unpublished-runtime') {
      assert.equal(report.resumeProgress.restoreWarningBeforeSend, 'runtime-model-unavailable')
    }
    if (fault === 'unpublished-runtime') {
      // Mirrors live run evidence: without a relayed descriptor, reselection
      // alone still ends in the guarded -32031 send rejection.
      assert.equal(report.resumeProgress.runtimeModelRelayed, false)
      assert.equal(report.checks.at(-1).error.rpcCode, -32031)
    }
    assert.deepEqual(report.cleanup, { workspaceRemoved: true, processesClosed: true })
  })
}

test('Resume: numeric -32031 alone is never classified as model-unavailable', async t => {
  const report = await probe(t, 'unknown-code')
  assert.deepEqual(report.checks.at(-1).error.remoteHints, [])
})

test('Resume: explicit native model-unavailable reason survives only as an allowlisted hint', () => {
  for (const error of [
    { message: 'ZCODE_RUNTIME_MODEL_UNAVAILABLE sk-PRIVATE' },
    { data: { type: 'ZCODE_RUNTIME_MODEL_UNAVAILABLE', secret: 'sk-PRIVATE' } },
    { message: '历史任务使用的模型已不可用 /Users/private' },
  ]) {
    const safe = diagnostic(new ProbeError('E_REMOTE', -32031, remoteIndicators(error)))
    assert.deepEqual(safe.remoteHints, ['runtime-model-unavailable'])
    assert.ok(!JSON.stringify(safe).includes('PRIVATE'))
    assert.ok(!JSON.stringify(safe).includes('/Users'))
  }
})
