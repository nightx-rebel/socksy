import { isDebug, log, setDebug } from './logger.js';

/**
 * @typedef {Object} CommandContext
 * @property {import('wa-multi-socket').MultiSocketManager} manager
 * @property {string} userId     which linked account received the message
 * @property {any} socket        Baileys socket of that account
 * @property {any} message       Baileys message (WAMessage)
 * @property {string} jid        chat jid
 * @property {string} sender     who wrote it
 * @property {boolean} isGroup
 * @property {boolean} isOwner
 * @property {string[]} args
 * @property {string} rawArgs
 * @property {string} prefix
 * @property {(text: string) => Promise<any>} reply   quoted reply via the rate-limited queue
 * @property {(sent: any, text: string) => Promise<any>} edit
 * @property {number} receivedAt
 */

const startedAt = Date.now();

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const parts = [
    [Math.floor(s / 86400), 'd'],
    [Math.floor((s % 86400) / 3600), 'h'],
    [Math.floor((s % 3600) / 60), 'm'],
    [s % 60, 's'],
  ];
  return parts.filter(([n]) => n > 0).map(([n, u]) => n + u).join(' ') || '0s';
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** @type {Array<{name:string, aliases?:string[], description:string, usage?:string, ownerOnly?:boolean, run:(ctx:CommandContext)=>Promise<void>}>} */
export const commands = [
  {
    name: 'ping',
    aliases: ['p'],
    description: 'Check the bot is alive and measure latency',
    async run(ctx) {
      const ts = Number(ctx.message.messageTimestamp ?? 0) * 1000;
      const inbound = ts ? Math.max(0, ctx.receivedAt - ts) : undefined;
      const t0 = Date.now();
      const sent = await ctx.reply('🏓 Pinging...');
      const roundTrip = Date.now() - t0;
      const text =
        '🏓 Pong!\n' +
        `👤 Account: ${ctx.userId}\n` +
        (inbound !== undefined ? `📥 Message → bot: ${inbound}ms\n` : '') +
        `📤 Bot → WhatsApp (send ack): ${roundTrip}ms`;
      if (sent) await ctx.edit(sent, text).catch(() => ctx.reply(text));
      else await ctx.reply(text);
    },
  },
  {
    name: 'help',
    aliases: ['menu', 'h'],
    description: 'List all commands',
    async run(ctx) {
      const lines = commands.map(
        (c) => `${c.ownerOnly ? '🔒' : '▫️'} ${ctx.prefix}${c.name}${c.usage ? ' ' + c.usage : ''} — ${c.description}`,
      );
      await ctx.reply('📖 *Commands*\n\n' + lines.join('\n'));
    },
  },
  {
    name: 'status',
    description: 'Socket status of this account and manager statistics',
    async run(ctx) {
      const stats = ctx.manager.getStats();
      await ctx.reply(
        '📡 *Status*\n' +
          `👤 userId: ${ctx.userId}\n` +
          `🔌 state: ${ctx.manager.getStatus(ctx.userId)}\n` +
          `📊 total ${stats.total} | 🟢 open ${stats.open} | 🟡 connecting ${stats.connecting} | 🔑 pairing ${stats.awaitingPairing} | 🔁 reconnecting ${stats.reconnecting}`,
      );
    },
  },
  {
    name: 'uptime',
    description: 'How long the bot has been running, plus memory',
    async run(ctx) {
      const m = process.memoryUsage();
      await ctx.reply(
        `⏱️ uptime: ${formatDuration(Date.now() - startedAt)}\n` +
          `🧠 RSS ${mb(m.rss)} | heap ${mb(m.heapUsed)} / ${mb(m.heapTotal)}\n` +
          `🟩 Node ${process.version}`,
      );
    },
  },
  {
    name: 'echo',
    description: 'Repeat the text you send',
    usage: '<text>',
    async run(ctx) {
      await ctx.reply(ctx.rawArgs ? `🔁 ${ctx.rawArgs}` : `ℹ️ Usage: ${ctx.prefix}echo <text>`);
    },
  },
  {
    name: 'time',
    description: 'Current server time',
    async run(ctx) {
      const now = new Date();
      await ctx.reply(`🕒 ${now.toString()}\n🌐 UTC: ${now.toISOString()}`);
    },
  },
  {
    name: 'info',
    aliases: ['whoami', 'id'],
    description: 'Chat, sender and message details (useful for setting OWNERS)',
    async run(ctx) {
      await ctx.reply(
        '🪪 *Info*\n' +
          `💬 chat: ${ctx.jid}\n` +
          `🙋 sender: ${ctx.sender}\n` +
          `👥 group: ${ctx.isGroup ? 'yes' : 'no'}\n` +
          `👑 owner: ${ctx.isOwner ? 'yes' : 'no'}\n` +
          `🆔 message id: ${ctx.message.key.id}\n` +
          `📛 pushName: ${ctx.message.pushName ?? '-'}\n` +
          `🤖 account: ${ctx.userId} (${ctx.socket.user?.id ?? '-'})`,
      );
    },
  },
  {
    name: 'react',
    description: 'React to this message with 👍',
    async run(ctx) {
      await ctx.manager.sendMessage(ctx.userId, ctx.jid, { react: { text: '👍', key: ctx.message.key } });
    },
  },
  {
    name: 'raw',
    description: 'Raw JSON of this message (debugging)',
    async run(ctx) {
      const json = JSON.stringify(ctx.message, (_k, v) => (typeof v === 'object' && v?.type === 'Buffer' ? '[Buffer]' : v), 2);
      await ctx.reply('🧾 ```' + json.slice(0, 3000) + (json.length > 3000 ? '\n…(truncated)' : '') + '```');
    },
  },
  {
    name: 'groupinfo',
    description: 'Group details (groups only)',
    async run(ctx) {
      if (!ctx.isGroup) {
        await ctx.reply('👥 This command only works in groups.');
        return;
      }
      const meta = await ctx.socket.groupMetadata(ctx.jid);
      await ctx.reply(
        '👥 *Group*\n' +
          `📛 name: ${meta.subject}\n` +
          `🆔 ${meta.id}\n` +
          `🧑‍🤝‍🧑 members: ${meta.participants.length}\n` +
          `👑 admins: ${meta.participants.filter((p) => p.admin).length}`,
      );
    },
  },
  {
    name: 'burst',
    description: 'Rate-limiter test: send N messages at once (max 10)',
    usage: '[n]',
    ownerOnly: true,
    async run(ctx) {
      const n = Math.min(10, Math.max(1, Number.parseInt(ctx.args[0] ?? '5', 10) || 5));
      const t0 = Date.now();
      const stamps = [];
      await Promise.all(
        Array.from({ length: n }, async (_, i) => {
          await ctx.manager.sendMessage(ctx.userId, ctx.jid, { text: `📨 burst ${i + 1}/${n}` });
          stamps.push(Date.now() - t0);
        }),
      );
      await ctx.reply(`⏲️ ${n} messages sent. Timings (ms): ${stamps.join(', ')}\nGaps between them mean the rate limiter works ✅`);
    },
  },
  {
    name: 'users',
    description: 'All accounts handled by this manager and their state',
    ownerOnly: true,
    async run(ctx) {
      const lines = ctx.manager.getUserIds().map((id) => `• ${id} → ${ctx.manager.getStatus(id)}`);
      await ctx.reply('👥 *Accounts*\n' + (lines.join('\n') || 'none'));
    },
  },
  {
    name: 'debug',
    description: 'Turn terminal debug logs on/off',
    usage: 'on|off',
    ownerOnly: true,
    async run(ctx) {
      const arg = ctx.args[0]?.toLowerCase();
      if (arg === 'on' || arg === 'off') setDebug(arg === 'on');
      log.info('🛠️', 'debug', `debug mode = ${isDebug()}`);
      await ctx.reply(`🛠️ Debug logs are now: ${isDebug() ? 'ON 🟢' : 'OFF 🔴'}`);
    },
  },
];

export const commandMap = new Map();
for (const command of commands) {
  commandMap.set(command.name, command);
  for (const alias of command.aliases ?? []) commandMap.set(alias, command);
}
