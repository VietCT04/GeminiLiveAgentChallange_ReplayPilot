import {
  StartRunRequestSchema,
  type StartRunRequest,
  StartRunResponseSchema,
  type StartRunResponse,
  type RunState,
} from '@replaypilot/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { runSequence } from '../lib/runner';
import { createRun, getRun, resolveArtifactPath, updateRun } from '../lib/run-store';

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
  goal: string,
  log: {
    info: (context: object, message: string) => void;
    error: (context: object, message: string) => void;
  },
): Promise<StartRunResponse> => {
  const runState = await createRun(goal);
  log.info({ runId: runState.runId }, 'Created run');

  void runSequence(runState.runId, log).catch((error: unknown) => {
    log.error({ runId: runState.runId, error }, 'Run failed during background execution');
  });

  return StartRunResponseSchema.parse({
    runId: runState.runId,
  });
};

export const runsRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: StartRunRequest }>('/', async (request, reply) => {
    const parsedBody = StartRunRequestSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        message: 'Invalid run request',
        issues: parsedBody.error.issues,
      });
    }

    const response = await startRun(parsedBody.data.goal, app.log);
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

    const response = await startRun(parsedBody.data.goal, app.log);
    return reply.send(response);
  });

  app.post('/demo', async (_request, reply) => {
    const response = await startRun(demoGoal, app.log);
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
};
