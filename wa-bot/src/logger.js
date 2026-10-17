import { inspect } from 'node:util';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', magenta: '\x1b[35m',
  cyan: '\x1b[36m', gray: '\x1b[90m',
};

let debugEnabled = true;
export const setDebug = (on) => { debugEnabled = on; };
export const isDebug = () => debugEnabled;

const time = () => {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

const style = {
  debug: { color: c.gray, badge: '🐛 DEBUG' },
  info: { color: c.cyan, badge: 'ℹ️  INFO ' },
  ok: { color: c.green, badge: '✅ OK   ' },
  warn: { color: c.yellow, badge: '⚠️  WARN ' },
  error: { color: c.red, badge: '❌ ERROR' },
};

function print(level, emoji, tag, message, data) {
  if (level === 'debug' && !debugEnabled) return;
  const s = style[level];
  const head = `${c.dim}${time()}${c.reset} ${s.color}${s.badge}${c.reset} ${emoji} ${c.bold}${tag}${c.reset}`;
  const out = level === 'error' ? console.error : console.log;
  out(`${head} ${s.color}${message}${c.reset}`);
  if (data !== undefined && debugEnabled) {
    const body = data instanceof Error
      ? (data.stack ?? String(data))
      : inspect(data, { depth: 4, colors: true, breakLength: 100 });
    out(`${c.dim}   ↳ ${c.reset}${body.split('\n').join('\n     ')}`);
  }
}

export const log = {
  debug: (emoji, tag, msg, data) => print('debug', emoji, tag, msg, data),
  info: (emoji, tag, msg, data) => print('info', emoji, tag, msg, data),
  ok: (emoji, tag, msg, data) => print('ok', emoji, tag, msg, data),
  warn: (emoji, tag, msg, data) => print('warn', emoji, tag, msg, data),
  error: (emoji, tag, msg, data) => print('error', emoji, tag, msg, data),
  banner(lines) {
    const width = Math.max(...lines.map((l) => [...l].length)) + 4;
    console.log(`${c.magenta}╔${'═'.repeat(width)}╗${c.reset}`);
    for (const l of lines) {
      console.log(`${c.magenta}║${c.reset}  ${l.padEnd(width - 2)}${c.magenta}║${c.reset}`);
    }
    console.log(`${c.magenta}╚${'═'.repeat(width)}╝${c.reset}`);
  },
};
