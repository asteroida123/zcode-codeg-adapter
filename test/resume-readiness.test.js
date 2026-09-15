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
  ['--live', '--scenario', 'resume'], ['--live', '--allow-model', '--allow-file-test', '--scenario', 'resume'],
  ['--live', '--allow-model', '--local-error', '--scenario', 'resume']]) {
  test(`Resume: rebind scope rejects ${JSON.stringify(args)}`, () => {
    assert.throws(() => parseArgs([...args, '--rebind-resume-model']), hasCode('E_REBIND_SCOPE'))
  })
}
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
  assert.equal(report.resumeProgress.modelRebind, undefined)
  assert.equal(report.resumeProgress.secondTurnRetainedContext, undefined)
  assert.ok(!report.failureContext.completedRpcMethods.includes('session/setModel'))
  assert.deepEqual(report.cleanup, { workspaceRemoved: true, processesClosed: true })
})

test('Resume: opt-in reselection permits continued response in the synthetic guarded backend', async t => {
  const report = await probe(t, 'guard', true)
  assert.equal(report.status, 'pass')
  assert.equal(report.productionReady, false)
  assert.equal(report.resumeProgress.modelRebind.originalSelectionRetained, true)
  assert.equal(report.resumeProgress.modelRebind.planModeRetained, true)
  assert.equal(report.resumeProgress.historyRetainedAfterRebind, true)
  assert.equal(report.resumeProgress.secondTurnRetainedContext, true)
  assert.equal(report.resumeProgress.stage, 'complete')
  for (const privateText of ['private-provider', 'private-model', 'sess-private', 'ZCODE_PROBE_', 'SYNTHETIC-SECRET']) {
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
