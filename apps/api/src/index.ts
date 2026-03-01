import { buildServer } from './server';

const port = Number(process.env.PORT ?? 8080);
const app = buildServer();

const start = async (): Promise<void> => {
  try {
    await app.listen({ port, host: '0.0.0.0' });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
