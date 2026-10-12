import { echoPlugin } from './plugins/echo.js';
import { helpPlugin } from './plugins/help.js';
import { pingPlugin } from './plugins/ping.js';

export const plugins = [pingPlugin, helpPlugin, echoPlugin];

export function attachPlugins(manager, registeredPlugins, { concurrency = 32, maxQueue = 2000, logger = console } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('Plugin concurrency must be a positive integer.');
  }
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 1) {
    throw new Error('Plugin maxQueue must be a positive integer.');
  }

  const queue = [];
  const attachedSockets = new WeakSet();
  let active = 0;

  const drain = () => {
    while (active < concurrency && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      void job().catch((error) => logger.error('Message dispatch failed', error)).finally(() => {
        active -= 1;
        drain();
      });
    }
  };

  const enqueue = (job) => {
    if (queue.length >= maxQueue) {
      logger.warn('Plugin queue is full; incoming message was skipped.');
      return;
    }
    queue.push(job);
    drain();
  };

  manager.events.on('user:connected', ({ userId, socket }) => {
    if (attachedSockets.has(socket)) return;
    attachedSockets.add(socket);
    socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const message of messages) {
        if (!message.key.remoteJid || message.key.fromMe) continue;
        enqueue(async () => {
          for (const plugin of registeredPlugins) {
            try {
              await plugin.onMessage({ userId, socket, message });
            } catch (error) {
              logger.error(`Plugin "${plugin.name}" failed`, { userId, error });
            }
          }
        });
      }
    });
  });
}