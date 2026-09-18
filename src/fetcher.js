/**
 * The proxy's outbound side: fetch one upstream URL and hand back the live
 * response stream. Redirects are NOT followed here — the web proxy rewrites the
 * Location header instead, so the browser's address stays in sync with the page
 * it's actually showing.
 *
 * An optional upstream proxy lets nebula run behind another proxy (and makes it
 * testable in a sandboxed network). https through an upstream uses CONNECT +
 * TLS; http uses an absolute-form request.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

/**
 * @returns {Promise<import('node:http').IncomingMessage>}
 */
export function requestUpstream(targetUrl, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    upstreamProxy = null,
    ca,
    insecure = false,
    timeout = 20_000,
  } = options;

  const url = new URL(targetUrl);
  const isHttps = url.protocol === 'https:';
  const port = url.port || (isHttps ? 443 : 80);

  return new Promise((resolve, reject) => {
    const fail = (err) => reject(err instanceof Error ? err : new Error(String(err)));

    const send = (requestFn) => {
      const req = requestFn();
      req.on('error', fail);
      req.setTimeout(timeout, () => req.destroy(new Error('upstream timed out')));
      if (body) req.write(body);
      req.end();
    };

    // https through an upstream proxy: open a raw tunnel, then TLS over it.
    if (upstreamProxy && isHttps) {
      const proxy = new URL(upstreamProxy);
      const socket = net.connect(Number(proxy.port), proxy.hostname, () => {
        socket.write(`CONNECT ${url.hostname}:${port} HTTP/1.1\r\nHost: ${url.hostname}:${port}\r\n\r\n`);
      });
      socket.on('error', fail);

      let handshake = '';
      const onData = (chunk) => {
        handshake += chunk.toString('latin1');
        if (!handshake.includes('\r\n\r\n')) return;
        socket.removeListener('data', onData);

        const statusLine = handshake.slice(0, handshake.indexOf('\r\n'));
        if (!/ 200 /.test(statusLine)) {
          socket.destroy();
          fail(`upstream proxy refused CONNECT: ${statusLine}`);
          return;
        }

        const secure = tls.connect(
          { socket, servername: url.hostname, ca, rejectUnauthorized: !insecure },
          () => send(() => http.request({
            method,
            path: `${url.pathname}${url.search}`,
            headers: { host: url.host, ...headers },
            createConnection: () => secure,
          }, resolve)),
        );
        secure.on('error', fail);
      };
      socket.on('data', onData);
      return;
    }

    // http through an upstream proxy: absolute-form request line.
    if (upstreamProxy && !isHttps) {
      const proxy = new URL(upstreamProxy);
      send(() => http.request({
        host: proxy.hostname,
        port: Number(proxy.port),
        method,
        path: targetUrl,
        headers: { host: url.host, ...headers },
      }, resolve));
      return;
    }

    // Direct connection.
    const mod = isHttps ? https : http;
    send(() => mod.request({
      hostname: url.hostname,
      port,
      method,
      path: `${url.pathname}${url.search}`,
      headers: { host: url.host, ...headers },
      ca,
      rejectUnauthorized: !insecure,
    }, resolve));
  });
}
