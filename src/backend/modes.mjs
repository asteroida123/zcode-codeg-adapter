// ZCode's switchable modes, with the ids and the copy its own picker uses.
//
// Facts behind this table (probed live and read out of the desktop bundle, see
// docs/PROTOCOL-CALIBRATION.md):
//   * The desktop offers exactly four: plan, build, edit, yolo.
//   * `auto` exists in the legacy protocol enum (`plan/build/edit/yolo/auto`)
//     and the backend still accepts it, but it is deliberately not a picker
//     mode and v4 drops it.
//   * `session/setMode` sticks for build/edit/yolo. `plan` is accepted and
//     normalised back to build: plan-ness lives in a workspace preference
//     (`planEnabled`) flipped by the agent's own EnterPlanMode/ExitPlanMode
//     tools, not by a mode value a client can write. The adapter therefore
//     advertises plan so the selector matches ZCode, and reports whatever the
//     session actually runs — never a fabricated mode.
//
// Shared by the ACP surface (the `mode` configOption) and the backend seam
// (the `open()` allowlist) so the two can never drift apart.
export const ZCODE_MODES = [
  { id: 'plan', name: 'Plan mode' },
  { id: 'build', name: 'Ask before changes' },
  { id: 'edit', name: 'Edit automatically' },
  { id: 'yolo', name: 'Full access' },
]

export const ZCODE_MODE_IDS = ZCODE_MODES.map(mode => mode.id)
