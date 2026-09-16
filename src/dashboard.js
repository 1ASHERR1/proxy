import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/**
 * The read-only observability surface. It never proxies anything — it only
 * reads from the Stats instance the proxy writes to.
 */
export function createDashboard({ stats, proxyPort, proxyHost, version }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://dashboard');

    if (url.pathname === '/api/stats') {
      const body = JSON.stringify({ ...stats.snapshot(), proxyPort, proxyHost, version });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');

      const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      send('snapshot', { ...stats.snapshot(), proxyPort, proxyHost, version });

      const unsubscribe = stats.subscribe((entry) => send('request', entry));
      const ticker = setInterval(() => {
        send('snapshot', { ...stats.snapshot(), proxyPort, proxyHost, version });
      }, 1000);

      const cleanup = () => {
        clearInterval(ticker);
        unsubscribe();
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;
    }

    // Static files, path-traversal safe.
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(requested));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    try {
      const body = await fs.readFile(filePath);
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found\n');
    }
  });

  return server;
}
