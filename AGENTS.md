# Local development handoff

Read `TASKBOOK.md` before editing. It is the current scoped development brief;
older README/maintenance text describes the legacy launcher baseline, not the
final adapter architecture.

- Work from `spike/zcode-backend-contract` or a feature branch based on it.
  The resume-readiness experiment is integrated; do not reapply the old patch.
- Start with T1 (restored session cannot send), then T2/T3 (turn ownership and
  cancellation). Preserve observed successes and failed-run progress.
- Own a narrow ACP/backend seam. Do not add remote services, an agent framework,
  automatic credential extraction, default approval, or speculative fallbacks.
- Run offline checks first: `npm run check`, `npm test`,
  `npm run test:mutations`, `npm run probe:backend`.
- Live model/file tests require the user's corresponding authorization. The
  temporary workspace is not an OS sandbox. Never log or commit credentials,
  raw private errors, native session identifiers, or personal paths.
- Do not rerun CLI setup on an already working configuration. Do not reset or
  discard existing local work. Do not merge main or publish without permission.
- Once authorized local tools can execute a test, inspect and fix it locally;
  do not make the user shuttle commands and logs between tools.
- Distinguish synthetic tests, user-reported real observations, and newly run
  real tests. An inconclusive result is not a pass.
