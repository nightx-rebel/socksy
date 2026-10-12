import makeWASocket, { DisconnectReason, type WASocket } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { EventEmitter } from 'node:events';
import type { AuthStore } from './auth-store.js';
import { loadAuthState, serializeCreds } from './auth-state.js';

export type SocketConfig = Omit<Parameters<typeof makeWASocket>[0], 'auth'>;
export type SocketFactory = (config: Parameters<typeof makeWASocket>[0]) => WASocket;

export type MultiSocketManagerOptions = {
  authStore: AuthStore;
  socketConfig?: SocketConfig;
  socketFactory?: SocketFactory;
  reconnect?: boolean;
  defaultReconnectDelayMs?: number;
  reconnectDelays?: Partial<Record<DisconnectReason, number | null>>;
  maxConcurrentConnections?: number;
  maxConcurrentPairings?: number;
  connectionAttemptTimeoutMs?: number;
  reconnectJitterMs?: number;
  maxReconnectDelayMs?: number;
};

export type AddUserOptions = {
  phoneNumber?: string;
  pairingCode?: string;
};

export type AddUserResult = {
  socket: WASocket;
  pairingCode?: string;
};

type ManagedSocket = {
  socket: WASocket;
  connectionTimer: NodeJS.Timeout;
  releaseConnectionSlot: () => void;
  pairingReadyWaiters: Set<{ resolve: () => void; reject: (error: Error) => void }>;
  closed: boolean;
  hasConnected: boolean;
  pairingReady: boolean;
};

class AsyncLimiter {
  private active = 0;
  private closed = false;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(): Promise<() => void> {
    if (this.closed) return Promise.reject(new Error('The socket manager is closed.'));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    return new Promise((resolve, reject) => this.queue.push({ resolve, reject }));
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.queue.splice(0)) {
      waiter.reject(new Error('The socket manager is closed.'));
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
        this.active += 1;
        next.resolve(this.createRelease());
      }
    };
  }
}

