# ReplayPilot

ReplayPilot is a browser automation copilot: a user describes a goal in chat, the system drafts an editable execution plan, launches a live browser, executes step by step, and continuously verifies its own progress with visual checks before moving forward.

The repo is intentionally opinionated around one core idea: browser agents should not blindly act. They should plan first, act in small steps, verify each step, pause for humans when needed, and keep artifacts for every important decision.

## What Makes This Project Strong

- Human-first control loop: the user does not immediately launch an agent. A high-level plan is generated first, shown in the UI, and can be edited before execution begins.
- Multi-stage agent safety: the runtime includes CAPTCHA detection, safety confirmation handoff, deterministic no-progress checks, and a Gemini-based visual verifier before marking a step complete.
- Artifact-driven debugging: planner requests, planner responses, screenshots, and verification verdicts are written to disk for every run so failures are inspectable after the fact.
- Shared contracts: frontend and backend use a shared Zod schema package, which keeps run state, plan data, and API payloads consistent.
- Practical browser automation: Playwright drives a real Chromium instance, while Gemini handles planning and visual reasoning.


## Architecture

### Monorepo Layout

- `apps/controller`: React + Vite frontend for chat, plan editing, screenshots, and live run status.
- `apps/api`: Fastify + Playwright + Gemini backend.
- `packages/shared`: Shared Zod schemas and TypeScript types used by both frontend and backend.

### Frontend (`apps/controller`)

The controller is a chat-style interface, but it is not just a text box:

- Normal chat first: user messages go to backend chat (`POST /runs/chat`) and the assistant replies conversationally.
- Workflow discovery: the assistant asks follow-up questions until automation requirements are complete.
- Workflow proposal: once details are sufficient, the assistant sends a proposal in chat and enables plan generation.
- Draft plan generation: `Generate Workflow Plan` requests a high-level plan before execution starts.
- Plan editor: the user can review, edit, remove, and add plan steps before confirming.
- Run controls: confirm, resume, and stop actions are available in the same panel.
- Progress panel: the right side shows run state, plan progress, handoff status, and the latest screenshot.
- Chat transcript: system and agent messages explain what is happening during execution.

This makes the product feel like a guided browser copilot rather than a black-box agent.

### Backend (`apps/api`)

The backend is where most of the interesting mechanics live:

- Fastify API for plan generation, run creation, run polling, artifact serving, stop, and resume.
- Playwright runtime for real browser control.
- Gemini high-level planning for user-facing draft plans.
- Gemini step planning for one-action-at-a-time execution.
- Gemini visual verification for step completion.
- State detection for blocker classification (including visual CAPTCHA detection support).

## Core Mechanisms

## 1. Plan-First Execution

The agent does not run immediately after a goal is entered.

Instead:

- `POST /runs/chat` handles normal chat and workflow discovery/proposal.
- `POST /runs/plan` generates a high-level plan after proposal confirmation.
- The plan is shown to the user in the UI.
- The user can edit the plan steps.
- Only then does `POST /runs` or `POST /runs/computer-use` begin execution.

This creates a strong approval boundary:

- the user sees what the agent intends to do
- the backend stores the approved plan on the run
- the runtime tracks `completedPlanSteps` against that approved plan

### Why this matters

This is important because the system is not merely "LLM clicks random things." It is a controlled workflow:

- intent capture
- plan proposal
- human approval
- guarded execution

## 2. High-Level Plan Generation

The high-level plan generator lives in:

- `apps/api/src/planner/highLevelPlan.ts`

It uses Gemini 2.5 Flash in structured JSON mode:

- `responseMimeType: "application/json"`
- explicit response schema

This avoids fragile prompt-only JSON parsing.

The backend also sanitizes the plan:

- it removes the common useless final "verify success" step
- it keeps the plan concise and user-editable

### Why this matters

This improves both UX and execution clarity:

- users get a clear, editable plan
- the system has a concrete execution contract
- the UI can show meaningful progress against plan steps, not just raw browser actions

## 3. Step Planner

The step planner lives in:

- `apps/api/src/planner/geminiPlanner.ts`

