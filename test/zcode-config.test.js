import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  buildProviderRegistry, buildRuntimeModel, selectableModelCatalog, zcodeConfigPath,
} from '../src/backend/zcode-config.mjs'

const cfg = providers => ({ provider: providers })

test('catalog: only providers the desktop would run are selectable', () => {
  const catalog = selectableModelCatalog(cfg({
    'builtin:on': { name: 'On', enabled: true, options: { apiKey: 'k' }, models: { 'm1': {}, 'm2': {} } },
    'builtin:off': { name: 'Off', enabled: false, options: { apiKey: 'k' }, models: { 'nope': {} } },
    'builtin:keyless': { name: 'Keyless', enabled: true, options: {}, models: { 'nope': {} } },
    'custom:key': { name: 'CK', options: { apiKey: 'k' }, models: { 'c1': {} } },
    'custom:disabled': { name: 'CD', enabled: false, options: { apiKey: 'k' }, models: { 'nope': {} } },
    'custom:keyless-ok': { name: 'KO', options: { apiKeyRequired: false }, models: { 'c2': {} } },
    'custom:local': { name: 'CL', options: { baseURL: 'http://127.0.0.1:8080/v1' }, models: { 'c3': {} } },
    'custom:remote-nokey': { name: 'CR', options: { baseURL: 'https://api.example.com' }, models: { 'nope': {} } },
  }))
  assert.deepEqual(catalog.map(e => `${e.providerId}/${e.modelId}`), [
    'builtin:on/m1', 'builtin:on/m2',
    'custom:key/c1', 'custom:keyless-ok/c2', 'custom:local/c3',
  ])
  assert.equal(catalog[0].providerName, 'On')
})

test('catalog: unreadable or malformed config yields an empty catalog', () => {
  assert.deepEqual(selectableModelCatalog(null), [])
  assert.deepEqual(selectableModelCatalog({}), [])
  assert.deepEqual(selectableModelCatalog({ provider: 'nope' }), [])
})

test('registry: skips zero-model providers, keys ride the inline union', () => {
  const registry = buildProviderRegistry(cfg({
    'builtin:on': { name: 'On', enabled: true, kind: 'anthropic', options: { apiKey: 'bk' }, models: { m1: {} } },
    'empty-plan': { name: 'Empty', enabled: true, options: { apiKey: 'k' }, models: {} },
    'custom:key': {
      name: 'CK', kind: 'openai-compatible', options: { apiKey: 'ck' },
      models: { c1: { name: 'C1', limit: { context: 128000, output: 8192 }, reasoning: { enabled: true, variants: ['low', 'high'], defaultVariant: 'high' } } },
    },
  }))
  assert.equal(registry.providers.length, 2)
  const custom = registry.providers.find(p => p.providerId === 'custom:key')
  assert.deepEqual(custom.apiKey, { source: 'inline', value: 'ck' })
  assert.equal(custom.apiFormat, 'openai-chat-completions')
  const model = custom.models[0]
  assert.equal(model.label, 'C1')
  assert.equal(model.contextWindow, 128000)
  assert.deepEqual(model.reasoning, { enabled: true, levels: [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }], defaultLevel: 'high' })
  // Zero-model providers must not appear — their presence would reject the
  // whole payload server-side.
  assert.ok(!registry.providers.some(p => p.providerId === 'empty-plan'))
  // Revision is a stable content gate.
  const again = buildProviderRegistry(cfg({
    'builtin:on': { name: 'On', enabled: true, kind: 'anthropic', options: { apiKey: 'bk' }, models: { m1: {} } },
    'custom:key': { name: 'CK', kind: 'openai-compatible', options: { apiKey: 'ck' }, models: { c1: { name: 'C1', limit: { context: 128000, output: 8192 }, reasoning: { enabled: true, variants: ['low', 'high'], defaultVariant: 'high' } } } },
  }))
  assert.equal(again.revision, registry.revision)
})

test('registry: no model-bearing providers yields null (never an empty push)', () => {
  assert.equal(buildProviderRegistry(null), null)
  assert.equal(buildProviderRegistry(cfg({ 'empty': { models: {} } })), null)
})

test('runtimeModel: third-party inlines the key, builtin never does', () => {
  const config = cfg({
    'builtin:plan': { enabled: true, kind: 'anthropic', options: { apiKey: 'bk' }, models: { 'GLM': {} } },
    'custom:key': { kind: 'openai-compatible', options: { apiKey: 'ck', baseURL: 'https://api.example.com' }, models: {} },
  })
  const custom = buildRuntimeModel(config, { providerId: 'custom:key', modelId: 'm9' })
  assert.deepEqual(custom.provider.apiKey, { source: 'inline', value: 'ck' })
  // Bare modelId fallback when the provider declares no models.
  assert.deepEqual(custom.provider.models, [{ modelId: 'm9' }])
  assert.deepEqual(custom.model, { providerId: 'custom:key', modelId: 'm9' })
  const builtin = buildRuntimeModel(config, { providerId: 'builtin:plan', modelId: 'GLM' })
  assert.equal(builtin.provider.apiKey, undefined)
  assert.equal(buildRuntimeModel(config, { providerId: 'missing', modelId: 'x' }), null)
})

test('config path lives under $HOME/.zcode/v2', () => {
  assert.equal(zcodeConfigPath('/home/u'), '/home/u/.zcode/v2/config.json')
})

// ---- 经 fake 后端的端到端：目录合并且按 config 切换真实发生 ----------------
// （spawn 的是真适配器进程，fake-zcode 充当原生后端；config.json 写进隔离的
// HOME，覆盖"目录来自 config、快照只补当前模型"的合并路径。）

