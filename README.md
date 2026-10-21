# Socksy

<p align="center">
  <img src="https://raw.githubusercontent.com/WhiskeySockets/Baileys/refs/heads/master/Media/logo.png" alt="Baileys logo" width="210">
</p>

<h2 align="center">One manager. Multiple WhatsApp sessions. Your bot logic, your sockets.</h2>

<p align="center">
  <strong>A lightweight multi-user WhatsApp connection manager powered by the official Baileys library.</strong>
</p>

<p align="center">
  <a href="https://github.com/nightx-rebel/socksy/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/nightx-rebel/socksy?style=for-the-badge&logo=github&color=yellow"></a>
  <img alt="Node.js 22.13+" src="https://img.shields.io/badge/Node.js-22.13%2B-339933?style=for-the-badge&logo=node.js&logoColor=white">
  <img alt="Baileys 7" src="https://img.shields.io/badge/Baileys-7-25D366?style=for-the-badge">
  <img alt="TypeScript ready" src="https://img.shields.io/badge/TypeScript-ready-3178C6?style=for-the-badge&logo=typescript&logoColor=white">
</p>

<p align="center">
  <a href="https://github.com/nightx-rebel/socksy">Repository</a> ·
  <a href="#-quick-start">Quick start</a> ·
  <a href="#-configuration">Configuration</a> ·
  <a href="#-manager-api">Manager API</a>
</p>

> [!TIP]
> ⭐ **Like Socksy? Give the repository a star on GitHub!** It helps more developers discover the project and motivates future improvements.
> <p><a href="https://github.com/nightx-rebel/socksy/stargazers"><strong>⭐ Star Socksy on GitHub</strong></a></p>

Socksy runs **multiple WhatsApp accounts from one Node.js application** using Baileys. Give each account a stable `userId`, and the manager creates an independent socket, stores that account's credentials and Signal keys, restores paired sessions after a restart, reconnects after temporary network failures, and queues outgoing messages with configurable spacing.

You write the bot logic. Socksy manages the connections.

> [!IMPORTANT]
> **Requirements:** Node.js `22.13+` and an ESM project (`"type": "module"`). Session data is sensitive: anyone who gains access to your database file or database URL may be able to control the linked WhatsApp accounts. Keep it private and never commit it to Git.

## 🧭 Contents

