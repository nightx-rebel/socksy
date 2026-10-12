import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attachPlugins, plugins } from '../src/plugins/index.js';

function createSocket() {
  return {
    ev: new EventEmitter(),
    sent: [],
    async sendMessage(jid, content) {
      this.sent.push({ jid, content });
    },
  };
}

test('example command plugins reply to ping, help, and echo', async () => {
  const socket = createSocket();
  const context = (text) => ({
    userId: 'user-1',
    socket,
    message: { key: { remoteJid: 'chat@s.whatsapp.net' }, message: { conversation: text } },
  });

  for (const text of ['!ping', '!help', '!echo hello there']) {
    for (const plugin of plugins) await plugin.onMessage(context(text));
  }

  assert.deepEqual(socket.sent.map(({ content }) => content.text), [
    'Pong!',
    'Commands: !ping, !echo <text>, !help',
    'hello there',
  ]);
});

test('dispatcher bounds queued work and ignores self and history messages', async () => {
  const manager = { events: new EventEmitter() };
  const socket = createSocket();
  const started = new Promise((resolve) => {
    manager.events.on('user:connected', resolve);
  });
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let finishFirst;
  const firstGate = new Promise((resolve) => {
    finishFirst = resolve;
  });
  let finishSecond;
  const secondFinished = new Promise((resolve) => {
    finishSecond = resolve;
  });
  const seen = [];
  const warnings = [];
  const plugin = {
    name: 'test',
    async onMessage({ message }) {
      seen.push(message.message.conversation);
      if (seen.length === 1) {
        releaseFirst();
        await firstGate;
      }
      if (seen.length === 2) finishSecond();
    },
  };

  attachPlugins(manager, [plugin], {
    concurrency: 1,
    maxQueue: 1,
    logger: { error() {}, warn: (message) => warnings.push(message) },
  });
  manager.events.emit('user:connected', { userId: 'user-1', socket });
  await started;

  const emitMessage = (text, type = 'notify', fromMe = false) => {
    socket.ev.emit('messages.upsert', {
      type,
      messages: [{ key: { remoteJid: 'chat@s.whatsapp.net', fromMe }, message: { conversation: text } }],
    });
  };
  emitMessage('history', 'append');
  emitMessage('self', 'notify', true);
  emitMessage('first');
  await firstStarted;
  emitMessage('second');
  emitMessage('dropped');
  assert.equal(warnings.length, 1);

  finishFirst();
  await secondFinished;
  assert.deepEqual(seen, ['first', 'second']);
});