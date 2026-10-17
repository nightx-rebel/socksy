# WhatsApp Bot Starter

An Express app using the sibling `wa-multi-socket` library for WhatsApp sessions, pairing codes, auth persistence, and reconnects. The sample bot includes `!ping`, `!help`, `!echo`, and other commands.

## Install and run

Requires Node.js 22.13 or newer. From the repository root:

```sh
npm ci
npm run build
cd wa-bot
npm ci
cp .env.example .env
```

Set `BOT_API_TOKEN` in `.env` to a long random secret. `API_KEY` is also accepted. Generate one with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Then start the bot from `wa-bot`:

```sh
npm start
```

The default host is `127.0.0.1`. If binding to a non-loopback address, configure an API key; startup fails without one. Keep the API private and use HTTPS when accessing it remotely.

## Pair an account

Use a WhatsApp account you own. Include its country code without a leading `+`:

```sh
curl --get 'http://localhost:3000/pair' \
  -H 'Authorization: Bearer replace-with-your-token' \
  --data-urlencode 'number=14155550123'
```

The `x-api-key` header is also supported. The server accepts `number` or `phone`; `userId` is optional and defaults to `user-<normalized number>`. A successful response only means the pairing-code request succeeded. On the phone, open WhatsApp → **Linked devices** → **Link a device** → **Link with phone number instead**, then enter the code promptly. Pairing codes expire; request a new one if linking times out.

The pairing endpoint is rate limited and its responses are marked `Cache-Control: no-store`. Avoid logging request URLs or response bodies at reverse proxies because pairing codes are sensitive.

## API

All routes except `/health` require the configured API key:

- `GET|POST /pair?number=<international number>[&userId=<id>]`
- `GET /users` and `GET /users/:userId`
- `POST /users/:userId/connect`
- `POST /users/:userId/disconnect`
- `POST /users/:userId/logout`
- `DELETE /users/:userId`
- `POST /send` with `{ "userId": "...", "to": "...", "text": "..." }`
- `GET /health`

The API key can be sent as `Authorization: Bearer <token>` or `x-api-key: <token>`. The health endpoint confirms that the API is running, not that WhatsApp is connected.

## Auth storage and operations

The default database is local SQLite at `wa-bot/data/wa-auth.sqlite`; startup fails if the library cannot restrict the database file to its owner. For a shared production database, set `DATABASE_URL` to a PostgreSQL connection URL. Optionally set `AUTH_ENCRYPTION_KEY` to a 32-byte key (64 hex characters or base64) to encrypt auth values at rest. Existing plaintext rows must be rewritten before enabling strict encrypted-only reads. Keep database backups and encryption keys private. Never commit the database, `.env`, pairing codes, or auth credentials.

`MAX_CONCURRENT_CONNECTIONS` limits simultaneous connection handshakes, not the number of accounts the host can sustain. Hundreds of persistent sessions require load testing against host memory, file descriptors, network, database, and reconnect behavior. Do not run two bot processes against the same account IDs without distributed session ownership/locking.

Messages are not written to logs by default. Set `DEBUG=true` only when needed; debug previews may contain message text.

Run the tests from the repository root with `npm test`, or from this folder with `npm test`.
