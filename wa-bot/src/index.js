import { getContentType, normalizeMessageContent } from '@whiskeysockets/baileys';
import { existsSync } from 'node:fs';
import { createAuthStore, DisconnectReason, MultiSocketManager, WaManagerError } from 'wa-multi-socket';
import { commandMap } from './commands.js';
import { log, setDebug } from './logger.js';
import { assertSecureHost, createServer } from './server.js';

if (existsSync('.env')) process.loadEnvFile('.env');

// ───────────────────────────── config ─────────────────────────────
const env = process.env;
const DEBUG = env.DEBUG === 'true';
const PREFIX = env.PREFIX || '!';
const OWNERS = (env.OWNERS ?? '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
const PORT = Number(env.PORT ?? 3000);
const HOST = env.HOST || '127.0.0.1';
const API_KEY = env.API_KEY || env.BOT_API_TOKEN || undefined;
const PAIRING_WINDOW_MS = 180_000;
setDebug(DEBUG);
assertSecureHost(HOST, API_KEY);

const reasonName = (reason) => {
  if (typeof reason !== 'number') return 'unknown';
  const name = Object.keys(DisconnectReason).find((key) => DisconnectReason[key] === reason);
  return `${name ?? 'unknown'} (${reason})`;
};
const userPart = (jid) => jid.split('@')[0].split(':')[0];
const maskCode = (code) => (code ? `${String(code).slice(0, 2)}******` : '');
const displayUserId = (userId) => {
  const match = String(userId).match(/^(user-)?(\d{7,15})$/);
  return match ? `${match[1] ?? ''}***${match[2].slice(-4)}` : userId;
};
const displayAddress = (address) => {
  const value = String(address ?? '');
  const [local, domain] = value.split('@');
  const number = local?.split(':')[0] ?? '';
  return /^\d{7,15}$/.test(number)
    ? `***${number.slice(-4)}${domain ? `@${domain}` : ''}`
    : value;
};

// ───────────────────────────── manager ─────────────────────────────
// Baileys' own logger is configured inside wa-multi-socket (LOG_LEVEL env).
const manager = new MultiSocketManager({
  authStore: createAuthStore(env.DATABASE_URL || undefined, {
    encryptionKey: env.AUTH_ENCRYPTION_KEY || undefined,
    onError: (error) => log.error('🗄️', 'database', 'PostgreSQL pool error', error),
  }),
  socketConfig: {
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async () => undefined,
  },
  maxConcurrentConnections: Number(env.MAX_CONCURRENT_CONNECTIONS ?? 20),
  maxConcurrentPairings: Number(env.MAX_CONCURRENT_PAIRINGS ?? 5),
  pairingTimeoutMs: PAIRING_WINDOW_MS,
  sendIntervalMs: Number(env.SEND_INTERVAL_MS ?? 400),
  sendJitterMs: 100,
});

// ───────────────────────── manager event logs ─────────────────────────
const ev = manager.events;
ev.on('user:connecting', ({ userId, reconnecting }) =>
  log.info('🔌', 'connecting', `${displayUserId(userId)}${reconnecting ? ' (reconnect)' : ''}`));
ev.on('user:connected', ({ userId, socket, reconnecting }) =>
  log.ok('🟢', 'connected', `${displayUserId(userId)} ${reconnecting ? 'reconnected 🔁' : 'connected 🎉'} as ${displayAddress(socket.user?.id ?? 'unknown')}`));
ev.on('user:disconnected', ({ userId, reason, manual, error }) =>
  log.warn('🔴', 'disconnected', `${displayUserId(userId)} reason=${reasonName(reason)} manual=${Boolean(manual)}`, error));
ev.on('user:reconnecting', ({ userId, reason, delayMs, attempt }) =>
  log.warn('🔁', 'reconnecting', `${displayUserId(userId)} attempt #${attempt} in ${delayMs}ms (${reasonName(reason)})`));
ev.on('user:reconnect-disabled', ({ userId, reason }) =>
  log.warn('⛔', 'reconnect-disabled', `${displayUserId(userId)} will not retry (${reasonName(reason)})`));
ev.on('user:reconnect-failed', ({ userId, attempts }) =>
  log.error('💥', 'reconnect-failed', `${displayUserId(userId)} gave up after ${attempts} attempts (auth kept)`));
ev.on('user:pairing-code', ({ userId, pairingCode }) =>
  log.ok('🔑', 'pairing-code', `${displayUserId(userId)} code issued (${maskCode(pairingCode)}) - returned to the HTTP caller only`));
ev.on('user:paired', ({ userId }) => log.ok('🔗', 'paired', `${displayUserId(userId)} linked successfully ✨`));
ev.on('user:pairing-failed', ({ userId, reason, error }) =>
  log.error('🚫', 'pairing-failed', `${displayUserId(userId)} (${reasonName(reason)}) - temporary session cleaned up`, error));
ev.on('user:logged-out', ({ userId }) =>
  log.warn('🚪', 'logged-out', `${displayUserId(userId)} logged out, socket closed and auth deleted 🧹`));
ev.on('user:removed', ({ userId }) => log.info('🗑️', 'removed', displayUserId(userId)));
ev.on('user:pruned', ({ userId }) => log.info('🧹', 'pruned', `${displayUserId(userId)} unfinished pairing removed on start`));
ev.on('baileys:connection.update', ({ userId, update }) => {
  const { connection, qr, isNewLogin, receivedPendingNotifications, lastDisconnect } = update;
  log.debug('📶', 'connection.update', displayUserId(userId), {
    connection,
    hasQr: Boolean(qr),
    isNewLogin,
    receivedPendingNotifications,
    lastDisconnect: lastDisconnect?.error?.message,
  });
});
ev.on('baileys:creds.update', ({ userId }) => log.debug('🔐', 'creds.update', `${displayUserId(userId)} (value not logged)`));
ev.on('manager:error', ({ userId, error, event }) =>
  log.error('🚨', 'manager:error', `${userId ? displayUserId(userId) : '(manager)'} ${event ?? ''}`, error));

// ───────────────────────── per-socket Baileys event logs ─────────────────────────
function attachSocketLogs(userId, socket) {
  const tag = (name) => `${displayUserId(userId)} > ${name}`;
  socket.ev.on('messages.update', (u) => log.debug('✏️', tag('messages.update'), `${u.length} update(s)`, u));
  socket.ev.on('messages.reaction', (r) => log.debug('😀', tag('messages.reaction'), `${r.length} reaction(s)`, r));
  socket.ev.on('message-receipt.update', (r) => log.debug('📬', tag('receipt'), `${r.length} receipt(s)`));
  socket.ev.on('presence.update', (p) => log.debug('👀', tag('presence.update'), p.id, p.presences));
  socket.ev.on('chats.upsert', (c) => log.debug('💬', tag('chats.upsert'), `${c.length} chat(s)`));
  socket.ev.on('chats.update', (c) => log.debug('💬', tag('chats.update'), `${c.length} chat(s)`));
  socket.ev.on('contacts.upsert', (c) => log.debug('📇', tag('contacts.upsert'), `${c.length} contact(s)`));
  socket.ev.on('groups.upsert', (g) => log.info('👥', tag('groups.upsert'), g.map((x) => x.subject).join(', ')));
  socket.ev.on('groups.update', (g) => log.info('🛠️', tag('groups.update'), `${g.length} group update(s)`, g));
  socket.ev.on('group-participants.update', (g) =>
    log.info('🧑‍🤝‍🧑', tag('group-participants'), `${g.id} ${g.action}: ${g.participants.length} participant(s)`, g));
  socket.ev.on('call', (calls) => log.info('📞', tag('call'), `${calls.length} call event(s)`, calls));
  socket.ev.on('blocklist.update', (b) => log.debug('🚷', tag('blocklist.update'), b));
  socket.ev.on('messaging-history.set', (h) =>
    log.debug('📜', tag('history.set'), `chats=${h.chats.length} contacts=${h.contacts.length} messages=${h.messages.length}`));
  socket.ev.on('messages.upsert', ({ messages, type }) => {
    void handleUpsert(userId, socket, messages, type);
  });
}

// ───────────────────────────── message handling ─────────────────────────────
const seen = new Set();
const remember = (id) => {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  return true;
};

function extractText(message) {
  const c = normalizeMessageContent(message.message);
  return (
    c?.conversation ??
    c?.extendedTextMessage?.text ??
    c?.imageMessage?.caption ??
    c?.videoMessage?.caption ??
    c?.documentMessage?.caption ??
    c?.buttonsResponseMessage?.selectedButtonId ??
    c?.listResponseMessage?.singleSelectReply?.selectedRowId ??
    c?.templateButtonReplyMessage?.selectedId ??
    ''
  ).trim();
}

async function handleUpsert(userId, socket, messages, type) {
  log.debug('📥', 'messages.upsert', `${displayUserId(userId)}: ${messages.length} message(s) (type=${type})`);
  if (type !== 'notify') return; // ignore history / append

  for (const message of messages) {
    try {
      const receivedAt = Date.now();
      const jid = message.key.remoteJid;
      const id = message.key.id;
      if (!jid || !id || !message.message || jid === 'status@broadcast') continue;
      if (!remember(`${userId}:${id}`)) continue;

      const content = normalizeMessageContent(message.message);
      const contentType = getContentType(content) ?? 'unknown';
      if (contentType === 'protocolMessage' || contentType === 'senderKeyDistributionMessage') continue;

      const isGroup = jid.endsWith('@g.us');
      const sender = isGroup ? (message.key.participant ?? jid) : jid;
      const fromMe = Boolean(message.key.fromMe);
      const text = extractText(message);
      log.info(
        '📩',
        'message',
        `[${displayUserId(userId)}] ${fromMe ? '➡️ outgoing' : '⬅️ incoming'} | ${contentType} | ${isGroup ? '👥' : '👤'} ${displayAddress(sender)}`,
      );
      if (DEBUG && text) log.debug('🧾', 'message.preview', text.slice(0, 120));

      if (!text.startsWith(PREFIX)) continue;
      const [rawName = '', ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
      const command = commandMap.get(rawName.toLowerCase());
      if (!command) {
        log.warn('❓', 'command', `[${displayUserId(userId)}] unknown command: ${rawName}`);
        continue;
      }

      const isOwner = fromMe || OWNERS.some((o) => userPart(o) === userPart(sender));
      if (command.ownerOnly && !isOwner) {
        log.warn('🔒', 'command', `[${displayUserId(userId)}] ${command.name} is owner-only - denied for ${displayAddress(sender)}`);
        await manager.sendMessage(userId, jid, { text: '🔒 This command is for the owner only.' }, { quoted: message });
        continue;
      }

      const ctx = {
        manager, userId, socket, message, jid, sender, isGroup, isOwner, args,
        rawArgs: args.join(' '), prefix: PREFIX, receivedAt,
        reply: (t) => manager.sendMessage(userId, jid, { text: t }, { quoted: message }),
        edit: (sent, t) => manager.sendMessage(userId, jid, { text: t, edit: sent.key }),
      };

      log.info('⚙️', 'command', `[${displayUserId(userId)}] ${PREFIX}${command.name} received`);
      const t0 = Date.now();
      await command.run(ctx);
      log.ok('🏁', 'command', `[${displayUserId(userId)}] ${command.name} finished (${Date.now() - t0}ms)`);
    } catch (error) {
      if (error instanceof WaManagerError) log.error('🧯', 'command', `[${displayUserId(userId)}] ${error.code}: ${error.message}`, error);
      else log.error('💣', 'command', `[${displayUserId(userId)}] command failed`, error);
    }
  }
}

// Attach handlers once per socket. A new socket is created on every reconnect.
const attached = new WeakSet();
ev.on('user:connected', ({ userId, socket }) => {
  if (attached.has(socket)) return;
  attached.add(socket);
  attachSocketLogs(userId, socket);
  log.debug('🧩', 'listeners', `${displayUserId(userId)}: Baileys listeners attached`);
  log.info('🤖', 'ready', `${displayUserId(userId)} is ready. Send "${PREFIX}ping" from any chat (your own number works too)`);
});

// ───────────────────────────── start ─────────────────────────────
log.banner([
  '🤖 wa-multi-socket test bot',
  `⚙️  prefix: ${PREFIX}   🐛 debug: ${DEBUG ? 'ON' : 'OFF'}   📦 Node ${process.version}`,
  `🌐 API: http://${HOST}:${PORT}   🔒 api key: ${API_KEY ? 'required' : 'off'}`,
  `👑 owners: ${OWNERS.length ? OWNERS.join(', ') : '(linked account itself only)'}`,
]);

const app = createServer({ manager, apiKey: API_KEY, pairingWindowMs: PAIRING_WINDOW_MS });
await manager.start();
log.info('🚀', 'start', `Restored saved sessions: ${manager.getUserIds().length}`);

const server = await new Promise((resolve, reject) => {
  const s = app.listen(PORT, HOST, () => resolve(s));
  s.once('error', reject);
}).catch((error) => {
  log.error('💥', 'http', `Cannot listen on ${HOST}:${PORT} (${error.code ?? error.message})`, error);
  return manager.close().then(() => {
    process.exit(1);
  });
});
log.ok('🌐', 'http', `API listening on http://${HOST}:${PORT}`);

const keyHeader = API_KEY ? ' -H "x-api-key: $API_KEY"' : '';
log.info('📘', 'usage', `Pair a number : curl${keyHeader} "http://${HOST}:${PORT}/pair?phone=<countrycode><number>"`);
log.info('📘', 'usage', `List accounts : curl${keyHeader} http://${HOST}:${PORT}/users`);
log.info('📘', 'usage', `Logout account: curl -X POST${keyHeader} http://${HOST}:${PORT}/users/<userId>/logout`);

const heartbeat = setInterval(() => {
  const s = manager.getStats();
  const m = process.memoryUsage();
  log.debug('🩺', 'heartbeat', `total ${s.total} | 🟢 ${s.open} | 🟡 ${s.connecting} | 🔑 ${s.awaitingPairing} | 🔁 ${s.reconnecting} | RSS ${(m.rss / 1048576).toFixed(0)}MB`);
}, 60_000);
heartbeat.unref();

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn('🛑', 'shutdown', `Received ${signal}: closing HTTP server, sockets and database...`);
  clearInterval(heartbeat);
  server.close();
  server.closeAllConnections?.();
  await manager.close();
  log.ok('👋', 'shutdown', 'Bye! (saved sessions are kept)');
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
