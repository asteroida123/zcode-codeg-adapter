import { AppServerBackend } from '../backend/backend.mjs'
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'

const idValue = value => typeof value === 'string' && value.length > 0 && value.length <= 512
const DEFAULT_PROMPT_TIMEOUT_MS = 600000
const STOP_CANCEL_TIMEOUT_MS = 15000

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
  constructor(conn, { backendFactory }) {
    this.#conn = conn
    this.#backendFactory = backendFactory
  }

  async initialize(params) {
    const requested = Number(params?.protocolVersion)
    return {
      protocolVersion: requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: false },
      },
      authMethods: [],
    }
  }

  async newSession(params) {
    const backend = this.#backendFactory(params.cwd, this.#conn)
    const sessionId = await backend.open(params.cwd, { mode: 'plan', mcpServers: params.mcpServers ?? [] })
    this.#sessions.set(sessionId, { backend, cwd: params.cwd })
    return { sessionId }
  }

  async loadSession(params) {
    const backend = this.#backendFactory(params.cwd, this.#conn)
    const sessionId = await backend.open(params.cwd, { sessionId: params.sessionId, mcpServers: params.mcpServers ?? [] })
    this.#sessions.set(sessionId, { backend, cwd: params.cwd })
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
    return { sessionId }
  }

  async prompt(params) {
    const session = this.#sessions.get(params.sessionId)
    if (!session) throw new Error('unknown session')
    const content = textFromPromptBlocks(params.prompt)
    const result = await session.backend.prompt(params.sessionId, content, {
      timeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
      cancelTimeoutMs: STOP_CANCEL_TIMEOUT_MS,
      onStream: text => {
        void this.#conn.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        }).catch(() => {})
      },
    })
    return { stopReason: stopReasonFor(result) }
  }

  async cancel(params) {
    const session = this.#sessions.get(params.sessionId)
    if (session) session.backend.cancel(params.sessionId)
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
    const outcome = await conn.requestPermission({
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
    })
    const selected = outcome?.outcome?.outcome === 'selected' ? String(outcome.outcome.optionId) : ''
    const matched = options.find(option => option.optionId === selected)
    if (matched && matched.kind.startsWith('allow')) return { decision: 'allow', reason: `client selected ${matched.optionId}` }
    return { decision: 'deny', reason: selected ? `client selected ${selected}` : 'client cancelled the request' }
  }
}

/** Stdio wiring for the adapter process. */
export function serveOverStdio({ command, entry, env }) {
  const toAgent = conn => new ZcodeCodegAgent(conn, {
    backendFactory: (cwd, agentConn) => new AppServerBackend({
      command, args: [entry, 'app-server', '--stdio'], cwd, env,
      timeoutMs: 10000,
      onPermission: nativeRequest => permissionDelegator(agentConn, nativeRequest.sessionId)(nativeRequest),
    }),
  })
  const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
  return new AgentSideConnection(toAgent, stream)
}
