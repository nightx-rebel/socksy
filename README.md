# wa-multi-socket

<p align="center">
	<img src="https://raw.githubusercontent.com/WhiskeySockets/Baileys/refs/heads/master/Media/logo.png" alt="Baileys logo" width="240">
</p>

<p align="center">
	<strong>One manager. Multiple WhatsApp sessions. Your bot logic, your sockets.</strong>
</p>

<p align="center">
	<img alt="Node.js 22.13+" src="https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=node.js&logoColor=white">
	<img alt="Baileys 7" src="https://img.shields.io/badge/Baileys-7-25D366">
	<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178C6?logo=typescript&logoColor=white">
</p>

`wa-multi-socket` runs **many WhatsApp accounts from one Node.js app** using Baileys v7. Give each account a `userId`, and the manager will:

- create a separate Baileys socket for it,
- save its login (credentials + keys) in a local SQLite file or PostgreSQL,
- restore it after a restart,
- reconnect it after a network drop,
- and send its messages slowly and safely.

You write the bot logic. The manager keeps the sessions alive.

> [!IMPORTANT]
> Requires Node.js `22.13+` and an ESM project (`"type": "module"`). Saved login data is sensitive. Anyone who gets your database file or URL can control those WhatsApp accounts. Keep it private.

## 🧭 Contents

