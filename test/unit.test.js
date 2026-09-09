import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import test from 'node:test'
import { assertNode, codegEnvironment, manifest, parseArgs, upstreamVersion } from '../src/launcher.js'

const root = fileURLToPath(new URL('../', import.meta.url))

// A fake upstream tests the wrapper, NOT ZCode or upstream protocol correctness.
function fixture(t, { source = 'export async function main() { process.stdin.pipe(process.stdout) }', version = upstreamVersion, installed = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zcode wrapper test '))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const path of ['bin', 'src', 'package.json']) {
    cpSync(join(root, path), join(dir, path), { recursive: true })
  }
  if (installed) {
    const pkg = join(dir, 'node_modules/zcode-acp-server')
    mkdirSync(join(pkg, 'dist'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({
      name: 'zcode-acp-server', version, type: 'module', main: 'dist/index.js',
    }))
    writeFileSync(join(pkg, 'dist/index.js'), source)
  }
  const entry = join(dir, 'bin/zcode-codeg.js')
  return {
    dir, entry,
    run(args = [], extra = {}) {
      const result = spawnSync(process.execPath, [entry, ...args], {
        cwd: dir, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, ...extra,
      })
      assert.ifError(result.error)
      return result
    },
  }
}

for (const [args, expected] of [
  [[], 'server'], [['server'], 'server'], [['doctor'], 'doctor'],
  [['--help'], 'help'], [['-h'], 'help'], [['--version'], 'version'],
]) {
  test(`CLI accepts ${JSON.stringify(args)}`, () => assert.equal(parseArgs(args), expected))
}

test('CLI rejects unknown or extra arguments without echoing them', () => {
  for (const args of [['serve'], ['tui'], ['hub'], ['doctor', '--secret'], ['--token=SECRET']]) {
    assert.throws(() => parseArgs(args), (error) => error.code === 'E_ARGS' && !error.message.includes('SECRET'))
  }
})

test('Node floor and real Node runtime are enforced', () => {
  for (const node of ['20.19.0', '22.12.0', 'bad', '22.13.0-pre']) {
    assert.throws(() => assertNode({ node }), { code: 'E_NODE' })
  }
  for (const node of ['22.13.0', '22.16.0', '24.0.0']) assert.doesNotThrow(() => assertNode({ node }))
  assert.throws(() => assertNode({ node: '24.0.0', bun: '1.4.0' }), { code: 'E_NODE' })
})

test('environment is stdio-only without modifying its input', () => {
  const input = {
    HOME: '/home/user', PATH: '/bin', HTTPS_PROXY: 'proxy',
    ZCODE_BIN: '/path with spaces/zcode.cjs', ZCODE_NODE: '/node',
    ZCODE_MODEL: 'chosen-model', ZCODE_BASE_URL: 'provider',
    ZCODE_ACP_SANDBOX: '1', ZCODE_ACP_DEBUG: '1', ZCODE_ACP_LANG: 'zh',
    ZCODE_ACP_REMOTE: '1', ZCODE_ACP_REMOTE_TOKEN: 'test-only-secret',
    ZCODE_ACP_REMOTE_PIN_CWD: '1', ZCODE_ACP_HUB_PORT: '8377',
    ZCODE_ACP_RUNTIME: 'bun', ZCODE_ACP_RESUME_SESSION: 'other-session',
    ZCODE_ACP_BOOT_CREATE_SESSION: '1',
  }
  const original = { ...input }
  const output = codegEnvironment(input)
  assert.deepEqual(input, original)
  assert.equal(output.ZCODE_ACP_REMOTE, '0')
  assert.equal(output.ZCODE_ACP_RUNTIME, 'node')
  for (const key of ['ZCODE_ACP_REMOTE_TOKEN', 'ZCODE_ACP_REMOTE_PIN_CWD', 'ZCODE_ACP_HUB_PORT', 'ZCODE_ACP_RESUME_SESSION', 'ZCODE_ACP_BOOT_CREATE_SESSION']) assert.equal(key in output, false)
  for (const key of ['HOME', 'PATH', 'HTTPS_PROXY', 'ZCODE_BIN', 'ZCODE_NODE', 'ZCODE_MODEL', 'ZCODE_BASE_URL', 'ZCODE_ACP_SANDBOX', 'ZCODE_ACP_DEBUG', 'ZCODE_ACP_LANG']) assert.equal(output[key], input[key])
  assert.deepEqual(codegEnvironment(output), output)
})

test('mixed-case Windows environment keys cannot reactivate remote routing', () => {
  const output = codegEnvironment({ zcode_acp_remote: '1', Zcode_Acp_Remote_Token: 'secret', zcode_acp_runtime: 'bun' })
  assert.deepEqual(output, { ZCODE_ACP_REMOTE: '0', ZCODE_ACP_RUNTIME: 'node' })
})

test('dependency is exactly pinned and publishing has no build/install hooks', () => {
  assert.match(upstreamVersion, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(Object.keys(manifest.dependencies), ['zcode-acp-server'])
  for (const name of ['install', 'postinstall', 'prepare', 'prepublishOnly']) assert.equal(manifest.scripts[name], undefined)
  assert.equal(manifest.bin['zcode-codeg'], 'bin/zcode-codeg.js')
})

test('--version works without upstream and prints only the adapter version', (t) => {
  const result = fixture(t, { installed: false }).run(['--version'])
  assert.equal(result.status, 0)
  assert.equal(result.stdout, `${manifest.version}\n`)
  assert.equal(result.stderr, '')
})

test('--help works without upstream; bare launch fails instead of faking ACP', (t) => {
  const app = fixture(t, { installed: false })
  assert.match(app.run(['--help']).stdout, /stdio/)
  const result = app.run()
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /E_DEPENDENCY/)
})

test('unknown arguments produce stderr only and exit 2', (t) => {
  const result = fixture(t).run(['--credential=TEST_SECRET'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /E_ARGS/)
  assert.doesNotMatch(result.stderr, /TEST_SECRET/)
})

test('a different upstream version fails before importing code', (t) => {
  const result = fixture(t, { version: '999.0.0', source: 'console.log("SHOULD_NOT_IMPORT")' }).run()
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /E_UPSTREAM_CONTRACT/)
})

test('doctor is explicitly launcher-only and never imports upstream', (t) => {
  const result = fixture(t, { source: 'throw new Error("SHOULD_NOT_IMPORT")' }).run(['doctor'])
  assert.equal(result.status, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.scope, 'launcher-only')
  for (const key of ['zcodeInstallation', 'authentication', 'acpHandshake']) assert.equal(report[key], 'not-checked')
})

test('environment is set before import; main runs once in the same process and cwd', (t) => {
  const source = `
    const atImport = process.env.ZCODE_ACP_REMOTE;
    let calls = 0;
    export async function main() {
      process.stdout.write(JSON.stringify({ atImport, runtime: process.env.ZCODE_ACP_RUNTIME,
        token: process.env.ZCODE_ACP_REMOTE_TOKEN, sandbox: process.env.ZCODE_ACP_SANDBOX,
        calls: ++calls, pid: process.pid, cwd: process.cwd() }) + '\\n');
    }
  `
  const app = fixture(t, { source })
  const result = app.run([], { env: { ...process.env, ZCODE_ACP_REMOTE: '1', ZCODE_ACP_REMOTE_TOKEN: 'secret', ZCODE_ACP_SANDBOX: '1' } })
  assert.equal(result.status, 0)
  const output = JSON.parse(result.stdout)
  assert.equal(output.atImport, '0')
  assert.equal(output.runtime, 'node')
  assert.equal(output.token, undefined)
  assert.equal(output.sandbox, '1')
  assert.equal(output.calls, 1)
  assert.equal(output.pid, result.pid)
  assert.equal(output.cwd, app.dir)
})

test('wrapper does not parse or rewrite stdio bytes (mock echo server)', (t) => {
  const input = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n中文\r\n\u0000\n'
  const result = fixture(t).run(['server'], { input })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, input)
})

