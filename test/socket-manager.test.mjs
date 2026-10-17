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
    this.sent = [];
  }

  async requestPairingCode(phoneNumber, customCode) {
    this.pairingRequest = { phoneNumber, customCode };
    return customCode ?? 'ABCD-EFGH';
  }

  async end(error) {
    this.ended = true;
    this.endError = error;
  }

  async sendMessage(jid, content) {
    const message = { key: { id: `message-${this.sent.length + 1}` }, jid, content };
    this.sent.push(message);
    return message;
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
    reconnectJitterMs: 0,
    socketFactory: (config) => {
      const socket = new FakeSocket(config);
      created.push(socket);
      return socket;
    },
  });

  const addingUser = manager.addUser('user-1', {
    phoneNumber: '+1 (555) 123-4567',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = manager.getSocket('user-1');
  assert.ok(socket);
  assert.equal(socket.pairingRequest, undefined);
  socket.ev.emit('connection.update', { qr: 'server-ready' });
  const { pairingCode } = await addingUser;
  assert.deepEqual(socket.pairingRequest, { phoneNumber: '15551234567', customCode: undefined });
  assert.equal(pairingCode, 'ABCD-EFGH');

  const reconnecting = once(manager.events, 'user:reconnecting');
  const nextConnecting = once(manager.events, 'user:connecting');
  socket.authState.creds.registered = true;
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

test('returns a pairing code for a random 12-digit phone number', async () => {
  const manager = new MultiSocketManager({
    authStore: new SQLiteAuthStore(':memory:'),
    socketFactory: (config) => new FakeSocket(config),
  });
  const phoneNumber = String(Math.floor(100_000_000_000 + Math.random() * 900_000_000_000));
  const pairingCodeEvent = once(manager.events, 'user:pairing-code');

  const addingUser = manager.addUser('user-random-phone', { phoneNumber });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = manager.getSocket('user-random-phone');
  assert.ok(socket);
  assert.equal(socket.pairingRequest, undefined);
  socket.ev.emit('connection.update', { qr: 'server-ready' });
  const { pairingCode } = await addingUser;

  assert.match(phoneNumber, /^\d{12}$/);
  assert.deepEqual(socket.pairingRequest, { phoneNumber, customCode: undefined });
  assert.equal(pairingCode, 'ABCD-EFGH');
  assert.deepEqual(await pairingCodeEvent, [{ userId: 'user-random-phone', pairingCode: 'ABCD-EFGH' }]);
  await manager.close();
});

test('limits simultaneous connection handshakes', async () => {
  const created = [];
  const manager = new MultiSocketManager({
    authStore: new SQLiteAuthStore(':memory:'),
    maxConcurrentConnections: 1,
    socketFactory: (config) => {
      const socket = new FakeSocket(config);
      created.push(socket);
      return socket;
    },
  });

  const first = await manager.connectUser('user-a');
  const secondPromise = manager.connectUser('user-b');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 1);

  first.ev.emit('connection.update', { connection: 'open' });
  const second = await secondPromise;
  assert.equal(created.length, 2);
  assert.equal(manager.getSocket('user-b'), second);
  await manager.close();
});

test('cancels a connection queued behind the handshake limit', async () => {
  const created = [];
  const manager = new MultiSocketManager({
    authStore: new SQLiteAuthStore(':memory:'),
    maxConcurrentConnections: 1,
    socketFactory: (config) => {
      const socket = new FakeSocket(config);
      created.push(socket);
      return socket;
    },
  });

  await manager.connectUser('user-active');
  const queuedConnection = manager.connectUser('user-queued');
  const queuedOutcome = queuedConnection.then(
    () => null,
    (error) => error,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 1);

  await manager.disconnectUser('user-queued');
  const error = await queuedOutcome;
  assert.match(error.message, /cancelled/);
  assert.equal(created.length, 1);
  await manager.disconnectUser('user-active');
  await manager.close();
});

test('does not schedule another reconnect after a pending reconnect is cancelled', async () => {
  const created = [];
  const manager = new MultiSocketManager({
    authStore: new SQLiteAuthStore(':memory:'),
    reconnectDelays: { [DisconnectReason.connectionLost]: 1 },
    reconnectJitterMs: 0,
    socketFactory: (config) => {
      const socket = new FakeSocket(config);
      created.push(socket);
      return socket;
    },
  });
  const original = await manager.connectUser('user-reconnect-cancel');
  original.authState.creds.registered = true;
  original.ev.emit('connection.update', { connection: 'open' });
  const reconnectScheduled = once(manager.events, 'user:reconnecting');
  original.disconnect(DisconnectReason.connectionLost);
  await reconnectScheduled;
  const reconnectConnecting = once(manager.events, 'user:connecting');
  const unexpectedRetry = [];
  manager.events.on('user:reconnecting', (event) => unexpectedRetry.push(event));
  await reconnectConnecting;

  await manager.disconnectUser('user-reconnect-cancel');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 1);
  assert.deepEqual(unexpectedRetry, []);
  await manager.close();
});

