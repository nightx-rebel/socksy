import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createBotApp } from '../src/app.js';

const token = 'test-token-value';

function makeApp(addUser = async () => ({ pairingCode: 'ABCD-EFGH' })) {
  const calls = [];
  const manager = {
    addUser: async (...args) => {
      calls.push(args);
      return addUser(...args);
    },
  };
  return { app: createBotApp({ manager, apiToken: token, logger: { error() {} } }), calls };
}

test('pair endpoint requires a bearer token', async () => {
  const { app, calls } = makeApp();
  const response = await request(app).get('/pair').query({ number: '+1 555 123 4567' });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test('pair endpoint normalizes the number and returns the pairing code', async () => {
  const { app, calls } = makeApp();
  const response = await request(app)
    .get('/pair')
    .set('Authorization', `Bearer ${token}`)
    .query({ number: '+1 (555) 123-4567' });

  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.body, { userId: '15551234567', pairingCode: 'ABCD-EFGH' });
  assert.deepEqual(calls, [['15551234567', { phoneNumber: '15551234567' }]]);
});

test('pair endpoint validates phone numbers before creating a socket', async () => {
  const { app, calls } = makeApp();
  const response = await request(app)
    .get('/pair')
    .set('Authorization', `Bearer ${token}`)
    .query({ number: '123' });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test('health endpoint does not expose socket details', async () => {
  const { app } = makeApp();
  const response = await request(app).get('/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});