It is responsible for choosing the next atomic action from the current screenshot and recent history.

Supported action types:

- `navigate`
- `click`
- `type`
- `scroll`
- `wait`
- `done`

For Computer Use mode, the backend accepts Gemini tool-call variants and normalizes them. This includes aliases like:

- `goto`, `open_url` -> `navigate`
- `double_click` -> `click` with `clicks: 2`
- `wait_5_seconds` -> `wait`
- `press_enter` -> `press_key`

### Strong planner context

The planner is not only given the raw goal. It is also given:

- current approved plan step index
- the exact current plan step
- completed steps
- upcoming steps

This reduces vague planning and keeps the model aligned with the user-approved sequence.

## 4. Browser Runtime

The browser executor lives in:

- `apps/api/src/lib/runner.ts`

Key runtime behavior:

- launches Chromium automatically
- opens Google automatically as the default start page
- executes one action at a time
- captures a screenshot after each step
- writes the step into run history
- updates run state continuously

### Typing semantics

ReplayPilot uses fill-style typing behavior:

- focus the field
- `Ctrl+A`
- `Backspace`
- type the intended value

This prevents accidental append behavior like:

- `agent@example.comagent@example.com`

### Smart Enter suppression

If a `type_*` action includes an implicit Enter/submit, the runtime checks upcoming approved plan steps:

- if the next plan clearly says to click a login or submit button, the Enter is suppressed
- otherwise, Enter can still be used

This prevents the model from prematurely submitting a form when typing and submit are meant to be separate steps.

## 5. Verification Pipeline

The verification pipeline lives in:

- `apps/api/src/observer/judgePipeline.ts`

This is one of the strongest technical parts of the repo.

Every executed step is verified after the action runs.

### Stage 0: Hard Blocks

The system immediately pauses for a human when:

- a CAPTCHA is detected
- a sensitive step requires human confirmation

Possible handoff reasons:

- `CAPTCHA_DETECTED`
- `SAFETY_CONFIRMATION_PENDING`

### Stage 1: Deterministic Signals

Before relying only on the model, the system also uses:

- current URL comparison
- screenshot hash comparison

This helps detect:

- no-progress loops
- real visual movement between states

### Stage 2: Vision Verification

Gemini is asked a narrow structured question:

- Did this screenshot satisfy the current plan step?
- Should the run `PASS`, `RETRY`, `FAIL`, or `WAITING_FOR_HUMAN`?

The verifier returns:

- verdict
- reasons
- evidence

Again, this uses structured JSON mode rather than prompt-only JSON.

### Stage 3: Decision Rule

The runtime applies the verdict:

- `PASS`: marks the current approved plan step complete
- `RETRY`: continue trying the same plan step
- `FAIL`: fail the run with a concrete reason
- `WAITING_FOR_HUMAN`: pause and wait for user resume

### Auto-stop on plan completion

The run does not have to wait for the planner to emit `done`.

Once the final approved plan step passes verification:

- the run is marked `success`
- the loop stops immediately

This keeps termination aligned with user-approved intent.

## 6. State Detection

The state detector lives in:

- `apps/api/src/observer/stateDetector.ts`

It uses Gemini structured outputs to classify the current browser screen, including:

- phase (`landing`, `auth`, `form`, `loading`, etc.)
- affordances (search input, primary button, results list, and more)
- blockers (`captcha`, `signin`, `modal`, and more)

This is used as an assistive signal in the verification pipeline, especially for hard blocks like CAPTCHA.

## 7. Human-in-the-Loop Handoff

When the system hits a situation that should not be handled automatically, it pauses the run instead of guessing.

That includes:

- CAPTCHA
- sensitive confirmation steps

Mechanism:

- run status becomes `waiting_for_human`
- a handoff screenshot is captured
- the reason and current URL are stored in run state
- the UI shows the paused state and allows `Resume`

This is important because it demonstrates that the agent is designed to fail safely, not just aggressively.

## 8. Artifact-Driven Debugging

Each run writes inspectable artifacts under:

- `apps/api/data/runs/<runId>/`

Common artifacts:

