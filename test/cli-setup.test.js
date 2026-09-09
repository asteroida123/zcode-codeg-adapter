import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { inspectSetup, choicesFrom, buildConfig, applySetup, SetupError } from '../scripts/setup-zcode-cli.mjs'
import { remoteIndicators } from '../spikes/backend-contract/diagnostics.mjs'
const execute = promisify(execFile)
const entry = fileURLToPath(new URL('../scripts/setup-zcode-cli.mjs', import.meta.url))
const secret = 'sk-SYNTHETIC-SETUP-SECRET'
const desktop = { mode: 'yolo', hooks: { enabled: true }, provider: {
  native: { kind: 'anthropic', enabled: true, options: { apiKey: secret, baseURL: 'https://example.invalid' }, models: { first: {}, second: {} } },
  disabled: { kind: 'anthropic', enabled: false, options: {}, models: { hidden: {} } },
} }
const code = expected => e => e instanceof SetupError && e.code === expected
async function fixture(t, cli) {
  const home = await mkdtemp(join(tmpdir(), 'zcode-setup-test-'))
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 3 }))
  const base = join(home, '.zcode')
  await mkdir(join(base, 'v2'), { recursive: true })
  await writeFile(join(base, 'v2/config.json'), JSON.stringify(desktop))
  await writeFile(join(base, 'v2/credentials.json'), 'DO NOT READ OR CHANGE')
  if (cli !== undefined) {
    await mkdir(join(base, 'cli'))
    await writeFile(join(base, 'cli/config.json'), JSON.stringify(cli))
  }
  return { home, base, snapshot: await inspectSetup(home) }
}

