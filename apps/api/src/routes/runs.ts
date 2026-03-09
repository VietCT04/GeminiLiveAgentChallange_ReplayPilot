import {
  ActionSchema,
  GeneratePlanRequestSchema,
  GeneratePlanResponseSchema,
  StartRunRequestSchema,
  type StartRunRequest,
  StartRunResponseSchema,
  type StartRunResponse,
  type RunState,
} from '@replaypilot/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { evaluateStep } from '../observer/judgePipeline';
import { runComputerUseSequence } from '../lib/runner';
import {
  appendHistory,
  createRun,
  getRun,
  listRuns,
  resolveArtifactPath,
  updateRun,
  writeArtifactJson,
} from '../lib/run-store';
import {
  planComputerUseStepDetailed,
} from '../planner/geminiPlanner';
import { generateHighLevelPlan } from '../planner/highLevelPlan';

const allowedArtifactExtensions = new Set(['.png', '.jpg', '.jpeg', '.json']);
const defaultViewport = {
  width: 1280,
  height: 720,
};

const RuntimeModeSchema = z.enum(['local-runner', 'orchestrator']);
const runtimeMode = RuntimeModeSchema.catch('local-runner').parse(
  process.env.REPLAYPILOT_MODE,
);
const isOrchestratorMode = runtimeMode === 'orchestrator';

const OrchestratorPlannerRequestSchema = z.object({
  screenshotBase64: z.string().min(1),
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
});

const OrchestratorReportStepRequestSchema = z.object({
  action: ActionSchema,
  summary: z.string().trim().min(1).max(500).optional(),
  screenshotBase64: z.string().min(1),
  currentUrl: z.string().trim().min(1),
  previousUrl: z.string().trim().min(1).nullable().optional(),
  previousScreenshotHash: z.string().trim().min(1).nullable().optional(),
});

const isNotFoundError = (error: unknown): boolean => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
};

const isInvalidArtifactPathError = (error: unknown): boolean => {
  return error instanceof Error && error.message === 'Invalid artifact path';
};

const sendNotFound = async (reply: FastifyReply): Promise<void> => {
  await reply.code(404).send({ message: 'Not found' });
};

const sendModeConflict = async (reply: FastifyReply): Promise<void> => {
  await reply.code(409).send({
    message:
      'This route is disabled in orchestrator mode. Use /runs/orchestrator/start and orchestrator step endpoints.',
  });
};

const formatStepFileName = (
  prefix: string,
  index: number,
  extension: string,
): string => {
  return `${prefix}_${String(index).padStart(2, '0')}.${extension}`;
};

const getCurrentPlanCriteria = (runState: RunState): string => {
  if (!runState.planSteps.length) {
    return runState.goal;
  }

  const currentStepIndex = Math.min(
    runState.completedPlanSteps,
    runState.planSteps.length - 1,
  );

  return runState.planSteps[currentStepIndex] ?? runState.goal;
};

const decodeScreenshotBytes = (base64: string): Buffer => {
  const normalized = base64.includes(',')
    ? base64.slice(base64.indexOf(',') + 1)
    : base64;

  return Buffer.from(normalized, 'base64');
};

const writePlannerDebugFiles = async (
  runId: string,
  index: number,
  debug: unknown,
): Promise<void> => {
  await writeArtifactJson(
    runId,
    formatStepFileName('planner_request', index, 'json'),
    (debug as { request: unknown }).request,
  );
  await writeArtifactJson(
    runId,
    formatStepFileName('planner_response', index, 'json'),
    (debug as { response: unknown }).response,
  );
};

const startRunInBackground = async (
  requestBody: StartRunRequest,
  log: {
    info: (context: object, message: string) => void;
    error: (context: object, message: string) => void;
  },
  runInBackground: (
    runId: string,
    log: { info: (context: object, message: string) => void },
  ) => Promise<void>,
): Promise<StartRunResponse> => {
  const runState = await createRun(requestBody.goal, requestBody.planSteps ?? []);
  log.info({ runId: runState.runId }, 'Created run');

  void runInBackground(runState.runId, log).catch((error: unknown) => {
    log.error(
      { runId: runState.runId, error },
      'Run failed during background execution',
    );
  });

  return StartRunResponseSchema.parse({
    runId: runState.runId,
  });
};

