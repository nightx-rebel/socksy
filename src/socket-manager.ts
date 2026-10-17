import makeWASocket, {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  type AnyMessageContent,
  type AuthenticationCreds,
  type MiscMessageGenerationOptions,
  type WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { EventEmitter } from 'node:events';
import type { AuthStore } from './auth-store.js';
import { isPaired, isUserPairedInStore, loadAuthState, serializeCreds } from './auth-state.js';
import { WaManagerError } from './errors.js';
import { SendScheduler } from './send-scheduler.js';
import { SessionAuthStore } from './session-store.js';
import logger from './logger.js';

export type SocketConfig = Omit<Parameters<typeof makeWASocket>[0], 'auth'>;
export type SocketFactory = (config: Parameters<typeof makeWASocket>[0]) => WASocket;

export type MultiSocketManagerOptions = {
  authStore: AuthStore;
  socketConfig?: SocketConfig;
  socketFactory?: SocketFactory;

  /** Automatic reconnect on/off (logout cleanup always happens). Default: true. */
  reconnect?: boolean;
  defaultReconnectDelayMs?: number;
  reconnectDelays?: Partial<Record<DisconnectReason, number | null>>;
  /** Give up after this many consecutive failed attempts (auth is kept). Default: 20. */
  maxReconnectAttempts?: number;
  /** A connection must stay open this long before its backoff counter resets. Default: 30s. */
  stableConnectionMs?: number;
  reconnectJitterMs?: number;
  maxReconnectDelayMs?: number;

  maxConcurrentConnections?: number;
  maxConcurrentPairings?: number;
  connectionAttemptTimeoutMs?: number;
  /** How long an unpaired socket waits for the user to enter the code. Default: 3 minutes. */
  pairingTimeoutMs?: number;
  /** Extra attempts when requesting a pairing code fails. Default: 2. */
  pairingRetries?: number;
  pairingRetryDelayMs?: number;

  /** Delete saved sessions that never finished pairing when `start()` runs. Default: true. */
  pruneUnregisteredOnStart?: boolean;
  /** Wrap the Signal key store in Baileys' in-memory cache. Default: true. */
  cacheSignalKeys?: boolean;

  /** Minimum gap between messages sent through `manager.sendMessage` per user. Default: 1000. */
  sendIntervalMs?: number;
  sendJitterMs?: number;
  maxQueuedMessagesPerUser?: number;
};

export type AddUserOptions = {
  phoneNumber?: string;
  /** Optional custom pairing code: exactly 8 letters/digits. */
  pairingCode?: string;
};

export type AddUserResult = {
  socket: WASocket;
  pairingCode?: string;
};

export type UserStatus =
  | 'open'
  | 'connecting'
  | 'awaiting-pairing'
  | 'reconnecting'
  | 'offline';

export type ManagerStats = {
  total: number;
  open: number;
  connecting: number;
  awaitingPairing: number;
  reconnecting: number;
};

type Waiter = { resolve: () => void; reject: (error: Error) => void };

type ManagedSocket = {
  socket: WASocket;
  creds: AuthenticationCreds;
  session: SessionAuthStore;
  releaseConnectionSlot: () => void;
  pairingReadyWaiters: Set<Waiter>;
  connectionTimer?: NodeJS.Timeout | undefined;
  pairingTimer?: NodeJS.Timeout | undefined;
  stableTimer?: NodeJS.Timeout | undefined;
  closed: boolean;
  hasConnected: boolean;
  pairingReady: boolean;
  wasPaired: boolean;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MAX_TIMER_DELAY_MS = 2_147_483_647;

class AsyncLimiter {
  private active = 0;
  private closed = false;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.closed) return Promise.reject(new WaManagerError('CLOSED', 'The socket manager is closed.'));
    if (signal?.aborted) {
      return Promise.reject(new WaManagerError('NOT_AVAILABLE', 'Connection request was cancelled.'));
    }
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        waiter.cleanup();
        reject(new WaManagerError('NOT_AVAILABLE', 'Connection request was cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.queue.splice(0)) {
      waiter.cleanup();
      waiter.reject(new WaManagerError('CLOSED', 'The socket manager is closed.'));
    }
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.queue.shift();
      if (next && !this.closed) {
        next.cleanup();
        this.active += 1;
        next.resolve(this.createRelease());
      }
    };
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new WaManagerError('INVALID_ARGUMENT', `${name} must be a positive safe integer.`);
  }
  return result;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new WaManagerError('INVALID_ARGUMENT', `${name} must be a non-negative safe integer.`);
  }
  return result;
}

