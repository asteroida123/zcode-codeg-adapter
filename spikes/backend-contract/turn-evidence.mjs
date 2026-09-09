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

/** A correct answer and a matched native turn identity are separate claims.
 * State/marker observations NEVER upgrade terminalIdMatched or scenario status.
 * Explicit selection avoids spreading future private snapshot fields to reports.
 */
export function modelObservation(result, snapshot) {
  return {
    ...result,
    responseMarkerMatched: snapshot.lastAssistantHasMarker === true,
    stateIdleAfterTurn: snapshot.idle === true,
    turnCorrelation: result.terminalIdMatched === true ? 'matched-payload-turn-id' : 'unverified',
  }
}
