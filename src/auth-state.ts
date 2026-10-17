import {
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys';
import type { AuthStore } from './auth-store.js';

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object';

/** JSON with binary support. Bytes are stored as base64 (much smaller than number arrays). */
export function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current instanceof Uint8Array) {
      return {
        __waB64: Buffer.from(current.buffer, current.byteOffset, current.byteLength).toString('base64'),
        __waBuffer: Buffer.isBuffer(current),
      };
    }
    // Buffer#toJSON runs before the replacer, so Buffers arrive in this shape.
    if (isRecord(current) && current.type === 'Buffer' && Array.isArray(current.data)) {
      return { __waB64: Buffer.from(current.data as number[]).toString('base64'), __waBuffer: true };
    }
    return current;
  });
}

/** Reads the new format and the older formats (number arrays, Baileys BufferJSON). */
export function deserialize<T>(value: string): T {
  return JSON.parse(value, (_key, current: unknown) => {
    if (!isRecord(current)) return current;
    if (typeof current.__waB64 === 'string') {
      const buffer = Buffer.from(current.__waB64, 'base64');
      return current.__waBuffer ? buffer : new Uint8Array(buffer);
    }
    if (Array.isArray(current.__waBytes)) {
      const bytes = Uint8Array.from(current.__waBytes as number[]);
      return current.__waBuffer ? Buffer.from(bytes) : bytes;
    }
    if (current.type === 'Buffer' && typeof current.data === 'string') {
      return Buffer.from(current.data, 'base64');
    }
    if (current.type === 'Buffer' && Array.isArray(current.data)) {
      return Buffer.from(current.data as number[]);
    }
    return current;
  }) as T;
}

/**
 * True once the account is really linked. `registered` alone is not reliable for
 * multi-device pairing, so `me + account` (set at pair-success) also counts.
 */
export function isPaired(creds: Partial<AuthenticationCreds>): boolean {
  return creds.registered === true || Boolean(creds.me?.id && creds.account);
}

export async function readCreds(
  store: AuthStore,
  userId: string,
): Promise<AuthenticationCreds | undefined> {
  const saved = await store.get(userId, 'creds');
  return saved ? deserialize<AuthenticationCreds>(saved) : undefined;
}

export async function isUserPairedInStore(store: AuthStore, userId: string): Promise<boolean> {
  const creds = await readCreds(store, userId);
  return creds !== undefined && isPaired(creds);
}

export async function loadAuthState(
  store: AuthStore,
  userId: string,
): Promise<AuthenticationState> {
  const saved = await readCreds(store, userId);
  const creds = saved ?? initAuthCreds();
  if (!saved) await store.setMany(userId, [{ key: 'creds', value: serialize(creds) }]);

  const keys: SignalKeyStore = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const recordKeys = ids.map((id) => `key:${type}:${id}`);
      const stored = store.getMany
        ? await store.getMany(userId, recordKeys)
        : new Map(
            (
              await Promise.all(
                recordKeys.map(async (key) => [key, await store.get(userId, key)] as const),
              )
            ).filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
          );
      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      ids.forEach((id, index) => {
        const raw = stored.get(recordKeys[index]!);
        if (raw === undefined) return;
        let value = deserialize<SignalDataTypeMap[T]>(raw);
        // Baileys expects a protobuf instance here (same as useMultiFileAuthState).
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(
            value as object,
          ) as unknown as SignalDataTypeMap[T];
        }
        result[id] = value;
      });
      return result;
    },
    set: async (data: SignalDataSet) => {
      const records = Object.entries(data as Record<string, Record<string, unknown> | undefined>)
        .flatMap(([type, values]) =>
          Object.entries(values ?? {}).map(([id, value]) => ({
            key: `key:${type}:${id}`,
            value: value === null || value === undefined ? null : serialize(value),
          })),
        );
      if (records.length > 0) await store.setMany(userId, records);
    },
    clear: async () => {
      await store.deleteKeys(userId, 'key:');
    },
  };

  return { creds, keys };
}

export function serializeCreds(creds: AuthenticationCreds): string {
  return serialize(creds);
}
