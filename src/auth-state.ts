import {
  initAuthCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys';
import type { AuthStore } from './auth-store.js';

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current instanceof Uint8Array) {
      return {
        __waBytes: Array.from(current),
        __waBuffer: Buffer.isBuffer(current),
      };
    }
    if (
      current !== null &&
      typeof current === 'object' &&
      'type' in current &&
      current.type === 'Buffer' &&
      'data' in current &&
      Array.isArray(current.data)
    ) {
      return { __waBytes: current.data, __waBuffer: true };
    }
    return current;
  });
}

function deserialize<T>(value: string): T {
  return JSON.parse(value, (_key, current: unknown) => {
    if (
      current !== null &&
      typeof current === 'object' &&
      '__waBytes' in current &&
      Array.isArray(current.__waBytes)
    ) {
      const bytes = Uint8Array.from(current.__waBytes as number[]);
      return (current as { __waBuffer?: boolean }).__waBuffer ? Buffer.from(bytes) : bytes;
    }
    return current;
  }) as T;
}

export async function loadAuthState(
  store: AuthStore,
  userId: string,
): Promise<AuthenticationState> {
  const savedCreds = await store.get(userId, 'creds');
  const creds = savedCreds ? deserialize<AuthenticationState['creds']>(savedCreds) : initAuthCreds();
  if (!savedCreds) await store.setMany(userId, [{ key: 'creds', value: serialize(creds) }]);

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
      const result: Record<string, SignalDataTypeMap[T]> = {};
      ids.forEach((id, index) => {
        const value = stored.get(recordKeys[index]!);
        if (value !== undefined) result[id] = deserialize<SignalDataTypeMap[T]>(value);
      });
      return result;
    },
    set: async (data: SignalDataSet) => {
      const records = Object.entries(data).flatMap(([type, values]) =>
        Object.entries(values ?? {}).map(([id, value]) => ({
          key: `key:${type}:${id}`,
          value: value === null ? null : serialize(value),
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

export function serializeCreds(creds: AuthenticationState['creds']): string {
  return serialize(creds);
}