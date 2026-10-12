import { createCommandPlugin } from '../message.js';

export const echoPlugin = createCommandPlugin('echo', async ({ command, args, socket, message }) => {
  if (command !== 'echo' || args.length === 0) return;
  await socket.sendMessage(message.key.remoteJid, { text: args.join(' ').slice(0, 1000) });
});