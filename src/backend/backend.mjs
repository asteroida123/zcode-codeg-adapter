import { realpath } from 'node:fs/promises'
import { PrivateRpc } from './rpc.mjs'
import { ProbeError, object } from './errors.mjs'
import { identityShape, turnIdentity } from './turn-evidence.mjs'
import { modelReferenceFromSnapshot, modelRuntimeFromSnapshot, rebindOriginalModel } from './resume-model.mjs'
import { restoreWarningIndicator } from './diagnostics.mjs'

export const PROFILE = 'app-server-cli-0.16.5-candidate'
export const EXPECTED_CLI = '0.16.5'
const idValue = value => typeof value === 'string' && value.length > 0 && value.length <= 512

/** Settle held permission decisions with an explicit deny. Cancellation and
 * shutdown must never leave a reverse request dangling; bounds stay tiny.
 * A module function, so prototype-only test doubles remain valid receivers.
 */
function flushPermissions(heldPermissions, metrics, sessionId = null) {
  for (const [key, responders] of [...heldPermissions]) {
    if (sessionId !== null && key !== sessionId) continue
    heldPermissions.delete(key)
    for (const respond of responders) respond({ decision: 'deny', reason: 'Probe deny: turn cancelled or backend closing' })
    metrics.permissionsDenied += responders.length
  }
}

/** Production backend seam. Owns semantic operations; callers do not send RPC.
 * Wire facts and the still-unverified assumptions are in docs/BACKEND-PROBE.md.
 */
export class AppServerBackend {
  constructor(options) {
    this.sessions = new Map()
    this.permissionMode = options.permissionMode === 'hold' ? 'hold' : 'deny'
    // Production permission seam: when present, decisions come from this
    // callback (the ACP client). Absent (probe default) -> deny/hold rules.
    this.onPermission = typeof options.onPermission === 'function' ? options.onPermission : null
    this.heldPermissions = new Map()
    this.metrics = { preferences: 0, permissionsDenied: 0, unsupportedInteractions: 0,
      unknownNotifications: 0, staleEvents: 0, unknownEvents: 0 }
    // Bounded wire vocabulary for failure diagnosis: type names and counts
    // only, never payloads. Consistent with reverseRpcMethods in reports.
    this.unknownEventTypes = new Map()
    this.rpc = new PrivateRpc({ ...options,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => this.reverseRequest(method, params),
      onFault: error => this.abortTurns(error),
    })
  }