function timerDelay(
  value: number | undefined,
  fallback: number,
  name: string,
  allowZero = false,
): number {
  const result = value ?? fallback;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(result) || result < minimum || result > MAX_TIMER_DELAY_MS) {
    throw new WaManagerError(
      'INVALID_ARGUMENT',
      `${name} must be an integer between ${minimum} and ${MAX_TIMER_DELAY_MS}.`,
    );
  }
  return result;
}

const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const PAIRING_CODE_PATTERN = /^[A-Za-z0-9]{8}$/;

function validateReconnectDelays(delays: Partial<Record<DisconnectReason, number | null>>) {
  for (const [reason, delay] of Object.entries(delays)) {
    if (delay !== null && (!Number.isSafeInteger(delay) || delay < 0)) {
      throw new WaManagerError('INVALID_ARGUMENT', `Reconnect delay for reason ${reason} must be null or a non-negative safe integer.`);
    }
  }
}

const defaultReconnectDelays: Partial<Record<DisconnectReason, number | null>> = {
  [DisconnectReason.connectionClosed]: 1_000,
  [DisconnectReason.connectionLost]: 2_000,
  // Another device/process took this session. Retrying makes two instances fight forever.
  [DisconnectReason.connectionReplaced]: null,
  [DisconnectReason.loggedOut]: null,
  [DisconnectReason.badSession]: 10_000,
  [DisconnectReason.restartRequired]: 1_000,
  [DisconnectReason.multideviceMismatch]: null,
  [DisconnectReason.forbidden]: null,
  [DisconnectReason.unavailableService]: 15_000,
};

export class MultiSocketManager {
  readonly events = new EventEmitter();

