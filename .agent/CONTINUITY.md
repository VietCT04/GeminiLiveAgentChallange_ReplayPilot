# CONTINUITY

[PLANS]
- 2026-03-12T07:17:08Z [USER] Remove legacy runSequence flow and keep runComputerUseSequence as the only run flow.

[DECISIONS]
- 2026-03-12T07:17:08Z [CODE] Delete dead unSequence implementation and associated legacy helpers/imports from pps/api/src/lib/runner.ts.

[PROGRESS]
- 2026-03-12T07:17:08Z [TOOL] Initial lint failed on one leftover unused variable in ensureAllowedNavigateUrl; updated URL validation to instantiate without assignment.

[DISCOVERIES]
- 2026-03-12T07:17:08Z [TOOL] git operations are blocked by dubious ownership safety check for G:/personalproject/ReplayPilot (UNCONFIRMED whether intentional environment policy).

[OUTCOMES]
- 2026-03-12T07:17:08Z [CODE] unSequence removed; only unComputerUseSequence remains exported and used by routes.
- 2026-03-12T07:17:08Z [TOOL] 
pm.cmd run lint -w apps/api passed.
- 2026-03-12T07:17:08Z [TOOL] 
pm.cmd run typecheck -w apps/api passed.