- [✨ Features](#-features)
- [📦 Install](#-install)
- [🚀 Quick start (2 minutes)](#-quick-start-2-minutes)
- [🤖 Use it in your bot](#-use-it-in-your-bot)
- [⚙️ Configuration guide](#️-configuration-guide)
- [🧩 `socketConfig` explained](#-socketconfig-explained)
- [👥 Manage multiple users](#-manage-multiple-users)
- [🔗 Pairing codes](#-pairing-codes)
- [📣 Events](#-events)
- [🔁 Reconnect policy](#-reconnect-policy)
- [⚖️ Capacity and connection management](#️-capacity-and-connection-management)
- [🗄️ Database and auth storage](#️-database-and-auth-storage)
- [🧰 Manager API](#-manager-api)
- [🚨 Error handling](#-error-handling)
- [🍳 Recipes](#-recipes)
- [🩺 Troubleshooting](#-troubleshooting)
- [🔐 Production notes](#-production-notes)
- [🧪 Development](#-development)

## ✨ Features

- Manage many user sessions with stable, application-defined `userId` values.
- Get the real Baileys `WASocket` for every user and use the full Baileys API.
- Pair new accounts with a phone number and a pairing code.
- Persist credentials and binary Signal keys in local SQLite or PostgreSQL.
- Restore saved accounts automatically with `manager.start()`.
- Limit simultaneous handshakes and pairing requests to avoid startup spikes.
- Retry temporary disconnects with capped exponential backoff and jitter.
- Queue outgoing messages per account, with a minimum delay and a bounded queue.
- Track connection state and overall statistics.
- Receive lifecycle events for connect, disconnect, pairing, logout, and errors.
- Disconnect temporarily, log out, or remove saved login data completely.
- Typed errors with stable codes (`WaManagerError`).
- One unreadable saved key does not break a whole session.

### How it fits together

```mermaid
flowchart LR
		Bot[Your bot / API] <--> Manager[MultiSocketManager]
		Manager <--> A[User A socket]
		Manager <--> B[User B socket]
		Manager <--> C[User C socket]
		Manager <--> DB[(SQLite or PostgreSQL<br/>credentials + Signal keys)]
		A <--> WA[WhatsApp]
		B <--> WA
		C <--> WA
```

## 📦 Install

If this package is published to npm:

```sh
npm install wa-multi-socket
```

To use a local checkout from your bot project:

```sh
npm install ../wa-multi-socket
```

Set `"type": "module"` in your app's `package.json`, or use `.mjs` files. Baileys, Boom, and the PostgreSQL driver are installed as dependencies.

Check your Node version first (Termux users too):

```sh
node -v   # must be v22.13 or higher
```

## 🚀 Quick start (2 minutes)

This is the smallest working bot. It restores saved accounts, listens for messages, and replies to `!ping`.

```ts
import { createAuthStore, MultiSocketManager } from 'wa-multi-socket';

// 1. Create ONE manager. Only `authStore` is required.
//    No URL = local SQLite file at ./data/wa-auth.sqlite
const manager = new MultiSocketManager({
	authStore: createAuthStore(),
});

// 2. Attach your bot to every user's socket.
//    This runs again after every reconnect, because each reconnect makes a new socket.
manager.events.on('user:connected', ({ userId, socket }) => {
	console.log(`${userId} is online`);

	socket.ev.on('messages.upsert', async ({ messages, type }) => {
		if (type !== 'notify') return;
		for (const msg of messages) {
			if (!msg.message || msg.key.fromMe) continue;
			const text = msg.message.conversation ?? msg.message.extendedTextMessage?.text ?? '';
			const jid = msg.key.remoteJid;
			if (jid && text === '!ping') {
				await manager.sendMessage(userId, jid, { text: 'pong 🏓' }, { quoted: msg });
			}
		}
	});
});

// 3. Show the pairing code to the person who owns the account.
manager.events.on('user:pairing-code', ({ userId, pairingCode }) => {
	console.log(`Pairing code for ${userId}: ${pairingCode}`);
});

// 4. Always listen for errors, or you will miss problems.
manager.events.on('manager:error', ({ userId, error }) => {
	console.error('manager error', userId ?? '(manager)', error);
});

// 5. Restore every account that was already saved.
await manager.start();

// 6. Add a new account (first run only; later it is restored by start()).
await manager.addUser('my-first-user', { phoneNumber: '15551234567' });

// 7. Close nicely on Ctrl+C.
const shutdown = () => void manager.close().then(() => process.exit(0));
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
```

**On your phone:** WhatsApp → Settings → Linked devices → Link a device → *Link with phone number instead* → enter the code.

Rules to remember:

- Register your event listeners **before** `await manager.start()`.
- Always send with `manager.sendMessage(...)` so the safe queue is used.
- Put message listeners inside `user:connected`, not outside it.

## 🤖 Use it in your bot

Create one manager for the whole app and share it. A common layout:

```text
my-bot/
	src/
		index.ts        ← starts everything
		whatsapp.ts     ← creates the manager (shared)
		commands.ts     ← your command logic
	package.json
	.env
```

### `src/whatsapp.ts`: the shared manager

```ts
import { createAuthStore, MultiSocketManager } from 'wa-multi-socket';

export const whatsapp = new MultiSocketManager({
	authStore: createAuthStore(process.env.DATABASE_URL), // empty = local SQLite
	socketConfig: {
		markOnlineOnConnect: false,
		syncFullHistory: false,
		generateHighQualityLinkPreview: false,
	},
	maxConcurrentConnections: 10,
});
```

### `src/commands.ts`: your commands

```ts
import type { WAMessage } from '@whiskeysockets/baileys';
import { whatsapp } from './whatsapp.js';

type Ctx = {
	userId: string;       // which account received the message
	jid: string;          // chat to reply to
	msg: WAMessage;       // the original message
	args: string[];       // words after the command
	reply: (text: string) => Promise<unknown>;
};

const commands: Record<string, (ctx: Ctx) => Promise<void>> = {
	ping: async ({ reply }) => void (await reply('pong 🏓')),
	echo: async ({ reply, args }) => void (await reply(args.join(' ') || 'Write something')),
	menu: async ({ reply }) => void (await reply(Object.keys(commands).map((c) => `!${c}`).join('\n'))),
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
	const run = commands[name.toLowerCase()];
	if (!run) return;

	await run({
		userId,
		jid,
		msg,
		args,
		reply: (t) => whatsapp.sendMessage(userId, jid, { text: t }, { quoted: msg }),
	});
}
```

### `src/index.ts`: wire it together

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

whatsapp.events.on('user:pairing-code', ({ userId, pairingCode }) =>
	console.log(`[${userId}] pairing code: ${pairingCode}`));
whatsapp.events.on('user:logged-out', ({ userId }) => console.log(`[${userId}] logged out`));
whatsapp.events.on('manager:error', ({ userId, error }) => console.error(userId ?? 'manager', error));

await whatsapp.start();

const shutdown = () => void whatsapp.close().then(() => process.exit(0));
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
```

### Using a user's socket anywhere

```ts
// Safe sending (queue + spacing). Use this by default.
await whatsapp.sendMessage(userId, jid, { text: 'Hello' });

// Direct Baileys access for everything else (groups, profile, etc.)
const socket = whatsapp.getConnectedSocket(userId);
if (!socket) throw new Error(`${userId} is offline`);
const groups = await socket.groupFetchAllParticipating();
```

> `socket.sendMessage(...)` works too, but it **skips** the anti-ban queue. Prefer `manager.sendMessage(...)`.

Choose a stable ID for each account (your database user ID, tenant ID, or any name). Reusing the same ID after a restart loads its saved login. The `userId` does not have to be the phone number.

**`userId` rules:** 1–128 characters, only letters, digits, `_` `.` `:` `@` `-`, and it must start with a letter or digit.

## ⚙️ Configuration guide

Only `authStore` is required. Everything else has a safe default. Pass options to `new MultiSocketManager({...})`.

### All options

| Option | Default | What it does |
|---|---:|---|
| `authStore` | **required** | Where logins are saved. Create it with `createAuthStore(...)`. |
| `socketConfig` | `{}` | Extra Baileys options for every socket. See [socketConfig explained](#-socketconfig-explained). |
| `socketFactory` | Baileys `makeWASocket` | Replace socket creation (useful for tests or a Baileys fork). |
| **Reconnect** | | |
| `reconnect` | `true` | Turn automatic reconnect on or off. Logout cleanup always happens. |
| `defaultReconnectDelayMs` | `3000` | First wait for reasons without their own delay. |
| `reconnectDelays` | built-in table | Per-reason wait in ms. `null` = never retry for that reason. |
| `maxReconnectAttempts` | `20` | Give up after this many failed tries in a row (login is kept). |
| `stableConnectionMs` | `30000` | A connection must stay open this long before the failure counter resets. |
| `reconnectJitterMs` | `1000` | Random extra wait so many users do not retry at the same moment. |
| `maxReconnectDelayMs` | `60000` | Longest possible wait between retries. |
| **Limits** | | |
| `maxConcurrentConnections` | `20` | How many logins may be connecting at the same time. |
| `maxConcurrentPairings` | `5` | How many pairing-code requests may run at the same time. |
| `connectionAttemptTimeoutMs` | `60000` | A connection that does not open in this time counts as failed. |
| **Pairing** | | |
| `pairingTimeoutMs` | `180000` | How long to wait for the user to type the code (3 minutes). |
| `pairingRetries` | `2` | Extra tries if requesting a code fails. |
| `pairingRetryDelayMs` | `2000` | Wait between pairing retries (grows each try). |
| **Startup and cache** | | |
| `pruneUnregisteredOnStart` | `true` | On `start()`, delete sessions that never finished pairing. |
| `cacheSignalKeys` | `true` | Keep Signal keys in memory for speed. Recommended. |
| **Sending** | | |
| `sendIntervalMs` | `1000` | Minimum gap between messages from one account. |
| `sendJitterMs` | `500` | Random extra gap added to each message (looks more human). |
| `maxQueuedMessagesPerUser` | `100` | Max waiting messages per account. More → `QUEUE_FULL` error. |

Timer values must be whole numbers within Node.js's maximum timer delay (about 24.8 days). Invalid values throw `INVALID_ARGUMENT` when the manager is created.

### Recommended presets

Copy the one closest to your setup, then tune.

**📱 Phone / Termux, 1–20 accounts**

```ts
const manager = new MultiSocketManager({
	authStore: createAuthStore(), // local SQLite
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

**🖥️ Small server (VPS), 20–150 accounts**

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

**🏢 Large deployment, 150+ accounts**

Split accounts across several processes (one owner per account), use PostgreSQL, and keep `maxConcurrentConnections` low per process (10–15). Load-test before going live. See [Capacity](#️-capacity-and-connection-management).

**🧪 Tests**

```ts
const manager = new MultiSocketManager({
	authStore: createAuthStore('sqlite::memory:'), // nothing saved to disk
	reconnect: false,
});
```

### Which setting should I change when…?

| Problem | Change |
|---|---|
| Phone gets slow or hot at startup | Lower `maxConcurrentConnections` |
| Worried about WhatsApp bans | Raise `sendIntervalMs` and `sendJitterMs` |
| Users reconnect too slowly | Lower `defaultReconnectDelayMs` |
| Gave up too early after a long outage | Raise `maxReconnectAttempts` |
| Pairing code expires before users type it | Raise `pairingTimeoutMs` |
| Bot sends bursts and gets `QUEUE_FULL` | Raise `maxQueuedMessagesPerUser` or send less |
| High RAM | Set `syncFullHistory: false`, lower connection limit |

## 🧩 `socketConfig` explained

`socketConfig` is a plain object of **Baileys socket options**. The manager copies it into `makeWASocket(...)` for every user. If you do not need to change anything, leave it out.

```ts
const manager = new MultiSocketManager({
	authStore: createAuthStore(),
	socketConfig: {
		markOnlineOnConnect: false,
		syncFullHistory: false,
		generateHighQualityLinkPreview: false,
	},
});
```

### Recommended values

| Option | Suggested | Why |
|---|---|---|
| `syncFullHistory` | `false` | Do not download old chats. Saves a lot of RAM and data. |
| `markOnlineOnConnect` | `false` | The account does not appear "online" on connect, and the owner's phone keeps its notifications. |
| `generateHighQualityLinkPreview` | `false` | Skips extra downloads when you send links. |
| `shouldIgnoreJid` | `(jid) => jid.endsWith('@broadcast')` | Ignore status/broadcast traffic you do not need. |
| `keepAliveIntervalMs` | `30000` | How often to ping WhatsApp to keep the connection alive. |
| `connectTimeoutMs` | `60000` | Baileys' own connect timeout. |
| `defaultQueryTimeoutMs` | `60000` | How long Baileys waits for WhatsApp to answer a request. |
| `emitOwnEvents` | `false` (optional) | Do not fire events for messages the account itself sends. |

Example with an ignore rule:

```ts
socketConfig: {
	markOnlineOnConnect: false,
	syncFullHistory: false,
	shouldIgnoreJid: (jid) => jid.endsWith('@broadcast'),
},
```

### What the manager sets for you (do not set these)

| Option | Why the manager controls it |
|---|---|
| `auth` | Loaded from your database for each user. |
| `logger` | The manager uses its own logger for all sockets. |
| `browser` | Fixed to a desktop identity (`Ubuntu / Chrome`), which pairing codes need. |

If you put these in `socketConfig`, they are ignored or replaced.

### Things to know

- **One object for all users.** Do not put user-specific values in it.
- Functions such as `getMessage` or `cachedGroupMetadata` do not know which user called them. If you share a cache between users there, data from one account can leak to another. Avoid shared caches in those hooks.
- Available options depend on your Baileys version. A wrong option name is a TypeScript error, so your editor will tell you.
- `printQRInTerminal` is gone in modern Baileys. This manager uses pairing codes.

## 👥 Manage multiple users

Each `addUser()` call with a different ID creates an independent socket and login.

```ts
await manager.addUser('tenant-a', { phoneNumber: '15550000001' });
await manager.addUser('tenant-b', { phoneNumber: '15550000002' });

const socketA = manager.getSocket('tenant-a');     // may still be connecting
const socketB = manager.getConnectedSocket('tenant-b'); // only when really online
const allSockets = manager.getSockets();           // Map<userId, WASocket>
const allIds = manager.getUserIds();
const onlineIds = manager.getConnectedUserIds();

for (const [userId, socket] of allSockets) {
	console.log(userId, socket.user?.id);
}
```

- `getSocket()` returns a socket even while it is still connecting.
- `getConnectedSocket()` returns it only after WhatsApp reports it open. Use this before sending.
- Use `socket.ev` to listen to any Baileys event. The manager does not forward every Baileys event.

Check state and counts:

```ts
manager.getStatus('tenant-a');
// 'open' | 'connecting' | 'awaiting-pairing' | 'reconnecting' | 'offline'

manager.getStats();
// { total, open, connecting, awaitingPairing, reconnecting }
```

## 🔗 Pairing codes

### One call: connect and get a code

```ts
const { socket, pairingCode } = await manager.addUser('tenant-a', {
	phoneNumber: '15551234567',
	pairingCode: 'ABCD1234', // optional: your own code, exactly 8 letters/digits
});

if (pairingCode) {
	// Show the code to the account owner.
}
```

### Listen for the code as an event

```ts
manager.events.on('user:pairing-code', ({ userId, pairingCode }) => {
	console.log('Pair this account:', userId, pairingCode);
});
```

### Ask for a code separately

```ts
const code = await manager.requestPairingCode('tenant-a', '15551234567');
```

### Rules

- Phone number: international format with country code, 7–15 digits, no leading `0` (example `15551234567`). Symbols such as `+` and spaces are removed for you.
- A custom code must be exactly 8 letters or digits.
- If the account is already paired, `addUser()` just connects it and returns no code. `requestPairingCode()` throws `ALREADY_PAIRED`.
- The owner enters the code in WhatsApp → Linked devices → Link with phone number.
- If the code is not used in time (`pairingTimeoutMs`), the half-finished session is deleted and `user:pairing-failed` fires.
- Pairing codes are sensitive. Send them only to the account owner, and avoid logging them in production.

### What happens after a user enters the code

1. `user:paired` fires.
2. WhatsApp asks for one restart. The manager reconnects automatically.
3. `user:connected` fires. The account is ready.

## 📣 Events

Subscribe with `manager.events` (a Node.js `EventEmitter`):

```ts
manager.events.on('event-name', (payload) => { ... });
```

### Event list

| Event | When it fires | Payload |
|---|---|---|
| `user:connecting` | A socket is about to be created | `userId`, `reconnecting` |
| `user:connected` | WhatsApp reports the connection is open | `userId`, `socket`, `reconnecting` |
| `user:disconnected` | A socket closed, or you disconnected it | `userId`, `socket`, `reason`, `error` (manual close: `manual: true`) |
| `user:reconnecting` | An automatic retry is scheduled | `userId`, `reason`, `delayMs`, `attempt` |
| `user:reconnect-disabled` | The policy says do not retry | `userId`, `reason` |
| `user:reconnect-failed` | Retry limit reached; login is kept | `userId`, `attempts`, `reason` |
| `user:pairing-code` | A pairing code was created | `userId`, `pairingCode` |
| `user:paired` | Pairing completed | `userId`, `socket` |
| `user:pairing-failed` | Pairing expired or failed; temporary login removed | `userId`, `reason`, `error` |
| `user:logged-out` | WhatsApp logged the device out; login deleted | `userId`, `reason` |
| `user:removed` | `removeUser()` / `logoutUser()` finished | `userId` |
| `user:pruned` | `start()` deleted an unfinished pairing | `userId` |
| `baileys:connection.update` | Baileys sent a connection update | `userId`, `socket`, `update` |
| `baileys:creds.update` | Baileys updated credentials | `userId`, `socket` |
| `manager:error` | Restore, storage, or socket problem | `error`; `userId` may be missing |

### What to do for each event

```ts
const { events } = manager;

// ✅ Account is online. Attach your bot here.
events.on('user:connected', ({ userId, socket, reconnecting }) => {
	console.log(userId, reconnecting ? 'reconnected' : 'connected');
	socket.ev.on('messages.upsert', (m) => { /* your bot */ });
});

// ⏳ Informational: socket is starting.
events.on('user:connecting', ({ userId, reconnecting }) => {});

// 🔌 Connection lost. Auto-retry may follow.
events.on('user:disconnected', ({ userId, reason, manual }) => {
	console.log(userId, 'closed', { reason, manual });
});

// 🔁 Retry planned. Good place to log or alert.
events.on('user:reconnecting', ({ userId, delayMs, attempt }) => {
	console.log(`${userId}: retry #${attempt} in ${delayMs}ms`);
});

// 🛑 Not retrying (by policy). Login is kept.
events.on('user:reconnect-disabled', ({ userId, reason }) => {});

// ❌ Gave up after too many tries. Notify the owner / try manager.connectUser(userId) later.
events.on('user:reconnect-failed', ({ userId, attempts }) => {});

// 🔑 Show this to the owner.
events.on('user:pairing-code', ({ userId, pairingCode }) => {});

// 🎉 Pairing worked.
events.on('user:paired', ({ userId }) => {});

// ⌛ Pairing did not finish. Ask the owner to try again with addUser().
events.on('user:pairing-failed', ({ userId, reason, error }) => {});

// 🚪 Owner removed the device in WhatsApp. Login was deleted. Needs a new pairing.
events.on('user:logged-out', ({ userId }) => {});

// 🧹 Housekeeping notices.
events.on('user:removed', ({ userId }) => {});
events.on('user:pruned', ({ userId }) => {});

// 📡 Low-level Baileys updates.
events.on('baileys:connection.update', ({ userId, update }) => {
	if (update.qr) console.log('QR update for', userId);
});
events.on('baileys:creds.update', ({ userId }) => {});

// ⚠️ ALWAYS handle this one.
events.on('manager:error', ({ userId, error }) => {
	console.error(userId ?? '(manager)', error);
});
```

### Good to know

- For `messages.upsert`, `groups.update`, `contacts.upsert` and every other Baileys event, use `socket.ev` on the user's socket. Manager events cover the manager's own lifecycle, not every Baileys event.
- `user:connected` fires once per socket. After a reconnect it fires again with a **new** socket, so attach your listeners inside it.
- If a listener throws, the error is sent to `manager:error` instead of crashing the manager. `EventEmitter` does not wait for promises, so wrap your own async code in `try/catch`.

## 🔁 Reconnect policy

The manager reconnects for you. **Do not** call `connectUser()` from a disconnect handler.

Set `reconnectDelays` with Baileys `DisconnectReason` values. The number is milliseconds; `null` means never retry for that reason. Login is kept for every disconnect except real logout.

| Disconnect reason | Baileys status | Default behavior |
|---|---:|---|
| `connectionClosed` | 428 | Retry after 1 second |
| `connectionLost` / `timedOut` | 408 | Retry after 2 seconds |
| `connectionReplaced` | 440 | No retry; another process may own the session |
| `badSession` | 500 | Retry after 10 seconds |
| `restartRequired` | 515 | Retry after 1 second |
| `unavailableService` | 503 | Retry after 15 seconds |
| `loggedOut` | 401 | Never retry; delete all saved login |
| `forbidden` | 403 | No retry; keep login |
| `multideviceMismatch` | 411 | No retry; keep login |
| Other / unknown | varies | `defaultReconnectDelayMs` (3 seconds) |

`connectionLost` and `timedOut` share status `408`, so they cannot have different delays.

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

How waiting works:

- Each failed try doubles the wait, up to `maxReconnectDelayMs` (60 s).
- Up to `reconnectJitterMs` (1 s) of random time is added.
- The counter resets only after a connection stays open for `stableConnectionMs` (30 s).
- After `maxReconnectAttempts` failures, `user:reconnect-failed` fires. The login is kept.
- A connection that never opens is closed after `connectionAttemptTimeoutMs` (60 s) and treated as a temporary failure.
- `reconnect: false` turns off retries. Logout cleanup still happens.

## ⚖️ Capacity and connection management

The manager limits **how many logins start at once**: 20 handshakes and 5 pairing requests by default. A handshake slot is held until the socket opens, reaches the pairing screen, closes, or times out.

```ts
const manager = new MultiSocketManager({
	authStore: createAuthStore(process.env.DATABASE_URL),
	maxConcurrentConnections: 12,
	maxConcurrentPairings: 3,
	connectionAttemptTimeoutMs: 60_000,
	reconnectJitterMs: 1_000,
	maxReconnectDelayMs: 60_000,
});
```

These limits smooth out startup spikes. They do **not** cap how many sockets can stay connected. Baileys keeps state in memory for each account, so no setting can promise that a given CPU/RAM budget handles 600–700 accounts. Before going live:

- load-test with realistic message traffic,
- watch RSS memory, event-loop delay, database speed, file descriptors, and network use,
- use PostgreSQL for several instances or heavy writes (the SQLite adapter is synchronous and best for one host),
- split accounts across processes, with one owner per account,
- keep your own message handlers fast so slow handlers cannot pile up work.

## 🗄️ Database and auth storage

`createAuthStore(url?, options?)` picks the database from the URL:

| URL | What you get |
|---|---|
| *(none / empty)* | Local SQLite at `./data/wa-auth.sqlite` |
| `sqlite://./data/mybot.sqlite` | SQLite at that relative path |
| `sqlite:///absolute/path/wa-auth.sqlite` | SQLite at an absolute path |
| `sqlite::memory:` | In memory only (tests; lost on exit) |
| `postgres://user:pass@host:5432/db` | PostgreSQL |
| `postgresql://user:pass@host:5432/db` | PostgreSQL |

Options (PostgreSQL):

| Option | Default | Meaning |
|---|---:|---|
| `poolMax` | `10` | Maximum database connections in the pool |
| `onError` | logs the error | Called for idle pool errors |

### Local SQLite (no setup)

```ts
const manager = new MultiSocketManager({
	authStore: createAuthStore(),
});
```

- Uses Node's built-in `node:sqlite`; no extra package needed.
- The `data/` folder is created in the directory you run the app from.
- Folder and file permissions are limited to the owner.
- You will see two helper files next to the database. See below.

#### What are the `-wal` and `-shm` files?

SQLite runs in WAL mode for faster writes. While the app runs you will see:

| File | Purpose |
|---|---|
| `wa-auth.sqlite-wal` | New writes land here first, then are merged into the main file. Protects data if the app crashes. |
| `wa-auth.sqlite-shm` | A temporary index for the WAL file. SQLite rebuilds it if missing. |

Do not delete them while the app is running or after a crash, because the newest data may still be inside. A clean `manager.close()` merges everything into the main file. To back up, stop the app and copy `wa-auth.sqlite`.

### PostgreSQL (Supabase, etc.)

```sh
export DATABASE_URL='postgresql://bot_user:secret@db.example.com:5432/whatsapp'
```

```ts
const manager = new MultiSocketManager({
	authStore: createAuthStore(process.env.DATABASE_URL, { poolMax: 10 }),
});
```

- The `wa_auth` table is created automatically.
- If the database is down at startup, table creation is retried on the next call.
- Special characters in the password (`@`, `#`, `/`) must be URL-encoded (`@` → `%40`).
- On Supabase, prefer the pooler URL (port `6543`).

### Moving between databases

Sessions do not move automatically between SQLite and PostgreSQL. After switching, each account must be paired again.

### Your own database

For another database (MySQL, Redis, …), implement the exported `AuthStore` interface and pass it as `authStore`. The manager owns the store and closes it on `manager.close()`.

## 🧰 Manager API

### Starting and adding

| Method | What it does |
|---|---|
| `start()` | Restore every saved, fully paired account. Unfinished pairings are deleted. Per-user failures go to `manager:error`. |
| `addUser(userId, { phoneNumber?, pairingCode? })` | Create a socket. With `phoneNumber` and an unpaired account, also returns a pairing code. Returns `{ socket, pairingCode? }`. |
| `connectUser(userId)` | Create or return a socket without asking for a code. |
| `requestPairingCode(userId, phoneNumber, customCode?)` | Get a code for an unpaired account. |

### Looking things up

| Method | Returns |
|---|---|
| `getSocket(userId)` | Socket (even if still connecting) or `undefined` |
| `getConnectedSocket(userId)` | Socket only if open, else `undefined` |
| `getSockets()` | `Map<userId, WASocket>` snapshot |
| `getUserIds()` | IDs of all managed sockets |
| `getConnectedUserIds()` | IDs of open sockets |
| `getStatus(userId)` | `open`, `connecting`, `awaiting-pairing`, `reconnecting`, or `offline` |
| `getStats()` | `{ total, open, connecting, awaitingPairing, reconnecting }` |
| `waitForConnection(userId, timeoutMs = 30000)` | Resolves with the socket when open, or rejects with `TIMEOUT` |

### Sending

| Method | What it does |
|---|---|
| `sendMessage(userId, jid, content, options?)` | Send through the per-user queue with spacing. Throws `NOT_CONNECTED` if offline, `QUEUE_FULL` if too many waiting. |

### Stopping

| Method | Closes socket | Deletes saved login | Unlinks on WhatsApp |
|---|:---:|:---:|:---:|
| `disconnectUser(userId)` | ✅ | ❌ | ❌ |
| `removeUser(userId)` | ✅ | ✅ | ❌ |
| `logoutUser(userId)` | ✅ | ✅ | ✅ (when possible) |
| `close()` | ✅ all | ❌ | ❌ |

Notes:

- `disconnectUser()` cancels a connection waiting for a slot and any messages still queued for that user. Queued messages are never replayed on a later connection.
- After a real `loggedOut`, login data is deleted. Calling `addUser()` with the same ID starts fresh and can be paired again.
- `close()` closes sockets and the database; saved logins stay for the next start.

## 🚨 Error handling

Errors thrown by the manager are `WaManagerError` with a stable `code`:

```ts
import { WaManagerError } from 'wa-multi-socket';

try {
	await manager.sendMessage(userId, jid, { text: 'hi' });
} catch (error) {
	if (WaManagerError.is(error, 'NOT_CONNECTED')) {
		// user is offline
	} else if (WaManagerError.is(error, 'QUEUE_FULL')) {
		// slow down
	} else {
		throw error;
	}
}
```

`WaManagerError.is(error)` checks for any manager error. `WaManagerError.is(error, 'A', 'B')` checks for specific codes.

| Code | Meaning |
|---|---|
| `CLOSED` | The manager was closed. |
| `INVALID_ARGUMENT` | Bad `userId`, phone number, pairing code, or option. |
| `ALREADY_PAIRED` | You asked for a code for an account that is already paired. |
| `PAIRING_IN_PROGRESS` | A pairing request for this user is already running. |
| `PAIRING_TIMEOUT` | The code was not used in time, or WhatsApp was too slow to start pairing. |
| `CONNECTION_TIMEOUT` | The connection did not open in `connectionAttemptTimeoutMs`. |
| `NOT_AVAILABLE` | The request was cancelled or the socket went away. |
| `NOT_CONNECTED` | The user is not online (also used for cancelled queued sends). |
| `QUEUE_FULL` | That user's send queue is full. |
| `TIMEOUT` | `waitForConnection` timed out. |

An error converts to clean JSON with `JSON.stringify(error)`: `{ name, code, message, userId?, cause? }`.

## 🍳 Recipes

### Send to every online account

```ts
for (const userId of manager.getConnectedUserIds()) {
	await manager.sendMessage(userId, jid, { text: 'Hello from all accounts' }).catch(() => {});
}
```

### Wait until a user is online, then send

```ts
await manager.waitForConnection('tenant-a', 30_000);
await manager.sendMessage('tenant-a', jid, { text: 'Ready!' });
```

### Add an account from a chat command (`!adduser 8801XXXXXXXXX`)

```ts
const commands = {
	adduser: async ({ args, reply }: { args: string[]; reply: (t: string) => Promise<unknown> }) => {
		const phone = args[0];
		if (!phone) return void (await reply('Usage: !adduser <number>'));
		try {
			const { pairingCode } = await manager.addUser(`user-${phone}`, { phoneNumber: phone });
			await reply(pairingCode ? `Your code: ${pairingCode}` : 'Already paired');
		} catch (error) {
			await reply(WaManagerError.is(error) ? error.message : 'Something went wrong');
		}
	},
};
```

### Show status of everyone

```ts
const lines = manager.getUserIds().map((id) => `${id}: ${manager.getStatus(id)}`);
console.log(lines.join('\n'), manager.getStats());
```

### Log an account out completely

```ts
await manager.logoutUser('tenant-a'); // unlinks on WhatsApp and deletes saved login
```

### Pause an account but keep its login

```ts
await manager.disconnectUser('tenant-a');
// later:
await manager.connectUser('tenant-a');
```

### Log every lifecycle event while debugging

```ts
for (const name of [
	'user:connecting', 'user:connected', 'user:disconnected', 'user:reconnecting',
	'user:reconnect-failed', 'user:reconnect-disabled', 'user:pairing-code',
	'user:paired', 'user:pairing-failed', 'user:logged-out', 'user:removed', 'user:pruned',
]) {
	manager.events.on(name, (p: { userId?: string }) => console.log(name, p.userId));
}
```

## 🩺 Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `Cannot find module 'node:sqlite'` | Node is too old. Install Node `22.13+`. |
| No messages arrive after a reconnect | Message listeners were attached outside `user:connected`. Move them inside. |
| `NOT_CONNECTED` when sending | The account is offline. Use `waitForConnection()` or check `getStatus()`. |
| `QUEUE_FULL` | You send faster than the queue drains. Send less, or raise `maxQueuedMessagesPerUser` and `sendIntervalMs` carefully. |
| Pairing code never works | Wrong number format (use country code, no leading `0`), code expired, or WhatsApp is not on the "Link with phone number" screen. Try again with `addUser()`. |
| `user:pairing-failed` | The code was not entered in time. Ask the owner to retry. |
| Account keeps disconnecting with reason `440` | The same login is running in two processes. Run it in only one. |
| `user:logged-out` | The owner removed the device in WhatsApp. A new pairing is needed. |
| Startup is slow or heavy | Lower `maxConcurrentConnections`. |
| All accounts need re-pairing | The `data/` folder or database was deleted or changed. Back it up. |
| `manager:error` about unreadable or incomplete credentials | That user's saved login is damaged. Remove it with `removeUser()` and pair again. Other users are not affected. |
| Build error about `exactOptionalPropertyTypes` | Do not assign `undefined` to optional fields; type them as `T \| undefined` instead. |

## 🔐 Production notes

- **Saved login data is stored as-is in the database.** It contains WhatsApp credentials and cryptographic keys. Restrict who can read the database and the `data/` folder, keep `DATABASE_URL` secret, and never commit `.env` or `data/` to git.
- Run **one manager process per `userId`**. If several instances could manage the same account, add locking or another ownership rule, or you will see `connectionReplaced` loops.
- Call `manager.close()` on shutdown. It closes sockets and the database without deleting logins.
- `disconnectUser()` is temporary and keeps login. `removeUser()` deletes it. A WhatsApp `loggedOut` always deletes it and is never retried.
- Always subscribe to `manager:error`.
- `manager.events` uses Node's `EventEmitter`. A listener exception is reported through `manager:error`, but your listener code should still handle its own async errors.
- Back up regularly: stop the app, then copy `data/wa-auth.sqlite` (or use your PostgreSQL backups).
- Use WhatsApp accounts responsibly and follow WhatsApp's Terms of Service. Spacing messages lowers risk but cannot guarantee that an account will never be limited or banned.

## 🧪 Development

```sh
npm install
npm run typecheck
npm test
```
