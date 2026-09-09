import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ProbeError, object } from './errors.mjs'

const own = (value, key) => Object.hasOwn(value, key)
const validId = id => (typeof id === 'string' && id.length <= 512) || Number.isSafeInteger(id)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Private NDJSON transport, NOT an ACP server. No JSON-RPC version field.
 * Request and reverse-request IDs occupy separate namespaces. A reverse request
 * must never resolve an outgoing call, even when their numeric IDs collide.
 */
export class PrivateRpc {
  constructor({ command, args = [], cwd, env, timeoutMs = 10000, maxFrameBytes = 4 * 1024 * 1024,
    onNotification = () => {}, onRequest = () => { throw new ProbeError('E_METHOD', -32601) },
    onFault = () => {} }) {
    this.timeoutMs = timeoutMs
    this.maxFrameBytes = maxFrameBytes
    this.onNotification = onNotification
    this.onRequest = onRequest
    this.onFault = onFault
    this.pending = new Map()
    this.reverseIds = new Set()
    this.nextId = 1
    this.buffer = Buffer.alloc(0)
    this.failure = null
    this.closing = false
    this.closePromise = null
    this.stats = { received: 0, lateResponses: 0, reverseRequests: 0, stderrBytes: 0 }
    this.child = spawn(command, args, {
      cwd, env, shell: false, windowsHide: true, stdio: 'pipe',
      detached: process.platform !== 'win32',
    })
    this.exited = new Promise(resolve => {
      this.child.once('close', (code, signal) => {
        this.closed = true
        if (!this.closing) this.fail(new ProbeError(this.buffer.length ? 'E_FRAME' : 'E_EXIT'))
        resolve({ code, signalled: signal !== null })
      })
    })
    this.child.once('error', () => this.fail(new ProbeError('E_SPAWN')))
    this.child.stdin.on('error', () => this.fail(new ProbeError('E_PIPE')))
    this.child.stdout.on('error', () => this.fail(new ProbeError('E_PIPE')))
    this.child.stderr.on('error', () => this.fail(new ProbeError('E_PIPE')))
    // Drain diagnostics without retaining any secrets or unbounded output.
    this.child.stderr.on('data', bytes => { this.stats.stderrBytes += bytes.length })
    this.child.stdout.on('data', bytes => this.consume(bytes))
    this.child.stdout.once('end', () => {
      if (!this.closing) this.fail(new ProbeError(this.buffer.length ? 'E_FRAME' : 'E_EXIT'))
    })
  }

