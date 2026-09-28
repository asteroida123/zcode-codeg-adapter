// ZCode's provider/model configuration, read from the store the DESKTOP app
// actually uses.
//
// It is no longer one file. Since the v1 provider schema, the catalog is
// assembled from two sources:
//
//   * personal providers — `~/.zcode/v2/provider_config.json`
//   * the builtin catalog — the app bundle's
//     `<resources>/config/provider/zcode-builtin.json`, refreshed from the CDN
//     into `~/.zcode/v2/runtime/provider/<platform>/<appVersion>/<endpoint>/zcode-builtin.json`
//     (the release with the highest `revision` wins; equal revisions keep the
//     bundled copy)
//
// `~/.zcode/v2/config.json` still carries the OLD single-file provider table.
// The desktop app reads it only as a one-time legacy import, so serving the
// model picker from it freezes the list at whatever that file held the day it
// stopped being written — missing every provider added since, and offering
// `builtin:*` rows that no longer exist in the current schema.
//
// What this module reproduces from the app's own resolver: which providers are
// selectable, which models each one offers, their order, and their display
// names. It never invents a row: a provider whose credential source cannot be
// confirmed is left out rather than shown as an unusable entry.
//
// Credentials discipline: `apiKey` values are carried only far enough to
// decide selectability and build the legacy-shaped store the other modules
// already consume. They are never logged, never returned in diagnostics, and
// never placed in an error message.