test('coalesces concurrent connection requests for one user', async () => {
  const created = [];
  const manager = new MultiSocketManager({
    authStore: new SQLiteAuthStore(':memory:'),
    socketFactory: (config) => {
      const socket = new FakeSocket(config);
      created.push(socket);
      return socket;
    },
  });

  const [first, second] = await Promise.all([
    manager.connectUser('user-shared'),
    manager.connectUser('user-shared'),
  ]);
  assert.equal(first, second);
  assert.equal(created.length, 1);
  await manager.close();
});

test('waits for an open socket and rejects invalid wait timeouts', async () => {
  const manager = new MultiSocketManager({
    authStore: new SQLiteAuthStore(':memory:'),
    socketFactory: (config) => new FakeSocket(config),
  });
  const socket = await manager.connectUser('user-wait');
  const connected = manager.waitForConnection('user-wait', 1_000);
  const event = once(manager.events, 'user:connected');
  socket.ev.emit('connection.update', { connection: 'open' });

  assert.equal(await connected, socket);
  await event;
  assert.throws(() => manager.waitForConnection('invalid id'), /userId must/);
  assert.throws(() => manager.waitForConnection('user-wait', -1), /timeoutMs must/);
  await manager.close();
});

test('cancels queued sends when a socket is disconnected', async () => {
  const created = [];
  const manager = new MultiSocketManager({
    authStore: new SQLiteAuthStore(':memory:'),
    reconnect: false,
    sendIntervalMs: 60_000,
    sendJitterMs: 0,
    socketFactory: (config) => {
      const socket = new FakeSocket(config);
      created.push(socket);
      return socket;
    },
  });
  const socket = await manager.connectUser('user-send');
  socket.authState.creds.registered = true;
  socket.ev.emit('connection.update', { connection: 'open' });
  await manager.sendMessage('user-send', '15551234567@s.whatsapp.net', { text: 'first' });
  const staleSend = manager.sendMessage('user-send', '15551234567@s.whatsapp.net', { text: 'stale' });

  await manager.disconnectUser('user-send');
  await assert.rejects(staleSend, /session changed/);

  const replacement = await manager.connectUser('user-send');
  replacement.authState.creds.registered = true;
  replacement.ev.emit('connection.update', { connection: 'open' });
  await manager.sendMessage('user-send', '15551234567@s.whatsapp.net', { text: 'current' });

  assert.deepEqual(socket.sent.map(({ content }) => content.text), ['first']);
  assert.deepEqual(replacement.sent.map(({ content }) => content.text), ['current']);
  await manager.close();
});

test('cleans an unpaired session when the pairing window expires', async () => {
  const store = new SQLiteAuthStore(':memory:');
  let socket;
  const manager = new MultiSocketManager({
    authStore: store,
    pairingTimeoutMs: 10,
    pairingRetries: 0,
    socketFactory: (config) => {
      socket = new FakeSocket(config);
      return socket;
    },
  });
  const pairingFailed = once(manager.events, 'user:pairing-failed');
  const addingUser = manager.addUser('user-expired', { phoneNumber: '15551234567' });
  await new Promise((resolve) => setImmediate(resolve));
  socket.ev.emit('connection.update', { qr: 'ready' });

  assert.equal((await addingUser).pairingCode, 'ABCD-EFGH');
  await pairingFailed;
  assert.equal(manager.getSocket('user-expired'), undefined);
  assert.deepEqual(await store.listUsers(), []);
  assert.equal(socket.ended, true);
  await manager.close();
});

