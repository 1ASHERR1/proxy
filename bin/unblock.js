#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWebProxy } from '../src/webproxy.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const HELP = `
  nebula unblock — a web proxy with a search box

  Usage
    unblock [options]

  Options
    -p, --port <n>        port to listen on            (default 8090)
    -h, --host <addr>     bind address                 (default 127.0.0.1)
        --search <url>    search template, %s = query  (default DuckDuckGo)
        --upstream <url>  route outbound through another proxy (http://host:port)
        --ca <file>       extra CA bundle for upstream TLS
        --insecure        skip upstream TLS verification (last resort)
    -q, --quiet           do not log each fetch
        --help            show this message
        --version         print the version

  Then open the printed URL, type a site or a search, and go.

  Example
    unblock --port 8090
    # then browse to http://127.0.0.1:8090
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '-p': case '--port': out.port = Number(next()); break;
      case '-h': case '--host': out.host = next(); break;
      case '--search': out.search = next(); break;
      case '--upstream': out.upstream = next(); break;
      case '--ca': out.ca = next(); break;
      case '--insecure': out.insecure = true; break;
      case '-q': case '--quiet': out.quiet = true; break;
      case '--help': out.help = true; break;
      case '--version': out.version = true; break;
      default:
        if (arg.startsWith('-')) {
          process.stderr.write(`unblock: unknown option ${arg}\n`);
          process.exit(1);
        }
    }
  }
  return out;
}

const cli = parseArgs(process.argv.slice(2));
if (cli.help) { process.stdout.write(`${HELP}\n`); process.exit(0); }
if (cli.version) { process.stdout.write(`${version}\n`); process.exit(0); }

const settings = {
  port: 8090,
  host: '127.0.0.1',
  ...cli,
};

const { server } = createWebProxy({
  upstreamProxy: settings.upstream || null,
  ca: settings.ca ? fs.readFileSync(settings.ca) : undefined,
  insecure: Boolean(settings.insecure),
  searchTemplate: settings.search || 'https://duckduckgo.com/html/?q=%s',
  onRequest: settings.quiet ? undefined : ({ target, status, detail }) => {
    const time = new Date().toISOString().slice(11, 19);
    const flag = detail ? ` (${detail})` : '';
    process.stdout.write(`${time}  ${String(status).padStart(3)}  ${target}${flag}\n`);
  },
});

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

server.once('error', (err) => {
  const reason = err.code === 'EADDRINUSE'
    ? `port ${settings.port} is already in use`
    : err.code === 'EACCES'
      ? `port ${settings.port} needs elevated privileges`
      : err.message;
  process.stderr.write(`unblock: ${reason}\n`);
  process.exit(1);
});

server.listen(settings.port, settings.host, () => {
  const url = `http://${settings.host}:${settings.port}`;
  process.stdout.write(`\n  nebula unblock v${version}\n`);
  process.stdout.write(`  open  ${url}\n`);
  if (!LOOPBACK.has(settings.host)) {
    process.stdout.write('  note  bound to a public address — anyone who can reach it can browse through you\n');
  }
  process.stdout.write('\n');
});

const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 250).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