import { readFile as readFileDefault, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const idValue = value => typeof value === 'string' && value.length > 0 && value.length <= 512
const array = value => (Array.isArray(value) ? value : [])

/** Groups the app shows first, in map order, before everything else. */
const ACCOUNT_GROUPS = new Set(['zai-family', 'bigmodel-family'])
/** Providers whose credential is a ZCode account (no inline key in any file). */
const ACCOUNT_ACCESS = 'zhipu-account'
/** Access kinds satisfied by an inline apiKey string. */
const KEY_ACCESS = new Set(['api-key', 'zhipu-coding-plan-api-key'])

export function zcodeProviderStorePaths(home = process.env.HOME || process.env.USERPROFILE || '') {
  const base = join(home, '.zcode', 'v2')
  return {
    personal: join(base, 'provider_config.json'),
    credentials: join(base, 'credentials.json'),
    legacy: join(base, 'config.json'),
    runtimeRoot: join(base, 'runtime', 'provider'),
  }
}

/** The bundled release path for the CLI entry the adapter was handed:
 * `<resources>/glm/zcode.cjs` -> `<resources>/config/provider/zcode-builtin.json`. */
export function bundledBuiltinPath(entry) {
  if (!idValue(entry)) return null
  return join(dirname(entry), '..', 'config', 'provider', 'zcode-builtin.json')
}

async function readJson(path, readFile) {
  if (!path) return null
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return object(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Every cached builtin release found under
 * `<base>/runtime/provider/<platform>/<appVersion>/<endpoint>/zcode-builtin.json`.
 * The platform segment is left open on purpose: the caller may be running a
 * cache another platform/version wrote, and the revision decides, not the path. */
async function cachedBuiltinPaths(runtimeRoot, readdirImpl = readdir) {
  const found = []
  let platforms = []
  try {
    platforms = await readdirImpl(runtimeRoot, { withFileTypes: true })
  } catch {
    return found
  }
  for (const platform of platforms) {
    if (!platform.isDirectory()) continue
    const platformDir = join(runtimeRoot, platform.name)
    let versions = []
    try {
      versions = await readdirImpl(platformDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const version of versions) {
      if (!version.isDirectory()) continue
      const versionDir = join(platformDir, version.name)
      let endpoints = []
      try {
        endpoints = await readdirImpl(versionDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const endpoint of endpoints) {
        if (!endpoint.isDirectory()) continue
        found.push(join(versionDir, endpoint.name, 'zcode-builtin.json'))
      }
    }
  }
  return found
}

/** The release the app itself would use: highest `revision`; on a tie the
 * earlier candidate wins, and the bundled copy is always passed first. */
export function pickBuiltinRelease(candidates) {
  let best = null
  for (const candidate of candidates) {
    if (!object(candidate?.config)) continue
    const revision = Number.isSafeInteger(candidate.revision) ? candidate.revision : -1
    if (best === null || revision > best.revision) best = { revision, release: candidate }
  }
  return best?.release ?? null
}

/** The credential KEYS that name an account provider, from
 * `credentials.json` (`account-provider:<plan>:<providerId>:…`). This is the
 * same evidence the desktop's account source reads; nothing is decoded, so no
 * secret ever leaves the file. */
export function accountCredentialKeys(credentials) {
  if (!object(credentials)) return []
  return Object.keys(credentials).filter(key => key.startsWith('account-provider:'))
}

/** Whether one account provider has a credential record. Matched as a whole
 * colon-delimited id, because a provider id may itself contain colons
 * (`account:bigmodel-individual-coding-plan`). */
export function hasAccountCredential(keys, providerId) {
  if (!idValue(providerId)) return false
  return keys.some(key => key.includes(`:${providerId}:`) || key.endsWith(`:${providerId}`))
}

/** Deep merge with `override` winning; arrays and scalars REPLACE (the app's
 * config overlay has the same shape — a rule that names one model id list owns
 * that field). */
function overlay(base, override) {
  if (!object(base)) return object(override) ? { ...override } : override
  if (!object(override)) return override === undefined ? base : override
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] = object(value) && object(base[key]) ? overlay(base[key], value) : value
  }
  return out
}

/** `resolveOwnedOrder`: the explicit order first, then the rest of `owned`,
 * then the rest of `added`. The app uses it for both provider and model order. */
function resolveOwnedOrder(owned, added, order) {
  const members = new Set([...owned, ...added])
  const out = []
  const push = id => { if (members.has(id) && !out.includes(id)) out.push(id) }
  for (const id of array(order)) push(id)
  for (const id of owned) if (!out.includes(id)) out.push(id)
  for (const id of added) if (!out.includes(id)) out.push(id)
  return out
}

function uniqueInOrder(ids) {
  const out = []
  for (const id of array(ids)) if (idValue(id) && !out.includes(id)) out.push(id)
  return out
}

function baseUrlKey(url) {
  return typeof url === 'string' ? url.replace(/\/+$/, '') : ''
}

function regexFor(pattern) {
  if (typeof pattern !== 'string' || pattern === '') return null
  try {
    return new RegExp(`^(?:${pattern})$`, 'i')
  } catch {
    return null
  }
}

/** One model rule matches when its kind-specific identity matches. Unknown
 * kinds never match — a rule this module does not understand must not silently
 * enable or disable a row. */
function ruleMatches(rule, target) {
  if (!object(rule)) return false
  const hasProvider = idValue(rule.providerId)
  const hasTemplate = idValue(rule.templateId)
  const hasModel = idValue(rule.modelId)
  if (hasProvider || hasTemplate) {
    if (hasProvider && rule.providerId !== target.providerId) return false
    if (hasTemplate && rule.templateId !== target.templateId) return false
    return hasModel ? rule.modelId === target.modelId : false
  }
  const matcher = regexFor(rule.modelMatch)
  if (!matcher || !matcher.test(target.modelId)) return false
  if (rule.apiTypeMatch !== undefined && rule.apiTypeMatch !== target.apiType) return false
  if (rule.baseUrlMatch !== undefined) {
    const expected = regexFor(rule.baseUrlMatch)
    if (!expected || !expected.test(baseUrlKey(target.baseUrl))) return false
  }
  return true
}

/** Builtin rules first, personal rules last: the app applies them in array
 * order, so the LAST matching rule that names a field decides it. */
function modelRuleSequence(builtinRules, personalRules) {
  const b = object(builtinRules) ? builtinRules : {}
  const p = object(personalRules) ? personalRules : {}
  return [
    ...array(b.modelRules), ...array(b.modelApiRules), ...array(b.providerSiteRules),
    ...array(b.templateModelRules), ...array(b.builtinProviderModelRules),
    ...array(p.providerModelRules), ...array(p.manualProviderModelRules),
  ]
}

/** The effective per-model config: enabled (default true) and the context
 * window, from every matching rule in application order. */
export function effectiveModelConfig(sequence, target) {
  let enabled = true
  let contextWindow
  for (const rule of sequence) {
    if (!ruleMatches(rule, target)) continue
    const config = rule.config
    if (!object(config)) continue
    if (config.enabled === true || config.enabled === false) enabled = config.enabled
    const context = config.properties?.contextWindow
    if (Number.isSafeInteger(context) && context > 0) contextWindow = context
  }
  return { enabled, ...(contextWindow === undefined ? {} : { contextWindow }) }
}

/** Merge the two stores into the provider list the app would show. */
export function mergeProviderCatalog({ builtin, personal, credentialKeys = [] }) {
  const builtinRules = array(builtin?.config?.providerConfigRules?.providerRules)
  const templates = new Map(
    array(builtin?.config?.providerConfigRules?.templateRules)
      .filter(template => idValue(template?.templateId))
      .map(template => [template.templateId, template]),
  )
  const personalRules = array(personal?.config?.providerConfigRules?.providerRules)
  const personalOrder = array(personal?.config?.providerOrder)
  const sequence = modelRuleSequence(builtin?.config?.modelConfigRules, personal?.config?.modelConfigRules)

  const merged = new Map()
  const add = (providerId, rule, { fromPersonal }) => {
    if (!idValue(providerId) || !object(rule)) return
    const templateId = idValue(rule.templateId) ? rule.templateId : null
    const template = templateId ? templates.get(templateId) : null
    const config = template ? overlay(template.config, rule.config) : (object(rule.config) ? { ...rule.config } : {})
    const previous = merged.get(providerId)
    if (previous) {
      // Personal entries win field by field over whatever the builtin store
      // contributed; only personal entries carry a key or the enabled flag.
      merged.set(providerId, {
        providerId,
        providerName: idValue(rule.providerName) ? rule.providerName : previous.providerName,
        fromPersonal: fromPersonal || previous.fromPersonal,
        templateId: templateId ?? previous.templateId,
        enabled: rule.enabled === undefined ? previous.enabled : rule.enabled,
        config: overlay(previous.config, config),
      })
      return
    }
    merged.set(providerId, {
      providerId,
      providerName: idValue(rule.providerName) ? rule.providerName : providerId,
      fromPersonal: Boolean(fromPersonal),
      templateId,
      enabled: rule.enabled,
      config,
    })
  }
  for (const rule of builtinRules) add(rule?.providerId, rule, { fromPersonal: false })
  for (const rule of personalRules) add(rule?.providerId, rule, { fromPersonal: true })

  const entries = [...merged.values()]
  const grouped = entries.filter(entry => ACCOUNT_GROUPS.has(entry.config?.group))
  const builtinIds = entries.filter(entry => !entry.fromPersonal && !grouped.includes(entry)).map(entry => entry.providerId)
  const personalIds = entries.filter(entry => entry.fromPersonal && !grouped.includes(entry)).map(entry => entry.providerId)
  const ordered = [...grouped, ...resolveOwnedOrder(builtinIds, personalIds, personalOrder).map(id => merged.get(id))]

  const catalog = []
  for (const entry of ordered) {
    const access = entry.config?.access
    const api = entry.config?.api
    if (entry.enabled === false) continue
    if (!object(access)) continue
    const account = access.type === ACCOUNT_ACCESS
    if (account) {
      // No inline credential exists for an account provider: without the
      // account's own credential record there is nothing the user could run.
      if (!hasAccountCredential(credentialKeys, entry.providerId)) continue
    } else if (KEY_ACCESS.has(access.type)) {
      if (!idValue(access.apiKey)) continue
    } else {
      continue
    }
    const builtinModelIds = uniqueInOrder(entry.config?.builtinModelIds)
    const personalModelIds = uniqueInOrder(entry.config?.personalModelIds)
      .filter(id => !builtinModelIds.includes(id))
    const target = { providerId: entry.providerId, templateId: entry.templateId, apiType: api?.type, baseUrl: api?.baseUrl }
    const models = []
    for (const modelId of resolveOwnedOrder(builtinModelIds, personalModelIds, entry.config?.modelOrder)) {
      if (modelId.startsWith('-')) continue
      const effective = effectiveModelConfig(sequence, { ...target, modelId })
      if (!effective.enabled) continue
      models.push({ modelId, ...(effective.contextWindow === undefined ? {} : { contextWindow: effective.contextWindow }) })
    }
    if (models.length === 0) continue
    catalog.push({
      providerId: entry.providerId,
      providerName: entry.providerName,
      account,
      ...(idValue(access.apiKey) ? { apiKey: access.apiKey } : {}),
      ...(idValue(api?.type) ? { apiType: api.type } : {}),
      ...(idValue(api?.baseUrl) ? { baseUrl: api.baseUrl } : {}),
      models,
    })
  }
  return catalog
}

/** The live catalog, or null when neither store could be read (callers then
 * keep their previous source rather than showing an empty picker). */
export async function loadLiveProviderCatalog({
  home = process.env.HOME || process.env.USERPROFILE || '',
  entry = process.env.ZCODE_CODEG_ENTRY ?? '',
  readFile = readFileDefault,
  readdirImpl = readdir,
} = {}) {
  const paths = zcodeProviderStorePaths(home)
  const personal = await readJson(paths.personal, readFile)
  const bundledPath = bundledBuiltinPath(entry)
  const candidates = []
  const bundled = await readJson(bundledPath, readFile)
  if (bundled) candidates.push(bundled)
  for (const path of await cachedBuiltinPaths(paths.runtimeRoot, readdirImpl)) {
    const release = await readJson(path, readFile)
    if (release) candidates.push(release)
  }
  if (!personal && candidates.length === 0) return null
  const builtin = pickBuiltinRelease(candidates)
  const credentials = await readJson(paths.credentials, readFile)
  const catalog = mergeProviderCatalog({
    builtin, personal, credentialKeys: accountCredentialKeys(credentials),
  })
  if (catalog.length === 0 && !personal && !builtin) return null
  return { catalog, source: { personal: Boolean(personal), builtinRevision: builtin?.revision ?? null } }
}

/** Legacy-shaped provider map (`{provider: {id: {name, kind, options, models}}}`)
 * for the provider-registry and runtimeModel-overlay builders, which are
 * written against that shape. Only providers with an inline key are projected:
 * account providers carry no key, and both builders invent one when handed a
 * custom-shaped entry. */
export function toLegacyProviderConfig(catalog) {
  const provider = {}
  for (const entry of array(catalog)) {
    if (entry.account) continue
    const models = {}
    for (const model of array(entry.models)) {
      const definition = {}
      if (Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0) {
        definition.limit = { context: model.contextWindow }
      }
      models[model.modelId] = definition
    }
    if (Object.keys(models).length === 0) continue
    provider[entry.providerId] = {
      name: entry.providerName,
      enabled: true,
      source: 'custom',
      ...(entry.apiType === 'anthropic-messages' ? { kind: 'anthropic' } : {}),
      ...(typeof entry.apiType === 'string' && entry.apiType.includes('openai') ? { kind: 'openai' } : {}),
      options: {
        ...(entry.baseUrl ? { baseURL: entry.baseUrl } : {}),
        ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
      },
      models,
    }
  }
  return { provider }
}
