import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { WaManagerError } from 'wa-multi-socket';
import { log } from './logger.js';

const STATUS_BY_CODE = {
  INVALID_ARGUMENT: 400,
  ALREADY_PAIRED: 409,
  PAIRING_IN_PROGRESS: 409,
  NOT_CONNECTED: 409,
  QUEUE_FULL: 429,
  CLOSED: 503,
  NOT_AVAILABLE: 503,
  TIMEOUT: 504,
  PAIRING_TIMEOUT: 504,
  CONNECTION_TIMEOUT: 504,
};

const sha256 = (value) =>
  createHash('sha256').update(String(value)).digest();

/** Tiny in-memory fixed-window limiter (per client IP). */
function rateLimit(max, windowMs) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();

    for (const [key, rec] of hits) {
      if (rec.reset < now) hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const rec = hits.get(key);

    if (!rec || rec.reset < now) {
      hits.set(key, {
        count: 1,
        reset: now + windowMs,
      });

      return next();
    }

    rec.count += 1;

    if (rec.count > max) {
      res.set(
        'Retry-After',
        String(Math.ceil((rec.reset - now) / 1000)),
      );

      log.warn('🚦', 'http', `Rate limit hit by ${key}`);

      return res.status(429).json({
        ok: false,
        error: 'rate_limited',
      });
    }

    return next();
  };
}

const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const toJid = (to) => {
  const value = String(to ?? '').trim();

  if (value.includes('@')) return value;

  const digits = value.replace(/\D/g, '');

  return digits ? `${digits}@s.whatsapp.net` : '';
};

/**
 * @param {{
 *   manager: import('wa-multi-socket').MultiSocketManager,
 *   apiKey?: string,
 *   pairingWindowMs: number
 * }} options
 */