  request(method, params = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (this.failure || this.closing) return Promise.reject(this.failure ?? new ProbeError('E_CLOSED'))
    if (signal?.aborted) return Promise.reject(new ProbeError('E_ABORTED'))
    if (this.pending.size >= 64) return Promise.reject(new ProbeError('E_LIMIT'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.pending.delete(id)
        if (error) reject(error)
        else resolve(result)
      }
      const abort = () => finish(new ProbeError('E_ABORTED'))
      const timer = setTimeout(() => finish(new ProbeError('E_TIMEOUT')), timeoutMs)
      this.pending.set(id, finish)
      signal?.addEventListener('abort', abort, { once: true })
      this.write({ id, method, params })
    })
  }

  notify(method, params = {}) {
    if (this.failure || this.closing) throw this.failure ?? new ProbeError('E_CLOSED')
    this.write({ method, params })
  }

  write(frame) {
    if (this.failure || this.closing) return
    let bytes
    try { bytes = Buffer.from(JSON.stringify(frame) + '\n') } catch { this.fail(new ProbeError('E_FRAME')); return }
    if (bytes.length > this.maxFrameBytes || this.child.stdin.writableLength + bytes.length > 8 * this.maxFrameBytes) {
      this.fail(new ProbeError('E_LIMIT')); return
    }
    this.child.stdin.write(bytes, error => { if (error) this.fail(new ProbeError('E_PIPE')) })
  }

  consume(bytes) {
    if (this.failure || this.closing) return
    this.buffer = Buffer.concat([this.buffer, bytes])
    let end
    while ((end = this.buffer.indexOf(10)) !== -1) {
      if (end > this.maxFrameBytes) { this.fail(new ProbeError('E_LIMIT')); return }
      const line = this.buffer.subarray(0, end)
      this.buffer = this.buffer.subarray(end + 1)
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(line)
        this.route(JSON.parse(text))
      } catch (error) { this.fail(error instanceof ProbeError ? error : new ProbeError('E_FRAME')); return }
      if (this.failure) return
    }
    if (this.buffer.length > this.maxFrameBytes) this.fail(new ProbeError('E_LIMIT'))
  }

  route(frame) {
    if (!object(frame) || own(frame, 'jsonrpc')) throw new ProbeError('E_FRAME')
    const hasId = own(frame, 'id')
    const hasMethod = own(frame, 'method')
    if (hasId && !validId(frame.id)) throw new ProbeError('E_FRAME')
    this.stats.received++
    if (hasMethod) {
      if (typeof frame.method !== 'string' || !frame.method || own(frame, 'result') || own(frame, 'error') ||
          (own(frame, 'params') && !object(frame.params))) throw new ProbeError('E_FRAME')
      if (!hasId) { this.onNotification(frame.method, frame.params ?? {}); return }
      if (this.reverseIds.has(frame.id)) throw new ProbeError('E_DUPLICATE_ID')
      if (this.reverseIds.size >= 4096) throw new ProbeError('E_LIMIT')
      this.reverseIds.add(frame.id)
      this.stats.reverseRequests++
      // Deliberately concurrent with outgoing calls: runtime preferences can be
      // requested before session/create replies, and permissions during send.
      Promise.resolve().then(() => this.onRequest(frame.method, frame.params ?? {})).then(
        result => this.write({ id: frame.id, result }),
        error => this.write({ id: frame.id, error: {
          code: error instanceof ProbeError && error.rpcCode === -32601 ? -32601 : -32603,
          message: 'Probe cannot fulfil this request',
        } }),
      )
      return
    }
    if (!hasId || own(frame, 'result') === own(frame, 'error')) throw new ProbeError('E_FRAME')
    if (own(frame, 'error') && !object(frame.error)) throw new ProbeError('E_FRAME')
    const finish = this.pending.get(frame.id)
    if (!finish) { this.stats.lateResponses++; return }
    finish(own(frame, 'error') ? new ProbeError('E_REMOTE', frame.error.code) : null, frame.result)
  }

  fail(error) {
    if (this.failure || this.closing) return
    this.failure = error
    for (const finish of [...this.pending.values()]) finish(error)
    try { this.onFault(error) } finally { void this.close() }
  }

  close() {
    if (this.closePromise) return this.closePromise
    this.closing = true
    for (const finish of [...this.pending.values()]) finish(this.failure ?? new ProbeError('E_CLOSED'))
    this.closePromise = this.shutdown()
    return this.closePromise
  }

  async shutdown() {
    if (!this.child.stdin.destroyed) this.child.stdin.end()
    let escalated = false
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (await Promise.race([this.exited.then(() => true), sleep(300).then(() => false)])) break
      escalated = true
      const pid = this.child.pid
      if (pid && process.platform === 'win32') {
        // Use the OS utility, not a shell or PATH-resolved executable.
        const root = process.env.SystemRoot ?? process.env.SYSTEMROOT
        if (root) await new Promise(resolve => {
          const killer = spawn(join(root, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'],
            { shell: false, windowsHide: true, stdio: 'ignore', timeout: 1000 })
          killer.once('error', resolve)
          killer.once('close', resolve)
        })
      } else if (pid) {
        try { process.kill(-pid, signal) } catch { /* already exited */ }
      }
      if (!this.closed) this.child.kill(signal)
    }
    const closed = await Promise.race([this.exited.then(() => true), sleep(1500).then(() => false)])
    // A descendant may hold inherited pipes open. Never let cleanup hang a test.
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    this.child.stderr.destroy()
    return { closed, escalated }
  }
}
