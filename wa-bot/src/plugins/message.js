export function getMessageText(message) {
  const content = message.message;
  if (!content) return '';
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    ''
  ).trim();
}

export function createCommandPlugin(name, handler) {
  return {
    name,
    async onMessage(context) {
      const text = getMessageText(context.message);
      if (!text.startsWith('!')) return;
      const [command = '', ...args] = text.slice(1).trim().split(/\s+/);
      await handler({ ...context, command: command.toLowerCase(), args, text });
    },
  };
}