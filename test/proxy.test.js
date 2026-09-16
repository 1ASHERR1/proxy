import { test, before, after, describe } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';

import { createProxy } from '../src/server.js';
import { RuleSet } from '../src/rules.js';
import { Stats } from '../src/stats.js';
import { startOrigin, throughProxy, throughTunnel, listen, close } from './helpers.js';

let origin;
let originPort;
let proxy;
let proxyPort;
let entries;

before(async () => {
  ({ server: origin, port: originPort } = await startOrigin());
  entries = [];
  proxy = createProxy({
    rules: new RuleSet({ block: ['blocked.example.com', '*.ads.example.com'] }),
    timeout: 2000,
    onEntry: (entry) => entries.push(entry),
  });
  proxyPort = await listen(proxy.server);
});

after(async () => {
  await close(proxy.server);
  await close(origin);
});

describe('http forwarding', () => {
  test('forwards a GET and returns the origin response', async () => {
    const res = await throughProxy(proxyPort, `http://127.0.0.1:${originPort}/hello`);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).url, '/hello');
  });

  test('forwards a request body', async () => {
    const res = await throughProxy(proxyPort, `http://127.0.0.1:${originPort}/post`, {
      method: 'POST', body: 'hello=world',
    });
    assert.equal(JSON.parse(res.body).body, 'hello=world');
  });

  test('passes large bodies through intact', async () => {
    const res = await throughProxy(proxyPort, `http://127.0.0.1:${originPort}/big`);
    assert.equal(res.body.length, 50_000);
  });

  test('preserves origin status codes', async () => {
    for (const code of [404, 500]) {
      const res = await throughProxy(proxyPort, `http://127.0.0.1:${originPort}/status/${code}`);
      assert.equal(res.status, code);
    }
  });

  test('adds a Via header and strips hop-by-hop headers', async () => {
    const res = await throughProxy(proxyPort, `http://127.0.0.1:${originPort}/headers`, {
      headers: { 'proxy-connection': 'keep-alive', 'proxy-authorization': 'Basic xxx' },
    });
    const seen = JSON.parse(res.body);
    assert.equal(seen.via, '1.1 nebula');
    assert.equal(seen.proxyAuthSeen, false, 'proxy-authorization must not reach the origin');
    assert.equal(seen.proxyConnectionSeen, false, 'proxy-connection must not reach the origin');
  });

  test('answers a non-absolute request with guidance, not a crash', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxyPort, path: '/', method: 'GET' },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /forward proxy/);
  });

  test('returns 502 when the upstream refuses the connection', async () => {
    const res = await throughProxy(proxyPort, 'http://127.0.0.1:1/unreachable');
    assert.equal(res.status, 502);
  });
});

describe('CONNECT tunnelling', () => {
  test('tunnels a request end to end', async () => {
    const res = await throughTunnel(proxyPort, `127.0.0.1:${originPort}`, '/tunnelled');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).url, '/tunnelled');
  });

  test('refuses a blocked host with 403', async () => {
    const res = await throughTunnel(proxyPort, 'blocked.example.com:443', '/');
    assert.equal(res.status, 403);
  });
});

describe('rules', () => {
  test('blocks an exact host', async () => {
    const res = await throughProxy(proxyPort, 'http://blocked.example.com/');
    assert.equal(res.status, 403);
    assert.match(res.body, /denied/);
  });

  test('blocks a wildcard subdomain but not an unrelated host', () => {
    const rules = new RuleSet({ block: ['*.ads.example.com'] });
    assert.equal(rules.check('tracker.ads.example.com').allowed, false);
    assert.equal(rules.check('ads.example.com').allowed, false, 'the apex is covered too');
    assert.equal(rules.check('example.com').allowed, true);
    assert.equal(rules.check('notads.example.com').allowed, true);
  });

  test('an allowlist denies everything not on it', () => {
    const rules = new RuleSet({ allow: ['*.internal.test'] });
    assert.equal(rules.check('api.internal.test').allowed, true);
    assert.equal(rules.check('example.com').allowed, false);
  });

  test('a blocklist entry wins over the allowlist', () => {
    const rules = new RuleSet({ allow: ['*'], block: ['bad.example.com'] });
    assert.equal(rules.check('good.example.com').allowed, true);
    assert.equal(rules.check('bad.example.com').allowed, false);
  });

  test('rule matching is case-insensitive', () => {
    const rules = new RuleSet({ block: ['Blocked.Example.COM'] });
    assert.equal(rules.check('blocked.example.com').allowed, false);
  });
});

