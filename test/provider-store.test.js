import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accountCredentialKeys, bundledBuiltinPath, effectiveModelConfig, hasAccountCredential,
  loadLiveProviderCatalog, mergeProviderCatalog, pickBuiltinRelease,
} from '../src/backend/provider-store.mjs'

const builtinRelease = ({ revision = 30, providers = [], templates = [], modelRules = [], templateModelRules = [], builtinProviderModelRules = [] } = {}) => ({
  schemaVersion: 1,
  revision,
  config: {
    providerConfigRules: { providerRules: providers, templateRules: templates },
    modelConfigRules: { modelRules, templateModelRules, builtinProviderModelRules },
  },
})

const personalStore = ({ providerOrder = [], providers = [], modelRules = [], manualProviderModelRules = [] } = {}) => ({
  schemaVersion: 1,
  config: {
    providerOrder,
    providerConfigRules: { providerRules: providers },
    modelConfigRules: { providerModelRules: modelRules, manualProviderModelRules },
  },
})

const ACCOUNT_RULE = {
  providerId: 'account:bigmodel-individual-coding-plan',
  providerName: 'BigModel Individual Coding Plan',
  config: {
    group: 'bigmodel-family',
    builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'],
    access: { type: 'zhipu-account', mode: 'individual-coding-plan' },
    api: { type: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
  },
}

const ACCOUNT_KEY = 'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:1:api-key'

const TEMPLATE = {
  templateId: 'xiaomi-mimo',
  templateNameMap: { 'en-US': 'Xiaomi MiMo' },
  config: { builtinModelIds: ['mimo-v2.5-pro', 'mimo-v2.5'], access: { type: 'api-key' } },
}

const personal = (providerId, providerName, models, extra = {}) => ({
  providerId,
  providerName,
  ...extra,
  config: {
    group: 'standard-personal',
    access: { type: 'api-key', apiKey: `key-${providerId}` },
    api: { type: 'anthropic-messages', baseUrl: `https://${providerId}.example/anthropic` },
    personalModelIds: models,
    modelOrder: models,
    ...(extra.config ?? {}),
  },
})

test('catalog: an entitled account provider is listed, an unentitled one is not', () => {
  const catalog = mergeProviderCatalog({
    builtin: builtinRelease({ providers: [ACCOUNT_RULE] }),
    personal: null,
    credentialKeys: [ACCOUNT_KEY],
  })
  assert.deepEqual(catalog.map(entry => entry.providerId), ['account:bigmodel-individual-coding-plan'])
  assert.deepEqual(catalog[0].models.map(model => model.modelId), ['GLM-5.3', 'GLM-5.3-Flash'])
  assert.equal(catalog[0].providerName, 'BigModel Individual Coding Plan')
  assert.equal(catalog[0].account, true)

  const unentitled = mergeProviderCatalog({
    builtin: builtinRelease({ providers: [ACCOUNT_RULE] }),
    personal: null,
    credentialKeys: [],
  })
  assert.deepEqual(unentitled, [], 'an account provider without a credential must not be offered')
})

test('catalog: a template-based personal provider unions template and personal models in modelOrder', () => {
  const catalog = mergeProviderCatalog({
    builtin: builtinRelease({ templates: [TEMPLATE] }),
    personal: personalStore({
      providers: [{
        providerId: 'xiaomi-mimo',
        templateId: 'xiaomi-mimo',
        providerName: 'Xiaomi MiMo',
        config: {
          access: { type: 'api-key', apiKey: 'k' },
          api: { baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic' },
          personalModelIds: ['mimo-v2.6-pro'],
          modelOrder: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2.6-pro'],
        },
      }],
      providerOrder: ['xiaomi-mimo'],
    }),
    credentialKeys: [],
  })
  assert.deepEqual(catalog[0].models.map(model => model.modelId), ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2.6-pro'])
  assert.equal(catalog[0].baseUrl, 'https://token-plan-sgp.xiaomimimo.com/anthropic')
  assert.equal(catalog[0].apiKey, 'k')
})

test('catalog: models a matching rule disables, and providers without a key, are left out', () => {
  const catalog = mergeProviderCatalog({
    builtin: builtinRelease({
      templates: [TEMPLATE],
      modelRules: [{ modelMatch: '.*', config: { enabled: true } }],
      templateModelRules: [{ templateId: 'xiaomi-mimo', modelId: 'mimo-v2.5', config: { enabled: false } }],
    }),
    personal: personalStore({
      providers: [
        personal('new-provider-4', 'cpa', ['m1'], { enabled: false }),
        personal('new-provider-5', 'happycoding', ['m1']),
        { providerId: 'no-key', providerName: 'No key', config: { access: { type: 'api-key' }, api: {}, personalModelIds: ['m1'] } },
        { providerId: 'xiaomi-mimo', templateId: 'xiaomi-mimo', providerName: 'Xiaomi MiMo',
          config: { access: { type: 'api-key', apiKey: 'k' }, api: {}, personalModelIds: ['mimo-v2.6-pro'] } },
      ],
    }),
    credentialKeys: [],
  })
  assert.deepEqual(catalog.map(entry => entry.providerId), ['new-provider-5', 'xiaomi-mimo'])
  assert.deepEqual(catalog[1].models.map(model => model.modelId), ['mimo-v2.5-pro', 'mimo-v2.6-pro'],
    'the template rule that disables mimo-v2.5 must survive the merge')
})

test('catalog: account families come first, then the personal provider order', () => {
  const second = { ...ACCOUNT_RULE, providerId: 'account:bigmodel-team-coding-plan' }
  const catalog = mergeProviderCatalog({
    builtin: builtinRelease({ providers: [ACCOUNT_RULE, second] }),
    personal: personalStore({
      providers: [personal('p-a', 'A', ['m1']), personal('p-b', 'B', ['m1'])],
      providerOrder: ['p-b', 'p-a'],
    }),
    credentialKeys: [ACCOUNT_KEY, 'account-provider:coding-plan:account:bigmodel-team-coding-plan:account:1:api-key'],
  })
  assert.deepEqual(catalog.map(entry => entry.providerId),
    ['account:bigmodel-individual-coding-plan', 'account:bigmodel-team-coding-plan', 'p-b', 'p-a'])
})

test('catalog: the legacy config.json is never a source for the live catalog', async t => {
  const home = await mkdtemp(join(tmpdir(), 'zcode-provider-store-'))
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  await mkdir(join(home, '.zcode', 'v2'), { recursive: true })
  await writeFile(join(home, '.zcode', 'v2', 'config.json'), JSON.stringify({
    provider: { 'builtin:bigmodel-coding-plan': { name: 'Legacy', enabled: true, options: { apiKey: 'k' }, models: { 'GLM-5.2': {} } } },
  }))
  // No provider_config.json, no builtin release anywhere: the live loader says
  // "nothing to read" and the caller keeps the legacy path. What it must never
  // do is present the legacy table as if it were current.
  const live = await loadLiveProviderCatalog({ home, entry: '/nonexistent/glm/zcode.cjs' })
  assert.equal(live, null)
})

test('catalog: personal store wins over the builtin entry for the same provider id', async t => {
  const home = await mkdtemp(join(tmpdir(), 'zcode-provider-store-'))
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  const v2 = join(home, '.zcode', 'v2')
  await mkdir(join(v2, 'runtime', 'provider', 'darwin-arm64', '3.14.3', 'endpoint-abc'), { recursive: true })
  await writeFile(join(v2, 'provider_config.json'), JSON.stringify(personalStore({
    providers: [personal('shared', 'Personal name', ['personal-model'], { config: { modelOrder: ['personal-model'] } })],
    providerOrder: ['shared'],
  })))
  await writeFile(join(v2, 'credentials.json'), JSON.stringify({
    'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:1:api-key': 'enc:v1:x',
  }))
  const runtimeRelease = builtinRelease({
    revision: 31,
    providers: [
      ACCOUNT_RULE,
      { providerId: 'shared', providerName: 'Builtin name', config: { builtinModelIds: ['builtin-model'], access: { type: 'api-key' }, api: {} } },
    ],
  })
  await writeFile(join(v2, 'runtime', 'provider', 'darwin-arm64', '3.14.3', 'endpoint-abc', 'zcode-builtin.json'),
    JSON.stringify(runtimeRelease))
  const live = await loadLiveProviderCatalog({ home, entry: '/nonexistent/glm/zcode.cjs' })
  assert.equal(live.source.builtinRevision, 31)
  const shared = live.catalog.find(entry => entry.providerId === 'shared')
  assert.equal(shared.providerName, 'Personal name')
  assert.deepEqual(shared.models.map(model => model.modelId), ['personal-model', 'builtin-model'],
    'the modelOrder the personal rule states wins, and the builtin catalog still contributes its models')
  assert.equal(shared.apiKey, 'key-shared')
  assert.deepEqual(live.catalog.map(entry => entry.providerId),
    ['account:bigmodel-individual-coding-plan', 'shared'])
})

test('builtin release: the highest revision wins and the bundled copy wins a tie', () => {
  const bundled = builtinRelease({ revision: 30 })
  const newer = builtinRelease({ revision: 31 })
  assert.equal(pickBuiltinRelease([bundled, newer]), newer)
  assert.equal(pickBuiltinRelease([bundled, builtinRelease({ revision: 30 })]), bundled)
  assert.equal(pickBuiltinRelease([{ nope: true }]), null)
})

test('builtin path: derived from the CLI entry the adapter was handed', () => {
  assert.equal(
    bundledBuiltinPath('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'),
    '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json')
  assert.equal(bundledBuiltinPath(''), null)
})

test('account entitlement: matched as a whole provider id, secrets never read', () => {
  const keys = accountCredentialKeys({
    'account-provider:coding-plan:account:bigmodel-team-coding-plan:account:1:api-key': 'enc:v1:x',
    'oauth:bigmodel:access_token': 'enc:v1:y',
  })
  assert.deepEqual(keys, ['account-provider:coding-plan:account:bigmodel-team-coding-plan:account:1:api-key'])
  assert.equal(hasAccountCredential(keys, 'account:bigmodel-team-coding-plan'), true)
  assert.equal(hasAccountCredential(keys, 'account:zai-team-coding-plan'), false)
  // A partial segment must not count as a match.
  assert.equal(hasAccountCredential(keys, 'bigmodel-team-coding-plan'), true)
  assert.deepEqual(accountCredentialKeys(null), [])
})

test('model rules: a later rule wins and unknown kinds never match', () => {
  const sequence = [
    { modelMatch: '.*', config: { enabled: true, properties: { contextWindow: 100 } } },
    { providerId: 'p', modelId: 'm', config: { enabled: false } },
    { modelMatch: 'm', config: { properties: { contextWindow: 200 } } },
  ]
  assert.deepEqual(effectiveModelConfig(sequence, { providerId: 'p', modelId: 'm' }), { enabled: false, contextWindow: 200 })
  assert.deepEqual(effectiveModelConfig(sequence, { providerId: 'p', modelId: 'other' }), { enabled: true, contextWindow: 100 })
  // A rule whose kind this module does not understand is inert, not a wildcard.
  assert.deepEqual(effectiveModelConfig([{ providerId: 'p', config: { enabled: false } }], { providerId: 'p', modelId: 'm' }),
    { enabled: true })
})
