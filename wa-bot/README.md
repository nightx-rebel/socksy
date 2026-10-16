# WhatsApp Bot Starter

An Express app that uses the sibling `wa-multi-socket` project for WhatsApp sessions, pairing codes, auth persistence, and reconnects. It includes a bounded plugin dispatcher and `!ping`, `!echo`, and `!help` examples.

## Install and run

Requires Node.js 22.13 or newer. From the repository root, install and build the library first, then install the bot dependencies:

```sh
npm ci
npm run build
cd wa-bot
npm ci
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy the generated value into `BOT_API_TOKEN` in `.env`. Keep the token private. Start the app from the `wa-bot` directory:

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

## Test a real WhatsApp pairing

The route tests below use a mock socket. To test against WhatsApp itself, use a phone number for an account you own and keep the bot running during the entire pairing attempt.

1. Set a private `BOT_API_TOKEN` in `.env` and start the bot from this directory with `npm start`.
2. In a second terminal, change to the `wa-bot` directory and request a pairing code. Replace the token and example number with your own values; include the country code and do not include a leading `+`:

   ```sh
   cd wa-bot
   curl --get 'http://localhost:3000/pair' \
     -H 'Authorization: Bearer YOUR_BOT_API_TOKEN' \
     --data-urlencode 'number=14155550123'
   ```

   You can optionally pass a stable account ID with `--data-urlencode 'userId=my-account'`. The default ID is the normalized phone number.
3. A successful response contains a `pairingCode`, for example `{"userId":"14155550123","pairingCode":"ABCD1234"}`. On your phone, open WhatsApp → **Linked devices** → **Link a device** → **Link with phone number instead**, then enter the code promptly. Menu wording may differ by WhatsApp version.
4. Wait for WhatsApp to finish linking and watch the bot terminal for errors. Receiving an API response with a code only means the code request succeeded; it does not prove that the account linked. Pairing codes expire, so request a new one if the attempt times out.

Never use a random or someone else's number. Do not share the pairing code, `.env`, or the auth database. The database is stored at `wa-bot/data/wa-auth.sqlite`, contains WhatsApp credentials and Signal keys, and is ignored by Git.

After linking, test the included plugins by sending `!ping`, `!help`, or `!echo hello` to the linked account from a different WhatsApp account. The bot should reply. The sample plugins ignore messages sent by the linked account itself. Saved auth is restored on the next start; press `Ctrl+C` to stop the bot gracefully.

Check that the HTTP API is responding with:

```sh
curl http://localhost:3000/healthz
```

It should return `{"status":"ok"}`. A successful health check confirms only that the API is running, not that WhatsApp is connected.

## Plugins

Add a module under `src/plugins/plugins/` and export an object with a unique `name` and an async `onMessage({ userId, socket, message })` method. Register it in `src/plugins/index.js`. Handlers receive incoming, non-self messages only. Plugin execution is bounded by `PLUGIN_CONCURRENCY` and `PLUGIN_MAX_QUEUE`; when the queue is full, new messages are skipped and a warning is logged. Keep handlers short and move slow work to a durable job queue.

## Capacity and operations

`MAX_CONCURRENT_CONNECTIONS` limits simultaneous connection handshakes, not the number of WhatsApp accounts the host can sustain. `MAX_CONCURRENT_PAIRINGS` separately limits pairing requests. Hundreds of persistent sessions require load testing against the actual host's memory, file descriptors, network, database, and reconnect behavior; this starter cannot guarantee 800–900 live accounts. WhatsApp may also restrict unofficial clients. Do not run two bot processes against the same account IDs without adding distributed session ownership/locking. For multiple hosts, partition users so only one process owns each session.

The `/pair` endpoint requires a bearer token and is rate limited. Put it behind HTTPS, restrict access at the network layer, and use a strong secret. Auth databases contain WhatsApp credentials and Signal keys; secure backups and filesystem/database access.

Run the route tests with `npm test`.