# WhatsApp Bot Starter

An Express app that uses the sibling `wa-multi-socket` project for WhatsApp sessions, pairing codes, auth persistence, and reconnects. It includes a bounded plugin dispatcher and `!ping`, `!echo`, and `!help` examples.

## Run

Requires Node.js 22.13 or newer. From this folder:

```sh
npm install
cp .env.example .env
```

Set `BOT_API_TOKEN` in `.env` to a long random secret, then start the app:

```sh
npm start
```

The default database is local SQLite at `wa-bot/data/wa-auth.sqlite`. For a shared production database, set `DATABASE_URL` to a PostgreSQL connection URL and protect it like any other credential.

Request a pairing code with an international number, including its country code:

```sh
curl -H 'Authorization: Bearer YOUR_BOT_API_TOKEN' \
  'http://localhost:3000/pair?number=15551234567'
```

The optional `userId` query parameter lets an application use its own stable account ID. The default ID is the normalized phone number. Pairing codes are sensitive; use HTTPS, keep the API token private, and do not log API query strings or response bodies at a reverse proxy.

## Plugins

Add a module under `src/plugins/plugins/` and export an object with a unique `name` and an async `onMessage({ userId, socket, message })` method. Register it in `src/plugins/index.js`. Handlers receive incoming, non-self messages only. Plugin execution is bounded by `PLUGIN_CONCURRENCY` and `PLUGIN_MAX_QUEUE`; when the queue is full, new messages are skipped and a warning is logged. Keep handlers short and move slow work to a durable job queue.

## Capacity and operations

`MAX_CONCURRENT_CONNECTIONS` limits simultaneous connection handshakes, not the number of WhatsApp accounts the host can sustain. `MAX_CONCURRENT_PAIRINGS` separately limits pairing requests. Hundreds of persistent sessions require load testing against the actual host's memory, file descriptors, network, database, and reconnect behavior; this starter cannot guarantee 800–900 live accounts. WhatsApp may also restrict unofficial clients. Do not run two bot processes against the same account IDs without adding distributed session ownership/locking. For multiple hosts, partition users so only one process owns each session.

The `/pair` endpoint requires a bearer token and is rate limited. Put it behind HTTPS, restrict access at the network layer, and use a strong secret. Auth databases contain WhatsApp credentials and Signal keys; secure backups and filesystem/database access.

Run the route tests with `npm test`.