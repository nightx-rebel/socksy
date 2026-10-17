import { WaManagerError } from './errors.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs tasks one-by-one per key and keeps a minimum (jittered) gap between them.
 * Used to space out outgoing WhatsApp messages per account, which lowers ban/rate-limit risk.
 */
export class SendScheduler {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastRun = new Map<string, number>();
  private readonly queued = new Map<string, number>();

  constructor(
    private readonly minIntervalMs: number,
    private readonly jitterMs: number,
    private readonly maxQueued: number,
  ) {}

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const waiting = this.queued.get(key) ?? 0;
    if (waiting >= this.maxQueued) {
      return Promise.reject(
        new WaManagerError('QUEUE_FULL', `Send queue for "${key}" is full (${this.maxQueued}).`),
      );
    }
    this.queued.set(key, waiting + 1);

    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      try {
        const last = this.lastRun.get(key);
        if (last !== undefined) {
          const gap = this.minIntervalMs + Math.floor(Math.random() * (this.jitterMs + 1));
          const wait = last + gap - Date.now();
          if (wait > 0) await sleep(wait);
        }
        return await task();
      } finally {
        this.lastRun.set(key, Date.now());
        const left = (this.queued.get(key) ?? 1) - 1;
        if (left <= 0) this.queued.delete(key);
        else this.queued.set(key, left);
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
    this.lastRun.delete(key);
  }
}
