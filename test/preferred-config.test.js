import assert from 'node:assert/strict'
import test from 'node:test'
import { preferredConfigSniffer, sanitizePreferredConfigValues } from '../src/acp/preferred-config.mjs'

const encoder = new TextEncoder()
const line = value => encoder.encode(JSON.stringify(value) + '\n')

/** Push the given byte chunks through a sniffer; return the bytes that came
 * out the other side (which must always be exactly the input). */
async function sniff(chunks) {
  const store = {}
  const stream = preferredConfigSniffer(store)
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  const forwarded = []
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      forwarded.push(value)
    }
  })()
  for (const chunk of chunks) await writer.write(chunk)
  await writer.close()
  await pump
  return { store, forwarded: Buffer.concat(forwarded.map(part => Buffer.from(part))) }
}

test('preferred-config: the initialize wire field is captured, bytes forwarded verbatim', async t => {
  const initialize = line({ id: 1, method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {}, preferredConfigValues: { mode: 'build' } } })
  const followUp = line({ id: 2, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } })
  const { store, forwarded } = await sniff([initialize, followUp])
  assert.deepEqual(store.preferredConfigValues, { mode: 'build' })
  assert.deepEqual(forwarded, Buffer.concat([initialize, followUp]), 'no byte may be altered or dropped')
})

test('preferred-config: capture survives a frame split across chunk boundaries', async t => {
  const initialize = line({ id: 1, method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {}, preferredConfigValues: { mode: 'build' } } })
  // Split at every single-byte offset around the middle of the frame, plus a
  // split inside the multi-byte-free JSON - arbitrary boundaries must work.
  const split = initialize.subarray(0, 57)
  const rest = initialize.subarray(57)
  const { store, forwarded } = await sniff([split, rest])
  assert.deepEqual(store.preferredConfigValues, { mode: 'build' })
  assert.deepEqual(forwarded, Buffer.concat([split, rest]))
})

test('preferred-config: initialize behind other frames and non-JSON noise is still found', async t => {
  const noise = encoder.encode('not json at all\n')
  const notification = line({ method: 'unrelated/notification', params: {} })
  const initialize = line({ id: 1, method: 'initialize',
    params: { protocolVersion: 1, preferredConfigValues: { mode: 'plan' } } })
  const { store } = await sniff([noise, notification, initialize])
  assert.deepEqual(store.preferredConfigValues, { mode: 'plan' })
})

test('preferred-config: frames after initialize cannot overwrite the capture', async t => {
  const initialize = line({ id: 1, method: 'initialize',
    params: { protocolVersion: 1, preferredConfigValues: { mode: 'build' } } })
  const forgery = line({ id: 2, method: 'initialize', params: { preferredConfigValues: { mode: 'yolo' } } })
  const { store, forwarded } = await sniff([initialize, forgery])
  assert.deepEqual(store.preferredConfigValues, { mode: 'build' }, 'only the connect-time handshake counts')
  assert.deepEqual(forwarded, Buffer.concat([initialize, forgery]), 'the forgery still reaches the SDK untouched')
})

test('preferred-config: initialize without usable preferences captures nothing', async t => {
  for (const params of [{ protocolVersion: 1 }, { protocolVersion: 1, preferredConfigValues: {} },
    { protocolVersion: 1, preferredConfigValues: { mode: [] } },
    { protocolVersion: 1, preferredConfigValues: null }]) {
    const { store } = await sniff([line({ id: 1, method: 'initialize', params })])
    assert.equal(store.preferredConfigValues, undefined)
  }
})

test('preferred-config: _meta delivery merges under the top-level wire field', async t => {
  const initialize = line({ id: 1, method: 'initialize', params: { protocolVersion: 1,
    _meta: { preferredConfigValues: { mode: 'build', model: 'p/m' } } } })
  const { store } = await sniff([initialize])
  assert.deepEqual(store.preferredConfigValues, { mode: 'build', model: 'p/m' })
})

test('preferred-config: sanitize keeps bounded primitives only', () => {
  assert.deepEqual(sanitizePreferredConfigValues({ mode: 'build', level: 2, flag: true }), { mode: 'build', level: 2, flag: true })
  assert.equal(sanitizePreferredConfigValues(null), null)
  assert.equal(sanitizePreferredConfigValues('build'), null)
  assert.equal(sanitizePreferredConfigValues([]), null)
  assert.deepEqual(sanitizePreferredConfigValues({ nested: { deep: true }, mode: 'build' }), { mode: 'build' })
  assert.equal(sanitizePreferredConfigValues({ mode: 'x'.repeat(257) }), null)
  assert.equal(sanitizePreferredConfigValues({}), null)
})

test('preferred-config: scanning gives up after a bounded budget without touching the stream', async t => {
  const noise = [encoder.encode('x'.repeat(64 * 1024))]
  for (let i = 0; i < 5; i++) noise.push(encoder.encode('y'.repeat(64 * 1024)))
  const initialize = line({ id: 1, method: 'initialize', params: { preferredConfigValues: { mode: 'build' } } })
  const { store, forwarded } = await sniff([...noise, initialize])
  assert.equal(store.preferredConfigValues, undefined, 'capture stops after the byte budget')
  assert.deepEqual(forwarded, Buffer.concat([...noise, initialize]), 'every byte still flows through')
})
