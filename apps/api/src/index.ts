import { getEnv } from "./config/env.js";
import { createServer } from "./server.js";
import { startNeonProxy } from "./lib/neon-proxy.js";

async function start() {
  // Start the Neon TLS proxy before Prisma connects
  await startNeonProxy();

  const env = getEnv();
  const app = createServer();

  try {
    await app.listen({
      host: env.API_HOST,
      port: env.API_PORT
    });
    app.log.info({ port: env.API_PORT }, "API server listening");
  } catch (error) {
    app.log.error({ err: error }, "Failed to start API server");
    process.exit(1);
  }
}

void start();
