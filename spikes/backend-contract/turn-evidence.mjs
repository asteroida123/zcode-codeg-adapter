/** Fixed, value-free observations; NOT a fallback turn-correlation algorithm.
 * A foreground execution, top-level turn ID and payload turn ID are distinct
 * candidates. Do not treat them as aliases without a verified native contract.
 */
function fieldShape(value, key) {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return 'absent'
  const field = value[key]
  if (typeof field === 'string' && field.length > 0 && field.length <= 512) return 'string'
  return 'invalid'
}

export function identityShape(event) {
  return {
    envelopeTurnId: fieldShape(event, 'turnId'),
    payloadTurnId: fieldShape(event?.payload, 'turnId'),
    foregroundExecutionId: fieldShape(event?.payload, 'foregroundExecutionId'),
  }
}

/** Normalized turn identity for one event. Envelope-level turnId is the
 * verified 0.16.5 location (two live runs, TURN-EVIDENCE.md); payload.turnId
 * stays a versioned fallback for other builds. foregroundExecutionId is
 * never a turn identity. 'invalid' values must fail, not pass as absent.
 */
export function turnIdentity(event) {
  const envelope = fieldShape(event, 'turnId')
  if (envelope === 'invalid' || fieldShape(event?.payload, 'turnId') === 'invalid') {
    return { id: null, source: 'invalid' }
  }
  if (envelope === 'string') return { id: event.turnId, source: 'envelope' }
  const payload = fieldShape(event?.payload, 'turnId')
  if (payload === 'string') return { id: event.payload.turnId, source: 'payload' }
  return { id: null, source: 'absent' }
}

/** A correct answer and a matched native turn identity are separate claims.
 * State/marker observations NEVER upgrade terminalIdMatched or scenario status.
 * turnCorrelation comes from the turn result when present; the legacy fallback
 * keeps pre-revision callers honest without claiming envelope matching.
 */
export function modelObservation(result, snapshot) {
  return {
    ...result,
    responseMarkerMatched: snapshot.lastAssistantHasMarker === true,
    stateIdleAfterTurn: snapshot.idle === true,
    turnCorrelation: result.turnCorrelation ??
      (result.terminalIdMatched === true ? 'matched-payload-turn-id' : 'unverified'),
  }
}
