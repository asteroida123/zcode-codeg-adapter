// Real pinned upstream, no fake backend and no model call. Not an E2E test.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { resolveUpstream, upstreamVersion } from '../src/launcher.js'

const entry = fileURLToPath(new URL('../bin/zcode-codeg.js', import.meta.url))

for (const shutdown of ['eof', ...(process.platform === 'win32' ? [] : ['sigterm'])]) {
  test(`real upstream initialize, method error and ${shutdown}`, { timeout: 30000 }, async (t) => {
    resolveUpstream() // Missing dependencies FAIL this test; never silently skip.
    const home = mkdtempSync(join(tmpdir(), 'zcode-acp-smoke-'))
    const cwd = join(home, 'workspace with spaces')
    mkdirSync(cwd)
    // Do not inherit provider credentials, NODE_OPTIONS or the user's ZCode state.
    const env = {}
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    Object.assign(env, {
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
      ZCODE_BIN: join(home, 'intentionally-absent-zcode.cjs'), ZCODE_NODE: process.execPath,
      ZCODE_ACP_LANG: 'en', ZCODE_ACP_DEBUG: '0',
      ZCODE_ACP_REMOTE: '1', ZCODE_ACP_REMOTE_TOKEN: 'test-not-a-real-token',
    })
    const child = spawn(process.execPath, [entry], { cwd, env, stdio: 'pipe' })
    const closed = once(child, 'close')
    // Do not leave a process running if an assertion/timeout aborts the test.
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed.catch(() => {})
      rmSync(home, { recursive: true, force: true })
    })
    let stderr = ''
    let buffer = ''
    let nextId = 1
    const pending = new Map()
    const frames = []
    let parseFailure
    child.stderr.setEncoding('utf8').on('data', (text) => { stderr = (stderr + text).slice(-8000) })
    child.stdout.setEncoding('utf8').on('data', (text) => {
      buffer += text
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const frame = JSON.parse(line)
          assert.equal(frame.jsonrpc, '2.0')
          frames.push(frame)
          if (pending.has(frame.id)) {
            pending.get(frame.id).resolve(frame)
            pending.delete(frame.id)
          }
        } catch (error) {
          parseFailure = error
          for (const waiter of pending.values()) waiter.reject(error)
          pending.clear()
        }
      }
    })
    child.on('close', () => {
      for (const waiter of pending.values()) waiter.reject(new Error(`Bridge exited before replying: ${stderr}`))
      pending.clear()
    })
    async function request(method, params) {
      const id = nextId++
      let timer
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}; ${stderr}`)) }, 15000)
          pending.set(id, { resolve, reject })
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
            if (error) { pending.delete(id); reject(error) }
          })
        })
      } finally { clearTimeout(timer) }
    }
    const initialized = await request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'codeg', version: 'adapter-contract-test' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    })
    assert.equal(initialized.error, undefined, JSON.stringify(initialized))
    assert.equal(initialized.result.protocolVersion, 1)
    assert.equal(initialized.result.agentInfo.version, upstreamVersion)
    assert.ok(initialized.result.authMethods.length > 0)
    assert.ok(initialized.result.agentCapabilities)
    const unknown = await request('codeg/nonexistent-contract-test', {})
    assert.equal(unknown.error.code, -32601)
    if (shutdown === 'eof') child.stdin.end()
    else child.kill('SIGTERM')
    const [code, signal] = await closed
    assert.equal(code, 0, stderr)
    assert.equal(signal, null)
    assert.equal(parseFailure, undefined)
    assert.equal(buffer.trim(), '')
    assert.ok(frames.length >= 2)
  })
}
