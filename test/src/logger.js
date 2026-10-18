import { inspect } from 'node:util';

/* ---------- Color setup ---------- */

const useColor =
  !process.env.NO_COLOR && (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR));

const esc = (code) => (useColor ? `\x1b[${code}m` : '');
const fg = (n) => esc(`38;5;${n}`);
const bg = (n) => esc(`48;5;${n}`);

const c = {
  reset: esc(0),
  bold: esc(1),
  dim: esc(2),
  white: fg(255),
  text: fg(252),
  gray: fg(245),
  dark: fg(240),
  black: fg(16),
  purple: fg(141),
  tag: fg(183),
};

/* ---------- Prefix & debug state ---------- */

let prefixText = (process.env.LOG_PREFIX ?? '=>>').toUpperCase();
export const setPrefix = (name) => { prefixText = String(name).toUpperCase(); };

let debugEnabled = false;
export const setDebug = (on) => { debugEnabled = Boolean(on); };
export const isDebug = () => debugEnabled;

/* ---------- Level styles ---------- */

const LEVELS = {
  debug: { icon: '◇', label: 'DEBUG', badge: 245, msg: c.gray },
  info:  { icon: '◆', label: 'INFO ', badge: 45,  msg: c.text },
  ok:    { icon: '✔', label: 'OK   ', badge: 84,  msg: fg(114) },
  warn:  { icon: '⚠', label: 'WARN ', badge: 220, msg: fg(221) },
  error: { icon: '✖', label: 'ERROR', badge: 203, msg: fg(210) },
};

const prefixBadge = () =>
  `${bg(99)}${c.white}${c.bold} ${prefixText} ${c.reset}`;

const levelBadge = (s) =>
  `${bg(s.badge)}${c.black}${c.bold} ${s.icon} ${s.label} ${c.reset}`;

/* ---------- Helpers ---------- */

function formatData(data) {
  if (data instanceof Error) return data.stack ?? String(data);
  if (typeof data === 'string') return data;
  return inspect(data, { depth: 4, colors: useColor, breakLength: 100 });
}

function renderData(data) {
  const lines = formatData(data).split('\n');
  const last = lines.length - 1;
  return lines
    .map((line, i) => {
      const branch = last === 0 ? '╰─' : i === 0 ? '╭─' : i === last ? '╰─' : '│ ';
      return `${c.dark}   ${branch}${c.reset} ${line}`;
    })
    .join('\n') + '\n';
}

function print(level, emoji, tag, message, data) {
  if (level === 'debug' && !debugEnabled) return;

  const s = LEVELS[level];
  const icon = emoji ? `${emoji} ` : '';
  const sep = `${c.dark}│${c.reset}`;
  const arrow = `${c.dark}›${c.reset}`;

  let out =
    `${prefixBadge()}${levelBadge(s)} ${sep} ` +
    `${icon}${c.bold}${c.tag}${tag}${c.reset} ${arrow} ${s.msg}${message}${c.reset}\n`;

  if (data !== undefined && (debugEnabled || level === 'error')) {
    out += renderData(data);
  }
  (level === 'error' ? process.stderr : process.stdout).write(out);
}

/* ---------- Public API ---------- */

export const log = {
  debug: (emoji, tag, msg, data) => print('debug', emoji, tag, msg, data),
  info: (emoji, tag, msg, data) => print('info', emoji, tag, msg, data),
  ok: (emoji, tag, msg, data) => print('ok', emoji, tag, msg, data),
  warn: (emoji, tag, msg, data) => print('warn', emoji, tag, msg, data),
  error: (emoji, tag, msg, data) => print('error', emoji, tag, msg, data),

  banner(lines) {
    if (!lines?.length) return;
    const rows = lines.map(String);
    const width = Math.max(...rows.map((l) => [...l].length)) + 6;
    const b = (t) => `${c.purple}${t}${c.reset}`;

    const body = rows.map((l, i) => {
      const gap = ' '.repeat(Math.max(0, width - 4 - [...l].length));
      const style = i === 0 ? `${c.bold}${c.white}` : c.gray;
      return `${b('│')}   ${style}${l}${c.reset}${gap}${b('│')}`;
    });

    process.stdout.write(
      ['', b(`╭${'─'.repeat(width)}╮`), ...body, b(`╰${'─'.repeat(width)}╯`), ''].join('\n') + '\n',
    );
  },

  divider() {
    process.stdout.write(`${c.dark}${'─'.repeat(52)}${c.reset}\n`);
  },
};
