import { config as loadEnv } from 'dotenv';
import * as path from 'node:path';
import { buildServer } from './server';

loadEnv({
  path: path.resolve(__dirname, '..', '..', '..', '.env'),
});

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
