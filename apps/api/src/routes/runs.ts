import {
  GeneratePlanRequestSchema,
  GeneratePlanResponseSchema,
  StartRunRequestSchema,
  type StartRunRequest,
  StartRunResponseSchema,
  type StartRunResponse,
  type RunState,
} from '@replaypilot/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { runComputerUseSequence, runSequence } from '../lib/runner';
import { createRun, getRun, resolveArtifactPath, updateRun } from '../lib/run-store';
import { generateHighLevelPlan } from '../planner/highLevelPlan';

const demoGoal =
  'Open YouTube, search Adele Hello official music video, open top result, attempt Like. Success if Like toggles on or sign in prompt appears.';

const allowedArtifactExtensions = new Set(['.png', '.jpg', '.jpeg', '.json']);

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

const startRun = async (
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
    log.error({ runId: runState.runId, error }, 'Run failed during background execution');
  });

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

  app.post<{ Body: StartRunRequest }>('/', async (request, reply) => {
    const parsedBody = StartRunRequestSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: 'Invalid run request',
        issues: parsedBody.error.issues,
      });
    }

    const response = await startRun(parsedBody.data, app.log, runSequence);
    return reply.send(response);
  });

  app.post<{ Body: StartRunRequest }>('/computer-use', async (request, reply) => {
    const parsedBody = StartRunRequestSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: 'Invalid run request',
        issues: parsedBody.error.issues,
      });
    }

    const response = await startRun(
      parsedBody.data,
      app.log,
      runComputerUseSequence,
    );
    return reply.send(response);
  });

  app.post('/demo', async (_request, reply) => {
    const response = await startRun({ goal: demoGoal }, app.log, runSequence);
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
                Math.min(existingRun.completedPlanSteps, existingRun.planSteps.length - 1)
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
