export {
  createAuthStore,
  PostgresAuthStore,
  SQLiteAuthStore,
  type CreateAuthStoreOptions,
} from './auth-store.js';
export type { AuthRecord, AuthStore } from './auth-store.js';
export { isPaired } from './auth-state.js';
export { WaManagerError, type WaManagerErrorCode } from './errors.js';
export {
  MultiSocketManager,
  type AddUserOptions,
  type AddUserResult,
  type ManagerStats,
  type MultiSocketManagerOptions,
  type SocketConfig,
  type SocketFactory,
  type UserStatus,
} from './socket-manager.js';
export { DisconnectReason } from '@whiskeysockets/baileys';
export type { WASocket } from '@whiskeysockets/baileys';