- [✨ Features](#-features)
- [📦 Installation](#-installation)
- [🚀 Quick start](#-quick-start)
- [🤖 Use Socksy in your bot](#-use-socksy-in-your-bot)
- [⚙️ Configuration](#️-configuration)
- [🧩 Socket configuration](#-socket-configuration)
- [👥 Multiple users](#-multiple-users)
- [🔗 Pairing codes](#-pairing-codes)
- [📣 Events](#-events)
- [🔁 Reconnection policy](#-reconnection-policy)
- [⚖️ Capacity and performance](#️-capacity-and-performance)
- [🗄️ Database and auth storage](#️-database-and-auth-storage)
- [🧰 Manager API](#-manager-api)
- [🚨 Error handling](#-error-handling)
- [🍳 Recipes](#-recipes)
- [🩺 Troubleshooting](#-troubleshooting)
- [🔐 Production notes](#-production-notes)
- [🧪 Development](#-development)
- [⭐ Support the project](#-support-the-project)

## ✨ Features

- Manage multiple WhatsApp accounts using stable, application-defined `userId` values.
- Access the real Baileys `WASocket` for each user and use the Baileys API.
- Pair new accounts using a phone number and a pairing code.
- Persist credentials and binary Signal keys in local SQLite or PostgreSQL.
- Restore saved, fully paired accounts with `manager.start()`.
- Limit concurrent connection handshakes and pairing attempts.
- Retry temporary disconnections using capped exponential backoff and jitter.
- Queue outgoing messages per account with configurable delay and queue limits.
- Track lifecycle events, connection state, and manager statistics.
- Disconnect temporarily, log out, or remove a saved login.
- Use typed errors with stable error codes (`WaManagerError`).
- Isolate damaged saved keys so one unreadable key does not have to break every session.

### How it works

```mermaid
flowchart LR
    Bot[Your bot / API] <--> Manager[Socksy: MultiSocketManager]
    Manager <--> A[User A socket]
    Manager <--> B[User B socket]
    Manager <--> C[User C socket]
    Manager <--> DB[(SQLite or PostgreSQL<br/>credentials + Signal keys)]
    A <--> WA[WhatsApp]
    B <--> WA
    C <--> WA
```

## 📦 Installation

Socksy is installed directly from GitHub; it does not need to be published on npm.

### Install from GitHub

```sh
npm install github:nightx-rebel/socksy
```

Short form:

```sh
npm i github:nightx-rebel/socksy
```

### Install from a local checkout

If the Socksy repository is next to your bot project, install it using the local path:

```sh
npm install ../socksy
```

Or clone it first:

```sh
git clone https://github.com/nightx-rebel/socksy.git
cd socksy
npm install
```

Set `"type": "module"` in your bot project's `package.json`, or use `.mjs` files. Baileys, Boom, and the PostgreSQL driver are installed as project dependencies.

Check your Node.js version (including on Termux):

```sh
node -v   # requires v22.13.0 or newer
```

> [!NOTE]
> Example imports below use `wa-multi-socket`, the package name currently shown in the source snippets. If you also change the package's `package.json` name to `socksy`, update those imports to `socksy` too.

## 🚀 Quick start

This minimal example restores saved accounts, listens for messages, and replies to `!ping`.

```ts
import { createAuthStore, MultiSocketManager } from 'wa-multi-socket';

// Create one manager for the whole application.
const manager = new MultiSocketManager({
  // No URL means local SQLite: ./data/wa-auth.sqlite
  authStore: createAuthStore(),
  socketConfig: {
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  },
});

// Register listeners before start(). Attach message listeners for every new socket.
manager.events.on('user:connected', ({ userId, socket }) => {
  console.log(`${userId} is online`);

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        '';
      const jid = msg.key.remoteJid;

      if (jid && text.trim().toLowerCase() === '!ping') {
        await manager.sendMessage(
          userId,
          jid,
          { text: 'pong 🏓' },
          { quoted: msg },
        );
      }
    }
  });
});

manager.events.on('user:pairing-code', ({ userId, pairingCode }) => {
  console.log(`Pairing code for ${userId}: ${pairingCode}`);
});

manager.events.on('manager:error', ({ userId, error }) => {
  console.error('[Socksy]', userId ?? '(manager)', error);
});

// Restore previously paired users.
await manager.start();

// Add an account on first setup. Pairing code may be returned here.
await manager.addUser('my-first-user', { phoneNumber: '15551234567' });

const shutdown = () => {
  void manager.close().then(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
```

On the phone being paired: **WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead**, then enter the pairing code.

**Remember:** register event listeners before `manager.start()`, attach Baileys message listeners inside `user:connected`, and use `manager.sendMessage(...)` for queued message sending.

## 🤖 Use Socksy in your bot

A simple project layout:

```text
my-bot/
├── src/
│   ├── index.ts
│   ├── whatsapp.ts
│   └── commands.ts
├── package.json
└── .env
```

### `src/whatsapp.ts` — shared manager

```ts
import { createAuthStore, MultiSocketManager } from 'wa-multi-socket';

export const whatsapp = new MultiSocketManager({
  authStore: createAuthStore(process.env.DATABASE_URL),
  socketConfig: {
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  },
  maxConcurrentConnections: 10,
});
```

### `src/commands.ts` — command handling

```ts
import type { WAMessage } from '@whiskeysockets/baileys';
import { whatsapp } from './whatsapp.js';

type Ctx = {
  userId: string;
  jid: string;
  msg: WAMessage;
  args: string[];
  reply: (text: string) => Promise<unknown>;
};

const commands: Record<string, (ctx: Ctx) => Promise<void>> = {
  ping: async ({ reply }) => void (await reply('pong 🏓')),
  echo: async ({ reply, args }) =>
    void (await reply(args.join(' ') || 'Write something')),
  menu: async ({ reply }) =>
    void (await reply(Object.keys(commands).map((name) => `!${name}`).join('\n'))),
};

export function getText(msg: WAMessage): string {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    ''
  ).trim();
}

export async function handleMessage(userId: string, msg: WAMessage): Promise<void> {
  const jid = msg.key.remoteJid;
  const text = getText(msg);
  if (!jid || !text.startsWith('!')) return;

  const [name = '', ...args] = text.slice(1).split(/\s+/);
  const command = commands[name.toLowerCase()];
  if (!command) return;

  await command({
    userId,
    jid,
    msg,
    args,
    reply: (text) => whatsapp.sendMessage(userId, jid, { text }, { quoted: msg }),
  });
}
```

### `src/index.ts` — start the bot

```ts
import { whatsapp } from './whatsapp.js';
import { handleMessage } from './commands.js';

whatsapp.events.on('user:connected', ({ userId, socket }) => {
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      try {
        await handleMessage(userId, msg);
      } catch (error) {
        console.error(`[${userId}] command failed`, error);
      }
    }
  });
});

whatsapp.events.on('user:pairing-code', ({ userId, pairingCode }) => {
  console.log(`[${userId}] pairing code: ${pairingCode}`);
});
whatsapp.events.on('user:logged-out', ({ userId }) => {
  console.log(`[${userId}] logged out`);
});
whatsapp.events.on('manager:error', ({ userId, error }) => {
  console.error(userId ?? '(manager)', error);
});

await whatsapp.start();

const shutdown = () => {
  void whatsapp.close().then(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
```

### Access a user's socket

```ts
// Recommended: safe queue + spacing.
await whatsapp.sendMessage(userId, jid, { text: 'Hello' });

// Direct Baileys access for groups, profile data, and other APIs.
const socket = whatsapp.getConnectedSocket(userId);
if (!socket) throw new Error(`${userId} is offline`);
const groups = await socket.groupFetchAllParticipating();
```

Direct `socket.sendMessage(...)` is available but bypasses Socksy's outgoing-message queue. Prefer `manager.sendMessage(...)` for normal bot messages.

Choose a stable `userId`, such as your database user ID or tenant ID. Reusing the same ID after a restart loads its saved login. A `userId` is **not required to be the phone number**. IDs must be 1–128 characters, start with a letter or digit, and contain only letters, digits, `_`, `.`, `:`, `@`, or `-`.

## ⚙️ Configuration

Only `authStore` is required. All other manager options have defaults.

| Option | Default | Purpose |
|---|---:|---|
| `authStore` | Required | Storage created by `createAuthStore(...)`. |
| `socketConfig` | `{}` | Extra Baileys options for each socket. |
| `socketFactory` | Baileys `makeWASocket` | Custom socket factory, useful for tests. |
| `reconnect` | `true` | Enable automatic reconnection. Logout cleanup still happens when disabled. |
| `defaultReconnectDelayMs` | `3000` | Initial wait when a disconnect has no special delay. |
| `reconnectDelays` | Built-in table | Per-reason delays; `null` disables retries for that reason. |
| `maxReconnectAttempts` | `20` | Consecutive failed retries before giving up (saved login is kept). |
| `stableConnectionMs` | `30000` | Open duration required to reset the failure counter. |
| `reconnectJitterMs` | `1000` | Random extra delay to spread out retries. |
| `maxReconnectDelayMs` | `60000` | Maximum delay between retries. |
| `maxConcurrentConnections` | `20` | Maximum simultaneous connection handshakes. |
| `maxConcurrentPairings` | `5` | Maximum simultaneous pairing attempts. |
| `connectionAttemptTimeoutMs` | `60000` | Timeout for a socket that never opens. |
| `pairingTimeoutMs` | `180000` | Time allowed to enter the pairing code (3 minutes). |
| `pairingRetries` | `2` | Extra pairing-code request attempts. |
| `pairingRetryDelayMs` | `2000` | Initial pause between pairing retries. |
| `pruneUnregisteredOnStart` | `true` | Delete unfinished pairings during startup. |
| `cacheSignalKeys` | `true` | Cache Signal keys in memory for speed. |
| `sendIntervalMs` | `1000` | Minimum delay between messages per account. |
| `sendJitterMs` | `500` | Additional random message delay. |
| `maxQueuedMessagesPerUser` | `100` | Maximum queued messages per account. |

Timer values must be whole numbers within Node.js's maximum timer delay (about 24.8 days). Invalid settings throw `INVALID_ARGUMENT` when the manager is created.

### Recommended configurations

**📱 Termux / small device — start with 1–20 accounts**

```ts
const manager = new MultiSocketManager({
  authStore: createAuthStore(),
  socketConfig: {
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  },
  maxConcurrentConnections: 5,
  maxConcurrentPairings: 2,
  sendIntervalMs: 1500,
  sendJitterMs: 700,
});
```

**🖥️ Small VPS — start with 20–150 accounts**

```ts
const manager = new MultiSocketManager({
  authStore: createAuthStore(process.env.DATABASE_URL, { poolMax: 10 }),
  socketConfig: {
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  },
  maxConcurrentConnections: 12,
  maxConcurrentPairings: 3,
  maxReconnectAttempts: 30,
  sendIntervalMs: 1200,
});
```

For larger deployments, use PostgreSQL and split accounts across processes, with one process owning each account. These are starting points, not capacity guarantees; load-test your actual workload before production.

**🧪 Tests — in-memory database**

```ts
const manager = new MultiSocketManager({
  authStore: createAuthStore('sqlite::memory:'),
  reconnect: false,
});
```

### Quick tuning guide

| Problem | Setting to review |
|---|---|
| Device becomes slow or hot at startup | Lower `maxConcurrentConnections`. |
| Too many messages are waiting | Reduce send volume or review `maxQueuedMessagesPerUser`. |
| Reconnects take too long | Review `defaultReconnectDelayMs` and `reconnectDelays`. |
| Retries stop too early | Raise `maxReconnectAttempts` if appropriate. |
| Pairing codes expire too soon | Review `pairingTimeoutMs`. |
| High RAM usage | Disable full history sync and reduce simultaneous connection attempts. |

Message spacing may reduce bursts, but **cannot guarantee that an account will never be limited or banned**.

## 🧩 Socket configuration

`socketConfig` is passed to Baileys when creating each user's socket. Leave it out if the defaults meet your needs.

```ts
socketConfig: {
  markOnlineOnConnect: false,
  syncFullHistory: false,
  generateHighQualityLinkPreview: false,
  shouldIgnoreJid: (jid) => jid.endsWith('@broadcast'),
  keepAliveIntervalMs: 30_000,
  connectTimeoutMs: 60_000,
  defaultQueryTimeoutMs: 60_000,
},
```

| Option | Suggested value | Benefit |
|---|---|---|
| `syncFullHistory` | `false` | Avoids downloading old chats; saves data and memory. |
| `markOnlineOnConnect` | `false` | Avoids marking the account online just because the socket connected. |
| `generateHighQualityLinkPreview` | `false` | Avoids extra downloads when generating link previews. |
| `shouldIgnoreJid` | Ignore unneeded broadcast JIDs | Can reduce irrelevant traffic. |
| `keepAliveIntervalMs` | `30000` | Keep-alive interval. |
| `connectTimeoutMs` | `60000` | Baileys connection timeout. |
| `defaultQueryTimeoutMs` | `60000` | Default time to wait for a WhatsApp response. |
| `emitOwnEvents` | `false` (optional) | Avoid emitting events for messages sent by the account itself. |

Socksy controls these options and replaces/ignores values supplied for them:

| Option | Reason |
|---|---|
| `auth` | Loaded separately for each user from the auth store. |
| `logger` | A manager logger is used across sockets. |
| `browser` | Fixed desktop identity (`Ubuntu / Chrome`) for pairing-code support. |

`socketConfig` is shared across all users. Avoid user-specific hooks or a shared cache that could leak one account's data into another. Available option names depend on the installed Baileys version. Modern Baileys no longer uses `printQRInTerminal`; Socksy uses pairing codes.

## 👥 Multiple users

Every `addUser()` call with a different ID manages a separate socket and saved login.

```ts
await manager.addUser('tenant-a', { phoneNumber: '15550000001' });
await manager.addUser('tenant-b', { phoneNumber: '15550000002' });

const socketA = manager.getSocket('tenant-a');
const socketB = manager.getConnectedSocket('tenant-b');
const allSockets = manager.getSockets();
const allIds = manager.getUserIds();
const onlineIds = manager.getConnectedUserIds();

for (const [userId, socket] of allSockets) {
  console.log(userId, socket.user?.id);
}
```

- `getSocket()` may return a socket that is still connecting.
- `getConnectedSocket()` returns a socket only after the connection is open.
- `getSockets()` returns a `Map<userId, WASocket>` snapshot.
- `getStatus(userId)` returns `open`, `connecting`, `awaiting-pairing`, `reconnecting`, or `offline`.
- `getStats()` returns `{ total, open, connecting, awaitingPairing, reconnecting }`.

## 🔗 Pairing codes

### Add an account and request a code

```ts
const { socket, pairingCode } = await manager.addUser('tenant-a', {
  phoneNumber: '15551234567',
  // Optional: provide your own 8-character alphanumeric code.
  pairingCode: 'ABCD1234',
});

if (pairingCode) {
  // Send the code privately to the account owner.
}
```

### Request a code separately

```ts
const code = await manager.requestPairingCode('tenant-a', '15551234567');
```

### Pairing rules

- Use the international phone number with country code: 7–15 digits, without a leading `0`. `+` and spaces are stripped automatically.
- A custom pairing code must contain exactly 8 letters or digits.
- If the account is already paired, `addUser()` connects it and returns no code; `requestPairingCode()` throws `ALREADY_PAIRED`.
- The owner enters the code from WhatsApp → **Linked devices** → **Link with phone number**.
- If pairing does not finish before `pairingTimeoutMs`, the temporary session is removed and `user:pairing-failed` fires.
- Pairing codes are sensitive. Only send them to the account owner and avoid logging them in production.

After the code is accepted, `user:paired` fires. WhatsApp may request one restart; Socksy handles reconnection, then emits `user:connected` when the socket is ready.

## 📣 Events

Subscribe to the manager's Node.js `EventEmitter` via `manager.events`.

| Event | When it fires | Payload highlights |
|---|---|---|
| `user:connecting` | A socket is about to be created | `userId`, `reconnecting` |
| `user:connected` | WhatsApp reports an open connection | `userId`, `socket`, `reconnecting` |
| `user:disconnected` | A socket closes or is manually disconnected | `userId`, `socket`, `reason`, `error`, possibly `manual` |
| `user:reconnecting` | An automatic retry is scheduled | `userId`, `reason`, `delayMs`, `attempt` |
| `user:reconnect-disabled` | Policy prevents another retry | `userId`, `reason` |
| `user:reconnect-failed` | Retry limit is reached | `userId`, `attempts`, `reason` |
| `user:pairing-code` | A pairing code is created | `userId`, `pairingCode` |
| `user:paired` | Pairing succeeds | `userId`, `socket` |
| `user:pairing-failed` | Pairing expires or fails | `userId`, `reason`, `error` |
| `user:logged-out` | WhatsApp reports a logout | `userId`, `reason` |
| `user:removed` | A user is removed or logged out | `userId` |
| `user:pruned` | Startup removes an unfinished pairing | `userId` |
| `baileys:connection.update` | Baileys emits a connection update | `userId`, `socket`, `update` |
| `baileys:creds.update` | Baileys updates credentials | `userId`, `socket` |
| `manager:error` | A restore, storage, or socket error occurs | `error`; `userId` may be missing |

### Example event setup

```ts
manager.events.on('user:connected', ({ userId, socket, reconnecting }) => {
  console.log(userId, reconnecting ? 'reconnected' : 'connected');

  // A new socket is created after reconnect, so attach listeners here.
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      try {
        // Call your message handler here.
      } catch (error) {
        console.error(`[${userId}] message handler failed`, error);
      }
    }
  });
});

manager.events.on('user:disconnected', ({ userId, reason, manual }) => {
  console.log(userId, 'closed', { reason, manual });
});
manager.events.on('user:reconnecting', ({ userId, delayMs, attempt }) => {
  console.log(`${userId}: retry #${attempt} in ${delayMs}ms`);
});
manager.events.on('user:pairing-code', ({ userId, pairingCode }) => {
  console.log('Pair privately:', userId, pairingCode);
});
manager.events.on('manager:error', ({ userId, error }) => {
  console.error(userId ?? '(manager)', error);
});
```

For `messages.upsert`, `groups.update`, `contacts.upsert`, and other Baileys events, use `socket.ev`. Socksy forwards manager lifecycle events but does not forward every Baileys event. A `user:connected` event fires once per socket, including after reconnect; the socket object may be new. Node's `EventEmitter` does not wait for asynchronous listeners, so catch errors inside async handlers. Do not call `connectUser()` inside a disconnect listener; the manager already handles reconnect policy.

## 🔁 Reconnection policy

Socksy retries temporary failures automatically. Login data is retained for disconnects except a real logout.

| Reason | Common status | Default behavior |
|---|---:|---|
| `connectionClosed` | 428 | Retry after 1 second |
| `connectionLost` / `timedOut` | 408 | Retry after 2 seconds |
| `connectionReplaced` | 440 | Do not retry; another process may own the session |
| `badSession` | 500 | Retry after 10 seconds |
| `restartRequired` | 515 | Retry after 1 second |
| `unavailableService` | 503 | Retry after 15 seconds |
| `loggedOut` | 401 | Do not retry; delete saved login |
| `forbidden` | 403 | Do not retry; keep login |
| `multideviceMismatch` | 411 | Do not retry; keep login |
| Other / unknown | Varies | Use `defaultReconnectDelayMs` |

Customize delays using exported Baileys disconnect reasons:

```ts
import { DisconnectReason } from 'wa-multi-socket';

const manager = new MultiSocketManager({
  authStore: createAuthStore(),
  defaultReconnectDelayMs: 4_000,
  reconnectDelays: {
    [DisconnectReason.connectionLost]: 7_000,
    [DisconnectReason.forbidden]: null,
  },
});
```

Each failed attempt increases the delay up to `maxReconnectDelayMs`; random jitter helps prevent many sessions retrying simultaneously. The retry counter resets only after the connection remains open for `stableConnectionMs`. Once `maxReconnectAttempts` is reached, `user:reconnect-failed` fires and the saved login is kept. `reconnect: false` disables retries, but logout cleanup still occurs.

## ⚖️ Capacity and performance

Connection limits control **how many handshakes begin at once**, not the total number of sockets that can remain connected. Baileys holds state in memory for every account, so no setting guarantees that a certain machine can support 600–700 accounts.

For a stable deployment:

- Load-test with realistic message volume before going live.
- Monitor RSS memory, event-loop delay, database speed, file descriptors, and network usage.
- Prefer PostgreSQL for multiple app instances or heavy writes; the SQLite adapter is synchronous and best suited to one host.
- Split large deployments across processes, with one process owning each account.
- Keep message handlers fast and avoid unbounded background work.
- Never run the same saved account in multiple processes without an ownership or locking mechanism; it may trigger `connectionReplaced` loops.

## 🗄️ Database and auth storage

`createAuthStore(url?, options?)` chooses storage according to the URL.

| URL | Storage |
|---|---|
| No URL / empty | Local SQLite at `./data/wa-auth.sqlite` |
| `sqlite://./data/mybot.sqlite` | SQLite at a relative path |
| `sqlite:///absolute/path/wa-auth.sqlite` | SQLite at an absolute path |
| `sqlite::memory:` | In-memory SQLite for tests; data disappears at exit |
| `postgres://user:pass@host:5432/db` | PostgreSQL |
| `postgresql://user:pass@host:5432/db` | PostgreSQL |

### SQLite

```ts
const manager = new MultiSocketManager({
  authStore: createAuthStore(),
});
```

The `data/` directory is created relative to the app's working directory. The adapter uses Node's built-in `node:sqlite`, so use a compatible Node.js release. SQLite uses write-ahead logging (WAL): the `-wal` file stores recent writes and `-shm` supports coordination. **Do not delete either file while the app is running or after an unclean shutdown.** Call `manager.close()` cleanly, stop the app, and then copy the main database file when making a backup.

### PostgreSQL

```sh
export DATABASE_URL='postgresql://bot_user:secret@db.example.com:5432/whatsapp'
```

```ts
const manager = new MultiSocketManager({
  authStore: createAuthStore(process.env.DATABASE_URL, { poolMax: 10 }),
});
```

The `wa_auth` table is created automatically. If the database is unavailable during startup, table creation is retried on a later call. URL-encode special characters in passwords (for example, `@` as `%40`). For Supabase, a pooler URL may be preferable, depending on the deployment.

### Switching or implementing a custom store

Sessions are not migrated automatically between SQLite and PostgreSQL. After switching stores, accounts need to be paired again unless you migrate the stored auth records yourself in a compatible way. For another database, implement the exported `AuthStore` interface and pass the implementation as `authStore`. The manager owns and closes the store when `manager.close()` is called.

## 🧰 Manager API

### Start and add users

| Method | Purpose |
|---|---|
| `start()` | Restore saved, fully paired accounts; unfinished pairings are pruned when configured. |
| `addUser(userId, { phoneNumber?, pairingCode? })` | Create a socket and optionally request a pairing code. Returns `{ socket, pairingCode? }`. |
| `connectUser(userId)` | Create or return a socket without requesting a pairing code. |
| `requestPairingCode(userId, phoneNumber, customCode?)` | Request a code for an unpaired account. |

### Look up state

| Method | Returns |
|---|---|
| `getSocket(userId)` | Socket, including while connecting, or `undefined` |
| `getConnectedSocket(userId)` | Socket only when open, otherwise `undefined` |
| `getSockets()` | Snapshot `Map<userId, WASocket>` |
| `getUserIds()` | IDs of managed sockets |
| `getConnectedUserIds()` | IDs of open sockets |
| `getStatus(userId)` | `open`, `connecting`, `awaiting-pairing`, `reconnecting`, or `offline` |
| `getStats()` | `{ total, open, connecting, awaitingPairing, reconnecting }` |
| `waitForConnection(userId, timeoutMs = 30000)` | Resolves with the open socket or rejects with `TIMEOUT` |

### Send and stop

| Method | Purpose |
|---|---|
| `sendMessage(userId, jid, content, options?)` | Send through the per-user queue. May throw `NOT_CONNECTED` or `QUEUE_FULL`. |
| `disconnectUser(userId)` | Close the socket but keep saved login data. Cancels pending sends for that user. |
| `removeUser(userId)` | Close the socket and delete saved login data. |
| `logoutUser(userId)` | Attempt to unlink the device on WhatsApp, then delete saved login data. |
| `close()` | Close all sockets and the database while retaining saved logins. |

A queued message is not replayed after a later reconnection. Once WhatsApp reports a real `loggedOut`, the saved login is deleted; call `addUser()` again to pair the account from scratch.

## 🚨 Error handling

Manager errors are instances of `WaManagerError` and expose stable error codes.

```ts
import { WaManagerError } from 'wa-multi-socket';

try {
  await manager.sendMessage(userId, jid, { text: 'Hello' });
} catch (error) {
  if (WaManagerError.is(error, 'NOT_CONNECTED')) {
    console.log('This account is offline.');
  } else if (WaManagerError.is(error, 'QUEUE_FULL')) {
    console.log('The send queue is full; slow down.');
  } else {
    throw error;
  }
}
```

`WaManagerError.is(error)` checks for any manager error. `WaManagerError.is(error, 'A', 'B')` checks for selected codes.

| Code | Meaning |
|---|---|
| `CLOSED` | The manager has already been closed. |
| `INVALID_ARGUMENT` | Invalid user ID, phone number, pairing code, or option. |
| `ALREADY_PAIRED` | A pairing code was requested for an already paired account. |
| `PAIRING_IN_PROGRESS` | A pairing request for this user is already running. |
| `PAIRING_TIMEOUT` | Pairing expired or WhatsApp did not start pairing in time. |
| `CONNECTION_TIMEOUT` | The connection did not open within `connectionAttemptTimeoutMs`. |
| `NOT_AVAILABLE` | The request was cancelled or the socket became unavailable. |
| `NOT_CONNECTED` | The user is offline or a queued send was cancelled. |
| `QUEUE_FULL` | The user's outgoing-message queue is full. |
| `TIMEOUT` | `waitForConnection()` timed out. |

Errors support clean JSON serialization, such as `{ name, code, message, userId?, cause? }`.

## 🍳 Recipes

### Send to each online account

```ts
for (const userId of manager.getConnectedUserIds()) {
  await manager
    .sendMessage(userId, jid, { text: 'Hello from all accounts' })
    .catch(() => {});
}
```

### Wait for a connection, then send

```ts
await manager.waitForConnection('tenant-a', 30_000);
await manager.sendMessage('tenant-a', jid, { text: 'Ready!' });
```

### Add a user from a command

```ts
const addUser = async (phone: string) => {
  if (!phone) throw new Error('Usage: adduser <number>');
  const { pairingCode } = await manager.addUser(`user-${phone}`, {
    phoneNumber: phone,
  });
  return pairingCode ? `Your pairing code: ${pairingCode}` : 'Already paired';
};
```

### Show session statuses

```ts
const lines = manager
  .getUserIds()
  .map((id) => `${id}: ${manager.getStatus(id)}`);
console.log(lines.join('\n'), manager.getStats());
```

### Log out or pause an account

```ts
await manager.logoutUser('tenant-a'); // Unlink and delete saved login.

await manager.disconnectUser('tenant-a'); // Pause; keep saved login.
await manager.connectUser('tenant-a'); // Reconnect later.
```

## 🩺 Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Cannot find module 'node:sqlite'` | Node.js is too old; use `22.13+`. |
| No messages arrive after reconnect | Attach `messages.upsert` inside `user:connected`. |
| `NOT_CONNECTED` when sending | Check `getStatus()` or use `waitForConnection()`. |
| `QUEUE_FULL` | Reduce send volume or tune the queue size carefully. |
| Pairing code does not work | Check the international phone format, expiry, and the WhatsApp “Link with phone number” screen. |
| `user:pairing-failed` fires | The code was not entered in time; retry with `addUser()`. |
| Repeated disconnect reason `440` | The same login may be running in multiple processes; use one owner per account. |
| `user:logged-out` fires | The device was unlinked; pair it again. |
| Startup is slow or memory use is high | Lower `maxConcurrentConnections` and keep full history sync disabled. |
| All accounts need pairing again | The database or `data/` folder may have been deleted, replaced, or changed. Restore a backup if available. |
| One account has unreadable credentials | Remove and re-pair that user's saved login; inspect `manager:error`. |
| TypeScript complains about `exactOptionalPropertyTypes` | Avoid assigning `undefined` to optional properties; use `T | undefined` where appropriate. |

## 🔐 Production notes

- Treat saved login data as passwords. Restrict access to the database file, `data/` folder, and `DATABASE_URL`.
- Never commit `.env`, SQLite databases, session data, or pairing codes to Git.
- Keep one manager process per `userId`, or implement explicit session ownership/locking across processes.
- Call `manager.close()` during shutdown. It closes sockets and storage but keeps saved logins.
- Remember the difference: `disconnectUser()` keeps login data; `removeUser()` deletes it; `logoutUser()` attempts to unlink and deletes it.
- Always subscribe to `manager:error` and handle errors in your own asynchronous listeners.
- Back up storage regularly. For SQLite, stop the app cleanly before copying the database.
- Use WhatsApp accounts responsibly and follow WhatsApp's Terms of Service. Send spacing is not a guarantee against limits or bans.

## 🧪 Development

```sh
npm install
npm install --prefix test
npm run typecheck
npm test
```

Before opening a pull request, run the type checks and tests and describe the problem your change solves.

## ⭐ Support the project

If Socksy helps you build a better WhatsApp bot, please consider giving it a ⭐ **star on GitHub**. Stars help the project reach more developers and encourage continued maintenance.

<p align="center">
  <a href="https://github.com/nightx-rebel/socksy/stargazers">
    <img src="https://img.shields.io/badge/⭐_Star_this_repo-on_GitHub-yellow?style=for-the-badge&logo=github" alt="Star Socksy on GitHub">
  </a>
</p>

<p align="center">
  Built with care for the developer community.
</p>

**Author:** `nightx-rebel (𝘴น𝚖𝔞ꪦ_𝗿ǿⲩ)`
