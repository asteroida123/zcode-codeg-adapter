import { AppServerBackend } from '../backend/backend.mjs'
import { buildRuntimeModel } from '../config/adapter-config.mjs'
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const idValue = value => typeof value === 'string' && value.length > 0 && value.length <= 512
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const DEFAULT_PROMPT_TIMEOUT_MS = 600000
const STOP_CANCEL_TIMEOUT_MS = 15000
const AGENT_MODES = [{ id: 'plan', name: 'Plan' }, { id: 'build', name: 'Build' }]
// Native tool.updated lifecycle -> ACP tool_call status. batch/raw payloads
// aggregate other calls and are not mirrored in v1.
const TOOL_STATUS = {
  scheduled: 'pending', started: 'in_progress', progress: 'in_progress',
  result: 'completed', error: 'failed',
}

/** Bounded wire diagnostic for a backend ProbeError. */
function annotatedMessage(error) {
  return `${error.code}${error.rpcCode !== undefined ? `/${error.rpcCode}` : ''}` +
    (Array.isArray(error.details?.remoteHints) && error.details.remoteHints.length > 0
      ? `/${error.details.remoteHints.join('+')}` : '')
}

/** Honest mapping from a backend prompt outcome to an ACP stop reason.
 * `cancelled` is only ever reported with a correlated terminal event; an
 * unconfirmed stop is surfaced as an error, never as a fake cancellation.
 */
function stopReasonFor(result) {
  if (result?.cancelled === true && result?.terminalIdMatched === true) return 'cancelled'
  if (result?.terminalObserved === true) return 'end_turn'
  return 'end_turn'
}

function textFromPromptBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').slice(0, 65536)
}

function toolKindFor(toolName) {
  const name = typeof toolName === 'string' ? toolName.toLowerCase() : ''
  if (/(edit|write|create|patch|apply)/.test(name)) return 'edit'
  if (/(read|view|list|glob|ls)/.test(name)) return 'read'
  if (/(bash|shell|exec|run|command)/.test(name)) return 'execute'
  if (/(search|grep|find)/.test(name)) return 'search'
  return 'other'
}

/** The adapter's ACP agent surface over one ZCode backend seam.
 * Capabilities are advertised only for behaviour that is implemented and
 * verified; there is no fs delegation (ZCode reads and writes files itself).
 */
export class ZcodeCodegAgent {
  constructor(conn, { backendFactory, config = null, cancelTimeoutMs = STOP_CANCEL_TIMEOUT_MS } = {}) {
    this.#conn = conn
    this.#backendFactory = backendFactory
    this.#config = config
    this.#cancelTimeoutMs = cancelTimeoutMs
  }

