import type { AuthRecord, AuthStore } from './auth-store.js';

export class SessionAuthStore implements AuthStore {
  private revoked = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly inner: AuthStore) {}

  revoke(): void {
    this.revoked = true;
  }

  async drain(): Promise<void> {
    await this.chain.then(
      () => undefined,
      () => undefined,
    );
  }

  get(userId: string, key: string): Promise<string | undefined> {
    return this.inner.get(userId, key);
  }

  async getMany(userId: string, keys: string[]): Promise<Map<string, string>> {
    if (this.inner.getMany) return this.inner.getMany(userId, keys);
    const entries = await Promise.all(
      keys.map(async (key) => [key, await this.inner.get(userId, key)] as const),
    );
    return new Map(entries.filter((e): e is readonly [string, string] => e[1] !== undefined));
  }

  setMany(userId: string, records: AuthRecord[]): Promise<void> {
    return this.enqueue(() => this.inner.setMany(userId, records));
  }

  deleteKeys(userId: string, prefix: string): Promise<void> {
    return this.enqueue(() => this.inner.deleteKeys(userId, prefix));
  }

  deleteUser(userId: string): Promise<void> {
    return this.inner.deleteUser(userId);
  }

  listUsers(): Promise<string[]> {
    return this.inner.listUsers();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    if (this.revoked) return Promise.resolve();
    const run = this.chain.then(() => (this.revoked ? undefined : work()));
    this.chain = run.catch(() => undefined);
    return run.then(() => undefined);
  }
}