import Fastify, { type FastifyInstance } from 'fastify';
import { runsRoutes } from './routes/runs';

export const buildServer = (): FastifyInstance => {
  const app = Fastify({
    logger: true,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', 'http://localhost:5173');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');

    if (request.method === 'OPTIONS') {
      await reply.code(204).send();
    }
  });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.register(runsRoutes, {
    prefix: '/runs',
  });

  return app;
};
