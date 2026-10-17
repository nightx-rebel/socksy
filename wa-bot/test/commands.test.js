import assert from 'node:assert/strict';
import test from 'node:test';
import { commandMap } from '../src/commands.js';
import { isDebug, setDebug } from '../src/logger.js';

function makeContext(rawArgs = '') {
  const sent = [];
  return {
    sent,
    context: {
      userId: 'user-1',
      prefix: '!',
      rawArgs,
      args: rawArgs ? rawArgs.split(/\s+/) : [],
      reply: async (text) => {
        sent.push(text);
      },
    },
  };
}

test('example commands provide help and echo without a live socket', async () => {
  const help = makeContext();
  await commandMap.get('help').run(help.context);
  assert.match(help.sent[0], /!ping/);
  assert.match(help.sent[0], /!echo/);

  const echo = makeContext('hello from tests');
  await commandMap.get('echo').run(echo.context);
  assert.equal(echo.sent[0], '🔁 hello from tests');
});

test('raw message inspection is restricted to owners', () => {
  assert.equal(commandMap.get('raw').ownerOnly, true);
});

test('debug command changes the live logging state', async () => {
  const context = makeContext();
  setDebug(false);
  await commandMap.get('debug').run({ ...context.context, args: ['on'] });
  assert.equal(isDebug(), true);

  await commandMap.get('debug').run({ ...context.context, args: ['off'] });
  assert.equal(isDebug(), false);
});
