/** Terminal presentation: colours, the banner, and the live request line. */

const ESC = '';
const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY !== false;

const wrap = (open, close) => (text) => (useColor ? `${ESC}[${open}m${text}${ESC}[${close}m` : String(text));

export const c = {
  reset: `${ESC}[0m`,
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  brightCyan: wrap(96, 39),
  brightMagenta: wrap(95, 39),
};

/** Paint a string across a blue -> magenta ramp, one 256-colour step per glyph. */
function gradient(text) {
  if (!useColor) return text;
  const ramp = [39, 38, 44, 75, 69, 105, 141, 177, 176, 170];
  const span = Math.max(1, text.replace(/\s/g, '').length);
  let out = '';
  let visible = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) {
      out += ch;
      continue;
    }
    const step = ramp[Math.min(ramp.length - 1, Math.floor((visible / span) * ramp.length))];
    out += `${ESC}[38;5;${step}m${ch}`;
    visible += 1;
  }
  return `${out}${ESC}[39m`;
}

const LOGO = [
  '    ███╗   ██╗███████╗██████╗ ██╗   ██╗██╗      █████╗',
  '    ████╗  ██║██╔════╝██╔══██╗██║   ██║██║     ██╔══██╗',
  '    ██╔██╗ ██║█████╗  ██████╔╝██║   ██║██║     ███████║',
  '    ██║╚██╗██║██╔══╝  ██╔══██╗██║   ██║██║     ██╔══██║',
  '    ██║ ╚████║███████╗██████╔╝╚██████╔╝███████╗██║  ██║',
  '    ╚═╝  ╚═══╝╚══════╝╚═════╝  ╚═════╝ ╚══════╝╚═╝  ╚═╝',
].join('\n');

export function banner({ host, port, dashboardHost, dashboardPort, rules, auth, version }) {
  const rule = c.gray('─'.repeat(62));
  const row = (label, value) => `    ${c.gray(label.padEnd(14))}${value}`;

  return [
    '',
    gradient(LOGO),
    '',
    `    ${c.dim(`forward proxy · v${version}`)}`,
    rule,
    row('proxy', c.bold(c.brightCyan(`http://${host}:${port}`))),
    row('dashboard', c.bold(c.brightMagenta(`http://${dashboardHost}:${dashboardPort}`))),
    row('auth', auth ? c.green('basic (required)') : c.dim('none')),
    row('rules', rules.isEmpty
      ? c.dim('none')
      : `${c.yellow(`${rules.allowPatterns.length} allow`)} ${c.gray('·')} ${c.yellow(`${rules.blockPatterns.length} block`)}`),
    rule,
    '',
    `    ${c.dim('export')} ${c.cyan(`http_proxy=http://${host}:${port} https_proxy=http://${host}:${port}`)}`,
    '',
  ].join('\n');
}

const statusColor = (status) => {
  if (status === null || status === undefined) return c.gray('  —');
  if (status >= 500) return c.red(String(status));
  if (status >= 400) return c.yellow(String(status));
  if (status >= 300) return c.cyan(String(status));
  return c.green(String(status));
};

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function requestLine(entry) {
  const time = new Date(entry.at ?? Date.now()).toTimeString().slice(0, 8);
  const verb = entry.kind === 'tunnel'
    ? c.magenta('TUNNEL')
    : c.blue(entry.method.padEnd(6).slice(0, 6));

  const target = entry.url.length > 64 ? `${entry.url.slice(0, 63)}…` : entry.url;
  const size = formatBytes(entry.bytesIn + entry.bytesOut).padStart(8);
  const ms = `${Math.round(entry.durationMs)}ms`.padStart(7);

  const marker = entry.outcome === 'blocked'
    ? c.red('■')
    : entry.outcome === 'error'
      ? c.yellow('▲')
      : c.gray('·');

  const suffix = entry.detail ? ` ${c.gray(`(${entry.detail})`)}` : '';

  return `${c.gray(time)} ${marker} ${verb} ${statusColor(entry.status)} ${c.gray(size)} ${c.gray(ms)}  ${target}${suffix}`;
}
