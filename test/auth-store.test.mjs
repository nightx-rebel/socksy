import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthStore, EncryptedAuthStore, SQLiteAuthStore } from '../dist/auth-store.js';

test('requires an encryption key when encrypted records are mandatory', () => {
  assert.throws(
    () => createAuthStore('sqlite::memory:', { requireEncrypted: true }),
    /requireEncrypted requires an encryptionKey/,
  );
});

test('encrypts auth values when an encryption key is configured', async () => {
  const store = createAuthStore('sqlite::memory:', {
    encryptionKey: 'a'.repeat(64),
    requireEncrypted: true,
  });

  await store.setMany('user-1', [{ key: 'secret', value: 'auth-value' }]);
  assert.equal(await store.get('user-1', 'secret'), 'auth-value');
  await store.close();
});

test('copies caller-provided encryption keys and binds ciphertext to its record', async () => {
  const key = Buffer.alloc(32, 7);
  const inner = new SQLiteAuthStore(':memory:');
  const store = new EncryptedAuthStore(inner, key, false);
  await store.setMany('user-1', [{ key: 'first', value: 'secret' }]);
  key.fill(0);

  assert.equal(await store.get('user-1', 'first'), 'secret');
  const ciphertext = await inner.get('user-1', 'first');
  await inner.setMany('user-1', [{ key: 'second', value: ciphertext }]);
  await assert.rejects(store.get('user-1', 'second'));
  await store.close();
});
