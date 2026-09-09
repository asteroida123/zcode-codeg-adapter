const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Only locally known operation names can enter a report, never arbitrary wire names.
export const RPC_METHODS = new Set([
  'session/create', 'session/resume', 'session/subscribe',
  'session/read', 'session/messages', 'session/send', 'session/stop',
])
export const REVERSE_METHODS = new Set([
  'session/requestRuntimePreferences', 'interaction/requestPermission',
  'interaction/requestUserInput', 'interaction/requestProviderRuntimeHeaders',
  'interaction/requestOfficialMcpAuthHeaders',
])
export const REMOTE_HINTS = new Set([
  'model-configuration', 'authentication', 'filesystem-access',
  'file-missing', 'runtime-dependency', 'state-store', 'request-schema', 'network',
])
const SYMBOLS = new Map([
  ['MISSING_CREDENTIAL', 'authentication'], ['AUTH_REQUIRED', 'authentication'],
  ['UNAUTHENTICATED', 'authentication'], ['INVALID_API_KEY', 'authentication'],
  ['MODEL_NOT_FOUND', 'model-configuration'], ['PROVIDER_NOT_FOUND', 'model-configuration'],
  ['MISSING_MODEL', 'model-configuration'], ['MISSING_PROVIDER', 'model-configuration'],
  ['EACCES', 'filesystem-access'], ['EPERM', 'filesystem-access'],
  ['ENOENT', 'file-missing'], ['MODULE_NOT_FOUND', 'runtime-dependency'],
  ['ERR_MODULE_NOT_FOUND', 'runtime-dependency'], ['ERR_UNKNOWN_BUILTIN_MODULE', 'runtime-dependency'],
  ['SQLITE_BUSY', 'state-store'], ['SQLITE_CANTOPEN', 'state-store'], ['SQLITE_CORRUPT', 'state-store'],
  ['INVALID_PARAMS', 'request-schema'], ['invalid_type', 'request-schema'],
  ['invalid_union', 'request-schema'], ['unrecognized_keys', 'request-schema'],
  ['ECONNREFUSED', 'network'], ['ENOTFOUND', 'network'], ['ETIMEDOUT', 'network'],
])
const PATTERNS = [
  ['model-configuration', /\b(?:no|missing|unknown|unconfigured) (?:default )?(?:model|provider)\b|\b(?:model|provider)(?: config(?:uration)?)? (?:is )?(?:not (?:found|configured|set)|missing)\b|\bmodel\.main\b/i],
  ['authentication', /\b(?:authentication (?:required|failed)|not (?:logged|signed) in|invalid (?:api key|token)|(?:missing|expired|invalid) credentials?|credential(?:s)? (?:not found|missing|expired)|api key (?:is )?(?:missing|required|invalid))\b/i],
  ['filesystem-access', /\b(?:EACCES|EPERM|permission denied|operation not permitted)\b/i],
  ['file-missing', /\bENOENT\b|no such file or directory/i],
  ['runtime-dependency', /\b(?:MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_BUILTIN_MODULE)\b|cannot find (?:module|package)|unknown built-in module/i],
  ['state-store', /\bSQLITE_(?:BUSY|CANTOPEN|CORRUPT)\b|database is locked|unable to open database/i],
  ['request-schema', /\b(?:invalid params|invalid parameters|invalid_type|invalid_union|unrecognized_keys)\b/i],
  ['network', /\b(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ENETUNREACH|ECONNRESET)\b/],
]

/** Lossy, bounded indicators only, NOT a root-cause diagnosis or log scrubber.
 * Unknown text is omitted entirely. Never copy a substring, key, stack or path.
 * The input is borrowed during response handling and is not retained.
 */
export function remoteIndicators(error) {
  const hints = new Set()
  let messagePresent = false
  let visited = 0
  function visit(value, depth) {
    if (++visited > 32 || depth > 3) return
    if (typeof value === 'string') {
      if (value.length > 0) messagePresent = true
      const text = value.slice(0, 2048)
      for (const [hint, pattern] of PATTERNS) if (pattern.test(text)) hints.add(hint)
      return
    }
    if (Array.isArray(value)) {
      for (const child of value.slice(0, 4)) visit(child, depth + 1)
      return
    }
    if (!object(value)) return
    if (typeof value.message === 'string' && value.message.length > 0) {
      messagePresent = true
      const text = value.message.slice(0, 2048)
      for (const [hint, pattern] of PATTERNS) if (pattern.test(text)) hints.add(hint)
    }
    for (const key of ['code', 'name']) {
      const hint = typeof value[key] === 'string' ? SYMBOLS.get(value[key]) : undefined
      if (hint) hints.add(hint)
    }
    for (const key of ['cause', 'error', 'data', 'detail', 'details', 'issues']) {
      if (Object.hasOwn(value, key)) visit(value[key], depth + 1)
    }
  }
  visit(error, 0)
  return { remoteMessagePresent: messagePresent, remoteHints: [...hints].sort() }
}

/** Revalidate at both construction and serialization; callers cannot add raw data. */
export function safeDetails(value) {
  if (!object(value)) return {}
  const out = {}
  if (RPC_METHODS.has(value.rpcMethod)) out.rpcMethod = value.rpcMethod
  if (typeof value.remoteMessagePresent === 'boolean') out.remoteMessagePresent = value.remoteMessagePresent
  if (Array.isArray(value.remoteHints)) {
    out.remoteHints = [...new Set(value.remoteHints.filter(hint => REMOTE_HINTS.has(hint)))].sort()
  }
  return out
}