  async open(cwd, { sessionId, mode = 'plan', mcpServers = [] } = {}) {
    if (!['plan', 'build'].includes(mode)) throw new ProbeError('E_MODE')
    const canonical = await realpath(cwd)
    const workspace = { workspacePath: canonical, workspaceKey: canonical }
    const result = await this.rpc.request(sessionId ? 'session/resume' : 'session/create',
      sessionId ? { sessionId, workspace } : { workspace, mode, mcpServers: this.#sanitizeMcpServers(mcpServers) })
    const id = result?.session?.sessionId
    if (!idValue(id) || (sessionId && id !== sessionId) || this.sessions.has(id)) throw new ProbeError('E_SESSION_ID')
    const returnedCwd = result?.session?.workspace?.workspacePath
    if (returnedCwd !== undefined && (!idValue(returnedCwd) || await realpath(returnedCwd) !== canonical)) {
      throw new ProbeError('E_WORKSPACE')
    }
    const state = { cwd: canonical, resumed: Boolean(sessionId), modelRebindAttempted: false, modelReference: null, lastSeq: -1, active: null, ready: false, finished: new Set() }
    this.sessions.set(id, state)
    try {
      // Attach state before subscribing: subscribe may emit its backlog before
      // its response. Record the boundary before any prompt is dispatched.
      const subscription = await this.rpc.request('session/subscribe', { sessionId: id, deliveryKind: 'desktop-continuous' })
      if (!Number.isSafeInteger(subscription?.eventSeq) || subscription.eventSeq < 0) throw new ProbeError('E_SCHEMA')
      state.lastSeq = Math.max(state.lastSeq, subscription.eventSeq)
      state.ready = true
      return id
    } catch (error) {
      this.sessions.delete(id)
      throw error // Never create a replacement session on a failed resume.
    }
  }

  /** Stdio MCP servers pass through with allowlisted fields only. Entries
   * without a command (HTTP/SSE and other transports) are rejected loudly
   * instead of being silently dropped.
   */
  #sanitizeMcpServers(mcpServers) {
    if (!Array.isArray(mcpServers)) throw new ProbeError('E_MCP_CONFIG')
    return mcpServers.map(server => {
      if (!object(server) || !idValue(server.name) || !idValue(server.command)) throw new ProbeError('E_MCP_CONFIG')
      return {
        name: server.name, command: server.command,
        ...(Array.isArray(server.args) ? { args: server.args.map(String).slice(0, 64) } : {}),
        ...(Array.isArray(server.env) ? { env: server.env.filter(item => object(item) && idValue(item.name)).slice(0, 64) } : {}),
      }
    }).slice(0, 32)
  }

  state(id) {
    const state = this.sessions.get(id)
    if (!state?.ready) throw new ProbeError('E_SESSION_ID')
    return state
  }

  /** Raw message history for ACP session/load replay. Bounded by callers. */
  async messages(id) {
    this.state(id)
    const history = await this.rpc.request('session/messages', { sessionId: id })
    if (!Array.isArray(history?.messages)) throw new ProbeError('E_SCHEMA')
    return history.messages
  }

  /** Model selector options from the native snapshot. Entries are parsed
   * defensively (`ref.providerId` and flat `providerId` layouts both occur);
   * unparseable entries are skipped, never guessed.
   */
  async modelOptions(id) {
    this.state(id)
    const snapshot = await this.rpc.request('session/read', { sessionId: id })
    const available = snapshot?.settings?.model?.available
    if (!Array.isArray(available)) return []
    const options = []
    for (const entry of available.slice(0, 64)) {
      if (!object(entry)) continue
      const ref = object(entry.ref) ? entry.ref : entry
      if (idValue(ref.providerId) && idValue(ref.modelId)) {
        options.push({
          providerId: ref.providerId, modelId: ref.modelId,
          ...(idValue(entry.label) ? { label: entry.label } : {}),
        })
      }
    }
    return options
  }

  async currentModel(id) {
    this.state(id)
    const snapshot = await this.rpc.request('session/read', { sessionId: id })
    return modelReferenceFromSnapshot(snapshot)
  }

  /** Current native session mode (settings.mode.current), or null when the
   * snapshot does not carry one. */
  async currentMode(id) {
    this.state(id)
    const snapshot = await this.rpc.request('session/read', { sessionId: id })
    const mode = snapshot?.settings?.mode?.current
    return typeof mode === 'string' && mode.length > 0 ? mode : null
  }

  /** Switch the session mode (native plan/build/edit/yolo/auto enum). */
  async setMode(id, mode) {
    this.state(id)
    if (!idValue(mode)) throw new ProbeError('E_MODE')
    await this.rpc.request('session/setMode', { sessionId: id, mode })
    return { mode }
  }

  /** Switch the session model (session-scoped, no workspace persistence). */
  async setModel(id, reference) {
    this.state(id)
    if (!object(reference) || !idValue(reference.providerId) || !idValue(reference.modelId)) {
      throw new ProbeError('E_RESUME_MODEL_REFERENCE')
    }
    await this.rpc.request('session/setModel', {
      sessionId: id,
      model: { providerId: reference.providerId, modelId: reference.modelId },
      persistAsWorkspaceLastUsed: false,
    })
    const current = await this.currentModel(id)
    if (!current || current.providerId !== reference.providerId || current.modelId !== reference.modelId) {
      throw new ProbeError('E_RESUME_MODEL_CHANGED')
    }
    return { model: reference }
  }

  /** Native session listing for the ACP mirror. Uses the first ready
   * session's transport; entries are passed through with allowlisted fields.
   */
  async listSessions({ limit = 50 } = {}) {
    const ready = [...this.sessions.values()].find(state => state.ready)
    if (!ready) throw new ProbeError('E_SESSION_ID')
    const result = await this.rpc.request('session/list', {
      directory: ready.cwd, limit,
    })
    if (!Array.isArray(result?.sessions)) throw new ProbeError('E_SCHEMA')
    return result.sessions.slice(0, limit).map(entry => ({
      sessionId: idValue(entry?.sessionId) ? entry.sessionId : null,
      cwd: idValue(entry?.workspace?.workspacePath) ? entry.workspace.workspacePath : null,
      title: idValue(entry?.title) ? entry.title : null,
      updatedAt: entry?.updatedAt !== undefined && entry.updatedAt !== null ? String(entry.updatedAt) : null,
    })).filter(entry => entry.sessionId !== null)
  }

  async inspect(id, marker = '') {
    this.state(id)
    const state = await this.rpc.request('session/read', { sessionId: id })
    const history = await this.rpc.request('session/messages', { sessionId: id })
    if (!object(state?.projection) || !Array.isArray(history?.messages)) throw new ProbeError('E_SCHEMA')
    this.state(id).modelReference = modelReferenceFromSnapshot(state)
    this.state(id).publishedRuntimeModel = modelRuntimeFromSnapshot(state)
    const assistant = history.messages.filter(message => message?.info?.role === 'assistant')
    const text = assistant.at(-1)?.parts?.filter(part => part.type === 'text').map(part => part.text ?? '').join('') ?? ''
    // Only return measurements. Never return model text or native IDs in reports.
    // The native snapshot carries the restore warning inside the projection.
    return { messageCount: history.messages.length, assistantMessages: assistant.length,
      lastAssistantHasMarker: marker.length > 0 && text.includes(marker),
      idle: state.projection.status === 'idle',
      restoreWarning: restoreWarningIndicator(state.projection.lastError) }
  }

  originalModelReference(id) {
    const ref = this.state(id).modelReference
    if (!ref) throw new ProbeError('E_RESUME_MODEL_REFERENCE')
    return { ...ref }
  }

  /** The model runtime descriptor published by the native snapshot, if any.
   * Null on 0.16.5: the CLI does not publish one to protocol clients.
   */
  publishedRuntimeModel(id) {
    const runtime = this.state(id).publishedRuntimeModel
    return runtime ? { ...runtime } : null
  }

  async rebindResumedModel(id, original, { allowRebind = false } = {}) {
    const state = this.state(id)
    if (allowRebind !== true || !state.resumed) throw new ProbeError('E_REBIND_SCOPE')
    if (state.active) throw new ProbeError('E_BUSY')
    if (state.modelRebindAttempted) throw new ProbeError('E_REBIND_ALREADY_ATTEMPTED')
    state.modelRebindAttempted = true
    return rebindOriginalModel(this.rpc, id, original)
  }

  prompt(id, content, { timeoutMs = 30000, cancelOnStream = false, cancelTimeoutMs = 3000, closeOnCancelTimeout = true, runtimeModel = null, onStream = null, onToolEvent = null } = {}) {
    const state = this.state(id)
    if (state.active) return Promise.reject(new ProbeError('E_BUSY'))
    if (this.rpc.failure || this.rpc.closing) return Promise.reject(new ProbeError('E_CLOSED'))
    const params = { sessionId: id, content }
    // Native send schema accepts an explicit runtimeModel descriptor which the
    // backend applies before guarding. Only an object passes through; semantic
    // validation and any errors stay with the native schema (-32602 feedback).
    if (runtimeModel !== null) {
      if (!object(runtimeModel)) return Promise.reject(new ProbeError('E_SEND_RUNTIME_MODEL'))
      params.runtimeModel = runtimeModel
    }
    return new Promise((resolve, reject) => {
      const turn = { accepted: false, started: false, turnId: null, terminal: null, cancelSent: false,
        streams: 0, tools: 0, denied: 0, cancelOnStream, cancelTimeoutMs, closeOnCancelTimeout,
        onStream: typeof onStream === 'function' ? onStream : null,
        onToolEvent: typeof onToolEvent === 'function' ? onToolEvent : null,
        toolCallIds: new Set(),
        startCount: 0, firstStartIdentity: null,
        timer: null, cancelTimer: null, settled: false, finish: null }
      turn.finish = (error, result) => {
        if (turn.settled) return
        turn.settled = true
        clearTimeout(turn.timer)
        clearTimeout(turn.cancelTimer)
        state.active = null
        if (turn.turnId) {
          state.finished.add(turn.turnId)
          if (state.finished.size > 64) state.finished.delete(state.finished.values().next().value)
        }
        if (error) reject(error)
        else resolve(result)
      }
      state.active = turn
      turn.timer = setTimeout(() => {
        turn.finish(new ProbeError('E_TURN_TIMEOUT'))
        // Outcome is unknown; poison the transport instead of replaying a prompt.
        void this.close()
      }, timeoutMs)
      this.rpc.request('session/send', params).then(result => {
        if (turn.settled) return
        if (result?.accepted !== true) { turn.finish(new ProbeError('E_SEND_REJECTED')); void this.close(); return }
        turn.accepted = true
        if (turn.cancelOnStream && turn.streams > 0) this.cancel(id)
        this.complete(turn)
      }, error => { turn.finish(error); void this.close() })
    })
  }

  complete(turn) {
    if (!turn.accepted || !turn.terminal || turn.settled) return
    if (turn.terminal.type === 'turn.failed' && !turn.cancelSent) { turn.finish(new ProbeError('E_TURN_FAILED')); return }
    const resultType = turn.terminal.payload.resultType
    const cancelled = ['cancelled', 'canceled', 'aborted', 'interrupted'].includes(resultType)
    // A terminal after stop may just be natural completion. Do not call it a
    // proven cancellation without an explicit backend cancellation reason.
    const terminalIdentity = turnIdentity(turn.terminal)
    const terminalIdMatched = turn.turnId !== null && terminalIdentity.id === turn.turnId
    turn.finish(null, { streams: turn.streams, tools: turn.tools, denied: turn.denied,
      turnIdObserved: turn.turnId !== null, terminalIdMatched, cancelSent: turn.cancelSent,
      stopAcknowledged: turn.stopAcknowledged === true,
      cancelled, terminalObserved: true, turnCorrelation: terminalIdMatched ? `matched-${terminalIdentity.source}-turn-id` : 'unverified',
      identityEvidence: { startCount: turn.startCount,
        firstStart: turn.firstStartIdentity, terminal: identityShape(turn.terminal) } })
  }

  cancel(id) {
    const turn = this.state(id).active
    if (!turn || turn.settled || turn.cancelSent) return false
    turn.cancelSent = true
    // Live 0.16.5 evidence: the notification form of session/stop left an
    // in-flight turn unsettled for 15s. The handler is request-shaped, so send
    // it with an id and record the acknowledgement. The acknowledgement is
    // evidence only - the verdict still belongs to a correlated terminal.
    void this.rpc.request('session/stop', { sessionId: id }, { timeoutMs: 5000 })
      .then(() => { turn.stopAcknowledged = true }, () => { turn.stopAcknowledged = false })
    // Held permissions are settled so a pending approval cannot block the
    // backend from observing or emitting the terminal.
    flushPermissions(this.heldPermissions, this.metrics, id)
    turn.cancelTimer = setTimeout(() => {
      turn.finish(new ProbeError('E_CANCEL_UNCONFIRMED'))
      // Outcome is unknown; poisoning stays the default so no caller replays
      // a prompt over an ambiguous transport. Read-only diagnostics may opt out.
      if (turn.closeOnCancelTimeout) void this.close()
    }, turn.cancelTimeoutMs)
    return true
  }

  notification(method, params) {
    if (method !== 'session/event') { this.metrics.unknownNotifications++; return }
    if (!idValue(params.sessionId) || !Number.isSafeInteger(params.seq) || params.seq < 0 ||
        typeof params.type !== 'string' || !object(params.payload)) throw new ProbeError('E_SCHEMA')
    const state = this.sessions.get(params.sessionId)
    if (!state) { this.metrics.staleEvents++; return }
    if (params.seq <= state.lastSeq) { this.metrics.staleEvents++; return }
    state.lastSeq = params.seq
    const turn = state.active
    if (!turn || !state.ready) return
    // Envelope-level turnId is the verified 0.16.5 identity location; payload
    // turnId remains a versioned fallback. Invalid values fail loudly.
    const identity = turnIdentity(params)
    if (identity.source === 'invalid') throw new ProbeError('E_SCHEMA')
    const nativeId = identity.id
    if (nativeId && (state.finished.has(nativeId) || (turn.turnId && turn.turnId !== nativeId))) {
      this.metrics.staleEvents++; return
    }
    if (params.type === 'turn.started') {
      turn.startCount++
      turn.firstStartIdentity ??= identityShape(params)
      turn.started = true
      turn.turnId ??= nativeId
    } else if (!turn.started) {
      this.metrics.staleEvents++
    } else if (params.type === 'model.streaming') {
      turn.streams++
      // Text relay hook for the ACP mapping. The backend itself never retains
      // or interprets model text; unknown payload shapes relay as empty.
      // Some backends stream before the send acknowledgement, so relaying does
      // not wait for acceptance; cancellation still does.
      if (typeof turn.onStream === 'function' &&
          (params.payload.kind === undefined || params.payload.kind === 'text_delta')) {
        const text = typeof params.payload.text === 'string' ? params.payload.text
          : typeof params.payload.delta === 'string' ? params.payload.delta : ''
        if (text.length > 0) turn.onStream(text.slice(0, 2048))
      }
      if (turn.accepted && turn.cancelOnStream) this.cancel(params.sessionId)
    } else if (params.type === 'tool.updated') {
      // tools counts DISTINCT tool calls: one native call emits several
      // lifecycle events (scheduled/started/progress/result/error).
      if (idValue(params.payload.toolCallId) && !turn.toolCallIds.has(params.payload.toolCallId)) {
        turn.toolCallIds.add(params.payload.toolCallId)
        turn.tools++
      }
      if (typeof turn.onToolEvent === 'function') turn.onToolEvent(params.payload)
    } else if (['turn.completed', 'turn.failed'].includes(params.type)) {
      turn.terminal = params
      this.complete(turn)
    } else {
      this.metrics.unknownEvents++
      if (!this.unknownEventTypes.has(params.type) && this.unknownEventTypes.size < 16) {
        this.unknownEventTypes.set(params.type, 0)
      }
      if (this.unknownEventTypes.has(params.type)) this.unknownEventTypes.set(params.type, this.unknownEventTypes.get(params.type) + 1)
    }
  }

  /** Wire vocabulary diagnostics for failure reports. Type names only. */
  diagnostics() {
    return { unknownEventTypes: [...this.unknownEventTypes].map(([type, count]) => ({ type, count })) }
  }

  async reverseRequest(method, params) {
    if (method === 'session/requestRuntimePreferences') {
      this.metrics.preferences++
      return { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false }
    }
    if (method === 'interaction/requestPermission') {
      const turn = this.sessions.get(params.sessionId)?.active
      if (this.onPermission) {
        // Decisions belong to the ACP client. Any callback failure denies;
        // nothing here can manufacture an allow.
        let decision = null
        try { decision = await this.onPermission(params) } catch { decision = null }
        if (decision?.decision === 'allow') return { decision: 'allow', reason: 'allowed by client' }
        this.metrics.permissionsDenied++
        if (turn) turn.denied++
        return { decision: 'deny', reason: typeof decision?.reason === 'string' && decision.reason ? decision.reason : 'denied by client' }
      }
      if (this.permissionMode === 'hold' && turn) {
        // Hold the decision open: cancellation must settle the turn while the
        // approval is still pending, never by silently approving it.
        const held = this.heldPermissions.get(params.sessionId) ?? []
        if (held.length >= 8) { this.metrics.permissionsDenied++; return { decision: 'deny', reason: 'Probe deny: held-permission bound exceeded' } }
        this.heldPermissions.set(params.sessionId, held)
        return new Promise(resolve => held.push(resolve))
      }
      this.metrics.permissionsDenied++
      if (turn) turn.denied++
      return { decision: 'deny', reason: 'Backend contract probe denies every permission request' }
    }
    this.metrics.unsupportedInteractions++
    // The probe cannot perform browser/auth/user-input interactions. Reply with
    // a protocol error, never a guessed success or auto-approved permission.
    throw new ProbeError('E_METHOD', -32601)
  }

  abortTurns(error) {
    for (const state of this.sessions.values()) state.active?.finish(error)
  }
  close() {
    this.abortTurns(new ProbeError('E_CLOSED'))
    flushPermissions(this.heldPermissions, this.metrics)
    return this.rpc.close()
  }
}