const defaultReconnectDelays: Partial<Record<DisconnectReason, number | null>> = {
  [DisconnectReason.connectionClosed]: 1_000,
  [DisconnectReason.connectionLost]: 2_000,
  [DisconnectReason.connectionReplaced]: 5_000,
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
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly pairingUsers = new Set<string>();
  private readonly reconnectDelays: Partial<Record<DisconnectReason, number | null>>;
  private readonly connectionLimiter: AsyncLimiter;
  private readonly pairingLimiter: AsyncLimiter;
  private closing = false;

  constructor(private readonly options: MultiSocketManagerOptions) {
    this.reconnectDelays = {
      ...defaultReconnectDelays,
      ...options.reconnectDelays,
    };
    this.connectionLimiter = new AsyncLimiter(
      this.positiveInteger(options.maxConcurrentConnections, 20, 'maxConcurrentConnections'),
    );
    this.pairingLimiter = new AsyncLimiter(
      this.positiveInteger(options.maxConcurrentPairings, 5, 'maxConcurrentPairings'),
    );
    this.positiveInteger(options.connectionAttemptTimeoutMs, 60_000, 'connectionAttemptTimeoutMs');
    this.nonNegativeInteger(options.reconnectJitterMs, 1_000, 'reconnectJitterMs');
    this.positiveInteger(options.maxReconnectDelayMs, 60_000, 'maxReconnectDelayMs');
  }

  async start(): Promise<void> {
    if (this.closing) throw new Error('The socket manager is closed.');
    const userIds = await this.options.authStore.listUsers();
    const results = await Promise.allSettled(userIds.map((userId) => this.connectUser(userId)));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.emit('manager:error', { userId: userIds[index], error: result.reason });
      }
    });
  }

  async addUser(userId: string, options: AddUserOptions = {}): Promise<AddUserResult> {
    this.assertUserId(userId);
    const socket = await this.connectUser(userId);
    if (!options.phoneNumber || socket.authState.creds.registered) return { socket };

    const pairingCode = await this.requestPairingCodeForSocket(
      userId,
      socket,
      options.phoneNumber,
      options.pairingCode,
    );
    return { socket, pairingCode };
  }

  async connectUser(userId: string): Promise<WASocket> {
    return this.connectUserInternal(userId, false);
  }

  private async connectUserInternal(userId: string, reconnecting: boolean): Promise<WASocket> {
    this.assertUserId(userId);
    if (this.closing) throw new Error('The socket manager is closed.');
    const existing = this.sockets.get(userId);
    if (existing && !existing.closed) return existing.socket;

    const reconnectTimer = this.reconnectTimers.get(userId);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      this.reconnectTimers.delete(userId);
    }
    if (existing) this.sockets.delete(userId);

    const currentPending = this.pending.get(userId);
    if (currentPending) return currentPending;

    const connection = this.openSocket(userId, reconnecting);
    this.pending.set(userId, connection);
    try {
      return await connection;
    } finally {
      if (this.pending.get(userId) === connection) this.pending.delete(userId);
    }
  }

  async requestPairingCode(userId: string, phoneNumber: string, customCode?: string): Promise<string> {
    const socket = await this.connectUser(userId);
    if (socket.authState.creds.registered) throw new Error(`User "${userId}" is already paired.`);
    return this.requestPairingCodeForSocket(userId, socket, phoneNumber, customCode);
  }

  getSocket(userId: string): WASocket | undefined {
    const entry = this.sockets.get(userId);
    return entry && !entry.closed ? entry.socket : undefined;
  }

  getSockets(): ReadonlyMap<string, WASocket> {
    return new Map(
      [...this.sockets.entries()]
        .filter(([, entry]) => !entry.closed)
        .map(([userId, entry]) => [userId, entry.socket]),
    );
  }

  getUserIds(): string[] {
    return [...this.sockets.entries()]
      .filter(([, entry]) => !entry.closed)
      .map(([userId]) => userId);
  }

  async disconnectUser(userId: string): Promise<void> {
    await this.stopUser(userId, false);
  }

  async removeUser(userId: string): Promise<void> {
    await this.stopUser(userId, true);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.connectionLimiter.close();
    this.pairingLimiter.close();
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.sockets.keys()].map((userId) => this.stopUser(userId, false)));
    await this.options.authStore.close();
  }

  private async openSocket(userId: string, reconnecting: boolean): Promise<WASocket> {
    const releaseConnectionSlot = await this.connectionLimiter.acquire();
    if (this.closing) {
      releaseConnectionSlot();
      throw new Error('The socket manager is closed.');
    }
    this.emit('user:connecting', { userId, reconnecting });
    try {
      const state = await loadAuthState(this.options.authStore, userId);
      const socket = (this.options.socketFactory ?? makeWASocket)({
        ...this.options.socketConfig,
        auth: state,
      });
      const entry: ManagedSocket = {
        socket,
        connectionTimer: setTimeout(() => {
          void this.handleDisconnect(userId, entry, new Error('Connection attempt timed out.'));
        }, this.options.connectionAttemptTimeoutMs ?? 60_000),
        releaseConnectionSlot,
        pairingReadyWaiters: new Set(),
        closed: false,
        hasConnected: false,
        pairingReady: false,
      };
      this.sockets.set(userId, entry);

      socket.ev.on('creds.update', () => {
        void this.options.authStore
          .setMany(userId, [{ key: 'creds', value: serializeCreds(state.creds) }])
          .catch((error: unknown) => this.emit('manager:error', { userId, error }));
        this.emit('baileys:creds.update', { userId, socket });
      });

      socket.ev.on('connection.update', (update) => {
        this.emit('baileys:connection.update', { userId, socket, update });
        if (
          !entry.pairingReady &&
          (update.connection === 'open' || (typeof update.qr === 'string' && update.qr.length > 0))
        ) {
          entry.pairingReady = true;
          for (const waiter of entry.pairingReadyWaiters) waiter.resolve();
          entry.pairingReadyWaiters.clear();
        }
        if (update.connection === 'open' && !entry.closed && !entry.hasConnected) {
          clearTimeout(entry.connectionTimer);
          entry.releaseConnectionSlot();
          entry.hasConnected = true;
          this.reconnectAttempts.delete(userId);
          this.emit('user:connected', { userId, socket, reconnecting });
        } else if (update.connection === 'close') {
          void this.handleDisconnect(userId, entry, update.lastDisconnect?.error).catch(
            (error: unknown) => this.emit('manager:error', { userId, error }),
          );
        }
      });

      return socket;
    } catch (error) {
      releaseConnectionSlot();
      throw error;
    }
  }

  private async handleDisconnect(
    userId: string,
    entry: ManagedSocket,
    error: unknown,
  ): Promise<void> {
    if (this.sockets.get(userId) !== entry || entry.closed) return;
    entry.closed = true;
    this.rejectPairingReadyWaiters(entry, error);
    clearTimeout(entry.connectionTimer);
    entry.releaseConnectionSlot();
    const reason = this.getDisconnectReason(error);
    this.emit('user:disconnected', { userId, socket: entry.socket, reason, error });

    if (reason === DisconnectReason.loggedOut) {
      this.sockets.delete(userId);
      await this.cleanSocket(entry, error);
      await this.options.authStore.deleteUser(userId);
      this.reconnectAttempts.delete(userId);
      this.emit('user:logged-out', { userId, reason });
      return;
    }

    const reasonDelay = reason === undefined ? undefined : this.reconnectDelays[reason];
    if (this.options.reconnect === false || reasonDelay === null) {
      this.sockets.delete(userId);
      await this.cleanSocket(entry, error);
      return;
    }

    await this.cleanSocket(entry, error);
    this.scheduleReconnect(userId, entry, reason, reasonDelay);
  }

  private scheduleReconnect(
    userId: string,
    entry: ManagedSocket | undefined,
    reason?: DisconnectReason,
    configuredDelay?: number | null,
  ): void {
    if (this.closing || this.options.reconnect === false) return;
    const attempt = this.reconnectAttempts.get(userId) ?? 0;
    const baseDelay = configuredDelay ?? this.options.defaultReconnectDelayMs ?? 3_000;
    const maximumDelay = this.options.maxReconnectDelayMs ?? 60_000;
    const backoff = Math.min(baseDelay * 2 ** attempt, maximumDelay);
    const jitter = Math.floor(Math.random() * ((this.options.reconnectJitterMs ?? 1_000) + 1));
    const delay = Math.min(backoff + jitter, maximumDelay);
    this.reconnectAttempts.set(userId, attempt + 1);
    const priorTimer = this.reconnectTimers.get(userId);
    if (priorTimer) clearTimeout(priorTimer);
    this.emit('user:reconnecting', { userId, reason, delayMs: delay });
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(userId);
      if (entry && this.sockets.get(userId) === entry) this.sockets.delete(userId);
      void this.connectUserInternal(userId, true).catch((error: unknown) => {
        this.emit('manager:error', { userId, error });
        this.scheduleReconnect(userId, undefined);
      });
    }, delay);
    this.reconnectTimers.set(userId, timer);
  }

  private async requestPairingCodeForSocket(
    userId: string,
    socket: WASocket,
    phoneNumber: string,
    customCode?: string,
  ): Promise<string> {
    if (this.pairingUsers.has(userId)) {
      throw new Error(`A pairing request is already in progress for user "${userId}".`);
    }
    const normalizedPhoneNumber = phoneNumber.replace(/\D/g, '');
    if (!normalizedPhoneNumber) throw new Error('phoneNumber must contain at least one digit.');
    this.pairingUsers.add(userId);
    try {
      const release = await this.pairingLimiter.acquire();
      try {
        await this.waitForPairingReady(userId, socket);
        const code = await socket.requestPairingCode(normalizedPhoneNumber, customCode);
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
      return Promise.reject(new Error(`Socket for user "${userId}" is not available for pairing.`));
    }
    if (entry.pairingReady) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const waiter = {
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
        waiter.reject(new Error(`Timed out waiting for WhatsApp to initialize pairing for user "${userId}".`));
      }, this.options.connectionAttemptTimeoutMs ?? 60_000);
      entry.pairingReadyWaiters.add(waiter);
    });
  }

  private rejectPairingReadyWaiters(entry: ManagedSocket, error: unknown): void {
    const reason = error instanceof Error
      ? error
      : new Error('Socket disconnected before WhatsApp initialized pairing.');
    for (const waiter of entry.pairingReadyWaiters) waiter.reject(reason);
    entry.pairingReadyWaiters.clear();
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

  private async stopUser(userId: string, deleteAuth: boolean): Promise<void> {
    const reconnectTimer = this.reconnectTimers.get(userId);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      this.reconnectTimers.delete(userId);
    }
    const pending = this.pending.get(userId);
    if (pending) await pending.catch(() => undefined);
    const entry = this.sockets.get(userId);
    this.sockets.delete(userId);
    if (entry) {
      const wasOpen = !entry.closed;
      entry.closed = true;
      this.rejectPairingReadyWaiters(entry, new Error('Socket was stopped before pairing completed.'));
      clearTimeout(entry.connectionTimer);
      entry.releaseConnectionSlot();
      if (wasOpen) {
        this.emit('user:disconnected', { userId, socket: entry.socket, manual: true });
      }
      await this.cleanSocket(entry);
    }
    if (deleteAuth) {
      await this.options.authStore.deleteUser(userId);
      this.emit('user:removed', { userId });
    }
    this.reconnectAttempts.delete(userId);
  }

  private async cleanSocket(entry: ManagedSocket, error?: unknown): Promise<void> {
    try {
      await entry.socket.end(error instanceof Error ? error : undefined);
    } catch (closeError) {
      this.emit('manager:error', { error: closeError });
    }
  }

  private assertUserId(userId: string): void {
    if (!userId.trim()) throw new Error('userId must be a non-empty string.');
  }

  private positiveInteger(value: number | undefined, fallback: number, name: string): number {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result <= 0) {
      throw new Error(`${name} must be a positive safe integer.`);
    }
    return result;
  }

  private nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 0) {
      throw new Error(`${name} must be a non-negative safe integer.`);
    }
    return result;
  }

  private emit(event: string, payload: unknown): void {
    this.events.emit(event, payload);
  }
}
