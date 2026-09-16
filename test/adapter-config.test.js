import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAdapterConfig, validateAdapterConfig, buildRuntimeModel } from '../src/config/adapter-config.mjs'
import { ProbeError } from '../src/backend/errors.mjs'

const validConfig = {
  providers: [{
    providerId: 'zai', kind: 'openai-compatible', baseURL: 'https://api.example/v1',
    apiKey: { source: 'env', name: 'ZAI_API_KEY' },
    models: [{ modelId: 'glm-5', contextWindow: 200000 }],
  }],
  defaultModel: { providerId: 'zai', modelId: 'glm-5' },
  revision: 'codeg-1',
}
const code = expected => error => error instanceof ProbeError && error.code === expected

test('Adapter config: valid document round-trips without copying unknown data', () => {
  const config = validateAdapterConfig(validConfig)
  assert.equal(config.providers[0].providerId, 'zai')
  assert.deepEqual(config.providers[0].apiKey, { source: 'env', name: 'ZAI_API_KEY' })
  assert.equal(config.revision, 'codeg-1')
})

for (const [name, mutate] of [
  ['unknown provider field', config => { config.providers[0].extra = 1 }],
  ['bad provider kind', config => { config.providers[0].kind = 'magic' }],
  ['empty models', config => { config.providers[0].models = [] }],
  ['non-integer context window', config => { config.providers[0].models[0].contextWindow = 1.5 }],
  ['unknown api key source', config => { config.providers[0].apiKey = { source: 'variable', name: 'X' } }],
  ['unknown api key field', config => { config.providers[0].apiKey = { source: 'env', name: 'X', value: 'sk-PRIVATE' } }],
  ['duplicate provider ids', config => { config.providers.push({ ...config.providers[0] }) }],
  ['bad default model', config => { config.defaultModel = { providerId: 'zai' } }],
  ['unknown top-level key', config => { config.nested = {} }],
  ['providers not a list', config => { config.providers = {} }],
]) {
  test(`Adapter config: ${name} fails closed`, () => {
    const config = structuredClone(validConfig)
    mutate(config)
    assert.throws(() => validateAdapterConfig(config), code('E_CONFIG'))
  })
}

test('Adapter config: missing file is relay-only mode; unreadable or invalid fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-config-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 3 }) })
  assert.equal(await loadAdapterConfig(undefined), null)
  assert.equal(await loadAdapterConfig(''), null)
  assert.equal(await loadAdapterConfig(join(dir, 'absent.json')), null)
  await writeFile(join(dir, 'broken.json'), '{nope')
  await assert.rejects(loadAdapterConfig(join(dir, 'broken.json')), code('E_CONFIG'))
  await writeFile(join(dir, 'good.json'), JSON.stringify(validConfig))
  assert.equal((await loadAdapterConfig(join(dir, 'good.json'))).providers.length, 1)
})

test('Adapter config: descriptor builds only for configured providers', () => {
  const config = validateAdapterConfig(validConfig)
  const descriptor = buildRuntimeModel(config, { providerId: 'zai', modelId: 'glm-5' })
  assert.equal(typeof descriptor.revision, 'string')
  assert.equal(typeof descriptor.generatedAt, 'number')
  assert.deepEqual(descriptor.model, { providerId: 'zai', modelId: 'glm-5' })
  assert.equal(descriptor.provider.kind, 'openai-compatible')
  assert.deepEqual(descriptor.provider.apiKey, { source: 'env', name: 'ZAI_API_KEY' })
  const variant = buildRuntimeModel(config, { providerId: 'zai', modelId: 'glm-5', variant: 'think' })
  assert.equal(variant.model.variant, 'think')
  // An unconfigured model id synthesizes its catalog entry; an unconfigured
  // provider yields no descriptor at all.
  const other = buildRuntimeModel(config, { providerId: 'zai', modelId: 'glm-6' })
  assert.ok(other.provider.models.some(model => model.modelId === 'glm-6'))
  assert.equal(buildRuntimeModel(config, { providerId: 'unknown', modelId: 'x' }), null)
  assert.equal(buildRuntimeModel(null, { providerId: 'zai', modelId: 'glm-5' }), null)
  assert.equal(buildRuntimeModel(config, null), null)
})
