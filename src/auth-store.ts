import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';

export type AuthRecord = {
  key: string;
  value: string | null;
};

export interface AuthStore {
  get(userId: string, key: string): Promise<string | undefined>;
  getMany?(userId: string, keys: string[]): Promise<Map<string, string>>;
  setMany(userId: string, records: AuthRecord[]): Promise<void>;
  deleteKeys(userId: string, prefix: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  listUsers(): Promise<string[]>;
  close(): Promise<void>;
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS wa_auth (
    user_id TEXT NOT NULL,
    record_key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, record_key)
  )
`;

/** Last write wins when the same key appears twice in one batch. */
function dedupe(records: AuthRecord[]): AuthRecord[] {
  return [...new Map(records.map((record) => [record.key, record])).values()];
}

export class SQLiteAuthStore implements AuthStore {
  private readonly database: DatabaseSync;
  private closed = false;
  private readonly getStatement;
  private readonly insertStatement;
  private readonly removeStatement;
  private readonly deleteUserStatement;
  private readonly deleteKeysStatement;
  private readonly listStatement;

  constructor(filename = './data/wa-auth.sqlite') {
    const inMemory = filename === ':memory:';
    const path = inMemory ? filename : resolve(filename);
    if (!inMemory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    if (!inMemory) {
      try {
        chmodSync(path, 0o600); // credentials: owner read/write only
      } catch {
        /* best effort (e.g. unsupported on some platforms) */
      }
    }
    this.database.exec(
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;',
    );
    this.database.exec(CREATE_TABLE);

    this.getStatement = this.database.prepare(
      'SELECT value FROM wa_auth WHERE user_id = ? AND record_key = ?',
    );
    this.insertStatement = this.database.prepare(
      'INSERT INTO wa_auth (user_id, record_key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, record_key) DO UPDATE SET value = excluded.value',
    );
    this.removeStatement = this.database.prepare(
      'DELETE FROM wa_auth WHERE user_id = ? AND record_key = ?',
    );
    this.deleteUserStatement = this.database.prepare('DELETE FROM wa_auth WHERE user_id = ?');
    this.deleteKeysStatement = this.database.prepare(
      'DELETE FROM wa_auth WHERE user_id = ? AND substr(record_key, 1, ?) = ?',
    );
    this.listStatement = this.database.prepare(
      'SELECT DISTINCT user_id FROM wa_auth ORDER BY user_id',
    );
  }

  async get(userId: string, key: string): Promise<string | undefined> {
    const row = this.getStatement.get(userId, key) as { value: string } | undefined;
    return row?.value;
  }

  async getMany(userId: string, keys: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const CHUNK = 500; // stay below SQLite's bound-parameter limit
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.database
        .prepare(
          `SELECT record_key, value FROM wa_auth WHERE user_id = ? AND record_key IN (${placeholders})`,
        )
        .all(userId, ...chunk) as { record_key: string; value: string }[];
      for (const row of rows) result.set(row.record_key, row.value);
    }
    return result;
  }

  async setMany(userId: string, records: AuthRecord[]): Promise<void> {
    if (records.length === 0) return;
    // Everything below is synchronous, so transactions of different callers never interleave.
    this.database.exec('BEGIN');
    try {
      for (const record of dedupe(records)) {
        if (record.value === null) this.removeStatement.run(userId, record.key);
        else this.insertStatement.run(userId, record.key, record.value);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async deleteUser(userId: string): Promise<void> {
    this.deleteUserStatement.run(userId);
  }

  async deleteKeys(userId: string, prefix: string): Promise<void> {
    this.deleteKeysStatement.run(userId, prefix.length, prefix);
  }

  async listUsers(): Promise<string[]> {
    return (this.listStatement.all() as { user_id: string }[]).map((row) => row.user_id);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}

export class PostgresAuthStore implements AuthStore {
  private readonly pool: Pool;
  private readonly initialization: Promise<void>;
  private closed = false;

  constructor(connectionString: string, onError: (error: Error) => void = () => undefined) {
    this.pool = new Pool({ connectionString });
    // An unhandled 'error' event on an idle client would crash the whole process.
    this.pool.on('error', onError);
    this.initialization = this.pool.query(CREATE_TABLE).then(() => undefined);
    // Avoid an unhandledRejection if the DB is down at startup; ready() still rethrows.
    this.initialization.catch(() => undefined);
  }

  private async ready(): Promise<void> {
    await this.initialization;
  }

  async get(userId: string, key: string): Promise<string | undefined> {
    await this.ready();
    const result = await this.pool.query<{ value: string }>(
      'SELECT value FROM wa_auth WHERE user_id = $1 AND record_key = $2',
      [userId, key],
    );
    return result.rows[0]?.value;
  }

  async getMany(userId: string, keys: string[]): Promise<Map<string, string>> {
    await this.ready();
    if (keys.length === 0) return new Map();
    const result = await this.pool.query<{ record_key: string; value: string }>(
      'SELECT record_key, value FROM wa_auth WHERE user_id = $1 AND record_key = ANY($2::text[])',
      [userId, keys],
    );
    return new Map(result.rows.map((row) => [row.record_key, row.value]));
  }

  async setMany(userId: string, records: AuthRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.ready();
    const unique = dedupe(records);
    const upserts = unique.filter(
      (record): record is AuthRecord & { value: string } => record.value !== null,
    );
    const deletions = unique.filter((record) => record.value === null).map((record) => record.key);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (upserts.length > 0) {
        await client.query(
          `INSERT INTO wa_auth (user_id, record_key, value)
           SELECT $1, record_key, value
           FROM UNNEST($2::text[], $3::text[]) AS records(record_key, value)
           ON CONFLICT (user_id, record_key) DO UPDATE SET value = EXCLUDED.value`,
          [userId, upserts.map((r) => r.key), upserts.map((r) => r.value)],
        );
      }
      if (deletions.length > 0) {
        await client.query(
          'DELETE FROM wa_auth WHERE user_id = $1 AND record_key = ANY($2::text[])',
          [userId, deletions],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteUser(userId: string): Promise<void> {
    await this.ready();
    await this.pool.query('DELETE FROM wa_auth WHERE user_id = $1', [userId]);
  }

  async deleteKeys(userId: string, prefix: string): Promise<void> {
    await this.ready();
    await this.pool.query(
      'DELETE FROM wa_auth WHERE user_id = $1 AND LEFT(record_key, $2::int) = $3',
      [userId, prefix.length, prefix],
    );
  }

  async listUsers(): Promise<string[]> {
    await this.ready();
    const result = await this.pool.query<{ user_id: string }>(
      'SELECT DISTINCT user_id FROM wa_auth ORDER BY user_id',
    );
    return result.rows.map((row) => row.user_id);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

const ENCRYPTED_PREFIX = 'enc:v1:';

function parseKey(key: string | Buffer): Buffer {
  if (Buffer.isBuffer(key)) {
    if (key.length !== 32) throw new Error('Encryption key must be exactly 32 bytes.');
    return key;
  }
  const candidates = [
    /^[0-9a-fA-F]{64}$/.test(key) ? Buffer.from(key, 'hex') : undefined,
    Buffer.from(key, 'base64'),
  ];
  const found = candidates.find((candidate) => candidate?.length === 32);
  if (!found) {
    throw new Error('Encryption key must be 32 bytes, given as 64 hex chars or base64.');
  }
  return found;
}

/**
 * Decorator that encrypts every value at rest with AES-256-GCM.
 * The (userId, key) pair is bound as AAD, so a ciphertext copied to another row will not decrypt.
 * Generate a key with:  node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
 */
export class EncryptedAuthStore implements AuthStore {
  private readonly key: Buffer;

  constructor(
    private readonly inner: AuthStore,
    key: string | Buffer,
    private readonly allowPlaintext = true,
  ) {
    this.key = parseKey(key);
  }

  private encrypt(userId: string, recordKey: string, plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${userId}\0${recordKey}`));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ENCRYPTED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  private decrypt(userId: string, recordKey: string, stored: string): string {
    if (!stored.startsWith(ENCRYPTED_PREFIX)) {
      if (this.allowPlaintext) return stored; // legacy row written before encryption was enabled
      throw new Error(`Unencrypted record found for "${userId}" while plaintext is not allowed.`);
    }
    const raw = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${userId}\0${recordKey}`));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  async get(userId: string, key: string): Promise<string | undefined> {
    const stored = await this.inner.get(userId, key);
    return stored === undefined ? undefined : this.decrypt(userId, key, stored);
  }

  async getMany(userId: string, keys: string[]): Promise<Map<string, string>> {
    const stored = this.inner.getMany
      ? await this.inner.getMany(userId, keys)
      : new Map(
          (
            await Promise.all(
              keys.map(async (key) => [key, await this.inner.get(userId, key)] as const),
            )
          ).filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
        );
    return new Map([...stored].map(([key, value]) => [key, this.decrypt(userId, key, value)]));
  }

  setMany(userId: string, records: AuthRecord[]): Promise<void> {
    return this.inner.setMany(
      userId,
      records.map((record) => ({
        key: record.key,
        value: record.value === null ? null : this.encrypt(userId, record.key, record.value),
      })),
    );
  }

  deleteKeys(userId: string, prefix: string): Promise<void> {
    return this.inner.deleteKeys(userId, prefix);
  }

  deleteUser(userId: string): Promise<void> {
    return this.inner.deleteUser(userId);
  }

  listUsers(): Promise<string[]> {
    return this.inner.listUsers();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

export type CreateAuthStoreOptions = {
  /** 32-byte key (64 hex chars or base64). When set, all values are encrypted at rest. */
  encryptionKey?: string | Buffer;
  /** Refuse to read unencrypted rows (use after you finished migrating). Default: false. */
  requireEncrypted?: boolean;
  /** Called for idle PostgreSQL pool errors. */
  onError?: (error: Error) => void;
};

export function createAuthStore(
  databaseUrl?: string,
  options: CreateAuthStoreOptions = {},
): AuthStore {
  let store: AuthStore;
  if (!databaseUrl) {
    store = new SQLiteAuthStore();
  } else if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
    store = new PostgresAuthStore(databaseUrl, options.onError);
  } else if (databaseUrl === 'sqlite::memory:') {
    store = new SQLiteAuthStore(':memory:');
  } else if (databaseUrl.startsWith('sqlite://')) {
    // sqlite:///abs/path -> /abs/path   |   sqlite://./rel/path -> ./rel/path
    store = new SQLiteAuthStore(decodeURIComponent(databaseUrl.slice('sqlite://'.length)));
  } else {
    throw new Error('Unsupported database URL. Use sqlite://, postgres://, or postgresql://.');
  }
  return options.encryptionKey
    ? new EncryptedAuthStore(store, options.encryptionKey, !options.requireEncrypted)
    : store;
}