- `run.json`: full persisted run state
- `step_XX.png`: step screenshots
- `planner_request_XX.json`: what was sent to Gemini
- `planner_response_XX.json`: Gemini output plus parsed action
- `judge_XX.json`: verification verdict, reasons, evidence, and deterministic signals

This makes failures explainable after the fact. It is a major practical advantage during demos and debugging.

## API Surface

### Health

- `GET /health`

Basic backend liveness check.

### Plan Generation

- `POST /runs/plan`

Input:

- goal

Output:

- goal
- summary
- steps

### Chat Assistant

- `POST /runs/chat`

Input:

- message
- recent chat history (`role`, `text`)

Output:

- `assistantMessage`
- `workflowPhase` (`CHAT`, `DISCOVERY`, `PROPOSAL`)
- optional proposal fields (`proposalGoal`, `proposalSummary`)

### Start Run

- `POST /runs`
- `POST /runs/computer-use`

Input:

- goal
- approved `planSteps`

Output:

- `runId`

### Poll Run

- `GET /runs/:runId`

Returns the full run state:

- goal
- plan steps
- completed plan steps
- status
- history
- handoff info
- latest screenshot URL
- last action
- error

### Resume / Stop

- `POST /runs/:runId/resume`
- `POST /runs/:runId/stop`

### Artifacts

- `GET /runs/:runId/artifacts/:name`

Serves screenshots and JSON artifacts.

## Run State Model

Important run statuses:

- `queued`
- `running`
- `waiting_for_human`
- `success`
- `fail`
- `stopped`

This is more than just "running vs done." It captures meaningful execution lifecycle states for the UI and for safer control flow.

## Local Development

## Prerequisites

- Node.js 20
- A `GOOGLE_API_KEY` in `.env`

For local Playwright browser control:

```bash
npx playwright install chromium
```

## Install

```bash
npm install
```

## Run

```bash
npm run dev
```

URLs:

- Controller: `http://localhost:5173`
- API: `http://localhost:8080`
- Health: `http://localhost:8080/health`

### Local vs Cloud changes

- Frontend-only changes: restart/refresh `apps/controller` locally (no push required for local testing).
- Backend-only changes: restart `apps/api` locally (no push required for local testing).
- To test on Cloud Run, push and redeploy backend/frontend services so remote revisions pick up your changes.

## Build

```bash
npm run build
```

## Why This Matters

ReplayPilot is not just "an LLM with a browser."

It demonstrates a more serious agent architecture:

- explicit planning before action
- human approval before execution
- structured outputs instead of brittle free-form parsing
- post-action visual verification
- deterministic guardrails
- safe pause and resume when confidence is not enough
- full artifact traceability for debugging and demos

That combination is the core technical value of the repo.

## Current Tradeoffs

This is still a fast-moving project, so some choices are intentionally pragmatic:

- The controller UI is focused on operational clarity, not multi-user auth or production polish.
- The verifier and planner are strong, but still model-driven, so prompt and schema design matter.
- Browser control currently uses a single local Playwright session rather than a remote streaming browser.
- The system optimizes for inspectability and safety over raw speed.

Those tradeoffs are acceptable here because they keep the important ideas easy to inspect and understand.

## Key Files

- `apps/api/src/routes/runs.ts`: main HTTP API
- `apps/api/src/lib/runner.ts`: browser runtime and execution loop
- `apps/api/src/planner/highLevelPlan.ts`: draft plan generation
- `apps/api/src/planner/geminiPlanner.ts`: next-step planning
- `apps/api/src/observer/stateDetector.ts`: visual state classification
- `apps/api/src/observer/judgePipeline.ts`: step verification and decision logic
- `apps/controller/src/App.tsx`: chat UI, plan editor, and run monitoring
- `packages/shared/src/index.ts`: shared contracts

## Summary

ReplayPilot's core achievement is not that it can click buttons. It is that it wraps browser automation in a safer, inspectable, human-reviewed workflow:

- plan first
- approve
- act in small steps
- verify each step
- pause when uncertain
- stop when the approved plan is complete

That is the foundation of a trustworthy browser agent, and that is what this repository is built to demonstrate.