describe('authentication', () => {
  let authProxy;
  let authPort;

  before(async () => {
    authProxy = createProxy({ auth: { username: 'ada', password: 'lovelace' } });
    authPort = await listen(authProxy.server);
  });
  after(async () => { await close(authProxy.server); });

  test('challenges an unauthenticated request with 407', async () => {
    const res = await throughProxy(authPort, `http://127.0.0.1:${originPort}/private`);
    assert.equal(res.status, 407);
    assert.match(res.headers['proxy-authenticate'], /^Basic/);
  });

  test('rejects wrong credentials', async () => {
    const wrong = Buffer.from('ada:wrong').toString('base64');
    const res = await throughProxy(authPort, `http://127.0.0.1:${originPort}/private`, {
      headers: { 'proxy-authorization': `Basic ${wrong}` },
    });
    assert.equal(res.status, 407);
  });

  test('accepts correct credentials', async () => {
    const ok = Buffer.from('ada:lovelace').toString('base64');
    const res = await throughProxy(authPort, `http://127.0.0.1:${originPort}/private`, {
      headers: { 'proxy-authorization': `Basic ${ok}` },
    });
    assert.equal(res.status, 200);
  });
});

describe('stats', () => {
  test('every recorded entry carries a timestamp for the log line', () => {
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.equal(typeof entry.at, 'number', 'onEntry must receive the stored record');
      assert.ok(Number.isFinite(new Date(entry.at).getTime()));
      assert.equal(typeof entry.id, 'number');
    }
  });

  test('counts requests, bytes and status classes', () => {
    const snap = proxy.stats.snapshot();
    assert.ok(snap.totals.requests > 0);
    assert.ok(snap.totals.bytesIn > 0);
    assert.ok(snap.totals.blocked > 0);
    assert.ok(snap.statusClasses['2xx'] > 0);
    assert.ok(snap.statusClasses['4xx'] > 0);
    assert.ok(snap.statusClasses['5xx'] > 0);
  });

  test('the series is a fixed-width window ending now', () => {
    const series = proxy.stats.snapshot().series;
    assert.equal(series.length, 180);
    assert.equal(series.at(-1).t, Math.floor(Date.now() / 1000));
    for (let i = 1; i < series.length; i += 1) {
      assert.equal(series[i].t - series[i - 1].t, 1, 'buckets are contiguous seconds');
    }
  });

  test('percentiles are ordered and bounded', () => {
    const stats = new Stats();
    for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) stats.recordLatency(ms);
    assert.equal(stats.percentile(50), 50);
    assert.equal(stats.percentile(100), 100);
    assert.ok(stats.percentile(95) >= stats.percentile(50));
  });

  test('percentiles on an empty sample do not throw', () => {
    assert.equal(new Stats().percentile(50), 0);
  });

  test('host cardinality stays bounded', () => {
    const stats = new Stats();
    for (let i = 0; i < 900; i += 1) stats._touchHost(`host-${i}.example`, 10);
    assert.ok(stats.hosts.size <= 500);
  });

  test('a throwing log consumer cannot take down a request', async () => {
    const noisy = createProxy({ onEntry: () => { throw new Error('bad consumer'); } });
    const port = await listen(noisy.server);
    const res = await throughProxy(port, `http://127.0.0.1:${originPort}/resilient`);
    assert.equal(res.status, 200);
    await close(noisy.server);
  });
});
