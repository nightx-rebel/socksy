import assert from 'node:assert/strict';
import test from 'node:test';
import { SQLiteAuthStore } from '../dist/auth-store.js';
import { loadAuthState } from '../dist/auth-state.js';

test('persists credentials and binary Signal keys, then clears keys', async () => {
  const store = new SQLiteAuthStore(':memory:');
  const firstState = await loadAuthState(store, 'user-1');
  await firstState.keys.set({
    'identity-key': { identity: new Uint8Array([1, 2, 3]) },
    tctoken: { token: { token: Buffer.from([4, 5]), timestamp: 'now' } },
  });

  const restored = await loadAuthState(store, 'user-1');
  assert.deepEqual(await restored.keys.get('identity-key', ['identity']), {
    identity: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual(await restored.keys.get('tctoken', ['token']), {
    token: { token: Buffer.from([4, 5]), timestamp: 'now' },
  });

  await restored.keys.clear();
  assert.deepEqual(await restored.keys.get('identity-key', ['identity']), {});
  assert.deepEqual(await store.listUsers(), ['user-1']);
  await store.deleteUser('user-1');
  assert.deepEqual(await store.listUsers(), []);
  await store.close();
});