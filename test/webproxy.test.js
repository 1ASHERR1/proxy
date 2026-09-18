import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';

import { createWebProxy } from '../src/webproxy.js';
import { PREFIX } from '../src/rewrite.js';

let origin;
let originPort;
let proxy;
let proxyPort;

/** GET through the proxy without following redirects, so Location is inspectable. */
function get(pathAndQuery, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, path: pathAndQuery, method },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

before(async () => {
  origin = http.createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head></head><body><a href="/next">n</a><img src="pic.png"></body></html>');
      return;
    }
    if (req.url === '/gzipped') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync('<html><body><a href="/deep/link">x</a></body></html>'));
      return;
    }
    if (req.url === '/redir') {
      res.writeHead(302, { location: '/target' });
      res.end();
      return;
    }
    if (req.url === '/setcookie') {
      res.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': 'sid=abc; Domain=example.com; Path=/; Secure; SameSite=None',
      });
      res.end('<html><body>ok</body></html>');
      return;
    }
    if (req.url === '/pixel.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });
  originPort = await listen(origin);

  ({ server: proxy } = createWebProxy({}));
  proxyPort = await listen(proxy);
});

after(async () => {
  await close(proxy);
  await close(origin);
});

const target = (path) => `${PREFIX}http://127.0.0.1:${originPort}${path}`;

describe('serving the portal', () => {
  test('the home page renders the search box', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.match(res.body.toString(), /nebula/);
    assert.match(res.body.toString(), /name="q"/);
  });

  test('robots.txt disallows crawling', async () => {
    const res = await get('/robots.txt');
    assert.match(res.body.toString(), /Disallow: \//);
  });
});

describe('the /go entry point', () => {
  test('a bare domain redirects into the proxy as https', async () => {
    const res = await get('/go?q=example.com');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `${PREFIX}https://example.com`);
  });

  test('free text becomes a search', async () => {
    const res = await get('/go?q=hello+world');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `${PREFIX}https://duckduckgo.com/html/?q=hello%20world`);
  });
});

describe('fetching and rewriting', () => {
  test('rewrites links and images in the fetched page', async () => {
    const res = await get(target('/page'));
    assert.equal(res.status, 200);
    const body = res.body.toString();
    assert.match(body, new RegExp(`href="${PREFIX}http://127.0.0.1:${originPort}/next"`));
    assert.match(body, new RegExp(`src="${PREFIX}http://127.0.0.1:${originPort}/pic.png"`));
  });

  test('injects the client patch and the home button', async () => {
    const body = (await get(target('/page'))).body.toString();
    assert.match(body, /window\.fetch/);
    assert.match(body, /Back to nebula/);
  });

  test('decompresses gzip before rewriting, and drops the encoding header', async () => {
    const res = await get(target('/gzipped'));
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], undefined);
    assert.match(res.body.toString(), new RegExp(`href="${PREFIX}http://127.0.0.1:${originPort}/deep/link"`));
  });

  test('rewrites a redirect Location back through the proxy', async () => {
    const res = await get(target('/redir'));
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `${PREFIX}http://127.0.0.1:${originPort}/target`);
  });

  test('scopes Set-Cookie to the proxy (drops Domain, Secure, SameSite=None)', async () => {
    const res = await get(target('/setcookie'));
    const cookie = res.headers['set-cookie'][0];
    assert.doesNotMatch(cookie, /Domain=/i);
    assert.doesNotMatch(cookie, /Secure/i);
    assert.doesNotMatch(cookie, /SameSite=None/i);
    assert.match(cookie, /SameSite=Lax/i);
  });

  test('streams a binary response through untouched', async () => {
    const res = await get(target('/pixel.png'));
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.deepEqual([...res.body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  test('reports an unreachable upstream as a 502 page', async () => {
    const res = await get(`${PREFIX}http://127.0.0.1:1/nope`);
    assert.equal(res.status, 502);
    assert.match(res.body.toString(), /reach that page/i);
  });
});

describe('quiet mode', () => {
  // A caller that passes `onRequest: undefined` (the -q flag) once crashed the
  // request with "config.onRequest is not a function"; it must serve normally.
  let quiet;
  let quietPort;

  before(async () => {
    ({ server: quiet } = createWebProxy({ onRequest: undefined }));
    quietPort = await listen(quiet);
  });
  after(async () => { await close(quiet); });

  test('serves a proxied page without an onRequest callback', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: quietPort, path: `${PREFIX}http://127.0.0.1:${originPort}/page` },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    assert.match(res.body, new RegExp(`href="${PREFIX}http://127.0.0.1:${originPort}/next"`));
  });
});
