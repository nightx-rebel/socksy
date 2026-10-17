import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthStore } from '../dist/auth-store.js';

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
