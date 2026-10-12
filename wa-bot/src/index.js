import 'dotenv/config';
import { createAuthStore, MultiSocketManager } from 'wa-multi-socket';
import { createBotApp } from './app.js';
import { attachPlugins, plugins } from './plugins/index.js';

const apiToken = process.env.BOT_API_TOKEN;
if (!apiToken) throw new Error('Set BOT_API_TOKEN before starting the bot.');

const positiveInteger = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
};

const manager = new MultiSocketManager({
  authStore: createAuthStore(process.env.DATABASE_URL),
  maxConcurrentConnections: positiveInteger('MAX_CONCURRENT_CONNECTIONS', 30),
  maxConcurrentPairings: positiveInteger('MAX_CONCURRENT_PAIRINGS', 5),
});

attachPlugins(manager, plugins, {
  concurrency: positiveInteger('PLUGIN_CONCURRENCY', 32),
  maxQueue: positiveInteger('PLUGIN_MAX_QUEUE', 2000),
});

manager.events.on('manager:error', ({ userId, error }) => {
  console.error('Socket manager error', { userId, error });
});
manager.events.on('user:logged-out', ({ userId }) => {
  console.info('WhatsApp session logged out', { userId });
});

const port = positiveInteger('PORT', 3000);
const app = createBotApp({ manager, apiToken });
const server = app.listen(port, () => console.info(`Bot API listening on port ${port}`));

await manager.start();

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    void manager.close().then(() => process.exit(0)).catch((error) => {
      console.error('Shutdown failed', error);
      process.exit(1);
    });
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);