import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { Pool } from 'pg';
import logger from './logger.js';

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

// ───────────────────────────────── SQLite ─────────────────────────────────

export class SQLiteAuthStore implements AuthStore {
  private readonly database: DatabaseSync;
  private closed = false;
  private readonly getStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly removeStatement: StatementSync;
  private readonly deleteUserStatement: StatementSync;
  private readonly deleteKeysStatement: StatementSync;
  private readonly listStatement: StatementSync;
  /** Prepared `IN (?, ?, ...)` statements, cached by placeholder count. */
  private readonly manyStatements = new Map<number, StatementSync>();

  constructor(filename = './data/wa-auth.sqlite') {
    const inMemory = filename === ':memory:';
    const path = inMemory ? filename : resolve(filename);
    if (!inMemory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    if (!inMemory) {
      try {
        chmodSync(path, 0o600);
      } catch (error) {
        this.database.close();
        throw error;
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

  private assertOpen(): void {
    if (this.closed) throw new Error('SQLiteAuthStore is closed.');
  }

  private manyStatement(count: number): StatementSync {
    let statement = this.manyStatements.get(count);
    if (!statement) {
      const placeholders = Array.from({ length: count }, () => '?').join(', ');
      statement = this.database.prepare(
        `SELECT record_key, value FROM wa_auth WHERE user_id = ? AND record_key IN (${placeholders})`,
      );
      this.manyStatements.set(count, statement);
    }
    return statement;
  }

  async get(userId: string, key: string): Promise<string | undefined> {
    this.assertOpen();
    const row = this.getStatement.get(userId, key) as { value: string } | undefined;
    return row?.value;
  }

  async getMany(userId: string, keys: string[]): Promise<Map<string, string>> {
    this.assertOpen();
    const result = new Map<string, string>();
    const CHUNK = 500; // stay below SQLite's bound-parameter limit
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK);
      const rows = this.manyStatement(chunk.length).all(userId, ...chunk) as unknown as {
        record_key: string;
        value: string;
      }[];
      for (const row of rows) result.set(row.record_key, row.value);
    }
    return result;
  }

  async setMany(userId: string, records: AuthRecord[]): Promise<void> {
    if (records.length === 0) return;
    this.assertOpen();
    // Everything below is synchronous, so transactions of different callers never interleave.
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const record of dedupe(records)) {
        if (record.value === null) this.removeStatement.run(userId, record.key);
        else this.insertStatement.run(userId, record.key, record.value);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // transaction may already be gone; keep the original error
      }
      throw error;
    }
  }

  async deleteUser(userId: string): Promise<void> {
    this.assertOpen();
    this.deleteUserStatement.run(userId);
  }

  async deleteKeys(userId: string, prefix: string): Promise<void> {
    this.assertOpen();
    this.deleteKeysStatement.run(userId, prefix.length, prefix);
  }

  async listUsers(): Promise<string[]> {
    this.assertOpen();
    return (this.listStatement.all() as unknown as { user_id: string }[]).map((row) => row.user_id);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      // Fold the WAL back into the main file so a plain file copy is complete.
      this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // not fatal
    }
    this.database.close();
  }
}

// ──────────────────────────────── PostgreSQL ────────────────────────────────

export type PostgresOptions = {
  /** Called for idle PostgreSQL pool errors. */
  onError?: (error: Error) => void;
  /** Max pool connections. Default: 10. */
  poolMax?: number;
};

export class PostgresAuthStore implements AuthStore {
  private readonly pool: Pool;
  private initialization: Promise<void> | undefined;
  private closed = false;

  constructor(
    connectionString: string,
    options: PostgresOptions = {},
  ) {
    const onError =
      options.onError ??
      ((error: Error) => logger.error('Idle PostgreSQL client error', 'DATABASE', error));
    this.pool = new Pool({
      connectionString,
      max: options.poolMax ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: {
           rejectUnauthorized: false,
           },
    });
    // An unhandled 'error' event on an idle client would crash the whole process.
    this.pool.on('error', onError);
    // Warm up at startup; a failure here is retried on the next call (see ready()).
    this.ready().catch(() => undefined);
  }

  /** Creates the table once. If it failed (DB down), the next call tries again. */
  private ready(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('PostgresAuthStore is closed.'));
    this.initialization ??= this.pool.query(CREATE_TABLE).then(
      () => undefined,
      (error: unknown) => {
        this.initialization = undefined;
        throw error;
      },
    );
    return this.initialization;
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
    if (keys.length === 0) return new Map();
    await this.ready();
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

// ───────────────────────────────── factory ─────────────────────────────────

export type CreateAuthStoreOptions = PostgresOptions;

/**
 * No URL                      -> SQLite at ./data/wa-auth.sqlite
 * sqlite::memory:             -> in-memory SQLite (tests)
 * sqlite://./path/file.sqlite -> SQLite at that path (sqlite:///abs/path for absolute)
 * postgres:// | postgresql:// -> PostgreSQL (Supabase etc.)
 */
export function createAuthStore(
  databaseUrl?: string,
  options: CreateAuthStoreOptions = {},
): AuthStore {
  const url = databaseUrl?.trim();
  if (!url) return new SQLiteAuthStore();
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return new PostgresAuthStore(url, options);
  }
  if (url === 'sqlite::memory:') return new SQLiteAuthStore(':memory:');
  if (url.startsWith('sqlite://')) {
    return new SQLiteAuthStore(decodeURIComponent(url.slice('sqlite://'.length)));
  }
  throw new Error('Unsupported database URL. Use sqlite://, postgres://, or postgresql://.');
}
