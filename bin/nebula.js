#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProxy } from '../src/server.js';
import { createDashboard } from '../src/dashboard.js';
import { RuleSet } from '../src/rules.js';
import { banner, requestLine, c } from '../src/log.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const HELP = `
  nebula — a forward proxy with a live dashboard

  Usage
    nebula [options]

  Options
    -p, --port <n>            proxy port                      (default 8080)
    -h, --host <addr>         proxy bind address              (default 127.0.0.1)
        --dashboard-port <n>  dashboard port                  (default proxy port + 1)
        --dashboard-host <a>  dashboard bind address          (default 127.0.0.1)
        --no-dashboard        run the proxy only
        --auth <user:pass>    require Proxy-Authorization
        --block <list>        comma-separated host patterns to deny
        --allow <list>        comma-separated host patterns to permit exclusively
        --timeout <ms>        upstream idle timeout           (default 30000)
    -c, --config <file>       JSON config file
    -q, --quiet               do not print each request
        --help                show this message
        --version             print the version

  Host patterns accept a leading wildcard: example.com, *.example.com, *

  Example
    nebula --port 8080 --block '*.doubleclick.net,ads.example.com'
    export http_proxy=http://127.0.0.1:8080 https_proxy=http://127.0.0.1:8080
`;

function parseArgs(argv) {
  const out = {};
  const list = (value) => String(value).split(',').map((s) => s.trim()).filter(Boolean);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];

    switch (arg) {
      case '-p': case '--port': out.port = Number(next()); break;
      case '-h': case '--host': out.host = next(); break;
      case '--dashboard-port': out.dashboardPort = Number(next()); break;
      case '--dashboard-host': out.dashboardHost = next(); break;
      case '--no-dashboard': out.dashboard = false; break;
      case '--auth': out.auth = next(); break;
      case '--block': out.block = list(next()); break;
      case '--allow': out.allow = list(next()); break;
      case '--timeout': out.timeout = Number(next()); break;
      case '-c': case '--config': out.config = next(); break;
      case '-q': case '--quiet': out.quiet = true; break;
      case '--help': out.help = true; break;
      case '--version': out.version = true; break;
      default:
        if (arg.startsWith('-')) {
          process.stderr.write(`nebula: unknown option ${arg}\n`);
          process.exit(1);
        }
    }
  }
  return out;
}

function loadConfig(file) {
  const candidate = file ?? path.join(process.cwd(), 'nebula.config.json');
  if (!fs.existsSync(candidate)) {
    if (file) {
      process.stderr.write(`nebula: config file not found: ${file}\n`);
      process.exit(1);
    }
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(candidate, 'utf8'));
  } catch (err) {
    process.stderr.write(`nebula: could not parse ${candidate}: ${err.message}\n`);
    process.exit(1);
  }
}

const cli = parseArgs(process.argv.slice(2));

if (cli.help) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}
if (cli.version) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

const file = loadConfig(cli.config);
const settings = {
  port: 8080,
  host: '127.0.0.1',
  dashboard: true,
  dashboardHost: '127.0.0.1',
  timeout: 30_000,
  quiet: false,
  allow: [],
  block: [],
  auth: null,
  ...file,
  ...cli,
};
settings.dashboardPort = settings.dashboardPort ?? settings.port + 1;

let auth = null;
if (settings.auth) {
  const raw = typeof settings.auth === 'string'
    ? { username: settings.auth.slice(0, settings.auth.indexOf(':')), password: settings.auth.slice(settings.auth.indexOf(':') + 1) }
    : settings.auth;
  if (!raw.username || !raw.password) {
    process.stderr.write('nebula: --auth expects user:pass\n');
    process.exit(1);
  }
  auth = raw;
}

const rules = new RuleSet({ allow: settings.allow, block: settings.block });

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
if (!LOOPBACK.has(settings.host) && !auth) {
  process.stderr.write(
    `${c.yellow('warning')} binding to ${settings.host} without --auth makes this an open relay `
    + 'reachable by anyone who can route to this host.\n\n',
  );
}

const { server, stats } = createProxy({
  auth,
  rules,
  timeout: settings.timeout,
  onEntry: (entry) => {
    if (!settings.quiet) process.stdout.write(`${requestLine(entry)}\n`);
  },
});

const listen = (srv, port, host, label) => new Promise((resolve, reject) => {
  srv.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      reject(new Error(`${label} port ${port} is already in use`));
    } else if (err.code === 'EACCES') {
      reject(new Error(`${label} port ${port} requires elevated privileges`));
    } else {
      reject(err);
    }
  });
  srv.listen(port, host, resolve);
});

const servers = [server];

try {
  await listen(server, settings.port, settings.host, 'proxy');

  if (settings.dashboard !== false) {
    const dashboard = createDashboard({
      stats,
      proxyPort: settings.port,
      proxyHost: settings.host,
      version,
    });
    await listen(dashboard, settings.dashboardPort, settings.dashboardHost, 'dashboard');
    servers.push(dashboard);
  }
} catch (err) {
  process.stderr.write(`${c.red('error')} ${err.message}\n`);
  process.exit(1);
}

process.stdout.write(banner({
  host: settings.host,
  port: settings.port,
  dashboardHost: settings.dashboardHost,
  dashboardPort: settings.dashboardPort,
  rules,
  auth,
  version,
}));

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  process.stdout.write(`\n${c.gray('shutting down…')}\n`);
  for (const srv of servers) srv.close();
  setTimeout(() => process.exit(0), 250).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
