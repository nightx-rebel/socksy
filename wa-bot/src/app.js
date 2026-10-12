import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';

function matchesToken(provided, expected) {
  if (typeof provided !== 'string') return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export function createBotApp({ manager, apiToken, logger = console }) {
  if (!apiToken) throw new Error('BOT_API_TOKEN is required.');

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/healthz', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.use('/pair', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });

  app.get(
    '/pair',
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (request, response) => {
      const authorization = request.get('authorization') ?? '';
      const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!matchesToken(bearerToken, apiToken)) {
        response.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const rawNumber = request.query.number;
      if (typeof rawNumber !== 'string') {
        response.status(400).json({ error: 'Provide a phone number in the number query parameter.' });
        return;
      }

      const phoneNumber = rawNumber.replace(/\D/g, '');
      if (phoneNumber.length < 8 || phoneNumber.length > 15) {
        response.status(400).json({ error: 'Phone number must contain 8 to 15 digits, including country code.' });
        return;
      }

      const requestedUserId = request.query.userId;
      const userId = typeof requestedUserId === 'string' ? requestedUserId.trim() : phoneNumber;
      if (!userId || userId.length > 128) {
        response.status(400).json({ error: 'userId must contain 1 to 128 characters.' });
        return;
      }

      try {
        const { pairingCode } = await manager.addUser(userId, { phoneNumber });
        if (!pairingCode) {
          response.status(409).json({ error: 'This account is already paired.', userId });
          return;
        }
        response.json({ userId, pairingCode });
      } catch (error) {
        logger.error('Pairing request failed', { userId, error });
        response.status(503).json({ error: 'Pairing could not be started. Try again shortly.' });
      }
    },
  );

  return app;
}