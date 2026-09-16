import http from 'node:http';

/** A tiny origin server the tests proxy to. */
export function startOrigin() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(50_000));
        return;
      }
      if (req.url === '/status/404') { res.writeHead(404).end('nope'); return; }
      if (req.url === '/status/500') { res.writeHead(500).end('boom'); return; }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        url: req.url,
        method: req.method,
        body: Buffer.concat(chunks).toString(),
        via: req.headers.via ?? null,
        proxyAuthSeen: 'proxy-authorization' in req.headers,
        proxyConnectionSeen: 'proxy-connection' in req.headers,
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Issue an absolute-form request through the proxy, the way a client would. */
export function throughProxy(proxyPort, targetUrl, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method,
      path: targetUrl,
      headers: { host: target.host, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Decode a chunked-transfer body. Inside a tunnel we are the HTTP parser. */
function dechunk(body) {
  let rest = body;
  let out = '';
  while (rest.length) {
    const eol = rest.indexOf('\r\n');
    if (eol === -1) break;
    const size = parseInt(rest.slice(0, eol), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out += rest.slice(eol + 2, eol + 2 + size);
    rest = rest.slice(eol + 2 + size + 2);
  }
  return out;
}

/** Open a CONNECT tunnel and speak plain HTTP through it. */
export function throughTunnel(proxyPort, authority, path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority, headers,
    });

    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        resolve({ status: res.statusCode, body: '' });
        return;
      }
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
      const chunks = [];
      socket.on('data', (c) => chunks.push(c));
      socket.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
        const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
        resolve({
          status: 200,
          body: /transfer-encoding:\s*chunked/i.test(head) ? dechunk(body) : body,
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

export function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

export const close = (server) => new Promise((resolve) => server.close(resolve));
