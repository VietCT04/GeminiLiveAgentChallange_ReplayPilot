import {
  StartRunResponseSchema,
  type StartRunResponse,
  type RunState,
} from '@replaypilot/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { runDemoSequence } from '../lib/runner';
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

export const runsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/demo', async (_request, reply) => {
    const runState = await createRun(demoGoal);
    app.log.info({ runId: runState.runId }, 'Created demo run');

    void runDemoSequence(runState.runId, app.log).catch(async (error: unknown) => {
      app.log.error(
        { runId: runState.runId, error },
        'Demo run failed during background execution',
      );
    });

    const response: StartRunResponse = {
      runId: runState.runId,
    };

    return reply.send(StartRunResponseSchema.parse(response));
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
