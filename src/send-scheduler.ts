import { WaManagerError } from './errors.js';

/**
 * Runs tasks one-by-one per key and keeps a minimum (jittered) gap between them.
 * Used to space out outgoing WhatsApp messages per account, which lowers ban/rate-limit risk.
 */
export class SendScheduler {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastRun = new Map<string, number>();
  private readonly generations = new Map<string, { pending: number; cancelled: boolean }>();
  private readonly pendingWaits = new Map<string, Set<() => void>>();

  constructor(
    private readonly minIntervalMs: number,
    private readonly jitterMs: number,
    private readonly maxQueued: number,
  ) {}

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    let generation = this.generations.get(key);
    if (!generation) {
      generation = { pending: 0, cancelled: false };
      this.generations.set(key, generation);
    }
    if (generation.pending >= this.maxQueued) {
      return Promise.reject(
        new WaManagerError('QUEUE_FULL', `Send queue for "${key}" is full (${this.maxQueued}).`),
      );
    }
    generation.pending += 1;

    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      try {
        this.assertCurrent(key, generation);
        const last = this.lastRun.get(key);
        if (last !== undefined) {
          const gap = this.minIntervalMs + Math.floor(Math.random() * (this.jitterMs + 1));
          const wait = last + gap - Date.now();
          if (wait > 0) await this.wait(key, wait, generation);
        }
        this.assertCurrent(key, generation);
        this.lastRun.set(key, Date.now());
        return await task();
      } finally {
        generation.pending -= 1;
        if (generation.pending === 0 && this.generations.get(key) === generation) {
          this.generations.delete(key);
        }
      }
    });

    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  forget(key: string): void {
    const generation = this.generations.get(key);
    if (generation) generation.cancelled = true;
    this.generations.delete(key);
    this.lastRun.delete(key);
    this.tails.delete(key);
    for (const cancel of this.pendingWaits.get(key) ?? []) cancel();
  }

  private assertCurrent(key: string, generation: { cancelled: boolean }): void {
    if (generation.cancelled) {
      throw new WaManagerError('NOT_CONNECTED', `Queued send for "${key}" was cancelled because its session changed.`);
    }
  }

  private wait(key: string, ms: number, generation: { cancelled: boolean }): Promise<void> {
    return new Promise((resolve) => {
      const waits = this.pendingWaits.get(key) ?? new Set<() => void>();
      this.pendingWaits.set(key, waits);
      const done = () => {
        clearTimeout(timer);
        waits.delete(done);
        if (waits.size === 0 && this.pendingWaits.get(key) === waits) this.pendingWaits.delete(key);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waits.add(done);
      if (generation.cancelled) done();
    });
  }
}
