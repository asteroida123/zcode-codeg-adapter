import { readFile, stat } from 'node:fs/promises'
import { ProbeError, object } from '../backend/errors.mjs'

const PROVIDER_KINDS = new Set(['anthropic', 'openai', 'openai-compatible'])
const API_FORMATS = new Set(['anthropic-messages', 'openai-chat-completions', 'openai-responses'])
const API_KEY_SOURCES = new Set(['credential', 'env', 'server-config', 'inline'])
const idValue = value => typeof value === 'string' && value.length > 0 && value.length <= 512

function validateApiKey(value, location) {
  if (value === undefined) return undefined
  if (!object(value) || !API_KEY_SOURCES.has(value.source)) throw new ProbeError('E_CONFIG')
  const shape = {
    credential: ['key'], env: ['name'], 'server-config': ['key'], inline: ['value'],
  }[value.source]
  for (const field of shape) if (!idValue(value[field])) throw new ProbeError('E_CONFIG')
  if (Object.keys(value).some(key => !['source', ...shape].includes(key))) throw new ProbeError('E_CONFIG')
  return { source: value.source, [shape[0]]: value[shape[0]] }
}

function validateModelEntry(value) {
  if (!object(value) || !idValue(value.modelId)) throw new ProbeError('E_CONFIG')
  const entry = { modelId: value.modelId }
  for (const field of ['label', 'description']) {
    if (value[field] !== undefined) {
      if (!idValue(value[field])) throw new ProbeError('E_CONFIG')
      entry[field] = value[field]
    }
  }
  for (const field of ['contextWindow', 'maxOutputTokens']) {
    if (value[field] !== undefined) {
      if (!Number.isSafeInteger(value[field]) || value[field] <= 0) throw new ProbeError('E_CONFIG')
      entry[field] = value[field]
    }
  }
  for (const field of ['supportsImages', 'supportsPdf']) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'boolean') throw new ProbeError('E_CONFIG')
      entry[field] = value[field]
    }
  }
  if (Object.keys(value).some(key => !Object.keys(entry).includes(key))) throw new ProbeError('E_CONFIG')
  return entry
}

function validateProvider(value) {
  if (!object(value) || !idValue(value.providerId) || !PROVIDER_KINDS.has(value.kind)) throw new ProbeError('E_CONFIG')
  const provider = { providerId: value.providerId, kind: value.kind }
  if (value.apiFormat !== undefined) {
    if (!API_FORMATS.has(value.apiFormat)) throw new ProbeError('E_CONFIG')
    provider.apiFormat = value.apiFormat
  }
  for (const field of ['label', 'baseURL', 'logoUrl', 'modelsDevProviderId']) {
    if (value[field] !== undefined) {
      if (!idValue(value[field])) throw new ProbeError('E_CONFIG')
      provider[field] = value[field]
    }
  }
  if (value.apiKeyRequired !== undefined) {
    if (typeof value.apiKeyRequired !== 'boolean') throw new ProbeError('E_CONFIG')
    provider.apiKeyRequired = value.apiKeyRequired
  }
  const apiKey = validateApiKey(value.apiKey)
  if (apiKey !== undefined) provider.apiKey = apiKey
  if (value.headers !== undefined) {
    if (!object(value.headers) || Object.entries(value.headers).some(([key, item]) => !idValue(key) || typeof item !== 'string')) {
      throw new ProbeError('E_CONFIG')
    }
    provider.headers = { ...value.headers }
  }
  if (!Array.isArray(value.models) || value.models.length === 0 || value.models.length > 256) throw new ProbeError('E_CONFIG')
  provider.models = value.models.map(validateModelEntry)
  if (Object.keys(value).some(key => !Object.keys(provider).includes(key))) throw new ProbeError('E_CONFIG')
  return provider
}

/** Validate an adapter configuration document. Unknown keys fail: the file
 * exists to mirror the native runtime descriptor, not to grow silently.
 * The document holds NO secret material - apiKey entries may only reference
 * a credential store, environment variable or server config by name/key id.
 */
export function validateAdapterConfig(data) {
  if (!object(data) || !Array.isArray(data.providers) || data.providers.length === 0 || data.providers.length > 32) {
    throw new ProbeError('E_CONFIG')
  }
  const providers = data.providers.map(validateProvider)
  const ids = providers.map(provider => provider.providerId)
  if (new Set(ids).size !== ids.length) throw new ProbeError('E_CONFIG')
  const config = { providers }
  if (data.defaultModel !== undefined) {
    if (!object(data.defaultModel) || !idValue(data.defaultModel.providerId) || !idValue(data.defaultModel.modelId)) throw new ProbeError('E_CONFIG')
    config.defaultModel = { providerId: data.defaultModel.providerId, modelId: data.defaultModel.modelId }
    if (Object.keys(data.defaultModel).some(key => !['providerId', 'modelId', 'variant'].includes(key))) throw new ProbeError('E_CONFIG')
    if (data.defaultModel.variant !== undefined) {
      if (!idValue(data.defaultModel.variant)) throw new ProbeError('E_CONFIG')
      config.defaultModel.variant = data.defaultModel.variant
    }
  }
  if (Object.keys(data).some(key => !['providers', 'defaultModel', 'revision'].includes(key))) throw new ProbeError('E_CONFIG')
  if (data.revision !== undefined) {
    if (!idValue(data.revision)) throw new ProbeError('E_CONFIG')
    config.revision = data.revision
  }
  return config
}

/** Load the adapter configuration from an explicit absolute path. A missing
 * file yields null (relay-only mode); anything unreadable or invalid fails.
 * File contents and paths never appear in errors.
 */
export async function loadAdapterConfig(path) {
  if (path === undefined || path === null || path === '') return null
  if (typeof path !== 'string' || !path.length || path.length > 1024) throw new ProbeError('E_CONFIG')
  let raw
  try {
    raw = await readFile(path, 'utf8')
    if (!(await stat(path)).isFile()) throw new Error('not a file')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new ProbeError('E_CONFIG')
  }
  let data
  try { data = JSON.parse(raw) } catch { throw new ProbeError('E_CONFIG') }
  return validateAdapterConfig(data)
}

/** Build the native runtimeModel descriptor for a model reference that the
 * NATIVE side published (session/read settings.model.current). Returns null
 * when no adapter provider matches, so callers keep relaying nothing rather
 * than guessing a provider definition.
 */
export function buildRuntimeModel(config, nativeRef) {
  if (!object(config) || !object(nativeRef) || !idValue(nativeRef.providerId) || !idValue(nativeRef.modelId)) return null
  const provider = config.providers.find(candidate => candidate.providerId === nativeRef.providerId)
  if (!provider) return null
  const models = provider.models.some(model => model.modelId === nativeRef.modelId)
    ? provider.models
    : [...provider.models, { modelId: nativeRef.modelId }]
  const model = { providerId: nativeRef.providerId, modelId: nativeRef.modelId }
  if (nativeRef.variant !== undefined && idValue(nativeRef.variant)) model.variant = nativeRef.variant
  return {
    revision: idValue(config.revision) ? config.revision : 'zcode-codeg-adapter',
    generatedAt: Date.now(),
    model,
    provider: { ...provider, models },
  }
}
