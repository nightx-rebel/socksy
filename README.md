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

`wa-multi-socket` manages multiple Baileys v7 user sessions from one Node.js application. It persists each user's credentials and Signal keys in SQLite or PostgreSQL, restores saved sessions after a restart, requests pairing codes for new users, and reconnects after temporary disconnects.

> [!IMPORTANT]
> Requires Node.js `22.13+` and an ESM application. Auth records contain sensitive WhatsApp credentials and cryptographic keys; protect your database and connection URL.

## 🧭 Contents

- [✨ Features](#-features)
- [📦 Install](#-install)
- [🚀 Quick start](#-quick-start)
- [🤖 Use it in your bot](#-use-it-in-your-bot)
- [👥 Manage multiple users](#-manage-multiple-users)
- [🔗 Pairing codes](#-pairing-codes)
- [📣 Events](#-events)
- [🔁 Reconnect policy](#-reconnect-policy)
- [🗄️ Database and auth storage](#-database-and-auth-storage)
- [🧰 Manager API](#-manager-api)
- [🔐 Production notes](#-production-notes)
- [🧪 Development](#-development)

## ✨ Features

- Manage many user sessions with stable application-defined `userId` values.
- Get the real Baileys `WASocket` for every user and use the full Baileys API.
- Pair new accounts with a phone number and pairing code.
- Persist credentials and binary Signal keys in local SQLite or PostgreSQL.
- Restore saved accounts automatically with `manager.start()`.
- Bound simultaneous handshakes and pairing requests to avoid startup spikes.
- Retry transient disconnects with capped exponential backoff and jitter.
- Receive manager lifecycle events for connect, disconnect, pairing, logout, and errors.
- Disconnect a user temporarily or remove their saved authentication completely.

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

This package is ESM. Set `"type": "module"` in your app's `package.json`, or use `.mjs` files. Baileys, Boom, and the PostgreSQL driver are installed as package dependencies.

## 🚀 Quick start

This example restores existing accounts, listens for lifecycle changes, adds a new account, and attaches your bot logic to the account's Baileys socket.

```ts
import {
	createAuthStore,
	DisconnectReason,
	MultiSocketManager,
} from 'wa-multi-socket';

const manager = new MultiSocketManager({
	authStore: createAuthStore(process.env.DATABASE_URL),
	reconnectDelays: {
		[DisconnectReason.connectionLost]: 2_000,
		[DisconnectReason.connectionClosed]: 1_000,
		[DisconnectReason.connectionReplaced]: 5_000,
		[DisconnectReason.badSession]: 10_000,
		[DisconnectReason.restartRequired]: 1_000,
		[DisconnectReason.unavailableService]: 15_000,
		[DisconnectReason.forbidden]: null,
		[DisconnectReason.multideviceMismatch]: null,
	},
});

// Register listeners before restoring sessions.
manager.events.on('user:connected', ({ userId, socket, reconnecting }) => {
	console.log(`${userId} ${reconnecting ? 'reconnected' : 'connected'}`);

	// Attach your normal Baileys event handlers to this user's socket.
	socket.ev.on('messages.upsert', ({ messages }) => {
		for (const message of messages) {
			console.log('message for', userId, message.key.remoteJid);
		}
	});
});

manager.events.on('user:reconnecting', ({ userId, reason, delayMs }) => {
	console.log(`${userId}: retrying in ${delayMs}ms (reason ${reason})`);
});

manager.events.on('user:logged-out', ({ userId }) => {
	console.log(`${userId}: logged out; saved authentication was deleted`);
});

manager.events.on('manager:error', ({ userId, error }) => {
	console.error('socket manager error', userId ?? '(manager)', error);
});

// Re-open all user sessions that already have saved auth.
await manager.start();

// Add a new user. Show this code to the user in your app or admin panel.
const { socket, pairingCode } = await manager.addUser('customer-42', {
	phoneNumber: '15551234567',
});

if (pairingCode) {
	console.log('WhatsApp pairing code:', pairingCode);
}

// `socket` is the real Baileys WASocket for customer-42.
console.log('Socket created:', Boolean(socket));

// Graceful shutdown closes sockets and the database handle but keeps auth.
const shutdown = () => void manager.close();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
```

Use an international phone number with country code, such as `15551234567`. The manager strips non-digit characters before requesting a code. Pairing codes are sensitive: deliver them only to the account owner and avoid logging them in production.

## 🤖 Use it in your bot

Create one manager instance for your application, register event listeners, and then call `start()`. Keeping the instance in a shared module lets API routes, command handlers, and background jobs access the same user sockets.

```text
my-bot/
	src/
		index.ts
		whatsapp.ts
	package.json
```

For example, in `src/whatsapp.ts`:

```ts
import { createAuthStore, MultiSocketManager } from 'wa-multi-socket';

export const whatsapp = new MultiSocketManager({
	authStore: createAuthStore(process.env.DATABASE_URL),
});

whatsapp.events.on('user:connected', ({ userId, socket }) => {
	console.log('WhatsApp ready:', userId);

	socket.ev.on('messages.upsert', ({ messages }) => {
		// Route messages to your command handler.
		console.log(`Received ${messages.length} message(s) for ${userId}`);
	});
});

whatsapp.events.on('user:disconnected', ({ userId, reason, manual }) => {
	console.log('Socket closed:', userId, { reason, manual });
});
```

Then start the manager from your app entry point:

```ts
import { whatsapp } from './whatsapp.js';

await whatsapp.start();
```

Use a user's socket anywhere in your app:

```ts
const socket = whatsapp.getSocket(userId);
if (!socket) throw new Error(`No active socket for ${userId}`);

await socket.sendMessage(jid, { text: 'Reply from this user session' });
```

Choose a stable application ID for each account, such as a database user ID or tenant ID. Reusing that same ID after a restart loads its saved authentication. The `userId` does not have to be the phone number.

## 👥 Manage multiple users

Each call uses a separate stable ID and gets an independent Baileys socket and auth state:

```ts
await manager.addUser('tenant-a', { phoneNumber: '15550000001' });
await manager.addUser('tenant-b', { phoneNumber: '15550000002' });

const tenantASocket = manager.getSocket('tenant-a');
const sockets = manager.getSockets(); // ReadonlyMap<string, WASocket>
const userIds = manager.getUserIds();

for (const [userId, socket] of sockets) {
	console.log(userId, socket.user?.id);
}
```

`getSockets()` returns a snapshot of the sockets currently managed (including sockets that are still connecting). `getSocket(userId)` returns `undefined` if that user has no active managed socket. Use each socket's `socket.ev` emitter to subscribe to any Baileys event; the manager does not relay the entire Baileys event map.

## 🔗 Pairing codes

`addUser()` can create the socket and request a code in one call:

```ts
const { socket, pairingCode } = await manager.addUser('tenant-a', {
	phoneNumber: '15551234567',
	pairingCode: 'ABCD1234', // Optional custom code supported by Baileys.
});

if (pairingCode) {
	// Present the code to the account owner.
}
```

The code is also emitted as `user:pairing-code`:

```ts
manager.events.on('user:pairing-code', ({ userId, pairingCode }) => {
	console.log('Pair this account:', userId, pairingCode);
});
```

Or request it separately for an unregistered account:

```ts
const code = await manager.requestPairingCode('tenant-a', '15551234567');
```

If credentials are already registered, `addUser()` connects the existing account and does not return a new pairing code. `requestPairingCode()` throws if the account is already registered. The account owner enters the code in WhatsApp's Linked devices flow.

## 📣 Events

Subscribe to manager lifecycle events with `manager.events`, a Node.js `EventEmitter`:

| Event | Emitted when | Main payload fields |
|---|---|---|
| `user:connecting` | A socket is about to be created | `userId`, `reconnecting` |
| `user:connected` | Baileys reports `connection: 'open'` | `userId`, `socket`, `reconnecting` |
| `user:disconnected` | A socket closes or is manually disconnected | `userId`, `socket`, `reason`, `error`; manual close includes `manual: true` |
| `user:reconnecting` | An automatic retry is scheduled | `userId`, `reason`, `delayMs` |
| `user:pairing-code` | A pairing code is generated | `userId`, `pairingCode` |
| `user:logged-out` | Baileys reports `loggedOut` and auth is deleted | `userId`, `reason` |
| `user:removed` | `removeUser()` finishes | `userId` |
| `baileys:connection.update` | Baileys emits a connection update | `userId`, `socket`, `update` |
| `baileys:creds.update` | Baileys updates credentials | `userId`, `socket` |
| `manager:error` | Session restore, storage, or socket management fails | `error`; `userId` may be absent |

Example:

```ts
manager.events.on('user:disconnected', ({ userId, reason, error, manual }) => {
	console.error({ userId, reason, manual, error });
});

manager.events.on('baileys:connection.update', ({ userId, update }) => {
	if (update.qr) console.log('QR update for', userId);
});
```

For `messages.upsert`, `groups.update`, `contacts.upsert`, and every other Baileys event, listen on the corresponding `socket.ev`. Manager events cover manager lifecycle and selected connection/auth updates; they are not a wildcard Baileys event stream.

## 🔁 Reconnect policy

Set `reconnectDelays` using Baileys `DisconnectReason` values. A delay is in milliseconds. Set a reason to `null` to disable automatic retries for it. Auth is retained for non-logout disconnects, even if retry is disabled.

| Disconnect reason | Baileys status | Default behavior |
|---|---:|---|
| `connectionClosed` | 428 | Retry after 1 second |
| `connectionLost` / `timedOut` | 408 | Retry after 2 seconds |
| `connectionReplaced` | 440 | Retry after 5 seconds |
| `badSession` | 500 | Retry after 10 seconds |
| `restartRequired` | 515 | Retry after 1 second |
| `unavailableService` | 503 | Retry after 15 seconds |
| `loggedOut` | 401 | Never retry; clear Signal keys and all auth |
| `forbidden` | 403 | No automatic retry; keep auth |
| `multideviceMismatch` | 411 | No automatic retry; keep auth |
| Other or unknown reason | Varies | Use `defaultReconnectDelayMs` (3 seconds by default) |

Baileys assigns the same numeric status (`408`) to `connectionLost` and `timedOut`, so they cannot be configured with different delays.

```ts
const manager = new MultiSocketManager({
	authStore: createAuthStore(),
	defaultReconnectDelayMs: 4_000,
	reconnectDelays: {
		[DisconnectReason.connectionLost]: 7_000,
		[DisconnectReason.forbidden]: null,
	},
});
```

Set `reconnect: false` to turn off automatic retries. Logout cleanup still happens: the socket is closed and saved auth is deleted. The manager handles socket `close` events and schedules retries itself; your bot does not need to call `connectUser()` from a disconnect handler.

Reconnect delays are initial delays: repeated failures increase the wait exponentially up to `maxReconnectDelayMs` (60 seconds by default), with up to `reconnectJitterMs` (1 second by default) added to spread retry bursts. A successful connection resets that user's backoff. A connection that never opens is closed and treated as a transient failure after `connectionAttemptTimeoutMs` (60 seconds by default).

## ⚖️ Capacity and connection management

The manager limits in-progress handshakes to 20 and pairing-code requests to 5 by default. A handshake slot is held until Baileys reports open/close or the attempt times out. Tune these per server rather than launching hundreds of logins at once:

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

These limits control connection and pairing bursts; they do not cap the number of established sockets. Baileys retains per-account protocol state, so no library setting can promise that a particular CPU/RAM/network budget will sustain 600–700 accounts. Load-test with representative message traffic and monitor RSS, event-loop delay, database latency, file descriptors, and network usage before setting production capacity. Use PostgreSQL for a multi-instance or high-write deployment; the built-in SQLite adapter is synchronous and best suited to a single host. For larger deployments, shard accounts across manager processes, keep one owner per account, and send application events to bounded queues so slow bot handlers cannot retain unbounded work.

## 🗄️ Database and auth storage

### Local SQLite

With no URL, `createAuthStore()` creates `./data/wa-auth.sqlite` relative to the current working directory. It uses Node's built-in `node:sqlite` module; no separate SQLite package is required.

```ts
const manager = new MultiSocketManager({
	authStore: createAuthStore(),
});
```

### PostgreSQL

Pass a PostgreSQL connection URL, commonly through an environment variable:

```sh
export DATABASE_URL='postgresql://bot_user:secret@db.example.com:5432/whatsapp'
```

```ts
const authStore = createAuthStore(process.env.DATABASE_URL);
const manager = new MultiSocketManager({ authStore });
```

Supported URL formats:

```text
sqlite:///absolute/path/wa-auth.sqlite
sqlite://./data/wa-auth.sqlite
sqlite::memory:
postgres://user:password@host:5432/database
postgresql://user:password@host:5432/database
```

The PostgreSQL adapter creates a `wa_auth` table if needed. For another SQL driver (for example, MySQL), implement the exported `AuthStore` interface and pass your adapter as `authStore`. The manager owns the supplied store and closes it when `manager.close()` is called.

## 🧰 Manager API

| Method | Purpose |
|---|---|
| `start()` | Restore all user IDs found in storage. Per-user failures are reported through `manager:error`. |
| `addUser(userId, options?)` | Create a user's socket; request a pairing code when `phoneNumber` is provided and credentials are not registered. |
| `connectUser(userId)` | Create or return a socket without requesting a pairing code. |
| `requestPairingCode(userId, phoneNumber, customCode?)` | Request a code for an unregistered account. |
| `getSocket(userId)` | Return that user's managed socket, or `undefined`. |
| `getSockets()` | Return a snapshot `ReadonlyMap<string, WASocket>`. |
| `getUserIds()` | Return IDs for currently managed sockets. |
| `disconnectUser(userId)` | Close the socket and keep saved auth. |
| `removeUser(userId)` | Close the socket and delete all auth records for that user. |
| `close()` | Close managed sockets and the auth store; keep saved auth for a future manager instance. |

`maxConcurrentConnections`, `maxConcurrentPairings`, `connectionAttemptTimeoutMs`, `reconnectJitterMs`, and `maxReconnectDelayMs` configure the corresponding limits described above.

After a real `loggedOut` disconnect, the auth records are deleted. Calling `addUser()` again with the same ID creates a fresh auth state that can be paired again.

## 🔐 Production notes

- Auth storage contains WhatsApp credentials and cryptographic Signal keys. Restrict database access and keep `DATABASE_URL` secret. This package does not encrypt stored data at rest.
- Run one manager process per `userId`. If multiple application instances may manage the same account, add distributed locking or another ownership mechanism.
- For 600–700 concurrent accounts, benchmark on the intended host and shard accounts across processes/hosts as needed. Connection limits smooth session startup; they are not a guarantee of the hardware capacity or a limit on established socket memory.
- Call `manager.close()` during graceful shutdown. It closes sockets and the database handle/pool without deleting saved auth.
- `disconnectUser()` is temporary and keeps auth. `removeUser()` deletes stored auth. A WhatsApp `loggedOut` disconnect always deletes auth and is never retried.
- `manager.events` uses Node's `EventEmitter`. Exceptions thrown by your listeners can propagate through the event flow; handle errors inside application listeners.
- Use WhatsApp accounts responsibly and in accordance with WhatsApp's Terms of Service.

## 🧪 Development

```sh
npm install
npm run typecheck
npm test
```
