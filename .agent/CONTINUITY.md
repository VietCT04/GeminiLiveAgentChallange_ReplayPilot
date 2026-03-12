# CONTINUITY

[PLANS]
- 2026-03-12T07:17:08Z [USER] Remove legacy runSequence flow and keep runComputerUseSequence as the only run flow.
- 2026-03-12T08:01:08Z [USER] Improve judge behavior to avoid false FAIL after successful login/navigation transitions.

[DECISIONS]
- 2026-03-12T07:17:08Z [CODE] Delete dead runSequence implementation and legacy-only helpers/imports in apps/api/src/lib/runner.ts.
- 2026-03-12T08:01:08Z [CODE] Strengthen judge prompt with post-action transition guidance and add guarded FAIL->RETRY downgrade for weak failure reasons with progress signals.

[PROGRESS]
- 2026-03-12T07:17:08Z [TOOL] Initial lint failed on one leftover unused variable in ensureAllowedNavigateUrl; fixed by constructing URL without assignment.
- 2026-03-12T08:01:08Z [TOOL] First scripted replacement for FAIL branch did not apply; replaced exact block by line-range rewrite.

[DISCOVERIES]
- 2026-03-12T07:17:08Z [TOOL] git operations are blocked by dubious ownership safety check for G:/personalproject/ReplayPilot (UNCONFIRMED whether intentional environment policy).

[OUTCOMES]
- 2026-03-12T07:17:08Z [CODE] runSequence removed; runComputerUseSequence remains exported and route-wired.
- 2026-03-12T07:17:08Z [TOOL] npm.cmd run lint -w apps/api passed.
- 2026-03-12T07:17:08Z [TOOL] npm.cmd run typecheck -w apps/api passed.
- 2026-03-12T08:01:08Z [CODE] judgePipeline prompt and FAIL handling updated to reduce false failures after state transition.
- 2026-03-12T08:01:08Z [TOOL] npm.cmd run lint -w apps/api passed.
- 2026-03-12T08:01:08Z [TOOL] npm.cmd run typecheck -w apps/api passed.
- 2026-03-12T08:03:15Z [USER] Removed guarded FAIL->RETRY downgrade logic from judge pipeline; kept change scope minimal per user instruction.
- 2026-03-12T08:22:11Z [CODE] Runner step counter now updates only on judge PASS; removed step updates during capture and done-without-judge path in apps/api/src/lib/runner.ts.
- 2026-03-12T08:25:49Z [CODE] Enforced done-after-judge-pass in local runner: done action now captures step, runs judge, and only marks success on PASS.
- 2026-03-12T08:31:09Z [CODE] Removed done fast-path in runComputerUseSequence; done now goes through capture + judge path like other actions before completion.
- 2026-03-12T08:32:48Z [CODE] Added explicit success path for done+judge PASS after shared judge flow to avoid unfinished runs when no plan steps exist.
- 2026-03-12T08:43:02Z [CODE] Local executor now accepts wait_N_seconds tool aliases by normalizing to wait and parsing duration from tool name when args lack timing.
- 2026-03-12T09:28:21Z [CODE] Local executor now logs each planner step with LLM tool call name and args before execution.
- 2026-03-12T09:37:03Z [CODE] Judge prompt now instructs PASS for submit/create steps when post-submit success cues appear (including cleared/reset form) even if submit button remains visible.

