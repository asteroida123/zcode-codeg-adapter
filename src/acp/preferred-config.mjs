/** Connect-time client config preferences (preferredConfigValues).
 *
 * Zed/codeg-style ACP clients send `preferredConfigValues` (e.g.
 * {"mode":"build"}) as a TOP-LEVEL field of the initialize request. The
 * pinned SDK (1.4.0) validates initialize with a stripping zod schema, so
 * that field never reaches the initialize() handler - and a session created
 * without it stays on the native default (plan), where MCP tools cannot run.
 * The field is not part of the SDK's schema, but it IS part of the wire
 * reality this adapter serves.
 *
 * Two capture paths, merged at use time (the wire field wins):
 * 1. preferredConfigSniffer - a TransformStream that forwards every byte of
 *    stdin untouched and, on the side, extracts the map from the raw
 *    initialize frame before the SDK parses it. Nothing is rewritten on the
 *    wire; scanning stops at the initialize frame or a small byte budget.
 * 2. initialize params `_meta.preferredConfigValues` - the protocol's own
 *    extensibility channel, which the SDK schema preserves.
 */

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const MAX_SCAN_BYTES = 256 * 1024

/** Bounded copy of a client preference map: primitive values only, capped
 * counts and lengths, no nested structures. Returns null for anything that
 * is not a usable map (absent, empty after filtering, wrong shape). */
export function sanitizePreferredConfigValues(value) {
  if (!object(value)) return null
  const out = {}
  for (const [key, entry] of Object.entries(value).slice(0, 16)) {
    if (key.length === 0 || key.length > 128) continue
    if (typeof entry === 'string' && entry.length > 256) continue
    if (!['string', 'number', 'boolean'].includes(typeof entry)) continue
    out[key] = entry
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Extract the sanitized preference map from one parsed initialize frame. */
function preferencesFromInitializeFrame(frame) {
  if (!object(frame) || frame.method !== 'initialize' || !object(frame.params)) return null
  const meta = sanitizePreferredConfigValues(frame.params._meta?.preferredConfigValues)
  const top = sanitizePreferredConfigValues(frame.params.preferredConfigValues)
  const merged = { ...(meta ?? {}), ...(top ?? {}) }
  return Object.keys(merged).length > 0 ? merged : null
}

/** Passive stdin sniffer. Writes the captured map into `store`
 * (store.preferredConfigValues). Bytes are enqueued unchanged BEFORE any
 * parsing, so the SDK downstream observes exactly what the client sent. */
export function preferredConfigSniffer(store) {
  const decoder = new TextDecoder()
  let buffer = ''
  let scanned = 0
  let done = false
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      if (done) return
      scanned += chunk.byteLength
      buffer += decoder.decode(chunk, { stream: true })
      let end
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (line.trim() === '') continue
        // initialize is normally the first frame, but only its CONTENT (not
        // its position) qualifies a line; anything else is skipped so a
        // chatty client cannot defeat the capture.
        try {
          const frame = JSON.parse(line)
          const preferences = preferencesFromInitializeFrame(frame)
          if (preferences) store.preferredConfigValues = preferences
          if (object(frame) && frame.method === 'initialize') done = true
        } catch { /* not JSON: the SDK will reject it; nothing to sniff */ }
      }
      if (scanned > MAX_SCAN_BYTES) done = true
    },
  })
}