  private readonly sockets = new Map<string, ManagedSocket>();
  private readonly pending = new Map<string, Promise<WASocket>>();
  private readonly connectionControllers = new Map<string, AbortController>();
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly pairingUsers = new Set<string>();
  private readonly pairingOperations = new Map<string, { cancelled: boolean }>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly reconnectDelays: Partial<Record<DisconnectReason, number | null>>;
  private readonly connectionLimiter: AsyncLimiter;
  private readonly pairingLimiter: AsyncLimiter;
  private readonly sendScheduler: SendScheduler;
  private readonly cfg: {
    connectionAttemptTimeoutMs: number;
    pairingTimeoutMs: number;
    reconnectJitterMs: number;
    maxReconnectDelayMs: number;
    defaultReconnectDelayMs: number;
    stableConnectionMs: number;
    maxReconnectAttempts: number;
    pairingRetries: number;
    pairingRetryDelayMs: number;
    pruneUnregisteredOnStart: boolean;
    cacheSignalKeys: boolean;
  };
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: MultiSocketManagerOptions) {
    this.reconnectDelays = { ...defaultReconnectDelays, ...options.reconnectDelays };
    validateReconnectDelays(this.reconnectDelays);
    const sendIntervalMs = timerDelay(options.sendIntervalMs, 1_000, 'sendIntervalMs', true);
    const sendJitterMs = timerDelay(options.sendJitterMs, 500, 'sendJitterMs', true);
    if (sendIntervalMs + sendJitterMs > MAX_TIMER_DELAY_MS) {
      throw new WaManagerError('INVALID_ARGUMENT', 'sendIntervalMs + sendJitterMs must not exceed the maximum timer delay.');
    }
    this.connectionLimiter = new AsyncLimiter(
      positiveInteger(options.maxConcurrentConnections, 20, 'maxConcurrentConnections'),
    );
    this.pairingLimiter = new AsyncLimiter(
      positiveInteger(options.maxConcurrentPairings, 5, 'maxConcurrentPairings'),
    );
    this.sendScheduler = new SendScheduler(
      sendIntervalMs,
      sendJitterMs,
      positiveInteger(options.maxQueuedMessagesPerUser, 100, 'maxQueuedMessagesPerUser'),
    );
    this.cfg = {
      connectionAttemptTimeoutMs: timerDelay(options.connectionAttemptTimeoutMs, 60_000, 'connectionAttemptTimeoutMs'),
      pairingTimeoutMs: timerDelay(options.pairingTimeoutMs, 180_000, 'pairingTimeoutMs'),
      reconnectJitterMs: timerDelay(options.reconnectJitterMs, 1_000, 'reconnectJitterMs', true),
      maxReconnectDelayMs: timerDelay(options.maxReconnectDelayMs, 60_000, 'maxReconnectDelayMs'),
      defaultReconnectDelayMs: nonNegativeInteger(options.defaultReconnectDelayMs, 3_000, 'defaultReconnectDelayMs'),
      stableConnectionMs: timerDelay(options.stableConnectionMs, 30_000, 'stableConnectionMs', true),
      maxReconnectAttempts: positiveInteger(options.maxReconnectAttempts, 20, 'maxReconnectAttempts'),
      pairingRetries: nonNegativeInteger(options.pairingRetries, 2, 'pairingRetries'),
      pairingRetryDelayMs: timerDelay(options.pairingRetryDelayMs, 2_000, 'pairingRetryDelayMs', true),
      pruneUnregisteredOnStart: options.pruneUnregisteredOnStart ?? true,
      cacheSignalKeys: options.cacheSignalKeys ?? true,
    };
  }

  // ───────────────────────────── public API ─────────────────────────────

  /** Restore every saved, fully paired session. Half-finished pairings are pruned. */
  async start(): Promise<void> {
    if (this.closing) throw new WaManagerError('CLOSED', 'The socket manager is closed.');
    const userIds = await this.options.authStore.listUsers();
    const toConnect: string[] = [];

    for (const userId of userIds) {
      if (this.cfg.pruneUnregisteredOnStart) {
        try {
          if (!(await isUserPairedInStore(this.options.authStore, userId))) {
            await this.options.authStore.deleteUser(userId);
            this.emit('user:pruned', { userId });
            continue;
          }
        } catch (error) {
          // e.g. wrong encryption key: never delete anything we could not read.
          this.emit('manager:error', { userId, error });
          continue;
        }
      }
      toConnect.push(userId);
    }

    const results = await Promise.allSettled(toConnect.map((userId) => this.connectUser(userId)));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.emit('manager:error', { userId: toConnect[index], error: result.reason });
      }
    });
  }

  async addUser(userId: string, options: AddUserOptions = {}): Promise<AddUserResult> {
    this.assertUserId(userId);
    const phone = options.phoneNumber === undefined ? undefined : this.normalizePhone(options.phoneNumber);
    const customCode = this.validateCustomCode(options.pairingCode);

    let socket: WASocket;
    try {
      socket = await this.connectUser(userId);
    } catch (error) {
      await this.discardIfUnpaired(userId);
      throw error;
    }
    if (!phone || this.isUserPaired(userId)) return { socket };
    const { socket: finalSocket, code } = await this.pairWithRetry(userId, phone, customCode);
    return { socket: finalSocket, pairingCode: code };
  }

  async connectUser(userId: string): Promise<WASocket> {
    return this.connectUserInternal(userId, false);
  }

  async requestPairingCode(userId: string, phoneNumber: string, customCode?: string): Promise<string> {
    this.assertUserId(userId);
    const phone = this.normalizePhone(phoneNumber);
    const custom = this.validateCustomCode(customCode);
    await this.connectUser(userId);
    if (this.isUserPaired(userId)) {
      throw new WaManagerError('ALREADY_PAIRED', `User "${userId}" is already paired.`);
    }
    return (await this.pairWithRetry(userId, phone, custom)).code;
  }

  getSocket(userId: string): WASocket | undefined {
    const entry = this.sockets.get(userId);
    return entry && !entry.closed ? entry.socket : undefined;
  }

  /** Only sockets whose connection is actually open. */
  getConnectedSocket(userId: string): WASocket | undefined {
    const entry = this.sockets.get(userId);
    return entry && !entry.closed && entry.hasConnected ? entry.socket : undefined;
  }

  getSockets(): ReadonlyMap<string, WASocket> {
    return new Map(
      [...this.sockets.entries()]
        .filter(([, entry]) => !entry.closed)
        .map(([userId, entry]) => [userId, entry.socket]),
    );
  }

  getUserIds(): string[] {
    return [...this.sockets.entries()].filter(([, e]) => !e.closed).map(([userId]) => userId);
  }

  getConnectedUserIds(): string[] {
    return [...this.sockets.entries()]
      .filter(([, e]) => !e.closed && e.hasConnected)
      .map(([userId]) => userId);
  }

  getStatus(userId: string): UserStatus {
    if (this.reconnectTimers.has(userId)) return 'reconnecting';
    const entry = this.sockets.get(userId);
    if (!entry || entry.closed) return 'offline';
    if (entry.hasConnected) return 'open';
    if (entry.pairingReady && !isPaired(entry.creds)) return 'awaiting-pairing';
    return 'connecting';
  }

  getStats(): ManagerStats {
    const stats: ManagerStats = { total: 0, open: 0, connecting: 0, awaitingPairing: 0, reconnecting: 0 };
    const ids = new Set<string>([...this.sockets.keys(), ...this.reconnectTimers.keys()]);
    for (const userId of ids) {
      stats.total += 1;
      switch (this.getStatus(userId)) {
        case 'open': stats.open += 1; break;
        case 'connecting': stats.connecting += 1; break;
        case 'awaiting-pairing': stats.awaitingPairing += 1; break;
        case 'reconnecting': stats.reconnecting += 1; break;
        default: break;
      }
    }
    return stats;
  }

  waitForConnection(userId: string, timeoutMs = 30_000): Promise<WASocket> {
    this.assertUserId(userId);
    timerDelay(timeoutMs, timeoutMs, 'timeoutMs', true);
    const current = this.getConnectedSocket(userId);
    if (current) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.events.off('user:connected', onConnected);
      };
      const onConnected = (payload: { userId: string; socket: WASocket }) => {
        if (payload.userId !== userId) return;
        cleanup();
        resolve(payload.socket);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new WaManagerError('TIMEOUT', `Timed out waiting for "${userId}" to connect.`));
      }, timeoutMs);
      this.events.on('user:connected', onConnected);
    });
  }

  /** Sends through a per-user queue that spaces messages out (rate-limit / ban protection). */
  async sendMessage(
    userId: string,
    jid: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ): Promise<Awaited<ReturnType<WASocket['sendMessage']>>> {
    this.assertUserId(userId);
    this.requireConnected(userId);
    return this.sendScheduler.run(userId, async () => {
      const socket = this.requireConnected(userId); // re-check: it may have dropped while queued
      return socket.sendMessage(jid, content, options);
    });
  }

  async disconnectUser(userId: string): Promise<void> {
    this.assertUserId(userId);
    await this.stopUser(userId, false);
  }

  async removeUser(userId: string): Promise<void> {
    this.assertUserId(userId);
    await this.stopUser(userId, true);
  }

  /** Unlinks the device on WhatsApp's side too, then deletes all saved auth. */
  async logoutUser(userId: string): Promise<void> {
    this.assertUserId(userId);
    const entry = this.sockets.get(userId);
    if (entry && !entry.closed) {
      try {
        await entry.socket.logout();
      } catch (error) {
        this.emit('manager:error', { userId, error });
      }
    }
    await this.stopUser(userId, true);
  }

  close(): Promise<void> {
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }

  // ───────────────────────────── connection ─────────────────────────────

  private async connectUserInternal(userId: string, reconnecting: boolean): Promise<WASocket> {
    this.assertUserId(userId);
    if (this.closing) throw new WaManagerError('CLOSED', 'The socket manager is closed.');

    // If this user is being logged out / pruned right now, wait for the cleanup to finish.
    const retiring = this.retiring.get(userId);
    if (retiring) await retiring.catch(() => undefined);
    if (this.closing) throw new WaManagerError('CLOSED', 'The socket manager is closed.');

    const existing = this.sockets.get(userId);
    if (existing && !existing.closed) return existing.socket;

    this.cancelReconnect(userId);
    if (existing) this.sockets.delete(userId);

    const currentPending = this.pending.get(userId);
    if (currentPending) return currentPending;

    const controller = new AbortController();
    const connection = this.openSocket(userId, reconnecting, controller.signal);
    this.connectionControllers.set(userId, controller);
    this.pending.set(userId, connection);
    try {
      return await connection;
    } finally {
      if (this.pending.get(userId) === connection) this.pending.delete(userId);
      if (this.connectionControllers.get(userId) === controller) {
        this.connectionControllers.delete(userId);
      }
    }
  }

  private async openSocket(
    userId: string,
    reconnecting: boolean,
    signal: AbortSignal,
  ): Promise<WASocket> {
    const releaseSlot = await this.connectionLimiter.acquire(signal);
    if (this.closing) {
      releaseSlot();
      throw new WaManagerError('CLOSED', 'The socket manager is closed.');
    }
    if (signal.aborted) {
      releaseSlot();
      throw new WaManagerError('NOT_AVAILABLE', 'Connection request was cancelled.');
    }
    this.emit('user:connecting', { userId, reconnecting });
    let session: SessionAuthStore | undefined;
    try {
      session = new SessionAuthStore(this.options.authStore);
      const state = await loadAuthState(session, userId);
      if (this.closing) throw new WaManagerError('CLOSED', 'The socket manager is closed.');
      if (signal.aborted) throw new WaManagerError('NOT_AVAILABLE', 'Connection request was cancelled.');

      // Always use our pino-pretty logger. If socketConfig.logger were reused here,
      // a raw Pino logger could bypass pino-pretty and print JSON to the terminal.
      // Pass the same logger to the Signal-key cache and socket.
      const socketLogger = logger.pino;

      const keys = this.cfg.cacheSignalKeys
        ? makeCacheableSignalKeyStore(state.keys, socketLogger)
        : state.keys;

      const socket = (this.options.socketFactory ?? makeWASocket)({
        ...this.options.socketConfig,
        browser: Browsers.ubuntu('Chrome'), // desktop browser identity for pairing codes
        logger: socketLogger, // intentionally override any socketConfig.logger
        auth: { creds: state.creds, keys },
      });

      logger.info(`Socket created${reconnecting ? ' for reconnect' : ''}`, userId);

      const entry: ManagedSocket = {
        socket,
        creds: state.creds,
        session,
        releaseConnectionSlot: releaseSlot,
        pairingReadyWaiters: new Set(),
        closed: false,
        hasConnected: false,
        pairingReady: false,
        wasPaired: isPaired(state.creds),
      };
      entry.connectionTimer = setTimeout(() => {
        this.fireDisconnect(
          userId,
          entry,
          new WaManagerError('CONNECTION_TIMEOUT', 'Connection attempt timed out.'),
        );
      }, this.cfg.connectionAttemptTimeoutMs);
      this.sockets.set(userId, entry);
      this.attachListeners(userId, entry);
      return socket;
    } catch (error) {
      if (session) {
        session.revoke();
        await session.drain();
      }
      releaseSlot();
      if (!(error instanceof WaManagerError && (error.code === 'CLOSED' || error.code === 'NOT_AVAILABLE'))) {
        logger.error('Failed to create socket', userId);
      }
      throw error;
    }
  }

  private attachListeners(userId: string, entry: ManagedSocket): void {
    const { socket } = entry;

    socket.ev.on('creds.update', () => {
      if (entry.closed) return; // a dead socket must never write
      if (!entry.wasPaired && isPaired(entry.creds)) {
        entry.wasPaired = true;
        clearTimeout(entry.pairingTimer);
        entry.pairingTimer = undefined;
        this.emit('user:paired', { userId, socket });
        logger.success('WhatsApp account paired', userId);
      }
      void entry.session
        .setMany(userId, [{ key: 'creds', value: serializeCreds(entry.creds) }])
        .catch((error: unknown) => this.emit('manager:error', { userId, error }));
      this.emit('baileys:creds.update', { userId, socket });
    });

    socket.ev.on('connection.update', (update) => {
      if (entry.closed) return;
      this.emit('baileys:connection.update', { userId, socket, update });

      const hasQr = typeof update.qr === 'string' && update.qr.length > 0;
      if (!entry.pairingReady && (update.connection === 'open' || hasQr)) {
        entry.pairingReady = true;
        for (const waiter of entry.pairingReadyWaiters) waiter.resolve();
        entry.pairingReadyWaiters.clear();
        logger.info('Pairing initialization is ready', userId);
      }

      // Unpaired socket reached the "enter the code" stage: swap the short handshake
      // timeout for the longer pairing window and free the handshake slot.
      if (hasQr && !entry.hasConnected && !isPaired(entry.creds) && !entry.pairingTimer) {
        clearTimeout(entry.connectionTimer);
        entry.connectionTimer = undefined;
        entry.releaseConnectionSlot();
        entry.pairingTimer = setTimeout(() => {
          this.fireDisconnect(
            userId,
            entry,
            new WaManagerError('PAIRING_TIMEOUT', 'Pairing was not completed in time.'),
          );
        }, this.cfg.pairingTimeoutMs);
      }

      if (update.connection === 'open' && !entry.hasConnected) {
        this.clearEntryTimers(entry);
        entry.releaseConnectionSlot();
        entry.hasConnected = true;
        entry.stableTimer = setTimeout(
          () => this.reconnectAttempts.delete(userId),
          this.cfg.stableConnectionMs,
        );
        logger.success('WhatsApp connection opened', userId);
        this.emit('user:connected', {
          userId,
          socket,
          reconnecting: (this.reconnectAttempts.get(userId) ?? 0) > 0,
        });
      } else if (update.connection === 'close') {
        logger.warn('WhatsApp connection closed', userId);
        this.fireDisconnect(userId, entry, update.lastDisconnect?.error);
      }
    });
  }

  private fireDisconnect(userId: string, entry: ManagedSocket, error: unknown): void {
    void this.track(this.handleDisconnect(userId, entry, error)).catch((failure: unknown) =>
      this.emit('manager:error', { userId, error: failure }),
    );
  }

  private async handleDisconnect(userId: string, entry: ManagedSocket, error: unknown): Promise<void> {
    if (this.sockets.get(userId) !== entry || entry.closed) return;
    entry.closed = true;
    this.sendScheduler.forget(userId);
    this.clearEntryTimers(entry);
    this.rejectPairingReadyWaiters(entry, error);
    entry.releaseConnectionSlot();

    const reason = this.getDisconnectReason(error);
    const paired = isPaired(entry.creds);
    this.emit('user:disconnected', { userId, socket: entry.socket, reason, error });

    // 1) Logged out on WhatsApp's side: end socket, delete auth, never reconnect.
    if (reason === DisconnectReason.loggedOut) {
      logger.warn('Session logged out; cleaning saved authentication', userId);
      await this.retire(userId, entry, error);
      this.emit('user:logged-out', { userId, reason });
      return;
    }

    // 2) Pairing never completed (code expired / abandoned / failed): clean up, do not loop.
    //    `restartRequired` is the normal step right after a successful pairing, so it is excluded.
    if (!paired && !entry.hasConnected && reason !== DisconnectReason.restartRequired) {
      logger.warn('Pairing did not complete; removing temporary session', userId);
      await this.retire(userId, entry, error);
      this.emit('user:pairing-failed', { userId, reason, error });
      return;
    }

    // 3) Normal disconnect: apply the reconnect policy.
    const reasonDelay = reason === undefined ? undefined : this.reconnectDelays[reason];
    if (this.options.reconnect === false || reasonDelay === null) {
      if (this.sockets.get(userId) === entry) this.sockets.delete(userId);
      await this.quiesce(entry, error);
      logger.warn('Reconnect disabled for disconnected session', userId);
      this.emit('user:reconnect-disabled', { userId, reason });
      return;
    }

    await this.quiesce(entry, error);
    if (this.closing || this.sockets.get(userId) !== entry) return; // removed meanwhile
    this.scheduleReconnect(userId, entry, reason, reasonDelay);
  }

  /** Let in-flight auth writes finish, block late ones, and end the socket. */
  private async quiesce(entry: ManagedSocket, error?: unknown): Promise<void> {
    await entry.session.drain();
    entry.session.revoke();
    this.cleanSocket(entry, error);
  }

  /** Full teardown + deletion of saved auth (logout / abandoned pairing). */
  private retire(userId: string, entry: ManagedSocket, error?: unknown): Promise<void> {
    if (this.sockets.get(userId) === entry) this.sockets.delete(userId);
    this.cancelReconnect(userId);
    entry.session.revoke(); // queued/late writes are dropped, so nothing can resurrect the session
    const task = (async () => {
      await entry.session.drain();
      this.cleanSocket(entry, error);
      await this.options.authStore.deleteUser(userId);
      this.reconnectAttempts.delete(userId);
      this.sendScheduler.forget(userId);
    })();
    this.retiring.set(userId, task);
    const clear = () => {
      if (this.retiring.get(userId) === task) this.retiring.delete(userId);
    };
    task.then(clear, clear);
    return task;
  }

  private scheduleReconnect(
    userId: string,
    entry: ManagedSocket | undefined,
    reason?: DisconnectReason,
    configuredDelay?: number | null,
  ): void {
    if (this.closing || this.options.reconnect === false) return;
    const attempt = this.reconnectAttempts.get(userId) ?? 0;

    if (attempt >= this.cfg.maxReconnectAttempts) {
      const current = this.sockets.get(userId);
      if (current?.closed) this.sockets.delete(userId);
      this.reconnectAttempts.delete(userId);
      logger.error(`Reconnect limit reached (${attempt} attempts)`, userId);
      this.emit('user:reconnect-failed', { userId, attempts: attempt, reason });
      return;
    }

    const baseDelay = configuredDelay ?? this.cfg.defaultReconnectDelayMs;
    const backoff = Math.min(baseDelay * 2 ** attempt, this.cfg.maxReconnectDelayMs);
    const jitter = Math.floor(Math.random() * (this.cfg.reconnectJitterMs + 1));
    const delay = Math.min(backoff + jitter, this.cfg.maxReconnectDelayMs);

    this.reconnectAttempts.set(userId, attempt + 1);
    const priorTimer = this.reconnectTimers.get(userId);
    if (priorTimer) clearTimeout(priorTimer);
    logger.warn(`Reconnecting in ${delay}ms (attempt ${attempt + 1})`, userId);
    this.emit('user:reconnecting', { userId, reason, delayMs: delay, attempt: attempt + 1 });

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(userId);
      if (entry && this.sockets.get(userId) === entry) this.sockets.delete(userId);
      void this.connectUserInternal(userId, true).catch((error: unknown) => {
        if (
          this.closing ||
          error instanceof WaManagerError && (error.code === 'CLOSED' || error.code === 'NOT_AVAILABLE')
        ) return;
        this.emit('manager:error', { userId, error });
        this.scheduleReconnect(userId, undefined);
      });
    }, delay);
    this.reconnectTimers.set(userId, timer);
  }

  private cancelReconnect(userId: string): void {
    const timer = this.reconnectTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(userId);
    }
  }

  // ─────────────────────────────── pairing ───────────────────────────────

  private async pairWithRetry(
    userId: string,
    phone: string,
    customCode?: string,
  ): Promise<{ socket: WASocket; code: string }> {
    if (this.pairingOperations.has(userId)) {
      throw new WaManagerError('PAIRING_IN_PROGRESS', `A pairing request is already in progress for user "${userId}".`);
    }
    const operation = { cancelled: false };
    this.pairingOperations.set(userId, operation);
    try {
      const attempts = 1 + this.cfg.pairingRetries;
      let lastError: unknown;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (operation.cancelled) {
          lastError = new WaManagerError('NOT_AVAILABLE', `Pairing was cancelled for user "${userId}".`);
          break;
        }
        try {
          const socket = await this.connectUser(userId); // fresh socket if the old one died
          if (this.isUserPaired(userId)) {
            throw new WaManagerError('ALREADY_PAIRED', `User "${userId}" is already paired.`);
          }
          const code = await this.requestPairingCodeForSocket(userId, socket, phone, customCode);
          return { socket, code };
        } catch (error) {
          lastError = error;
          if (this.closing || operation.cancelled || !this.isRetryablePairingError(error) || attempt === attempts) break;
          logger.warn(`Pairing attempt ${attempt} failed; retrying`, userId);
          await sleep(Math.min(this.cfg.pairingRetryDelayMs * attempt, MAX_TIMER_DELAY_MS));
        }
      }

      // Give up. Remove the half-created account so no zombie session/auth is left behind.
      const code = lastError instanceof WaManagerError ? lastError.code : undefined;
      const keep = operation.cancelled || code === 'PAIRING_IN_PROGRESS' || code === 'ALREADY_PAIRED' || code === 'CLOSED';
      if (!keep && !this.isUserPaired(userId)) {
        await this.stopUser(userId, true).catch((error: unknown) =>
          this.emit('manager:error', { userId, error }),
        );
        this.emit('user:pairing-failed', { userId, error: lastError });
      }
      if (operation.cancelled) logger.warn('Pairing cancelled', userId);
      else logger.error('Pairing failed', userId);
      throw lastError;
    } finally {
      if (this.pairingOperations.get(userId) === operation) this.pairingOperations.delete(userId);
    }
  }

  private async discardIfUnpaired(userId: string): Promise<void> {
    if (this.closing) return;
    try {
      if (!(await isUserPairedInStore(this.options.authStore, userId))) await this.stopUser(userId, true);
    } catch (error) {
      this.emit('manager:error', { userId, error });
    }
  }
  
  private isRetryablePairingError(error: unknown): boolean {
    if (!(error instanceof WaManagerError)) return true; // Baileys / network errors
    return (
      error.code === 'PAIRING_TIMEOUT' ||
      error.code === 'CONNECTION_TIMEOUT' ||
      error.code === 'NOT_AVAILABLE'
    );
  }

  private async requestPairingCodeForSocket(
    userId: string,
    socket: WASocket,
    phoneNumber: string,
    customCode?: string,
  ): Promise<string> {
    if (this.pairingUsers.has(userId)) {
      throw new WaManagerError('PAIRING_IN_PROGRESS', `A pairing request is already in progress for user "${userId}".`);
    }
    this.pairingUsers.add(userId);
    try {
      const release = await this.pairingLimiter.acquire();
      try {
        await this.waitForPairingReady(userId, socket);
        const code = await socket.requestPairingCode(phoneNumber, customCode);
        logger.pairing('Pairing code requested successfully', userId);
        this.emit('user:pairing-code', { userId, pairingCode: code });
        return code;
      } finally {
        release();
      }
    } finally {
      this.pairingUsers.delete(userId);
    }
  }

  private waitForPairingReady(userId: string, socket: WASocket): Promise<void> {
    const entry = this.sockets.get(userId);
    if (!entry || entry.socket !== socket || entry.closed) {
      return Promise.reject(new WaManagerError('NOT_AVAILABLE', `Socket for user "${userId}" is not available for pairing.`));
    }
    if (entry.pairingReady) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timer);
          entry.pairingReadyWaiters.delete(waiter);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          entry.pairingReadyWaiters.delete(waiter);
          reject(error);
        },
      };
      timer = setTimeout(() => {
        waiter.reject(new WaManagerError('PAIRING_TIMEOUT', `Timed out waiting for WhatsApp to initialize pairing for user "${userId}".`));
      }, this.cfg.connectionAttemptTimeoutMs);
      entry.pairingReadyWaiters.add(waiter);
    });
  }

  private rejectPairingReadyWaiters(entry: ManagedSocket, error: unknown): void {
    const reason = error instanceof Error
      ? error
      : new WaManagerError('NOT_AVAILABLE', 'Socket disconnected before WhatsApp initialized pairing.');
    for (const waiter of [...entry.pairingReadyWaiters]) waiter.reject(reason);
    entry.pairingReadyWaiters.clear();
  }

  // ───────────────────────────── stop / close ─────────────────────────────

  private stopUser(userId: string, deleteAuth: boolean): Promise<void> {
    const retiring = this.retiring.get(userId);
    if (retiring) {
      return retiring.catch(() => undefined).then(() => this.stopUser(userId, deleteAuth));
    }

    const task = Promise.resolve().then(() => this.stopUserInternal(userId, deleteAuth));
    this.retiring.set(userId, task);
    const clear = () => {
      if (this.retiring.get(userId) === task) this.retiring.delete(userId);
    };
    task.then(clear, clear);
    return task;
  }

  private async stopUserInternal(userId: string, deleteAuth: boolean): Promise<void> {
    const pairing = this.pairingOperations.get(userId);
    if (pairing) pairing.cancelled = true;
    this.connectionControllers.get(userId)?.abort();
    this.cancelReconnect(userId);
    this.sendScheduler.forget(userId);
    const pending = this.pending.get(userId);
    if (pending) await pending.catch(() => undefined);

    const entry = this.sockets.get(userId);
    this.sockets.delete(userId);
    if (entry) {
      const wasOpen = !entry.closed;
      entry.closed = true;
      this.clearEntryTimers(entry);
      this.rejectPairingReadyWaiters(entry, new WaManagerError('NOT_AVAILABLE', 'Socket was stopped before pairing completed.'));
      entry.releaseConnectionSlot();
      if (deleteAuth) entry.session.revoke();
      if (wasOpen) this.emit('user:disconnected', { userId, socket: entry.socket, manual: true });
      await this.quiesce(entry);
    }
    if (deleteAuth) {
      await this.options.authStore.deleteUser(userId);
      this.emit('user:removed', { userId });
    }
    this.reconnectAttempts.delete(userId);
  }

  private async doClose(): Promise<void> {
    this.closing = true;
    this.connectionLimiter.close();
    this.pairingLimiter.close();
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();

    await this.settleAll();
    await Promise.all([...this.sockets.keys()].map((userId) => this.stopUser(userId, false)));
    await this.settleAll(); // wait for disconnect handlers still touching the store
    await this.options.authStore.close();
  }

  private async settleAll(): Promise<void> {
    await Promise.allSettled([...this.pending.values(), ...this.inflight, ...this.retiring.values()]);
    if (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise);
    const done = () => {
      this.inflight.delete(promise);
    };
    promise.then(done, done);
    return promise;
  }

  // ─────────────────────────────── helpers ───────────────────────────────

  private clearEntryTimers(entry: ManagedSocket): void {
    clearTimeout(entry.connectionTimer);
    clearTimeout(entry.pairingTimer);
    clearTimeout(entry.stableTimer);
    entry.connectionTimer = undefined;
    entry.pairingTimer = undefined;
    entry.stableTimer = undefined;
  }

  private cleanSocket(entry: ManagedSocket, error?: unknown): void {
    try {
      entry.socket.end(error instanceof Error ? error : undefined);
    } catch (closeError) {
      this.emit('manager:error', { error: closeError });
    }
  }

  private isUserPaired(userId: string): boolean {
    const entry = this.sockets.get(userId);
    return entry !== undefined && isPaired(entry.creds);
  }

  private requireConnected(userId: string): WASocket {
    const socket = this.getConnectedSocket(userId);
    if (!socket) throw new WaManagerError('NOT_CONNECTED', `User "${userId}" is not connected.`);
    return socket;
  }

  private getDisconnectReason(error: unknown): DisconnectReason | undefined {
    if (error instanceof Boom) return error.output.statusCode as DisconnectReason;
    if (
      error !== null &&
      typeof error === 'object' &&
      'output' in error &&
      error.output !== null &&
      typeof error.output === 'object' &&
      'statusCode' in error.output &&
      typeof error.output.statusCode === 'number'
    ) {
      return error.output.statusCode as DisconnectReason;
    }
    return undefined;
  }

  private assertUserId(userId: string): void {
    if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
      throw new WaManagerError(
        'INVALID_ARGUMENT',
        'userId must be 1-128 chars: letters, digits, "_", ".", ":", "@", "-" (not starting with a symbol).',
      );
    }
  }

  private normalizePhone(phoneNumber: string): string {
    const digits = String(phoneNumber).replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15 || digits.startsWith('0')) {
      throw new WaManagerError(
        'INVALID_ARGUMENT',
        'phoneNumber must be an international number with country code (7-15 digits, no leading 0).',
      );
    }
    return digits;
  }

  private validateCustomCode(code: string | undefined): string | undefined {
    if (code === undefined) return undefined;
    if (!PAIRING_CODE_PATTERN.test(code)) {
      throw new WaManagerError('INVALID_ARGUMENT', 'A custom pairing code must be exactly 8 letters/digits.');
    }
    return code.toUpperCase();
  }

  /** Listener exceptions never break manager internals; they are reported as `manager:error`. */
  private emit(event: string, payload: unknown): void {
    try {
      this.events.emit(event, payload);
    } catch (error) {
      if (event === 'manager:error') return;
      this.emit('manager:error', { error, event });
    }
  }
}
