import assert from 'node:assert/strict';
import test from 'node:test';
import { isOwnerMessage } from '../src/authorization.js';

test('owner checks reject unrelated senders and match configured account IDs', () => {
  assert.equal(isOwnerMessage(false, '15550000002@s.whatsapp.net', ['15550000001']), false);
  assert.equal(isOwnerMessage(false, '15550000001:4@s.whatsapp.net', ['15550000001']), true);
  assert.equal(isOwnerMessage(true, '15550000002@s.whatsapp.net', []), true);
});