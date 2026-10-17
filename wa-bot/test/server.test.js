import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import request from 'supertest';
import { assertSecureHost, createServer } from '../src/server.js';

const token = 'test-token-value';

function makeApp(addUser = async () => ({ pairingCode: 'ABCD-EFGH' }), apiKey = token, initialUserIds = []) {
  const calls = [];
  const manager = {
    events: new EventEmitter(),
    addUser: async (...args) => {
      calls.push(args);
      return addUser(...args);
    },
    getUserIds: () => initialUserIds,
    getStatus: () => 'offline',
    getStats: () => ({ total: 0, open: 0, connecting: 0, awaitingPairing: 0, reconnecting: 0 }),
    getConnectedSocket: () => undefined,
    sendMessage: async () => {
      throw new Error('private internal detail');
    },
  };
  return { app: createServer({ manager, apiKey, pairingWindowMs: 180_000 }), calls, manager };
}

test('pair endpoint requires an API token', async () => {
  const { app, calls } = makeApp();
  const response = await request(app).get('/pair').query({ number: '+1 555 123 4567' });

  assert.equal(response.status, 401);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(calls.length, 0);
});

test('pair endpoint accepts documented bearer auth and number parameter', async () => {
  const { app, calls } = makeApp();
  const response = await request(app)
    .get('/pair')
    .set('Authorization', `Bearer ${token}`)
    .query({ number: '+1 (555) 123-4567' });

  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.pairingCode, 'ABCD-EFGH');
  assert.equal(response.body.userId, 'user-15551234567');
  assert.deepEqual(calls, [['user-15551234567', { phoneNumber: '+1 (555) 123-4567' }]]);
});

test('pair endpoint accepts the x-api-key header', async () => {
  const { app, calls } = makeApp();
  const response = await request(app)
    .get('/pair')
    .set('x-api-key', token)
    .query({ phone: '+1 (555) 123-4567' });

  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(calls.length, 1);
});

test('health endpoint is public and does not expose account details', async () => {
  const { app } = makeApp();
  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.stats, {
    total: 0,
    open: 0,
    connecting: 0,
    awaitingPairing: 0,
    reconnecting: 0,
  });
});

test('keeps accounts in the list after their connection closes', async () => {
  const { app, manager } = makeApp();
  manager.events.emit('user:connecting', { userId: 'user-1' });
  manager.events.emit('user:disconnected', { userId: 'user-1' });

  const response = await request(app).get('/users').set('x-api-key', token);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.users, [{ userId: 'user-1', status: 'offline' }]);
});

test('includes already-managed users when the server is created', async () => {
  const { app } = makeApp(undefined, token, ['user-existing']);
  const response = await request(app).get('/users').set('x-api-key', token);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.users, [{ userId: 'user-existing', status: 'offline' }]);
});

test('requires an API key when binding outside loopback', () => {
  assert.throws(() => assertSecureHost('0.0.0.0'), /API_KEY is required/);
  assert.doesNotThrow(() => assertSecureHost('127.0.0.1'));
  assert.doesNotThrow(() => assertSecureHost('0.0.0.0', token));
});

test('does not expose unexpected internal error details', async () => {
  const { app } = makeApp();
  const response = await request(app)
    .post('/send')
    .set('x-api-key', token)
    .send({ userId: 'user-1', to: '15551234567', text: 'hello' });

  assert.equal(response.status, 500);
  assert.equal(response.body.message, 'Internal server error.');
  assert.doesNotMatch(JSON.stringify(response.body), /private internal detail/);
});
