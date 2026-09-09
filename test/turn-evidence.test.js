import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerBackend } from '../spikes/backend-contract/backend.mjs'
import { parseArgs, runProbe } from '../spikes/backend-contract/probe.mjs'
import { identityShape, modelObservation } from '../spikes/backend-contract/turn-evidence.mjs'

// Independent SYNTHETIC wire fixture. No real ZCode, inherited HOME, credentials,
// native transcripts or network. The fake IDs deliberately look like secrets.
const server = String.raw`
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('0.16.5'); process.exit(0); }
const fs = require('node:fs');
const mode = process.argv[2];
let seq = 0, answer = '', history = [];
try { history = JSON.parse(fs.readFileSync('synthetic-history.json', 'utf8')); } catch {}
const out = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const event = (type, payload) => {
  const params = { sessionId: 'synthetic-session', seq: ++seq, type, payload };
  if (mode === 'envelope') params.turnId = 'sk-PRIVATE-TURN';
  if (mode === 'payload') payload.turnId = 'sk-PRIVATE-TURN';
  if (mode === 'execution') payload.foregroundExecutionId = 'sk-PRIVATE-EXECUTION';
  out({ method: 'session/event', params });
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const {id, method, params} = JSON.parse(line);
  if (method === 'session/create') out({id, result: { session: { sessionId: 'synthetic-session', workspace: params.workspace } }});
  if (method === 'session/resume') out({id, result: { session: { sessionId: params.sessionId, workspace: params.workspace } }});
  if (method === 'session/subscribe') out({id, result: {eventSeq: seq}});
  if (method === 'session/send') {
    answer = params.content.includes('token you replied with earlier') ? history.at(-1)?.parts[0].text : (params.content.match(/ZCODE_PROBE_[a-f0-9]+/)?.[0] ?? params.content);
    history.push({info: {role: 'assistant'}, parts: [{type: 'text', text: answer}]});
    fs.writeFileSync('synthetic-history.json', JSON.stringify(history));
    out({id, result: {accepted: true}});
    event('turn.started', {});
    event('model.streaming', {kind: 'text_delta', text: answer});
    event('turn.completed', {resultType: 'success'});
  }
  if (method === 'session/read') out({id, result: {projection: {status: 'idle'}}});
  if (method === 'session/messages') out({id, result: {messages: history}});
});
`

async function fixture(t, mode) {
  const cwd = await mkdtemp(join(tmpdir(), 'zcode-evidence-test-'))
  const script = join(cwd, 'synthetic.cjs')
  await writeFile(script, server.replace('const mode = process.argv[2];', `const mode = ${JSON.stringify(mode)};`))
  const env = { HOME: cwd, USERPROFILE: cwd }
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TMP', 'TEMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const backend = new AppServerBackend({ command: process.execPath, args: [script, mode], cwd, env, timeoutMs: 5000 })
  t.after(async () => { await backend.close(); await rm(cwd, { recursive: true, force: true, maxRetries: 3 }) })
  return { backend, cwd, script }
}

const absent = { envelopeTurnId: 'absent', payloadTurnId: 'absent', foregroundExecutionId: 'absent' }

test('Turn evidence: absent fields are observations, not manufactured IDs', () => {
  assert.deepEqual(identityShape({payload: {}}), absent)
  assert.deepEqual(identityShape(undefined), absent)
})
test('Turn evidence: candidate ID locations never expose any value or arbitrary key', () => {
  const shape = identityShape({turnId: 'sk-SECRET-A', payload: {turnId: 'sk-SECRET-B',
    foregroundExecutionId: '/private/SECRET', 'sk-SECRET-KEY': 'ignored'}})
  assert.deepEqual(shape, { envelopeTurnId: 'string', payloadTurnId: 'string', foregroundExecutionId: 'string' })
  assert.ok(!JSON.stringify(shape).includes('SECRET'))
})
test('Turn evidence: invalid identities are not treated as missing or valid', () => {
  for (const value of [null, undefined, '', 123, {}, [], 'x'.repeat(513)]) {
    assert.equal(identityShape({payload: {turnId: value}}).payloadTurnId, 'invalid')
  }
})
test('Turn evidence: private snapshot values do not enter model observations', () => {
  const result = {terminalIdMatched: false, turnIdObserved: false}
  const snapshot = {lastAssistantHasMarker: true, idle: true, text: 'sk-SECRET', path: '/private/SECRET'}
  const observed = modelObservation(result, snapshot)
  assert.equal(observed.responseMarkerMatched, true)
  assert.equal(observed.stateIdleAfterTurn, true)
  assert.equal(observed.turnCorrelation, 'unverified')
  assert.equal(observed.terminalIdMatched, false)
  assert.ok(!JSON.stringify(observed).includes('SECRET'))
  assert.deepEqual(result, {terminalIdMatched: false, turnIdObserved: false})
})
test('Turn evidence: a matched ID cannot manufacture a verified answer or idle state', () => {
  const observed = modelObservation({terminalIdMatched: true}, {lastAssistantHasMarker: false, idle: false})
  assert.equal(observed.turnCorrelation, 'matched-payload-turn-id')
  assert.equal(observed.responseMarkerMatched, false)
  assert.equal(observed.stateIdleAfterTurn, false)
})