  async initialize(params) {
    const requested = Number(params?.protocolVersion)
    return {
      protocolVersion: requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        listSessions: true,
        promptCapabilities: { embeddedContext: false },
      },
      authMethods: [],
    }
  }

  /** Session-mode advertisement plus the model selector, both fed from the
   * native snapshot. A read failure degrades to modes-only; it never fakes
   * options.
   */
  async #sessionOptions(session) {
    const options = { modes: { currentModeId: 'plan', availableModes: AGENT_MODES } }
    try {
      const models = await session.backend.modelOptions(session.sessionId)
      const current = await session.backend.currentModel(session.sessionId)
      if (models.length > 0) {
        const valueOf = model => `${model.providerId}/${model.modelId}`
        const seen = new Set()
        const selectOptions = []
        for (const model of models) {
          const value = valueOf(model)
          if (seen.has(value)) continue
          seen.add(value)
          selectOptions.push({ value, name: model.label ?? model.modelId })
        }
        if (current && !seen.has(valueOf(current))) {
          selectOptions.push({ value: valueOf(current), name: current.modelId })
        }
        if (selectOptions.length > 0) {
          options.configOptions = [{
            id: 'model', type: 'select', name: 'Model',
            currentValue: current ? valueOf(current) : selectOptions[0].value,
            options: selectOptions,
          }]
        }
      }
    } catch {
      // Modes-only advertisement; no fabricated model options.
    }
    return options
  }

  async newSession(params) {
    const backend = this.#backendFactory(params.cwd, this.#conn)
    const sessionId = await backend.open(params.cwd, { mode: 'plan', mcpServers: params.mcpServers ?? [] })
    const session = { backend, sessionId, cwd: params.cwd, seenToolCallIds: new Set() }
    this.#sessions.set(sessionId, session)
    return { sessionId, ...(await this.#sessionOptions(session)) }
  }

  async loadSession(params) {
    const backend = this.#backendFactory(params.cwd, this.#conn)
    const sessionId = await backend.open(params.cwd, { sessionId: params.sessionId, mcpServers: params.mcpServers ?? [] })
    const session = { backend, sessionId, cwd: params.cwd, seenToolCallIds: new Set() }
    this.#sessions.set(sessionId, session)
    await this.#captureConfigDescriptor(session)
    // ACP load replays history before the request returns. Only text parts
    // are replayed; counts stay bounded to protect the client connection.
    const history = await backend.messages(sessionId)
    let replayed = 0
    for (const message of history.slice(-512)) {
      const role = message?.info?.role
      for (const part of Array.isArray(message?.parts) ? message.parts : []) {
        if (part?.type !== 'text' || typeof part.text !== 'string' || part.text.length === 0) continue
        await this.#conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: role === 'assistant' ? 'agent_message_chunk' : 'user_message_chunk',
            content: { type: 'text', text: part.text.slice(0, 65536) },
          },
        })
        if (++replayed >= 2048) break
      }
    }
    return { sessionId, ...(await this.#sessionOptions(session)) }
  }

  async setSessionMode(params) {
    const session = this.#sessions.get(params.sessionId)
    if (!session) throw new Error('unknown session')
    const { mode } = await session.backend.setMode(params.sessionId, params.modeId)
    await this.#conn.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: 'current_mode_update', currentModeId: mode },
    }).catch(() => {})
  }

  async setSessionConfigOption(params) {
    const session = this.#sessions.get(params.sessionId)
    if (!session) throw new Error('unknown session')
    if (params.configId !== 'model') throw new Error('unknown config option')
    const separator = String(params.value).indexOf('/')
    if (separator <= 0) throw new Error('malformed model option value')
    const reference = {
      providerId: String(params.value).slice(0, separator),
      modelId: String(params.value).slice(separator + 1),
    }
    if (!idValue(reference.providerId) || !idValue(reference.modelId)) throw new Error('malformed model option value')
    await session.backend.setModel(params.sessionId, reference)
    return this.#sessionOptions(session)
  }

  async listSessions(params) {
    // Listing needs a live transport; reuse a ready session when possible and
    // otherwise spawn a short-lived backend against the requested directory.
    for (const session of this.#sessions.values()) {
      if (!session.backend.sessions.values().next().value?.ready) continue
      const sessions = await session.backend.listSessions({ limit: 50 })
      if (sessions.length > 0 || !params.cwd) {
        return { sessions: sessions.map(entry => this.#sessionInfo(entry)) }
      }
    }
    const backend = this.#backendFactory(params.cwd ?? join(tmpdir(), 'zcode-codeg-list'), this.#conn)
    try {
      await backend.open(params.cwd ?? join(tmpdir(), 'zcode-codeg-list'))
      const sessions = await backend.listSessions({ limit: 50 })
      return { sessions: sessions.map(entry => this.#sessionInfo(entry)) }
    } finally {
      void backend.close()
    }
  }

  #sessionInfo(entry) {
    return {
      sessionId: entry.sessionId,
      cwd: entry.cwd ?? '',
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    }
  }

  async prompt(params) {
    const session = this.#sessions.get(params.sessionId)
    if (!session) throw new Error('unknown session')
    const content = textFromPromptBlocks(params.prompt)
    // Runtime supply order: what the native side published wins; otherwise a
    // descriptor built from the adapter config and the native-published model
    // reference. Without either, the send goes without one (relay-only).
    const runtimeModel = session.backend.publishedRuntimeModel(params.sessionId) ??
      session.configDescriptor ?? null
    let result
    try {
      result = await session.backend.prompt(params.sessionId, content, {
        timeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
        cancelTimeoutMs: this.#cancelTimeoutMs,
        runtimeModel,
        onStream: text => {
          void this.#conn.sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
          }).catch(() => {})
        },
        onToolEvent: payload => {
          const update = this.#toolCallUpdate(session, payload)
          if (update) {
            void this.#conn.sessionUpdate({ sessionId: params.sessionId, update }).catch(() => {})
          }
        },
      })
    } catch (error) {
      // The 0.16.5 stop defect makes protocol cancellation unconfirmable.
      // Recycle the backend process and resume the native session so the
      // session stays usable, then surface the cancellation honestly as a
      // failed prompt - never as a fabricated `cancelled` stop reason.
      if (error?.code === 'E_CANCEL_UNCONFIRMED' || error?.code === 'E_CLOSED') {
        if (session.cancelRequested) {
          const recycled = await this.#recycle(params.sessionId, session).catch(() => false)
          const recycledError = new Error(
            recycled ? 'cancellation unconfirmed: backend process recycled, session resumed'
              : 'cancellation unconfirmed: backend process recycled, resume failed')
          recycledError.code = 'E_CANCEL_RECYCLED'
          throw recycledError
        }
      }
      // Bounded diagnostics ride on the wire so clients can classify native
      // failures without raw error text.
      if (error?.code !== undefined && typeof error.code === 'string' && error.code.startsWith('E_')) {
        error.message = annotatedMessage(error)
      }
      throw error
    }
    return { stopReason: stopReasonFor(result) }
  }

  /** Map one native tool.updated payload to an ACP tool_call (first sighting
   * of a toolCallId within the turn) or tool_call_update (lifecycle
   * transitions). Batch and raw aggregates are not mirrored in v1.
   */
  #toolCallUpdate(session, payload) {
    if (!object(payload) || !idValue(payload.toolCallId)) return null
    const status = TOOL_STATUS[payload.kind]
    if (status === undefined) return null
    const isFirst = !session.seenToolCallIds.has(payload.toolCallId)
    if (isFirst) session.seenToolCallIds.add(payload.toolCallId)
    const update = { toolCallId: payload.toolCallId, status }
    const toolName = typeof payload.toolName === 'string' && payload.toolName ? payload.toolName : undefined
    if (isFirst) {
      update.sessionUpdate = 'tool_call'
      update.kind = toolKindFor(toolName)
      update.title = typeof payload.description === 'string' && payload.description
        ? payload.description.slice(0, 512) : (toolName ?? 'Tool call')
    } else {
      update.sessionUpdate = 'tool_call_update'
    }
    if (toolName) update.name = toolName
    if (payload.kind === 'scheduled' && payload.input !== undefined) update.rawInput = payload.input
    if (payload.kind === 'result' && payload.result !== undefined) update.rawOutput = payload.result
    if (payload.kind === 'progress' && typeof payload.stdoutTail === 'string' && payload.stdoutTail) {
      update.rawOutput = payload.stdoutTail.slice(0, 4096)
    }
    return update
  }

  async #recycle(sessionId, session) {
    try {
      const backend = this.#backendFactory(session.cwd, this.#conn)
      await backend.open(session.cwd, { sessionId })
      const fresh = { backend, sessionId, cwd: session.cwd, seenToolCallIds: new Set() }
      this.#sessions.set(sessionId, fresh)
      // A recycled backend resumed the native session, so the restore guard
      // applies again: rebuild the descriptor supply for the next send.
      await this.#captureConfigDescriptor(fresh)
      return true
    } catch {
      return false
    }
  }

  /** With an adapter config, capture the descriptor supplier for resumed
   * sends; without one this stays unset (relay-only mode).
   */
  async #captureConfigDescriptor(session) {
    try {
      await session.backend.inspect(session.sessionId, '')
      const descriptor = buildRuntimeModel(this.#config, session.backend.originalModelReference(session.sessionId))
      if (descriptor) session.configDescriptor = descriptor
    } catch {
      // No native reference or no config: relay-only.
    }
  }

  async cancel(params) {
    const session = this.#sessions.get(params.sessionId)
    if (session && session.backend.cancel(params.sessionId)) session.cancelRequested = true
  }

  async closeSession(params) {
    const session = this.#sessions.get(params.sessionId)
    if (session) {
      this.#sessions.delete(params.sessionId)
      await session.backend.close()
    }
  }

  #conn
  #backendFactory
  #config
  #cancelTimeoutMs
  #sessions = new Map()
}

