export { createAuthStore, PostgresAuthStore, SQLiteAuthStore } from './auth-store.js';
export type { AuthRecord, AuthStore } from './auth-store.js';
export {
  MultiSocketManager,
  type AddUserOptions,
  type AddUserResult,
  type MultiSocketManagerOptions,
  type SocketConfig,
  type SocketFactory,
} from './socket-manager.js';
export { DisconnectReason } from '@whiskeysockets/baileys';
export type { WASocket } from '@whiskeysockets/baileys';