// ZCode 桌面配置（~/.zcode/v2/config.json）读取：完整模型目录、provider
// registry 推送载荷、setModel 的 runtimeModel overlay。协议对齐
// zcode-acp-server 0.32.0（william0wang/zcode-acp）的实证行为：
//
//   - 会话快照的 settings.model.available 只含当前在用模型（真机只回
//     一条），完整目录在 config.json 的 provider 表里。
//   - 后端不自动加载第三方 provider：session 建立后必须推
//     workspace/updateProviderRegistry，否则换模型报 provider_not_configured。
//   - 切到第三方 provider 时 setModel 必须带 runtimeModel overlay 且内联
//     apiKey（{source:"inline"} 联合体，裸字符串会被严格 schema 拒绝）；
//     builtin provider 走自己的 OAuth，绝不内联密钥。
//
// 密钥纪律：apiKey 只进入发往本机 ZCode 后端的 RPC 载荷；不进日志、不进
// 错误消息、不落盘、不进 transcript。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { object } from './errors.mjs'

/** Non-empty bounded identifier (mirrors the backend seam's idValue). */
const idValue = value => typeof value === 'string' && value.length > 0 && value.length <= 512

export function zcodeConfigPath(home = process.env.HOME || process.env.USERPROFILE || '~') {
  return join(home, '.zcode', 'v2', 'config.json')
}

/** Read and parse the config; ANY failure yields null (callers fall back to
 * the session snapshot and never fake a catalog). */
export async function readZcodeConfig(path = zcodeConfigPath()) {
  try {
    const cfg = JSON.parse(await readFile(path, 'utf8'))
    return object(cfg) ? cfg : null
  } catch {
    return null
  }
}

export const isBuiltinProvider = providerId =>
  typeof providerId === 'string' && providerId.startsWith('builtin:')

function isLocalBaseURL(url) {
  if (typeof url !== 'string' || url === '') return false
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/** Whether the desktop app itself would run this provider (mirrors its
 * 未启用 marking): builtin needs enabled + a credential; custom needs a key,
 * keyless-allowed, or a local baseURL (llama.cpp/Ollama style). */
function providerSelectable(providerId, provider) {
  if (!object(provider)) return false
  if (isBuiltinProvider(providerId)) {
    return provider.enabled === true && Boolean(provider.options?.apiKey)
  }
  if (provider.enabled === false) return false
  if (provider.options?.apiKey) return true
  if (provider.options?.apiKeyRequired === false) return true
  return isLocalBaseURL(provider.options?.baseURL)
}

/** The full selectable model catalog: every usable provider × its models. */
export function selectableModelCatalog(cfg) {
  if (!object(cfg?.provider)) return []
  const out = []
  for (const [providerId, provider] of Object.entries(cfg.provider)) {
    if (!idValue(providerId) || !providerSelectable(providerId, provider)) continue
    const providerName = idValue(provider.name) ? provider.name : providerId
    const models = object(provider.models) ? provider.models : {}
    for (const modelId of Object.keys(models)) {
      if (idValue(modelId)) out.push({ providerId, providerName, modelId })
    }
  }
  return out
}

function apiFormatForKind(kind) {
  if (typeof kind !== 'string' || kind === '') return undefined
  if (kind.includes('anthropic')) return 'anthropic-messages'
  if (kind.includes('openai')) return 'openai-chat-completions'
  return undefined
}

/** One model element in backend schema. Carries the full definition — a bare
 * {modelId} overlay makes the backend fall back to the apiFormat's default
 * two-state thought levels, silently resetting the session's variants. */
function buildModelElement(modelId, model) {
  const element = { modelId }
  if (idValue(model?.name)) element.label = model.name
  if (Number.isSafeInteger(model?.limit?.context) && model.limit.context > 0) {
    element.contextWindow = model.limit.context
  }
  if (Number.isSafeInteger(model?.limit?.output) && model.limit.output > 0) {
    element.maxOutputTokens = model.limit.output
  }
  const variants = Array.isArray(model?.reasoning?.variants) ? model.reasoning.variants : []
  if (model?.reasoning?.enabled === true && variants.length > 0) {
    const reasoning = { enabled: true, levels: variants.map(v => ({ value: v, label: v })) }
    if (idValue(model.reasoning.defaultVariant)) reasoning.defaultLevel = model.reasoning.defaultVariant
    element.reasoning = reasoning
  }
  return element
}

function buildProviderElement(providerId, provider) {
  const models = Object.entries(object(provider.models) ? provider.models : {})
    .map(([modelId, model]) => buildModelElement(modelId, object(model) ? model : {}))
  const element = {
    providerId,
    kind: provider.kind,
    apiFormat: apiFormatForKind(provider.kind),
    baseURL: provider.options?.baseURL,
    label: idValue(provider.name) ? provider.name : providerId,
    models,
    source: idValue(provider.source) ? provider.source : 'custom',
  }
  if (provider.options?.apiKeyRequired !== undefined) {
    element.apiKeyRequired = provider.options.apiKeyRequired
  }
  if (provider.options?.apiKey) {
    element.apiKey = { source: 'inline', value: provider.options.apiKey }
  }
  for (const key of Object.keys(element)) {
    if (element[key] === undefined) delete element[key]
  }
  return element
}

/** Stable FNV-1a 32-bit hex hash — the backend skips unchanged revisions. */
function hashRevision(providers) {
  const signature = providers
    .map(p => `${p.providerId}|${p.kind ?? ''}|${p.baseURL ?? ''}|${JSON.stringify(p.models ?? [])}`)
    .sort()
    .join('\n')
  let h = 0x811c9dc5
  for (let i = 0; i < signature.length; i++) {
    h ^= signature.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Registry payload for workspace/updateProviderRegistry. Unlike the catalog,
 * EVERY configured provider rides along (the backend applies its own
 * availability rules); a provider with zero models is skipped because the
 * strict schema would reject the whole payload. */
export function buildProviderRegistry(cfg, now = Date.now()) {
  if (!object(cfg?.provider)) return null
  const providers = []
  for (const [providerId, provider] of Object.entries(cfg.provider)) {
    if (!idValue(providerId) || !object(provider)) continue
    if (Object.keys(object(provider.models) ? provider.models : {}).length === 0) continue
    providers.push(buildProviderElement(providerId, provider))
  }
  if (providers.length === 0) return null
  return { providers, generatedAt: now, revision: hashRevision(providers) }
}

/** runtimeModel overlay for session/setModel. Third-party providers MUST
 * inline their apiKey (the backend resolves auth from the overlay alone);
 * builtin providers never send one. */
export function buildRuntimeModel(cfg, reference, revision = 'codeg-adapter') {
  const provider = object(cfg?.provider) ? cfg.provider[reference.providerId] : null
  if (!object(provider)) return null
  const models = Object.entries(object(provider.models) ? provider.models : {})
    .map(([modelId, model]) => buildModelElement(modelId, object(model) ? model : {}))
  if (models.length === 0) models.push({ modelId: reference.modelId })
  const overlay = {
    providerId: reference.providerId,
    kind: provider.kind ?? 'anthropic',
    apiFormat: apiFormatForKind(provider.kind),
    baseURL: provider.options?.baseURL ?? 'https://open.bigmodel.cn/api/anthropic',
    models,
  }
  if (!isBuiltinProvider(reference.providerId) && provider.options?.apiKey) {
    overlay.apiKey = { source: 'inline', value: provider.options.apiKey }
  }
  return {
    revision,
    generatedAt: Date.now(),
    model: { providerId: reference.providerId, modelId: reference.modelId },
    provider: overlay,
  }
}