test('missing main export fails with no protocol output', (t) => {
  const result = fixture(t, { source: 'export const notMain = 1' }).run()
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /E_UPSTREAM_CONTRACT/)
})

for (const [name, source, code] of [
  ['import', 'throw new Error("TEST_SECRET")', 'E_UPSTREAM_IMPORT'],
  ['startup', 'export async function main() { throw new Error("TEST_SECRET") }', 'E_UPSTREAM_START'],
]) {
  test(`${name} failure is redacted, not reported as successful startup`, (t) => {
    const result = fixture(t, { source }).run()
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, new RegExp(code))
    assert.doesNotMatch(result.stderr, /TEST_SECRET/)
  })
}

test('normal startup adds no transport or permission implementation', () => {
  const source = readFileSync(join(root, 'src/launcher.js'), 'utf8')
  assert.doesNotMatch(source, /node:(child_process|http|net|readline)/)
  assert.doesNotMatch(source, /allow_always|allow_once|yolo|request_permission/)
})

test('SIGTERM reaches upstream directly (mock lifecycle, POSIX)', { skip: process.platform === 'win32', timeout: 10000 }, async (t) => {
  const app = fixture(t, { source: `export async function main() {
    process.on('SIGTERM', () => process.exit(0));
    process.stdin.resume();
    process.stdout.write('ready\\n');
  }` })
  const child = spawn(process.execPath, [app.entry], { cwd: app.dir, stdio: 'pipe' })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  child.stderr.resume()
  const closed = once(child, 'close')
  await once(child.stdout, 'data')
  child.kill('SIGTERM')
  const [code, signal] = await closed
  assert.equal(code, 0)
  assert.equal(signal, null)
})