test('does not recreate a socket after the user cancels an in-flight pairing', async () => {
  const created = [];
  const manager = new MultiSocketManager({
    authStore: new SQLiteAuthStore(':memory:'),
    socketFactory: (config) => {
      const socket = new FakeSocket(config);
      created.push(socket);
      return socket;
    },
  });
  const addingUser = manager.addUser('user-cancel', { phoneNumber: '15551234567' });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = manager.getSocket('user-cancel');
  assert.ok(socket);

  await manager.disconnectUser('user-cancel');
  await assert.rejects(addingUser, /stopped before pairing/);
  assert.equal(created.length, 1);
  assert.equal(manager.getSocket('user-cancel'), undefined);
  await manager.close();
});

test('serializes reconnects behind account removal and auth deletion', async () => {
  const store = new SQLiteAuthStore(':memory:');
  const deleteUser = store.deleteUser.bind(store);
  let releaseDelete;
  let notifyDeleteStarted;
  const deleteStarted = new Promise((resolve) => {
    notifyDeleteStarted = resolve;
  });
  const deleteGate = new Promise((resolve) => {
    releaseDelete = resolve;
  });
  store.deleteUser = async (userId) => {
    notifyDeleteStarted();
    await deleteGate;
    await deleteUser(userId);
  };
  const created = [];
  const manager = new MultiSocketManager({
    authStore: store,
    socketFactory: (config) => {
      const socket = new FakeSocket(config);
      created.push(socket);
      return socket;
    },
  });
  const original = await manager.connectUser('user-remove-race');
  const removing = manager.removeUser('user-remove-race');
  await deleteStarted;
  const reconnecting = manager.connectUser('user-remove-race');
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(created.length, 1);
    releaseDelete();
    await removing;
    const replacement = await reconnecting;
    assert.notEqual(replacement, original);
    assert.equal(created.length, 2);
    assert.deepEqual(await store.listUsers(), ['user-remove-race']);
  } finally {
    releaseDelete();
    await removing.catch(() => undefined);
    await manager.close();
  }
});

test('restores healthy users when another user fails socket creation', async () => {
  const store = new SQLiteAuthStore(':memory:');
  await store.setMany('bad-user', [{ key: 'creds', value: '{"marker":"fail"}' }]);
  await store.setMany('good-user', [{ key: 'creds', value: '{"registered":true}' }]);
  const manager = new MultiSocketManager({
    authStore: store,
    maxConcurrentConnections: 1,
    pruneUnregisteredOnStart: false,
    socketFactory: (config) => {
      if (config.auth.creds.marker === 'fail') throw new Error('simulated socket failure');
      return new FakeSocket(config);
    },
  });
  const errors = [];
  manager.events.on('manager:error', (event) => errors.push(event));

  await manager.start();

  assert.equal(manager.getSocket('bad-user'), undefined);
  assert.ok(manager.getSocket('good-user'));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].userId, 'bad-user');
  await manager.close();
});

test('rejects duplicate pairing requests for one user', async () => {
  const manager = new MultiSocketManager({
    authStore: new SQLiteAuthStore(':memory:'),
    socketFactory: (config) => new FakeSocket(config),
  });
  await manager.connectUser('user-pairing');

  let resolvePairing;
  const socket = manager.getSocket('user-pairing');
  socket.requestPairingCode = async () =>
    new Promise((resolve) => {
      resolvePairing = resolve;
    });
  const first = manager.requestPairingCode('user-pairing', '+1 555 123 4567');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    manager.requestPairingCode('user-pairing', '+1 555 123 4567'),
    /already in progress/,
  );
  socket.ev.emit('connection.update', { qr: 'server-ready' });
  await new Promise((resolve) => setImmediate(resolve));
  resolvePairing('ABCD-EFGH');
  assert.equal(await first, 'ABCD-EFGH');
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

test('rejects invalid reconnect delays during construction', () => {
  assert.throws(
    () => new MultiSocketManager({
      authStore: new SQLiteAuthStore(':memory:'),
      reconnectDelays: { [DisconnectReason.connectionLost]: -1 },
    }),
    /Reconnect delay/,
  );
  assert.throws(
    () => new MultiSocketManager({
      authStore: new SQLiteAuthStore(':memory:'),
      connectionAttemptTimeoutMs: 2_147_483_648,
    }),
    /connectionAttemptTimeoutMs/,
  );
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