const startRunWithoutBackground = async (
  requestBody: StartRunRequest,
  log: {
    info: (context: object, message: string) => void;
  },
): Promise<StartRunResponse> => {
  const runState = await createRun(requestBody.goal, requestBody.planSteps ?? []);
  log.info({ runId: runState.runId }, 'Created run in orchestrator mode');

  return StartRunResponseSchema.parse({
    runId: runState.runId,
  });
};

export const runsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/plan', async (request, reply) => {
    const parsedBody = GeneratePlanRequestSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: 'Invalid plan request',
        issues: parsedBody.error.issues,
      });
    }

    const generatedPlan = await generateHighLevelPlan(parsedBody.data.goal);
    const response = GeneratePlanResponseSchema.parse({
      goal: parsedBody.data.goal,
      summary: generatedPlan.summary,
      steps: generatedPlan.steps,
    });

    return reply.send(response);
  });

  app.post<{ Body: StartRunRequest }>('/orchestrator/start', async (request, reply) => {
    const parsedBody = StartRunRequestSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: 'Invalid run request',
        issues: parsedBody.error.issues,
      });
    }

    const response = await startRunWithoutBackground(parsedBody.data, app.log);
    return reply.send(response);
  });

  app.get('/orchestrator/pending', async (_request, reply) => {
    const runs = await listRuns();
    const pending = runs
      .filter((run) => run.status === 'running' && run.history.length === 0)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((run) => ({
        runId: run.runId,
        goal: run.goal,
      }));

    return reply.send({
      pending,
    });
  });

  app.post<{ Params: { runId: string } }>(
    '/:runId/orchestrator/plan-next',
    async (request, reply) => {
      const parsedBody = OrchestratorPlannerRequestSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          message: 'Invalid orchestrator planner request',
          issues: parsedBody.error.issues,
        });
      }

      try {
        const runState = await getRun(request.params.runId);
        const screenshotBytes = decodeScreenshotBytes(parsedBody.data.screenshotBase64);
        const viewport = parsedBody.data.viewport ?? defaultViewport;
        const plannerIndex = runState.history.length;

        const { toolCall, actionPreview, summary, debug } =
          await planComputerUseStepDetailed(
            runState.goal,
            screenshotBytes,
            runState.history,
            viewport,
            {
              verifierLowConfidenceStreak: 0,
              planSteps: runState.planSteps,
              completedPlanSteps: runState.completedPlanSteps,
            },
          );
        await writePlannerDebugFiles(runState.runId, plannerIndex, debug);

        return reply.send({
          planner: 'computer-use',
          ...(toolCall ? { toolCall } : {}),
          actionPreview,
          summary,
          runState,
        });
      } catch (error) {
        if (isNotFoundError(error)) {
          return sendNotFound(reply);
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { runId: string } }>(
    '/:runId/orchestrator/report-step',
    async (request, reply) => {
      const parsedBody = OrchestratorReportStepRequestSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          message: 'Invalid step report request',
          issues: parsedBody.error.issues,
        });
      }

      try {
        const runState = await getRun(request.params.runId);
        const index = runState.history.length;
        const screenshotName = formatStepFileName('step', index, 'png');
        const screenshotPath = resolveArtifactPath(runState.runId, screenshotName);
        const screenshotBytes = decodeScreenshotBytes(parsedBody.data.screenshotBase64);

        await writeFile(screenshotPath, screenshotBytes);
        await appendHistory(runState.runId, {
          index,
          ts: Date.now(),
          action: parsedBody.data.action,
          screenshotName,
          note: parsedBody.data.summary ?? 'Reported by local executor',
        });

        let nextRunState = await updateRun(runState.runId, {
          status: 'running',
          step: index + 1,
          lastAction: parsedBody.data.action,
          lastScreenshotUrl: `/runs/${runState.runId}/artifacts/${screenshotName}`,
          updatedAt: Date.now(),
        });

        const evaluation = await evaluateStep({
          goal: runState.goal,
          stepIndex: runState.completedPlanSteps,
          stepCriteria: getCurrentPlanCriteria(runState),
          currentUrl: parsedBody.data.currentUrl,
          previousUrl: parsedBody.data.previousUrl ?? null,
          screenshotBytes,
          previousScreenshotHash: parsedBody.data.previousScreenshotHash ?? null,
        });
        await writeArtifactJson(
          runState.runId,
          formatStepFileName('judge', index, 'json'),
          evaluation,
        );

        if (evaluation.verdict === 'WAITING_FOR_HUMAN') {
          nextRunState = await updateRun(runState.runId, {
            status: 'waiting_for_human',
            updatedAt: Date.now(),
            handoff: {
              reason: evaluation.handoffReason ?? 'CAPTCHA_DETECTED',
              url: parsedBody.data.currentUrl,
              screenshotUrl: `/runs/${runState.runId}/artifacts/${screenshotName}`,
            },
          });
        } else if (evaluation.verdict === 'FAIL') {
          nextRunState = await updateRun(runState.runId, {
            status: 'fail',
            updatedAt: Date.now(),
            error: `Judge failed step: ${evaluation.reasonsUi.join('; ')}`,
          });
        } else if (
          evaluation.verdict === 'PASS' &&
          runState.planSteps.length > 0 &&
          runState.completedPlanSteps < runState.planSteps.length
        ) {
          const nextCompletedPlanSteps = runState.completedPlanSteps + 1;
          const hasFinishedPlan = nextCompletedPlanSteps >= runState.planSteps.length;
          nextRunState = await updateRun(runState.runId, {
            completedPlanSteps: nextCompletedPlanSteps,
            ...(hasFinishedPlan
              ? {
                  status: 'success' as const,
                }
              : {}),
            updatedAt: Date.now(),
          });
        }

        return reply.send({
          verdict: evaluation.verdict,
          reasonsUi: evaluation.reasonsUi,
          reasonsFull: evaluation.reasonsFull,
          screenshotHash: evaluation.screenshotHash,
          runState: nextRunState,
        });
      } catch (error) {
        if (isNotFoundError(error)) {
          return sendNotFound(reply);
        }
        throw error;
      }
    },
  );

  app.post<{ Body: StartRunRequest }>('/computer-use', async (request, reply) => {
    if (isOrchestratorMode) {
      return sendModeConflict(reply);
    }

    const parsedBody = StartRunRequestSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: 'Invalid run request',
        issues: parsedBody.error.issues,
      });
    }

    const response = await startRunInBackground(
      parsedBody.data,
      app.log,
      runComputerUseSequence,
    );
    return reply.send(response);
  });

  app.get<{ Params: { runId: string } }>('/:runId', async (request, reply) => {
    try {
      const runState: RunState = await getRun(request.params.runId);
      return reply.send(runState);
    } catch (error) {
      if (isNotFoundError(error)) {
        return sendNotFound(reply);
      }
      throw error;
    }
  });

  app.get<{ Params: { runId: string; name: string } }>(
    '/:runId/artifacts/:name',
    async (request, reply) => {
      const { runId, name } = request.params;
      const ext = path.extname(name).toLowerCase();

      if (path.basename(name) !== name || !allowedArtifactExtensions.has(ext)) {
        return sendNotFound(reply);
      }

      try {
        const artifactPath = resolveArtifactPath(runId, name);
        const file = await readFile(artifactPath);

        if (ext === '.png') {
          reply.type('image/png');
        } else if (ext === '.jpg' || ext === '.jpeg') {
          reply.type('image/jpeg');
        } else if (ext === '.json') {
          reply.type('application/json');
        }

        return reply.send(file);
      } catch (error) {
        if (isNotFoundError(error) || isInvalidArtifactPathError(error)) {
          return sendNotFound(reply);
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { runId: string } }>(
    '/:runId/stop',
    async (request, reply) => {
      try {
        const runState = await updateRun(request.params.runId, {
          status: 'stopped',
          updatedAt: Date.now(),
        });

        app.log.info({ runId: runState.runId }, 'Stopped run');
        return reply.send(runState);
      } catch (error) {
        if (isNotFoundError(error)) {
          return sendNotFound(reply);
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { runId: string } }>(
    '/:runId/resume',
    async (request, reply) => {
      try {
        const existingRun = await getRun(request.params.runId);
        const currentPlanStep =
          existingRun.planSteps.length > 0
            ? existingRun.planSteps[
                Math.min(
                  existingRun.completedPlanSteps,
                  existingRun.planSteps.length - 1,
                )
              ]
            : undefined;
        const runState = await updateRun(request.params.runId, {
          status: 'running',
          updatedAt: Date.now(),
          handoff: undefined,
          ...(existingRun.handoff?.reason === 'SAFETY_CONFIRMATION_PENDING' &&
          currentPlanStep
            ? {
                approvedSafetyStep: currentPlanStep,
              }
            : {}),
        });

        app.log.info({ runId: runState.runId }, 'Resumed run');
        return reply.send(runState);
      } catch (error) {
        if (isNotFoundError(error)) {
          return sendNotFound(reply);
        }
        throw error;
      }
    },
  );
};
