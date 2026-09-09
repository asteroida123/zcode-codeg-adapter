import { realpath } from 'node:fs/promises'
import { PrivateRpc } from './rpc.mjs'
import { ProbeError, object } from './errors.mjs'

export const PROFILE = 'app-server-cli-0.16.5-candidate'
export const EXPECTED_CLI = '0.16.5'
const idValue = value => typeof value === 'string' && value.length > 0 && value.length <= 512

/** Candidate backend seam. Owns semantic operations; callers do not send RPC.
 * This spike intentionally does not advertise any ACP capabilities.
 * Wire facts and the still-unverified assumptions are in docs/BACKEND-PROBE.md.
 */
export class AppServerBackend {
  constructor(options) {
    this.sessions = new Map()
    this.metrics = { preferences: 0, permissionsDenied: 0, unsupportedInteractions: 0,
      unknownNotifications: 0, staleEvents: 0, unknownEvents: 0 }
    this.rpc = new PrivateRpc({ ...options,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => this.reverseRequest(method, params),
      onFault: error => this.abortTurns(error),
    })
  }

  async open(cwd, { sessionId, mode = 'plan' } = {}) {
    if (!['plan', 'build'].includes(mode)) throw new ProbeError('E_MODE')
    const canonical = await realpath(cwd)
    const workspace = { workspacePath: canonical, workspaceKey: canonical }
    const result = await this.rpc.request(sessionId ? 'session/resume' : 'session/create',
      sessionId ? { sessionId, workspace } : { workspace, mode, mcpServers: [] })
    const id = result?.session?.sessionId
    if (!idValue(id) || (sessionId && id !== sessionId) || this.sessions.has(id)) throw new ProbeError('E_SESSION_ID')
    const returnedCwd = result?.session?.workspace?.workspacePath
    if (returnedCwd !== undefined && (!idValue(returnedCwd) || await realpath(returnedCwd) !== canonical)) {
      throw new ProbeError('E_WORKSPACE')
    }
    const state = { cwd: canonical, lastSeq: -1, active: null, ready: false, finished: new Set() }
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

  state(id) {
    const state = this.sessions.get(id)
    if (!state?.ready) throw new ProbeError('E_SESSION_ID')
    return state
  }

  async inspect(id, marker = '') {
    this.state(id)
    const state = await this.rpc.request('session/read', { sessionId: id })
    const history = await this.rpc.request('session/messages', { sessionId: id })
    if (!object(state?.projection) || !Array.isArray(history?.messages)) throw new ProbeError('E_SCHEMA')
    const assistant = history.messages.filter(message => message?.info?.role === 'assistant')
    const text = assistant.at(-1)?.parts?.filter(part => part.type === 'text').map(part => part.text ?? '').join('') ?? ''
    // Only return measurements. Never return model text or native IDs in reports.
    return { messageCount: history.messages.length, assistantMessages: assistant.length,
      lastAssistantHasMarker: marker.length > 0 && text.includes(marker),
      idle: state.projection.status === 'idle' }
  }

  prompt(id, content, { timeoutMs = 30000, cancelOnStream = false, cancelTimeoutMs = 3000 } = {}) {
    const state = this.state(id)
    if (state.active) return Promise.reject(new ProbeError('E_BUSY'))
    if (this.rpc.failure || this.rpc.closing) return Promise.reject(new ProbeError('E_CLOSED'))
    return new Promise((resolve, reject) => {
      const turn = { accepted: false, started: false, turnId: null, terminal: null, cancelSent: false,
        streams: 0, tools: 0, denied: 0, cancelOnStream, cancelTimeoutMs,
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
      this.rpc.request('session/send', { sessionId: id, content }).then(result => {
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
    turn.finish(null, { streams: turn.streams, tools: turn.tools, denied: turn.denied,
      turnIdObserved: turn.turnId !== null, terminalIdMatched: turn.terminal.payload.turnId === turn.turnId && turn.turnId !== null, cancelSent: turn.cancelSent,
      cancelled, terminalObserved: true })
  }

  cancel(id) {
    const turn = this.state(id).active
    if (!turn || turn.settled || turn.cancelSent) return false
    turn.cancelSent = true
    this.rpc.notify('session/stop', { sessionId: id })
    turn.cancelTimer = setTimeout(() => {
      turn.finish(new ProbeError('E_CANCEL_UNCONFIRMED'))
      void this.close()
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
    const nativeId = params.payload.turnId
    if (nativeId !== undefined && !idValue(nativeId)) throw new ProbeError('E_SCHEMA')
    if (nativeId && (state.finished.has(nativeId) || (turn.turnId && turn.turnId !== nativeId))) {
      this.metrics.staleEvents++; return
    }
    if (params.type === 'turn.started') {
      turn.started = true
      turn.turnId = nativeId ?? null
    } else if (!turn.started) {
      this.metrics.staleEvents++
    } else if (params.type === 'model.streaming') {
      turn.streams++
      if (turn.accepted && turn.cancelOnStream) this.cancel(params.sessionId)
    } else if (params.type === 'tool.updated') {
      turn.tools++
    } else if (['turn.completed', 'turn.failed'].includes(params.type)) {
      turn.terminal = params
      this.complete(turn)
    } else {
      this.metrics.unknownEvents++
    }
  }

  reverseRequest(method, params) {
    if (method === 'session/requestRuntimePreferences') {
      this.metrics.preferences++
      return { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false }
    }
    if (method === 'interaction/requestPermission') {
      this.metrics.permissionsDenied++
      const turn = this.sessions.get(params.sessionId)?.active
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
    return this.rpc.close()
  }
}
