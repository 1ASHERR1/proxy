import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';

import { Stats } from './stats.js';
import { RuleSet } from './rules.js';

/** Headers that describe a single hop and must not be forwarded upstream. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function sanitizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function splitHostPort(authority, fallbackPort) {
  // IPv6 literals arrive as [::1]:443
  const match = /^\[(.+)\](?::(\d+))?$/.exec(authority);
  if (match) return { hostname: match[1], port: Number(match[2] || fallbackPort) };

  const idx = authority.lastIndexOf(':');
  if (idx === -1) return { hostname: authority, port: fallbackPort };
  return { hostname: authority.slice(0, idx), port: Number(authority.slice(idx + 1)) || fallbackPort };
}

function timingSafeEqual(a, b) {
  // Constant-time-ish comparison without pulling in crypto timing edge cases
  // around differing lengths.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function createProxy(options = {}) {
  const config = {
    timeout: 30_000,
    auth: null,
    rules: new RuleSet(),
    onEntry: () => {},
    ...options,
  };

  const stats = config.stats ?? new Stats();
  const rules = config.rules instanceof RuleSet ? config.rules : new RuleSet(config.rules);

  const expectedCredential = config.auth
    ? Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64')
    : null;

  function isAuthorized(req) {
    if (!expectedCredential) return true;
    const header = req.headers['proxy-authorization'];
    if (typeof header !== 'string') return false;
    const [scheme, credential] = header.split(' ');
    if (!scheme || scheme.toLowerCase() !== 'basic' || !credential) return false;
    return timingSafeEqual(credential, expectedCredential);
  }

  function finish(entry) {
    const record = stats.record(entry);
    try {
      config.onEntry(record);
    } catch {
      // Logging is never allowed to take down a proxied request.
    }
  }

  const server = http.createServer();

  server.on('request', (req, res) => {
    const started = performance.now();
    let bytesIn = 0;
    let bytesOut = 0;

    const done = (outcome, status, host, url, detail) => {
      finish({
        kind: 'http',
        method: req.method,
        host,
        url,
        status,
        bytesIn,
        bytesOut,
        durationMs: performance.now() - started,
        outcome,
        detail,
      });
    };

    // A request that is not in absolute-form came straight at the proxy port
    // rather than through it.
    if (!/^https?:\/\//i.test(req.url || '')) {
      const body = 'Nebula is a forward proxy. Point your client at it with '
        + 'http_proxy/https_proxy, or open the dashboard for live traffic.\n';
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
      done('error', 400, 'nebula', req.url || '/', 'direct request');
      return;
    }

    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Malformed request URI.\n');
      done('error', 400, 'invalid', req.url, 'bad uri');
      return;
    }

    if (!isAuthorized(req)) {
      res.writeHead(407, {
        'proxy-authenticate': 'Basic realm="nebula"',
        'content-type': 'text/plain; charset=utf-8',
      });
      res.end('Proxy authentication required.\n');
      done('error', 407, target.hostname, req.url, 'auth required');
      return;
    }

    const verdict = rules.check(target.hostname);
    if (!verdict.allowed) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Request to ${target.hostname} denied: ${verdict.reason}.\n`);
      done('blocked', 403, target.hostname, req.url, verdict.reason);
      return;
    }

    const headers = sanitizeHeaders(req.headers);
    headers.connection = 'close';
    headers.via = '1.1 nebula';

    const upstream = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    });

    upstream.setTimeout(config.timeout, () => {
      upstream.destroy(new Error('upstream timed out'));
    });

    upstream.on('response', (upstreamRes) => {
      const responseHeaders = sanitizeHeaders(upstreamRes.headers);
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);

      upstreamRes.on('data', (chunk) => {
        bytesIn += chunk.length;
        stats.recordBytes('in', chunk.length);
      });

      upstreamRes.pipe(res);
      upstreamRes.on('end', () => done('ok', upstreamRes.statusCode ?? null, target.hostname, req.url));
    });

    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Upstream request failed: ${err.message}\n`);
      } else {
        res.destroy();
      }
      done('error', 502, target.hostname, req.url, err.code || err.message);
    });

    req.on('data', (chunk) => {
      bytesOut += chunk.length;
      stats.recordBytes('out', chunk.length);
    });

    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket, head) => {
    const started = performance.now();
    const { hostname, port } = splitHostPort(req.url || '', 443);
    let bytesIn = 0;
    let bytesOut = 0;
    let settled = false;

    const done = (outcome, status, detail) => {
      if (settled) return;
      settled = true;
      stats.active.tunnels = Math.max(0, stats.active.tunnels - 1);
      finish({
        kind: 'tunnel',
        method: 'CONNECT',
        host: hostname,
        url: `${hostname}:${port}`,
        status,
        bytesIn,
        bytesOut,
        durationMs: performance.now() - started,
        outcome,
        detail,
      });
    };

    const reject = (statusLine, message, outcome, status, detail) => {
      clientSocket.write(`HTTP/1.1 ${statusLine}\r\n${message}Content-Length: 0\r\n\r\n`);
      clientSocket.destroy();
      done(outcome, status, detail);
    };

    stats.active.tunnels += 1;
    clientSocket.on('error', () => done('error', null, 'client socket error'));

    if (!isAuthorized(req)) {
      reject('407 Proxy Authentication Required',
        'Proxy-Authenticate: Basic realm="nebula"\r\n',
        'error', 407, 'auth required');
      return;
    }

    const verdict = rules.check(hostname);
    if (!verdict.allowed) {
      reject('403 Forbidden', '', 'blocked', 403, verdict.reason);
      return;
    }

    const upstream = net.connect({ host: hostname, port }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: nebula\r\n\r\n');
      if (head && head.length) upstream.write(head);

      upstream.on('data', (chunk) => {
        bytesIn += chunk.length;
        stats.recordBytes('in', chunk.length);
      });
      clientSocket.on('data', (chunk) => {
        bytesOut += chunk.length;
        stats.recordBytes('out', chunk.length);
      });

      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.setTimeout(config.timeout, () => upstream.destroy(new Error('tunnel idle timeout')));

    upstream.on('error', (err) => {
      if (!clientSocket.destroyed && !settled) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      }
      clientSocket.destroy();
      done('error', 502, err.code || err.message);
    });

    upstream.on('close', () => {
      clientSocket.destroy();
      done('ok', 200);
    });
    clientSocket.on('close', () => upstream.destroy());
  });

  server.on('connection', (socket) => {
    stats.active.requests += 1;
    socket.once('close', () => {
      stats.active.requests = Math.max(0, stats.active.requests - 1);
    });
  });

  return { server, stats, rules };
}