for (const mode of ['missing', 'envelope', 'execution', 'payload']) {
  test(`Turn evidence: ${mode} wire identity preserves strict attribution`, async t => {
    const {backend, cwd} = await fixture(t, mode)
    const id = await backend.open(cwd)
    const result = await backend.prompt(id, 'ZCODE_PROBE_SYNTHETIC', {timeoutMs: 5000})
    const snapshot = await backend.inspect(id, 'ZCODE_PROBE_SYNTHETIC')
    const observed = modelObservation(result, snapshot)
    assert.equal(observed.responseMarkerMatched, true)
    assert.equal(observed.stateIdleAfterTurn, true)
    assert.equal(observed.streams, 1)
    assert.equal(observed.terminalObserved, true)
    assert.equal(observed.turnIdObserved, mode === 'payload')
    assert.equal(observed.terminalIdMatched, mode === 'payload')
    assert.equal(observed.turnCorrelation, mode === 'payload' ? 'matched-payload-turn-id' : 'unverified')
    const expected = { ...absent }
    if (mode === 'payload') expected.payloadTurnId = 'string'
    if (mode === 'envelope') expected.envelopeTurnId = 'string'
    if (mode === 'execution') expected.foregroundExecutionId = 'string'
    assert.deepEqual(observed.identityEvidence, {startCount: 1, firstStart: expected, terminal: expected})
    for (const privateValue of ['sk-PRIVATE', 'synthetic-session', 'ZCODE_PROBE_SYNTHETIC']) {
      assert.ok(!JSON.stringify(observed).includes(privateValue))
    }
    assert.equal((await backend.close()).closed, true)
  })
}

for (const mode of ['missing', 'envelope', 'execution', 'payload']) {
  test(`Probe report: ${mode} identity does not turn verified output into fake attribution`, async t => {
    const { script } = await fixture(t, mode)
    // Drives the live code path with a synthetic executable, NOT live ZCode.
    const report = await runProbe(parseArgs(['--live', '--zcode', script, '--allow-model', '--scenario', 'smoke']))
    assert.equal(report.turnEvidenceRevision, 1)
    assert.equal(report.status, mode === 'payload' ? 'pass' : 'inconclusive')
    assert.equal(report.productionReady, false)
    const check = report.checks.find(check => check.name === 'smoke')
    assert.equal(check.outcome, report.status)
    assert.equal(check.observed.responseMarkerMatched, true)
    assert.equal(check.observed.terminalIdMatched, mode === 'payload')
    assert.deepEqual(report.cleanup, {workspaceRemoved: true, processesClosed: true})
    for (const secret of ['sk-PRIVATE', 'ZCODE_PROBE_', 'synthetic-session']) assert.ok(!JSON.stringify(report).includes(secret))
  })
}

test('Probe report: ID-less resume retains both turns and stays inconclusive', async t => {
  const { script } = await fixture(t, 'missing')
  const report = await runProbe(parseArgs(['--live', '--zcode', script, '--allow-model', '--scenario', 'resume']))
  assert.equal(report.status, 'inconclusive')
  const result = report.checks.find(check => check.name === 'resume').observed
  assert.equal(result.historyRetained, true)
  assert.equal(result.secondTurnRetainedContext, true)
  for (const turn of [result.firstTurn, result.continuedTurn]) {
    assert.equal(turn.responseMarkerMatched, true)
    assert.equal(turn.stateIdleAfterTurn, true)
    assert.equal(turn.turnCorrelation, 'unverified')
    assert.equal(turn.terminalIdMatched, false)
  }
  assert.deepEqual(report.cleanup, {workspaceRemoved: true, processesClosed: true})
})