test('Setup: exact native model-config error is classified without disclosing path', () => {
  const out = remoteIndicators({ code: -32603, message: 'Model config is missing. Create /Users/example/.zcode/cli/config.json with an explicit model provider before running ZCode.' })
  assert.deepEqual(out, { remoteMessagePresent: true, remoteHints: ['model-configuration'] })
  assert.ok(!JSON.stringify(out).includes('/Users/'))
  assert.deepEqual(remoteIndicators({ message: 'Internal error' }).remoteHints, [])
})
test('Setup: dry inspection neither creates CLI directory nor changes native files', async t => {
  const { base, snapshot } = await fixture(t)
  assert.equal(snapshot.choices.length, 2)
  assert.equal(snapshot.target, null)
  await assert.rejects(lstat(join(base, 'cli')), { code: 'ENOENT' })
  assert.equal(await readFile(join(base, 'v2/credentials.json'), 'utf8'), 'DO NOT READ OR CHANGE')
})
test('Setup: CLI read-only summary contains no provider IDs, endpoint or secret', async t => {
  const { home, base } = await fixture(t)
  const { stdout, stderr } = await execute(process.execPath, [entry], { env: { ...process.env, HOME: home, USERPROFILE: home } })
  assert.deepEqual(JSON.parse(stdout), { status: 'inspected', writes: false, cliConfigExists: false,
    cliModelReferencePresent: false, selectableModels: 2, authenticationVerified: false, sessionVerified: false })
  assert.equal(stderr, '')
  assert.ok(!stdout.includes(secret))
  await assert.rejects(lstat(join(base, 'cli')), { code: 'ENOENT' })
})
test('Setup: only selected provider and string model.main are copied', async t => {
  const { snapshot } = await fixture(t)
  const next = buildConfig(snapshot, 1)
  assert.equal(next.model.main, 'native/second')
  assert.deepEqual(Object.keys(next.provider), ['native'])
  assert.equal(next.provider.native.options.apiKey, secret)
  assert.equal(next.mode, undefined)
  assert.equal(next.hooks, undefined)
  assert.equal(snapshot.source.data.model, undefined)
})
test('Setup: missing explicit confirmation prevents all writes', async t => {
  const { snapshot, base } = await fixture(t)
  await assert.rejects(applySetup(snapshot, 0), code('E_CONFIRM'))
  await assert.rejects(lstat(join(base, 'cli')), { code: 'ENOENT' })
})
test('Setup: no default-first selection or out-of-range selection', async t => {
  const { snapshot } = await fixture(t)
  for (const index of [undefined, -1, 2, 0.5, '1', NaN]) assert.throws(() => buildConfig(snapshot, index), code('E_SELECTION'))
})
test('Setup: confirmed creation is private, source and credentials stay unchanged', async t => {
  const { snapshot, base } = await fixture(t)
  const result = await applySetup(snapshot, 1, { confirmed: true })
  assert.equal(result.status, 'written')
  assert.equal(result.backedUp, false)
  assert.equal(result.authenticationVerified, false)
  const next = JSON.parse(await readFile(snapshot.targetPath, 'utf8'))
  assert.equal(next.model.main, 'native/second')
  assert.deepEqual(JSON.parse(await readFile(snapshot.sourcePath, 'utf8')), desktop)
  assert.equal(await readFile(join(base, 'v2/credentials.json'), 'utf8'), 'DO NOT READ OR CHANGE')
  if (process.platform !== 'win32') {
    assert.equal((await lstat(snapshot.targetPath)).mode & 0o777, 0o600)
    assert.equal((await lstat(snapshot.cliDir)).mode & 0o777, 0o700)
  }
  assert.deepEqual(await readdir(snapshot.cliDir), ['config.json'])
})
test('Setup: existing config fields and bytes are preserved in backup', async t => {
  const cli = { hooks: { enabled: false }, mode: 'plan', mcp: { servers: {} }, model: { lite: 'other/small' },
    provider: { other: { kind: 'openai', options: { apiKey: 'old-synthetic-key' } } } }
  const { snapshot } = await fixture(t, cli)
  const before = await readFile(snapshot.targetPath)
  const result = await applySetup(snapshot, 0, { confirmed: true })
  assert.ok(result.backedUp)
  assert.deepEqual(await readFile(join(snapshot.cliDir, result.backupName)), before)
  const next = JSON.parse(await readFile(snapshot.targetPath, 'utf8'))
  assert.deepEqual(next.hooks, cli.hooks)
  assert.deepEqual(next.provider.other, cli.provider.other)
  assert.deepEqual(next.mcp, cli.mcp)
  assert.equal(next.mode, 'plan')
  assert.deepEqual(next.model, { lite: 'other/small', main: 'native/first' })
  if (process.platform !== 'win32') assert.equal((await lstat(join(snapshot.cliDir, result.backupName))).mode & 0o777, 0o600)
})
test('Setup: an existing explicit model is not silently changed', async t => {
  const { snapshot } = await fixture(t, { model: { main: 'other/model' } })
  await assert.rejects(applySetup(snapshot, 0, { confirmed: true }), code('E_EXISTING_MODEL'))
  assert.deepEqual(await readdir(snapshot.cliDir), ['config.json'])
})
test('Setup: object-form missing model can be repaired without losing sibling models', async t => {
  const { snapshot } = await fixture(t, { model: { main: { provider: 'native', model: 'first' }, lite: 'other/small' } })
  assert.deepEqual(buildConfig(snapshot, 1).model, { main: 'native/second', lite: 'other/small' })
})
test('Setup: conflicting CLI provider is not overwritten', async t => {
  const { snapshot } = await fixture(t, { provider: { native: { kind: 'openai', options: {} } } })
  await assert.rejects(applySetup(snapshot, 0, { confirmed: true }), code('E_PROVIDER_CONFLICT'))
})
test('Setup: identical existing provider is retained', async t => {
  const { snapshot } = await fixture(t, { provider: { native: desktop.provider.native } })
  assert.deepEqual(buildConfig(snapshot, 1).provider.native, desktop.provider.native)
})
test('Setup: no plaintext key is invented for provider using native credential resolution', () => {
  const source = { provider: { native: { enabled: true, kind: 'anthropic', options: {}, models: { one: {} } } } }
  const snapshot = { source: { data: source }, target: null, choices: choicesFrom(source) }
  assert.deepEqual(buildConfig(snapshot, 0).provider.native.options, {})
})
test('Setup: absent or unusable desktop catalog fails without inventing a model', () => {
  for (const data of [{}, { provider: {} }, { provider: { p: { enabled: true, kind: 'anthropic', options: {}, models: {} } } }]) {
    assert.throws(() => choicesFrom(data), code('E_NO_DESKTOP_PROVIDER'))
  }
})
test('Setup: malformed CLI config is not reset or overwritten', async t => {
  const { home, snapshot } = await fixture(t, {})
  await writeFile(snapshot.targetPath, '{bad json')
  await assert.rejects(inspectSetup(home), code('E_CONFIG_FORMAT'))
  assert.equal(await readFile(snapshot.targetPath, 'utf8'), '{bad json')
  for (const data of [{ model: [] }, { model: 'model' }, { provider: [] }]) {
    assert.throws(() => buildConfig({ ...snapshot, target: { data } }, 0), code('E_CONFIG_FORMAT'))
  }
})
test('Setup: changed target after inspection stops without overwriting new bytes', async t => {
  const { snapshot } = await fixture(t, {})
  const changed = '{"custom":"changed"}'
  await writeFile(snapshot.targetPath, changed)
  await assert.rejects(applySetup(snapshot, 0, { confirmed: true }), code('E_CHANGED'))
  assert.equal(await readFile(snapshot.targetPath, 'utf8'), changed)
  assert.deepEqual(await readdir(snapshot.cliDir), ['config.json'])
})
test('Setup: changed desktop config after selection stops before copying credentials', async t => {
  const { snapshot } = await fixture(t)
  await writeFile(snapshot.sourcePath, '{}')
  await assert.rejects(applySetup(snapshot, 0, { confirmed: true }), code('E_CHANGED'))
  await assert.rejects(lstat(snapshot.targetPath), { code: 'ENOENT' })
})
test('Setup: newly appeared target is not clobbered', async t => {
  const { snapshot } = await fixture(t)
  await mkdir(snapshot.cliDir)
  await writeFile(snapshot.targetPath, '{}')
  await assert.rejects(applySetup(snapshot, 0, { confirmed: true }), code('E_CHANGED'))
  assert.equal(await readFile(snapshot.targetPath, 'utf8'), '{}')
})
test('Setup: existing lock is respected and not deleted', async t => {
  const { snapshot } = await fixture(t, {})
  const path = join(snapshot.cliDir, '.codeg-setup.lock')
  await writeFile(path, 'existing lock')
  await assert.rejects(applySetup(snapshot, 0, { confirmed: true }), code('E_LOCKED'))
  assert.equal(await readFile(path, 'utf8'), 'existing lock')
})
test('Setup: source symlink is refused', async t => {
  const { home, snapshot, base } = await fixture(t)
  const original = await readFile(snapshot.sourcePath)
  const other = join(base, 'other.json')
  await writeFile(other, original)
  await rm(snapshot.sourcePath)
  await symlink(other, snapshot.sourcePath)
  await assert.rejects(inspectSetup(home), code('E_UNSAFE_PATH'))
})
test('Setup: target directory symlink is refused', async t => {
  const { home, snapshot, base } = await fixture(t)
  const other = join(base, 'other')
  await mkdir(other)
  await symlink(other, snapshot.cliDir, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(inspectSetup(home), code('E_UNSAFE_PATH'))
})
test('Setup: interactive apply cannot be piped into automatic consent', async t => {
  const { home, snapshot } = await fixture(t)
  await assert.rejects(execute(process.execPath, [entry, '--apply'], { env: { ...process.env, HOME: home, USERPROFILE: home } }), e => {
    assert.ok(e.stderr.startsWith('E_TTY:'))
    assert.ok(!e.stderr.includes(secret))
    return true
  })
  await assert.rejects(lstat(snapshot.targetPath), { code: 'ENOENT' })
})
test('Setup: unknown CLI arguments are not echoed', async () => {
  await assert.rejects(execute(process.execPath, [entry, secret]), e => {
    assert.ok(e.stderr.startsWith('E_ARGS:'))
    assert.ok(!e.stderr.includes(secret))
    return true
  })
})