// fileURLToPath, not URL.pathname: on Windows the raw pathname keeps a
// leading slash (/D:/...) and spawn ENOENTs — the suite hung to the CI job
// timeout there before this matched the repo's other test files.
const bin = fileURLToPath(new URL('../bin/zcode-codeg-acp.js', import.meta.url))
const fake = fileURLToPath(new URL('./fake-zcode.cjs', import.meta.url))

async function start(t, { zcodeHomeConfig, noRegistry = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'zcode-cfg-test-'))
  const env = { ...process.env, ZCODE_CODEG_ENTRY: fake, HOME: cwd, USERPROFILE: cwd, TMPDIR: undefined,
    ...(noRegistry ? { FAKE_NO_REGISTRY: '1' } : {}) }
  if (zcodeHomeConfig) {
    await mkdir(join(cwd, '.zcode', 'v2'), { recursive: true })
    await writeFile(join(cwd, '.zcode', 'v2', 'config.json'), JSON.stringify(zcodeHomeConfig))
  }
  const child = spawn(process.execPath, [bin], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { try { child.kill() } catch {} })
  let nextId = 1
  const pending = new Map()
  // An adapter that dies at boot (missing dependency, E_ENTRY, crash) must
  // fail its pending requests instead of leaving them pending forever — the
  // hang runs to the test-runner/job timeout otherwise.
  child.on('exit', () => {
    for (const { reject } of pending.values()) reject(new Error('adapter exited before answering'))
    pending.clear()
  })
  child.on('error', error => {
    for (const { reject } of pending.values()) reject(new Error(`adapter failed to spawn: ${error.message}`))
    pending.clear()
  })
  child.stdout.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue
      let msg; try { msg = JSON.parse(line) } catch { continue }
      if (msg.id !== undefined && msg.method) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n')
      } else if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id)
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
      }
    }
  })
  const request = (method, params) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  await request('initialize', { protocolVersion: 1 })
  return { request, cwd }
}

test('e2e: the model selector merges the config catalog with the snapshot', async t => {
  const { request, cwd } = await start(t, { zcodeHomeConfig: cfg({
    'builtin:plan': { name: 'BigPlan', enabled: true, kind: 'anthropic', options: { apiKey: 'bk' }, models: { 'GLM-5.3': {} } },
    'custom:x': { name: 'CX', kind: 'openai-compatible', options: { apiKey: 'ck' }, models: { 'glm-x': {} } },
    'custom:off': { name: 'CO', enabled: false, options: { apiKey: 'ck' }, models: { 'never': {} } },
  }) })
  const created = await request('session/new', { cwd, mcpServers: [] })
  const modelOption = created.configOptions?.find(option => option.id === 'model')
  const values = modelOption.options.map(option => option.value)
  // config 目录（含展示名）+ fake 快照的两条 + 当前模型，去重合并。
  assert.ok(values.includes('builtin:plan/GLM-5.3'), JSON.stringify(values))
  assert.ok(values.includes('custom:x/glm-x'))
  assert.ok(values.includes('builtin-x/fake-model'))
  assert.ok(!values.includes('custom:off/never'))
  const fromConfig = modelOption.options.find(option => option.value === 'builtin:plan/GLM-5.3')
  assert.equal(fromConfig.name, 'BigPlan · GLM-5.3')
  // 切到 config 目录里的模型（带 runtimeModel overlay）被接受。
  const switched = await request('session/set_config_option', {
    sessionId: created.sessionId, configId: 'model', value: 'builtin:plan/GLM-5.3',
  })
  assert.equal(switched.error, undefined)
  const after = switched?.configOptions?.find(option => option.id === 'model')
  assert.equal(after?.currentValue, 'builtin:plan/GLM-5.3')
})

test('e2e: on a registry-less backend (0.16.5) in-registry switching works bare; outside fails cleanly', async t => {
  const { request, cwd } = await start(t, { noRegistry: true, zcodeHomeConfig: cfg({
    'builtin:plan': { name: 'BigPlan', enabled: true, kind: 'anthropic', options: { apiKey: 'bk' }, models: { 'GLM-5.3': {} } },
  }) })
  const created = await request('session/new', { cwd, mcpServers: [] })
  // 目录仍来自 config（config 模型照常列出）。
  const modelOption = created.configOptions?.find(option => option.id === 'model')
  assert.ok(modelOption.options.some(o => o.value === 'builtin:plan/GLM-5.3'))
  // registry 内模型（fake 的 builtin-x 对）以 0.16.5 裸形态（options.reasoningLevel、无 overlay）切换成功。
  const inRegistry = await request('session/set_config_option', {
    sessionId: created.sessionId, configId: 'model', value: 'builtin-x/fake-mini',
  })
  assert.equal(inRegistry.error, undefined, JSON.stringify(inRegistry).slice(0, 200))
  // registry 外模型被后端拒绝 —— 干净的错误浮现（正是真机 GLM-5.3 的行为），连接不倒。
  const outside = await request('session/set_config_option', {
    sessionId: created.sessionId, configId: 'model', value: 'builtin:plan/GLM-5.3',
  }).catch(e => ({ error: String(e) }))
  assert.ok(outside.error, 'an outside-registry switch must surface an error')
  // 会话仍然可用：目录再读一次。
  const again = await request('session/set_config_option', {
    sessionId: created.sessionId, configId: 'model', value: 'builtin-x/fake-model',
  })
  assert.equal(again.error, undefined)
})

test('e2e: without a config the selector degrades to the snapshot list', async t => {
  const { request, cwd } = await start(t)
  const created = await request('session/new', { cwd, mcpServers: [] })
  const modelOption = created.configOptions?.find(option => option.id === 'model')
  assert.deepEqual(modelOption.options.map(o => o.value).sort(), ['builtin-x/fake-mini', 'builtin-x/fake-model'])
})
