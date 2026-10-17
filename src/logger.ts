import pino from 'pino';
import chalk from 'chalk';
import os from 'node:os';

type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' | 'FATAL' | 'PAIRING';

const COLORS: Record<LogLevel, (text: string) => string> = {
  TRACE: chalk.gray,
  DEBUG: chalk.magenta,
  INFO: chalk.cyan,
  SUCCESS: chalk.green,
  WARN: chalk.yellow,
  ERROR: chalk.red,
  FATAL: chalk.bgRed.white,
  PAIRING: chalk.hex('#A78BFA'),
};

const ICONS: Record<LogLevel, string> = {
  TRACE: '◇',
  DEBUG: '◈',
  INFO: '◆',
  SUCCESS: '✔',
  WARN: '⚠',
  ERROR: '✖',
  FATAL: '☠',
  PAIRING: '◇',
};

const timestamp = (): string =>
  new Date().toLocaleTimeString('en-GB', { hour12: false });

function formatMessage(message: unknown): string {
  if (message instanceof Error) return message.stack ?? message.message;
  if (typeof message === 'string') return message;

  try {
    const json = JSON.stringify(message);
    return json === undefined ? String(message) : json;
  } catch {
    return String(message);
  }
}

function write(
  level: LogLevel,
  message: unknown,
  session: string = 'SYSTEM',
  metadata?: unknown,
): void {
  const color = COLORS[level];
  const icon = ICONS[level];
  const phoneLikeId = session.match(/^(user-)?(\d{7,15})$/);
  const phoneNumber = phoneLikeId?.[2];
  const safeSession = phoneNumber
    ? `${phoneLikeId?.[1] ?? ''}***${phoneNumber.slice(-4)}`
    : session;

  console.log(
    chalk.gray(timestamp()),
    chalk.gray('│'),
    color(`${icon} ${level.padEnd(7)}`),
    chalk.gray('│'),
    chalk.hex('#00E5FF')(`[${safeSession}]`),
    chalk.gray('│'),
    color(formatMessage(message)),
  );

  if (metadata !== undefined) {
    console.log(chalk.gray('  └─'), chalk.white(formatMessage(metadata)));
  }
}

/** Pino-compatible logger intended for Baileys socket and signal-key store. */
const pinoLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: process.env.NO_COLOR ? false : true,
      translateTime: 'SYS:HH:MM:ss',
      // Hide host/process identifiers and noisy handshake metadata (including
      // ephemeral clientHello values) while keeping useful messages/errors.
      ignore: 'pid,hostname,browser,helloMsg',
      singleLine: true,
      levelFirst: true,
      hideObject: true,
    },
  },
});

const logger = {
  /** Pass this to Baileys' `logger` option. */
  pino: pinoLogger,

  trace: (message: unknown, session?: string, metadata?: unknown): void =>
    write('TRACE', message, session, metadata),
  debug: (message: unknown, session?: string, metadata?: unknown): void =>
    write('DEBUG', message, session, metadata),
  info: (message: unknown, session?: string, metadata?: unknown): void =>
    write('INFO', message, session, metadata),
  success: (message: unknown, session?: string, metadata?: unknown): void =>
    write('SUCCESS', message, session, metadata),
  warn: (message: unknown, session?: string, metadata?: unknown): void =>
    write('WARN', message, session, metadata),
  error: (message: unknown, session?: string, metadata?: unknown): void =>
    write('ERROR', message, session, metadata),
  fatal: (message: unknown, session?: string, metadata?: unknown): void =>
    write('FATAL', message, session, metadata),
  pairing: (message: unknown, session?: string, metadata?: unknown): void =>
    write('PAIRING', message, session, metadata),

  banner(): void {
    const border = '━'.repeat(42);
    console.log();
    console.log(chalk.hex('#00E5FF')(`  ╭${border}╮`));
    console.log(
      chalk.hex('#00E5FF')('  │') +
        chalk.bold.white('  ✦  SYSTEM LOGGER'.padEnd(42)) +
        chalk.hex('#00E5FF')('│'),
    );
    console.log(
      chalk.hex('#00E5FF')('  │') +
        chalk.gray('  ⚡  PREMIUM LOGGING ENGINE'.padEnd(42)) +
        chalk.hex('#00E5FF')('│'),
    );
    console.log(chalk.hex('#00E5FF')(`  ╰${border}╯`));
    console.log();
  },

  divider(): void {
    console.log(chalk.hex('#7C4DFF')(`  ${'━'.repeat(46)}`));
  },

  getStats() {
    const memory = process.memoryUsage();
    return {
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rss: `${(memory.rss / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(memory.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(memory.heapTotal / 1024 / 1024).toFixed(2)} MB`,
      },
      platform: os.platform(),
      nodeVersion: process.version,
    };
  },
};

export default logger;
