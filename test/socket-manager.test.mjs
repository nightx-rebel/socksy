import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import { Boom } from '@hapi/boom';
import { DisconnectReason, MultiSocketManager, SQLiteAuthStore } from '../dist/index.js';

class FakeSocket {
  constructor({ auth }) {
    this.authState = auth;
    this.ev = new EventEmitter();
    this.ended = false;
  }

  async requestPairingCode(phoneNumber, customCode) {
    this.pairingRequest = { phoneNumber, customCode };
    return customCode ?? 'ABCD-EFGH';
  }

  async end(error) {
    this.ended = true;
    this.endError = error;
  }

  disconnect(reason) {
    this.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Boom('disconnected', { statusCode: reason }) },
    });
  }
}

test('pairs users and reconnects with the configured delay', async () => {
  const created = [];
  const manager = new MultiSocketManager({
    authStore: new SQLiteAuthStore(':memory:'),
    reconnectDelays: { [DisconnectReason.connectionLost]: 5 },
    socketFactory: (config) => {
      const socket = new FakeSocket(config);
      created.push(socket);
      return socket;
    },
  });

  const { socket, pairingCode } = await manager.addUser('user-1', {
    phoneNumber: '+1 (555) 123-4567',
  });
  assert.equal(pairingCode, 'ABCD-EFGH');
  assert.deepEqual(socket.pairingRequest, { phoneNumber: '15551234567', customCode: undefined });
  assert.equal(manager.getSocket('user-1'), socket);

  const reconnecting = once(manager.events, 'user:reconnecting');
  const nextConnecting = once(manager.events, 'user:connecting');
  socket.disconnect(DisconnectReason.connectionLost);
  const [event] = await reconnecting;
  assert.equal(event.delayMs, 5);
  await nextConnecting;
  await new Promise((resolve) => setImmediate(resolve));

  const reconnectedSocket = manager.getSocket('user-1');
  assert.notEqual(reconnectedSocket, socket);
  assert.equal(created.length, 2);
  const connected = once(manager.events, 'user:connected');
  reconnectedSocket.ev.emit('connection.update', { connection: 'open' });
  assert.equal((await connected)[0].reconnecting, true);
  await manager.close();
});

test('logout clears stored auth and closes the socket without reconnecting', async () => {
  const store = new SQLiteAuthStore(':memory:');
  let socket;
  const manager = new MultiSocketManager({
    authStore: store,
    socketFactory: (config) => {
      socket = new FakeSocket(config);
      return socket;
    },
  });
  await manager.addUser('user-2');

  const loggedOut = once(manager.events, 'user:logged-out');
  socket.disconnect(DisconnectReason.loggedOut);
  await loggedOut;

  assert.equal(manager.getSocket('user-2'), undefined);
  assert.equal(socket.ended, true);
  assert.deepEqual(await store.listUsers(), []);
  await manager.close();
});

test('manual disconnect emits an event and preserves saved auth', async () => {
  const store = new SQLiteAuthStore(':memory:');
  const manager = new MultiSocketManager({
    authStore: store,
    socketFactory: (config) => new FakeSocket(config),
  });
  const { socket } = await manager.addUser('user-3');

  const disconnected = once(manager.events, 'user:disconnected');
  await manager.disconnectUser('user-3');
  const [event] = await disconnected;

  assert.equal(event.manual, true);
  assert.equal(socket.ended, true);
  assert.deepEqual(await store.listUsers(), ['user-3']);
  await manager.close();
});