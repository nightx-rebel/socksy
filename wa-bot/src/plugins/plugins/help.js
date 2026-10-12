import { createCommandPlugin } from '../message.js';

export const helpPlugin = createCommandPlugin('help', async ({ command, socket, message }) => {
  if (command !== 'help' && command !== 'menu') return;
  await socket.sendMessage(message.key.remoteJid, {
    text: 'Commands: !ping, !echo <text>, !help',
  });
});