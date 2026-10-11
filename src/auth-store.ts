import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';

export type AuthRecord = {
  key: string;
  value: string | null;
};

export interface AuthStore {
  get(userId: string, key: string): Promise<string | undefined>;
  setMany(userId: string, records: AuthRecord[]): Promise<void>;
  deleteKeys(userId: string, prefix: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  listUsers(): Promise<string[]>;
  close(): Promise<void>;
}

export class SQLiteAuthStore implements AuthStore {
  private readonly database: DatabaseSync;

  constructor(filename = './data/wa-auth.sqlite') {
    const path = filename === ':memory:' ? filename : resolve(filename);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS wa_auth (
        user_id TEXT NOT NULL,
        record_key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (user_id, record_key)
      )
    `);
  }

  async get(userId: string, key: string): Promise<string | undefined> {
    const row = this.database
      .prepare('SELECT value FROM wa_auth WHERE user_id = ? AND record_key = ?')
      .get(userId, key) as { value: string } | undefined;
    return row?.value;
  }

  async setMany(userId: string, records: AuthRecord[]): Promise<void> {
    const insert = this.database.prepare(
      'INSERT INTO wa_auth (user_id, record_key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, record_key) DO UPDATE SET value = excluded.value',
    );
    const remove = this.database.prepare(
      'DELETE FROM wa_auth WHERE user_id = ? AND record_key = ?',
    );

    this.database.exec('BEGIN');
    try {
      for (const record of records) {
        if (record.value === null) remove.run(userId, record.key);
        else insert.run(userId, record.key, record.value);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async deleteUser(userId: string): Promise<void> {
    this.database.prepare('DELETE FROM wa_auth WHERE user_id = ?').run(userId);
  }

  async deleteKeys(userId: string, prefix: string): Promise<void> {
    this.database
      .prepare(
        'DELETE FROM wa_auth WHERE user_id = ? AND substr(record_key, 1, ?) = ?',
      )
      .run(userId, prefix.length, prefix);
  }

  async listUsers(): Promise<string[]> {
    const rows = this.database
      .prepare('SELECT DISTINCT user_id FROM wa_auth ORDER BY user_id')
      .all() as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  async close(): Promise<void> {
    this.database.close();
  }
}

export class PostgresAuthStore implements AuthStore {
  private readonly pool: Pool;
  private readonly initialization: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.initialization = this.pool.query(`
      CREATE TABLE IF NOT EXISTS wa_auth (
        user_id TEXT NOT NULL,
        record_key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (user_id, record_key)
      )
    `).then(() => undefined);
  }

  private async ready(): Promise<void> {
    await this.initialization;
    await this.pool.query('SELECT 1');
  }

  async get(userId: string, key: string): Promise<string | undefined> {
    await this.ready();
    const result = await this.pool.query<{ value: string }>(
      'SELECT value FROM wa_auth WHERE user_id = $1 AND record_key = $2',
      [userId, key],
    );
    return result.rows[0]?.value;
  }

  async setMany(userId: string, records: AuthRecord[]): Promise<void> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const record of records) {
        if (record.value === null) {
          await client.query(
            'DELETE FROM wa_auth WHERE user_id = $1 AND record_key = $2',
            [userId, record.key],
          );
        } else {
          await client.query(
            'INSERT INTO wa_auth (user_id, record_key, value) VALUES ($1, $2, $3) ON CONFLICT (user_id, record_key) DO UPDATE SET value = EXCLUDED.value',
            [userId, record.key, record.value],
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
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
      'DELETE FROM wa_auth WHERE user_id = $1 AND SUBSTRING(record_key FROM 1 FOR $2) = $3',
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
    await this.pool.end();
  }
}

export function createAuthStore(databaseUrl?: string): AuthStore {
  if (!databaseUrl) return new SQLiteAuthStore();
  if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
    return new PostgresAuthStore(databaseUrl);
  }
  if (databaseUrl === 'sqlite::memory:') return new SQLiteAuthStore(':memory:');
  if (databaseUrl.startsWith('sqlite:///')) {
    return new SQLiteAuthStore(decodeURIComponent(databaseUrl.slice('sqlite://'.length)));
  }
  if (databaseUrl.startsWith('sqlite://')) {
    return new SQLiteAuthStore(decodeURIComponent(databaseUrl.slice('sqlite://'.length)));
  }
  throw new Error('Unsupported database URL. Use sqlite://, postgres://, or postgresql://.');
}