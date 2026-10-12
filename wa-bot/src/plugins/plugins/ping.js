import { createCommandPlugin } from '../message.js';

export const pingPlugin = createCommandPlugin('ping', async ({ command, socket, message }) => {
  if (command !== 'ping') return;
  await socket.sendMessage(message.key.remoteJid, { text: 'Pong!' });
});