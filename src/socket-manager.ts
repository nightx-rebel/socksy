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
  state: Awaited<ReturnType<typeof loadAuthState>>;
  generation: number;
  reconnectTimer?: NodeJS.Timeout;
  closed: boolean;
  hasConnected: boolean;
};

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
  private readonly reconnectDelays: Partial<Record<DisconnectReason, number | null>>;
  private generation = 0;
  private closing = false;

  constructor(private readonly options: MultiSocketManagerOptions) {
    this.reconnectDelays = {
      ...defaultReconnectDelays,
      ...options.reconnectDelays,
    };
  }

  async start(): Promise<void> {
    this.closing = false;
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

    const pairingCode = await socket.requestPairingCode(
      options.phoneNumber.replace(/[^0-9]/g, ''),
      options.pairingCode,
    );
    this.emit('user:pairing-code', { userId, pairingCode });
    return { socket, pairingCode };
  }

  async connectUser(userId: string): Promise<WASocket> {
    this.assertUserId(userId);
    if (this.closing) throw new Error('The socket manager is closed.');
    const existing = this.sockets.get(userId);
    if (existing && !existing.closed) return existing.socket;
    if (existing?.reconnectTimer) clearTimeout(existing.reconnectTimer);
    if (existing) this.sockets.delete(userId);

    const currentPending = this.pending.get(userId);
    if (currentPending) return currentPending;

    const connection = this.openSocket(userId, false);
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
    const code = await socket.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''), customCode);
    this.emit('user:pairing-code', { userId, pairingCode: code });
    return code;
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
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.sockets.keys()].map((userId) => this.stopUser(userId, false)));
    await this.options.authStore.close();
  }

  private async openSocket(userId: string, reconnecting: boolean): Promise<WASocket> {
    this.emit('user:connecting', { userId, reconnecting });
    const state = await loadAuthState(this.options.authStore, userId);
    const socket = (this.options.socketFactory ?? makeWASocket)({
      ...this.options.socketConfig,
      auth: state,
    });
    const entry: ManagedSocket = {
      socket,
      state,
      generation: ++this.generation,
      closed: false,
      hasConnected: false,
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
      if (update.connection === 'open') {
        entry.hasConnected = true;
        this.emit('user:connected', { userId, socket, reconnecting });
      } else if (update.connection === 'close') {
        void this.handleDisconnect(userId, entry, update.lastDisconnect?.error);
      }
    });

    return socket;
  }

  private async handleDisconnect(
    userId: string,
    entry: ManagedSocket,
    error: unknown,
  ): Promise<void> {
    if (this.sockets.get(userId) !== entry || entry.closed) return;
    entry.closed = true;
    const reason = this.getDisconnectReason(error);
    this.emit('user:disconnected', { userId, socket: entry.socket, reason, error });

    if (reason === DisconnectReason.loggedOut) {
      this.sockets.delete(userId);
      await this.cleanSocket(entry, error, true);
      await this.options.authStore.deleteUser(userId);
      this.emit('user:logged-out', { userId, reason });
      return;
    }

    const reasonDelay = reason === undefined ? undefined : this.reconnectDelays[reason];
    const delay = reasonDelay ?? this.options.defaultReconnectDelayMs ?? 3_000;
    if (this.options.reconnect === false || reasonDelay === null) {
      this.sockets.delete(userId);
      await this.cleanSocket(entry, error);
      return;
    }

    this.emit('user:reconnecting', { userId, reason, delayMs: delay });
    entry.reconnectTimer = setTimeout(() => {
      if (this.sockets.get(userId) !== entry || this.closing) return;
      this.sockets.delete(userId);
      void this.openSocket(userId, true).catch((reconnectError: unknown) => {
        this.emit('manager:error', { userId, error: reconnectError });
        const current = this.sockets.get(userId);
        if (current === entry) this.sockets.delete(userId);
      });
    }, delay);
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
    const pending = this.pending.get(userId);
    if (pending) await pending.catch(() => undefined);
    const entry = this.sockets.get(userId);
    if (entry?.reconnectTimer) clearTimeout(entry.reconnectTimer);
    this.sockets.delete(userId);
    if (entry) {
      const wasOpen = !entry.closed;
      entry.closed = true;
      if (wasOpen) {
        this.emit('user:disconnected', { userId, socket: entry.socket, manual: true });
      }
      await this.cleanSocket(entry, undefined, deleteAuth);
    }
    if (deleteAuth) {
      await this.options.authStore.deleteUser(userId);
      this.emit('user:removed', { userId });
    }
  }

  private async cleanSocket(
    entry: ManagedSocket,
    error?: unknown,
    clearAuthKeys = false,
  ): Promise<void> {
    if (clearAuthKeys) {
      try {
        await entry.state.keys.clear?.();
      } catch (clearError) {
        this.emit('manager:error', { error: clearError });
      }
    }
    try {
      await entry.socket.end(error instanceof Error ? error : undefined);
    } catch (closeError) {
      this.emit('manager:error', { error: closeError });
    }
  }

  private assertUserId(userId: string): void {
    if (!userId.trim()) throw new Error('userId must be a non-empty string.');
  }

  private emit(event: string, payload: unknown): void {
    this.events.emit(event, payload);
  }
}