/** Client-side permission delegation over ACP. The client's option selection
 * is the only path to an allow; a cancelled or malformed outcome denies.
 */
export function permissionDelegator(conn, acpSessionId) {
  return async nativeRequest => {
    const options = (Array.isArray(nativeRequest.options) ? nativeRequest.options : [])
      .filter(option => option && idValue(option.optionId) && idValue(option.kind))
      .slice(0, 8)
      .map(option => ({ optionId: option.optionId, kind: option.kind, name: idValue(option.name) ? option.name : option.optionId }))
    // The client chooses from THIS list, so the response is matched against
    // it - including when native supplies none and defaults are offered.
    const request = {
      sessionId: acpSessionId,
      toolCall: {
        toolCallId: idValue(nativeRequest.toolCallId) ? nativeRequest.toolCallId : `perm_${nativeRequest.requestId ?? 'x'}`,
        kind: toolKindFor(nativeRequest.toolName),
        title: idValue(nativeRequest.toolName) ? nativeRequest.toolName : 'Tool approval',
        rawInput: nativeRequest.input ?? null,
      },
      options: options.length > 0 ? options : [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'deny_once', kind: 'deny_once', name: 'Deny' },
      ],
    }
    const outcome = await conn.requestPermission(request)
    const selected = outcome?.outcome?.outcome === 'selected' ? String(outcome.outcome.optionId) : ''
    const matched = request.options.find(option => option.optionId === selected)
    if (matched && matched.kind.startsWith('allow')) return { decision: 'allow', reason: `client selected ${matched.optionId}` }
    return { decision: 'deny', reason: selected ? `client selected ${selected}` : 'client cancelled the request' }
  }
}

/** Stdio wiring for the adapter process. `config` is the loaded adapter
 * configuration (or null for relay-only mode).
 */
export function serveOverStdio({ command, entry, env, config = null }) {
  const toAgent = conn => new ZcodeCodegAgent(conn, {
    backendFactory: (cwd, agentConn) => new AppServerBackend({
      command, args: [entry, 'app-server', '--stdio'], cwd, env,
      timeoutMs: 10000,
      onPermission: nativeRequest => permissionDelegator(agentConn, nativeRequest.sessionId)(nativeRequest),
    }),
    config,
  })
  const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
  return new AgentSideConnection(toAgent, stream)
}
