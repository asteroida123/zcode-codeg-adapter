import { mkdtempSync, chmodSync, openSync, writeFileSync, closeSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const METHODS = new Set(['session/create', 'session/subscribe', 'session/read', 'session/messages'])
const FIELDS = ['cause', 'error', 'data', 'detail', 'details', 'issues']
const repository = fileURLToPath(new URL('../../', import.meta.url))
const inside = (root, path) => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel))
}

/** Bounded error-message projection, NOT a sanitizer. Use only in a LOCAL file
 * after explicit consent. A message may itself contain a secret, URL or path.
 * Never collect params, responses, logs, config, headers, or a separate stack.
 */
export function localErrorTexts(error) {
  const messages = []
  let visited = 0
  function visit(value, location, depth) {
    if (++visited > 32 || depth > 3 || messages.length >= 8) return
    if (typeof value === 'string') {
      if (value) messages.push({ location, text: value.slice(0, 2048), truncated: value.length > 2048 })
    } else if (Array.isArray(value)) {
      value.slice(0, 4).forEach((child, index) => visit(child, `${location}[${index}]`, depth + 1))
    } else if (value && typeof value === 'object') {
      if (typeof value.message === 'string') visit(value.message, `${location}.message`, depth)
      for (const field of FIELDS) if (Object.hasOwn(value, field)) visit(value[field], `${location}.${field}`, depth + 1)
    }
  }
  visit(error, 'error', 0)
  return messages
}

/** First-error-only local sink. No directory or file is created on success.
 * All sensitive values stay out of the serializable instance and public report.
 * POSIX permissions: directory 0700, file 0600. Windows relies on temp-directory
 * ACLs; mode bits are not an ACL guarantee there.
 */
export class LocalErrorCapture {
  #path
  #attempted = false
  #failed = false
  get path() { return this.#path }
  status() { return { enabled: true, attempted: this.#attempted, saved: Boolean(this.#path), failed: this.#failed } }
  capture(method, error) {
    if (this.#attempted || !METHODS.has(method)) return
    this.#attempted = true
    let dir
    let fd
    try {
      const base = realpathSync(tmpdir())
      // An overridden TMPDIR inside the checkout must not put private data in Git.
      if (inside(realpathSync(repository), base)) throw new Error('unsafe temp directory')
      dir = mkdtempSync(join(base, 'zcode-probe-private-'))
      chmodSync(dir, 0o700)
      const path = join(dir, 'session-error.json')
      fd = openSync(path, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify({
        warning: 'LOCAL ONLY. Error text may contain secrets. Do not upload or paste this file. Delete after diagnosis.',
        rpcMethod: method,
        ...(Number.isSafeInteger(error?.code) ? { rpcCode: error.code } : {}),
        messages: localErrorTexts(error),
      }, null, 2) + '\n')
      closeSync(fd)
      fd = undefined
      this.#path = path
    } catch {
      this.#failed = true
      if (fd !== undefined) try { closeSync(fd) } catch {}
      if (dir) try { rmSync(dir, { recursive: true, force: true }) } catch {}
      // Logging failure must not replace the native RPC failure or print its data.
    }
  }
}
