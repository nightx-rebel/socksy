import pino, { type DestinationStream } from 'pino';
import chalk from 'chalk';
import os from 'node:os';
import { inspect } from 'node:util';

if (process.env.NO_COLOR) chalk.level = 0;

type LogLevel =
  | 'TRACE' | 'DEBUG' | 'INFO' | 'SUCCESS'
  | 'WARN' | 'ERROR' | 'FATAL' | 'PAIRING';

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

const RANK: Record<LogLevel, number> = {
  TRACE: 10, DEBUG: 20, INFO: 30, SUCCESS: 30,
  PAIRING: 30, WARN: 40, ERROR: 50, FATAL: 60,
};

const PINO_LEVELS: Record<number, LogLevel> = {
  10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL',
};

const LEVEL_NAMES: Record<string, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 100,
};

const envLevel = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const levelName = envLevel in LEVEL_NAMES ? envLevel : 'info';
const THRESHOLD: number = LEVEL_NAMES[levelName] ?? 30;

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

function formatMetadata(metadata: unknown): string {
  if (metadata instanceof Error) return metadata.stack ?? metadata.message;
  if (typeof metadata === 'string') return metadata;
  return inspect(metadata, { depth: 4, breakLength: 100, colors: chalk.level > 0 });
}

function maskSession(session: string): string {
  const m = session.match(/^(user-)?(\d{7,15})$/);
  const digits = m?.[2];
  if (!digits) return session;
  return `${m?.[1] ?? ''}***${digits.slice(-4)}`;
}

function write(
  level: LogLevel,
  message: unknown,
  session: string = 'SYSTEM',
  metadata?: unknown,
): void {
  if (RANK[level] < THRESHOLD) return;

  const color = COLORS[level];
  const sep = chalk.gray('│');

  let out =
    [
      color(`${ICONS[level]} ${level.padEnd(7)}`),
      chalk.hex('#00E5FF')(`[${maskSession(session)}]`),
      color(formatMessage(message)),
    ].join(` ${sep} `) + '\n';

  if (metadata !== undefined) {
    const body = formatMetadata(metadata).split('\n').join('\n     ');
    out += `${chalk.gray('  └─')} ${chalk.white(body)}\n`;
  }

  process.stdout.write(out);
}

/* ---------- Baileys / pino bridge ---------- */

const BASE_HIDDEN = new Set([
  'level', 'time', 'pid', 'hostname', 'msg', 'name', 'class',
  'browser', 'helloMsg', 'err', 'error',
]);

const pinoStream: DestinationStream = {
  write(chunk: string): void {
    let rec: Record<string, any>;
    try {
      rec = JSON.parse(chunk);
    } catch {
      process.stdout.write(chunk.endsWith('\n') ? chunk : `${chunk}\n`);
      return;
    }

    const level = PINO_LEVELS[Number(rec.level)] ?? 'INFO';
    let msg = typeof rec.msg === 'string' ? rec.msg : '';

    const err = rec.err ?? rec.error;
    const errText = typeof err === 'string' ? err : err?.message;
    if (errText && !msg.includes(errText)) {
      msg = msg ? `${msg} (${errText})` : String(errText);
    }


    let extra: Record<string, unknown> | undefined;
    if (THRESHOLD <= 20) {
      extra = {};
      for (const [k, v] of Object.entries(rec)) {
        if (!BASE_HIDDEN.has(k)) extra[k] = v;
      }
      if (err && typeof err === 'object') extra.err = err;
      if (Object.keys(extra).length === 0) extra = undefined;
    }

    write(level, msg || '(no message)', 'BAILEYS', extra);
  },
};

const pinoLogger = pino(
  { level: levelName, base: null, timestamp: false },
  pinoStream,
);

const logger = {
  pino: pinoLogger,

  trace: (m: unknown, s?: string, d?: unknown): void => write('TRACE', m, s, d),
  debug: (m: unknown, s?: string, d?: unknown): void => write('DEBUG', m, s, d),
  info: (m: unknown, s?: string, d?: unknown): void => write('INFO', m, s, d),
  success: (m: unknown, s?: string, d?: unknown): void => write('SUCCESS', m, s, d),
  warn: (m: unknown, s?: string, d?: unknown): void => write('WARN', m, s, d),
  error: (m: unknown, s?: string, d?: unknown): void => write('ERROR', m, s, d),
  fatal: (m: unknown, s?: string, d?: unknown): void => write('FATAL', m, s, d),
  pairing: (m: unknown, s?: string, d?: unknown): void => write('PAIRING', m, s, d),

  banner(): void {
    const border = '━'.repeat(42);
    const cyan = chalk.hex('#00E5FF');
    process.stdout.write(
      [
        '',
        cyan(`  ╭${border}╮`),
        cyan('  │') + chalk.bold.white('  ✦  SYSTEM LOGGER'.padEnd(42)) + cyan('│'),
        cyan('  │') + chalk.gray('  ⚡  LOGGING ENGINE'.padEnd(42)) + cyan('│'),
        cyan(`  ╰${border}╯`),
        '',
        '',
      ].join('\n'),
    );
  },

  divider(): void {
    process.stdout.write(chalk.hex('#7C4DFF')(`  ${'━'.repeat(46)}`) + '\n');
  },

  getStats() {
    const mem = process.memoryUsage();
    const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(2)} MB`;
    return {
      uptimeSeconds: Math.floor(process.uptime()),
      memory: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal) },
      platform: os.platform(),
      nodeVersion: process.version,
    };
  },
};

export default logger;