export function createServer({ manager, apiKey, pairingWindowMs }) {
  const app = express();

  app.disable('x-powered-by');

  app.use(express.json({ limit: '10kb' }));

  // Every account we have seen.
  // Reconnecting and offline accounts are still listed.
  const known = new Set();

  const ev = manager.events;

  ev.on('user:connecting', ({ userId }) => {
    known.add(userId);
  });

  for (const name of [
    'user:removed',
    'user:logged-out',
    'user:pairing-failed',
    'user:pruned',
  ]) {
    ev.on(name, ({ userId }) => {
      if (userId) known.delete(userId);
    });
  }

  const listUsers = () => {
    const ids = new Set([
      ...known,
      ...manager.getUserIds(),
    ]);

    return [...ids]
      .sort()
      .map((userId) => ({
        userId,
        status: manager.getStatus(userId),
      }));
  };

  // Request logging
  app.use((req, res, next) => {
    const t0 = Date.now();

    res.on('finish', () => {
      log.debug(
        '🌐',
        'http',
        `${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - t0}ms)`,
      );
    });

    next();
  });

  // Optional API key authentication
  if (apiKey) {
    const expected = sha256(apiKey);

    app.use((req, res, next) => {
      if (req.path === '/health') {
        return next();
      }

      const given = sha256(req.get('x-api-key') ?? '');

      if (timingSafeEqual(given, expected)) {
        return next();
      }

      log.warn(
        '🔒',
        'http',
        `Rejected ${req.method} ${req.path}: bad or missing x-api-key`,
      );

      return res.status(401).json({
        ok: false,
        error: 'unauthorized',
      });
    });
  }

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      uptimeSeconds: Math.floor(process.uptime()),
      stats: manager.getStats(),
    });
  });

  // API routes information
  app.get('/', (_req, res) => {
    res.json({
      ok: true,
      port: 5000,
      routes: [
        'GET|POST /pair?phone=<number>[&userId=<id>]   -> returns a pairing code',
        'GET  /users                                   -> all accounts + status',
        'GET  /users/:userId                           -> one account',
        'POST /users/:userId/connect                   -> (re)connect a saved account',
        'POST /users/:userId/disconnect                -> close socket, keep auth',
        'POST /users/:userId/logout                    -> unlink device + delete auth',
        'DELETE /users/:userId                         -> close socket + delete auth',
        'POST /send  {userId, to, text}                -> send a text through the rate-limited queue',
        'GET  /health',
      ],
    });
  });

  // ── Pairing ─────────────────────────────────────────────
  app.all(
    '/pair',
    rateLimit(10, 60_000),
    wrap(async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({
          ok: false,
          error: 'method_not_allowed',
        });
      }

      const input = {
        ...req.query,
        ...(req.body && typeof req.body === 'object'
          ? req.body
          : {}),
      };

      const phone = String(input.phone ?? '').trim();
      const digits = phone.replace(/\D/g, '');

      if (!digits) {
        return res.status(400).json({
          ok: false,
          error: 'phone_required',
          hint:
            'curl "http://localhost:5000/pair?phone=<country code + number>"',
        });
      }

      const userId = String(input.userId ?? `user-${digits}`);

      log.info(
        '🔑',
        'pair',
        `Pair request: userId=${userId}, phone=***${digits.slice(-4)}`,
      );

      const { pairingCode } = await manager.addUser(userId, {
        phoneNumber: phone,
      });

      if (!pairingCode) {
        log.info(
          '♻️',
          'pair',
          `${userId} is already paired; it is just connecting`,
        );

        return res.json({
          ok: true,
          userId,
          alreadyPaired: true,
          status: manager.getStatus(userId),
        });
      }

      return res.json({
        ok: true,
        userId,
        pairingCode,
        expiresInSeconds: Math.round(pairingWindowMs / 1000),
        instructions:
          'WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead',
      });
    }),
  );

  // ── Accounts ────────────────────────────────────────────
  app.get('/users', (_req, res) => {
    res.json({
      ok: true,
      stats: manager.getStats(),
      users: listUsers(),
    });
  });

  app.get('/users/:userId', (req, res) => {
    const { userId } = req.params;

    const found = listUsers().find(
      (user) => user.userId === userId,
    );

    if (!found) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
      });
    }

    const socket = manager.getConnectedSocket(userId);

    return res.json({
      ok: true,
      ...found,
      account: socket?.user?.id ?? null,
    });
  });

  // Connect or reconnect a saved account
  app.post(
    '/users/:userId/connect',
    wrap(async (req, res) => {
      await manager.connectUser(req.params.userId);

      res.json({
        ok: true,
        userId: req.params.userId,
        status: manager.getStatus(req.params.userId),
      });
    }),
  );

  // Disconnect while keeping authentication
  app.post(
    '/users/:userId/disconnect',
    wrap(async (req, res) => {
      await manager.disconnectUser(req.params.userId);

      res.json({
        ok: true,
        userId: req.params.userId,
        status: manager.getStatus(req.params.userId),
      });
    }),
  );

  // Logout and delete authentication
  app.post(
    '/users/:userId/logout',
    wrap(async (req, res) => {
      await manager.logoutUser(req.params.userId);

      res.json({
        ok: true,
        userId: req.params.userId,
        loggedOut: true,
      });
    }),
  );

  // Remove account
  app.delete(
    '/users/:userId',
    wrap(async (req, res) => {
      await manager.removeUser(req.params.userId);

      res.json({
        ok: true,
        userId: req.params.userId,
        removed: true,
      });
    }),
  );

  // ── Sending ─────────────────────────────────────────────
  app.post(
    '/send',
    wrap(async (req, res) => {
      const { userId, to, text } = req.body ?? {};

      const jid = toJid(to);

      if (
        !userId ||
        !jid ||
        typeof text !== 'string' ||
        !text
      ) {
        return res.status(400).json({
          ok: false,
          error: 'userId, to and text are required',
        });
      }

      const sent = await manager.sendMessage(
        String(userId),
        jid,
        { text },
      );

      return res.json({
        ok: true,
        userId,
        to: jid,
        messageId: sent?.key?.id ?? null,
      });
    }),
  );

  // ── Fallbacks ───────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({
      ok: false,
      error: 'not_found',
    });
  });

  // Error handler
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, _next) => {
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({
        ok: false,
        error: 'invalid_json',
      });
    }

    if (error instanceof WaManagerError) {
      const status = STATUS_BY_CODE[error.code] ?? 500;

      log.warn(
        '🧯',
        'http',
        `${req.method} ${req.path} failed: ${error.code} - ${error.message}`,
      );

      return res.status(status).json({
        ok: false,
        error: error.code,
        message: error.message,
      });
    }

    log.error(
      '💣',
      'http',
      `${req.method} ${req.path} crashed`,
      error,
    );

    return res.status(500).json({
      ok: false,
      error: 'internal_error',
      message: error?.message ?? 'unknown',
    });
  });

  return app;
}