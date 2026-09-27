import { ProbeError, object } from './errors.mjs'

const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512

/** Extract only a native selection, never credentials or a provider definition.
 * This candidate deliberately supports one observed snapshot layout. Missing or
 * changed layouts stop the experiment; they do not select a default model.
 */
/** The provider's own display name for `ref`, taken from the snapshot's
 * available list — the one place the native backend names a provider. Null when
 * the snapshot carries none, so callers degrade instead of inventing a name. */
function providerLabelFromSnapshot(snapshot, ref) {
  const available = snapshot?.settings?.model?.available
  if (!Array.isArray(available)) return null
  for (const entry of available) {
    const candidate = object(entry?.ref) ? entry.ref : entry
    if (!object(candidate)) continue
    if (candidate.providerId !== ref.providerId || candidate.modelId !== ref.modelId) continue
    return identifier(entry?.providerLabel) ? entry.providerLabel : null
  }
  return null
}

export function modelReferenceFromSnapshot(snapshot) {
  const ref = snapshot?.settings?.model?.current
  if (!object(ref) || !identifier(ref.providerId) || !identifier(ref.modelId)) return null
  const out = { providerId: ref.providerId, modelId: ref.modelId }
  const providerLabel = providerLabelFromSnapshot(snapshot, out)
  if (providerLabel) out.providerLabel = providerLabel
  return out
}

/** Relay ONLY a model runtime the native side itself published in a snapshot.
 * The adapter never constructs provider definitions or auth material; if the
 * native snapshot exposes none, the caller continues without one.
 */
export function modelRuntimeFromSnapshot(snapshot) {
  const runtime = snapshot?.settings?.runtimeModel
  return object(runtime) ? runtime : null
}

const same = (a, b) => a !== null && b !== null && a.providerId === b.providerId && a.modelId === b.modelId

/** Opt-in same-model reselection experiment, NOT a general restore repair.
 * The native service remains responsible for model resolution and auth. No
 * runtimeModel overlay, provider-registry push, config read or prompt retry.
 * A successful setModel response alone is insufficient: read back the exact
 * original selection and idle state before the caller may continue.
 */
export async function rebindOriginalModel(rpc, sessionId, original) {
  if (!object(original) || !identifier(original.providerId) || !identifier(original.modelId)) {
    throw new ProbeError('E_RESUME_MODEL_REFERENCE')
  }
  const expected = { providerId: original.providerId, modelId: original.modelId }
  const before = await rpc.request('session/read', { sessionId })
  const selected = modelReferenceFromSnapshot(before)
  if (!selected) throw new ProbeError('E_RESUME_MODEL_REFERENCE')
  if (!same(selected, expected)) throw new ProbeError('E_RESUME_MODEL_CHANGED')
  if (before?.settings?.mode?.current !== 'plan') throw new ProbeError('E_RESUME_MODE_CHANGED')
  if (before?.projection?.status !== 'idle') throw new ProbeError('E_RESUME_NOT_IDLE')
  await rpc.request('session/setModel', {
    sessionId,
    model: expected,
    persistAsWorkspaceLastUsed: false,
  })
  const after = await rpc.request('session/read', { sessionId })
  if (!same(modelReferenceFromSnapshot(after), expected)) throw new ProbeError('E_RESUME_MODEL_CHANGED')
  if (after?.settings?.mode?.current !== 'plan') throw new ProbeError('E_RESUME_MODE_CHANGED')
  if (after?.projection?.status !== 'idle') throw new ProbeError('E_RESUME_NOT_IDLE')
  // This verifies selection/state only, not authorization or successful inference.
  return { attempted: true, verified: true, originalSelectionRetained: true, planModeRetained: true, stateIdleAfterRebind: true }
}
