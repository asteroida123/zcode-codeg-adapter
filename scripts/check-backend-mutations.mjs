// Small, targeted negative controls, not a general mutation testing framework.
// Mutate only a temporary copy. The checked-out source is never modified.
import { mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const root = fileURLToPath(new URL('../', import.meta.url))
const cases = [
  { name: 'permission deny', file: 'backend.mjs', pattern: 'Backend: permission denial',
    before: "return { decision: 'deny', reason:", after: "return { decision: 'allow', reason:" },
  { name: 'send acceptance barrier', file: 'backend.mjs', pattern: 'Backend: terminal before send acknowledgement',
    before: 'if (!turn.accepted || !turn.terminal || turn.settled) return', after: 'if (!turn.terminal || turn.settled) return' },
  { name: 'reverse-request namespace', file: 'rpc.mjs', pattern: 'RPC: reverse request ID',
    before: '    if (hasMethod) {',
    after: '    if (hasMethod && hasId && this.pending.has(frame.id)) { this.pending.get(frame.id)(null, frame.params); return }\n    if (hasMethod) {' },
]
for (const mutation of cases) {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-mutation-'))
  try {
    await cp(join(root, 'spikes'), join(dir, 'spikes'), { recursive: true })
    await cp(join(root, 'test'), join(dir, 'test'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{"type":"module"}')
    const run = () => spawnSync(process.execPath,
      ['--test', '--test-name-pattern', mutation.pattern, 'test/backend-contract.test.js'],
      { cwd: dir, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 })
    assert.equal(run().status, 0, `${mutation.name}: baseline must pass`)
    const path = join(dir, 'spikes/backend-contract', mutation.file)
    const source = await readFile(path, 'utf8')
    assert.equal(source.split(mutation.before).length, 2, 'Mutation must match exactly once')
    await writeFile(path, source.replace(mutation.before, mutation.after))
    assert.ok((await readFile(path, 'utf8')).includes(mutation.after), 'Verify mutation actually landed')
    const result = run()
    assert.equal(result.status, 1, `${mutation.name}: mutated test must fail, not hang or pass`)
    assert.ok(result.stdout.includes('not ok') && result.stdout.includes('# fail 1'), 'Must be an assertion failure')
    console.log(`Detected mutation: ${mutation.name}`)
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3 }) }
}
