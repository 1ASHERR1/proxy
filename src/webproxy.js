/**
 * The web ("unblocker") proxy: a site with a search box that fetches a target
 * page server-side and serves it back through our own origin, rewriting every
 * URL so the browser keeps talking to us instead of the origin site.
 *
 *   GET /               → the portal (search box)
 *   GET /go?q=...       → resolve a query to a URL and redirect into /p/
 *   *   /p/<target-url> → fetch, rewrite, and serve the target
 *
 * Static pages and progressively-enhanced sites work well. Login-walled sites,
 * heavy single-page apps, and streaming video are out of scope for a project
 * this size — the README says so plainly.
 */

import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requestUpstream } from './fetcher.js';
import {
  PREFIX, rewriteHtml, rewriteCss, resolveQuery,
} from './rewrite.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Response headers that must not survive the trip through the proxy.
const DROP_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'content-length', // recomputed for rewritten bodies, preserved otherwise
  'transfer-encoding',
  'connection',
  'keep-alive',
  'public-key-pins',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
]);

function decompress(buffer, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buffer);
    if (encoding === 'deflate') return zlib.inflateSync(buffer);
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    // A body that doesn't decompress is served as-is rather than lost.
  }
  return buffer;
}

/** Scope cookies to the proxy origin so they come back to us, not the origin site. */
function rewriteCookies(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list.map((c) => c
    .replace(/;\s*Domain=[^;]+/gi, '')
    .replace(/;\s*Secure/gi, '')
    .replace(/;\s*SameSite=None/gi, '; SameSite=Lax'));
}

/** The invisible client-side patch: catch URLs that only appear at runtime. */
function clientPatch(target) {
  const T = JSON.stringify(target);
  const P = JSON.stringify(PREFIX);
  return `<script>(function(){var T=${T},P=${P};`
    + 'function px(u){try{if(u==null)return u;var s=String(u).trim();'
    + "if(s===''||/^(#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(s))return u;"
    + 'if(s.indexOf(P)===0)return s;if(s.indexOf(location.origin+P)===0)return s;'
    + "var a=new URL(s,T);if(a.protocol!=='http:'&&a.protocol!=='https:')return u;return P+a.href;}catch(e){return u;}}"
    + 'var f=window.fetch;if(f){window.fetch=function(i,o){try{if(typeof i==="string")i=px(i);'
    + 'else if(i&&i.url)i=new Request(px(i.url),i);}catch(e){}return f.call(this,i,o);};}'
    + 'var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){'
    + 'try{u=px(u);}catch(e){}return xo.apply(this,[m,u].concat([].slice.call(arguments,2)));};'
    + 'var wo=window.open;window.open=function(u){try{u=px(u);}catch(e){}'
    + 'return wo.apply(this,[u].concat([].slice.call(arguments,1)));};'
    + '})();</script>'
    // A tiny, high-z-index way home that borrows nothing from the page's styles.
    + '<a href="/" style="position:fixed;z-index:2147483647;right:14px;bottom:14px;'
    + 'font:600 12px system-ui,sans-serif;color:#fff;background:#2a78d6;text-decoration:none;'
    + 'padding:7px 12px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.28)" '
    + 'aria-label="Back to nebula">◈ nebula</a>';
}

function errorPage(res, code, title, detail) {
  const body = `<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;'
    + 'font-family:system-ui,sans-serif;background:#0d0d0d;color:#e8e8e6}'
    + '.box{max-width:30rem;padding:2rem;text-align:center}h1{font-size:1.2rem;margin:0 0 .5rem}'
    + 'p{color:#9a9a94;line-height:1.6;margin:0 0 1.25rem}a{color:#3987e5}'
    + 'code{background:#1e1e1c;padding:2px 6px;border-radius:5px;font-size:.85em}</style>'
    + `<div class="box"><h1>${title}</h1><p>${detail}</p><a href="/">← Back to nebula</a></div>`;
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

export function createWebProxy(options = {}) {
  const config = {
    upstreamProxy: null,
    ca: undefined,
    insecure: false,
    searchTemplate: 'https://duckduckgo.com/html/?q=%s',
    ...options,
  };
  // A caller may pass `onRequest: undefined` (e.g. a quiet flag); the spread
  // above lets that win over a default, so normalise it to a real function.
  const report = typeof config.onRequest === 'function' ? config.onRequest : () => {};

  async function proxy(req, res, target) {
    let url = target;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    // Buffer a request body for POST/PUT so forms and logins can work.
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const reqBody = chunks.length ? Buffer.concat(chunks) : undefined;

    const outHeaders = {
      'user-agent': req.headers['user-agent'] || 'Mozilla/5.0 (compatible; nebula)',
      accept: req.headers.accept || '*/*',
      'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
    };
    if (req.headers.cookie) outHeaders.cookie = req.headers.cookie;
    if (reqBody && req.headers['content-type']) outHeaders['content-type'] = req.headers['content-type'];

    let upstream;
    try {
      upstream = await requestUpstream(url, {
        method: req.method,
        headers: outHeaders,
        body: reqBody,
        upstreamProxy: config.upstreamProxy,
        ca: config.ca,
        insecure: config.insecure,
      });
    } catch (err) {
      report({ target: url, status: 502, detail: err.message });
      errorPage(res, 502, "Couldn't reach that page",
        `nebula tried to load <code>${url.replace(/[<>&"]/g, '')}</code> but the site didn't answer.`);
      return;
    }

    const status = upstream.statusCode || 502;
    report({ target: url, status });

    // Rewrite redirects so the browser follows them back through the proxy.
    if (status >= 300 && status < 400 && upstream.headers.location) {
      upstream.resume();
      try {
        const loc = new URL(upstream.headers.location, url).href;
        res.writeHead(status, { location: PREFIX + loc, 'content-type': 'text/plain' });
        res.end(`Redirecting to ${loc}`);
      } catch {
        errorPage(res, 502, 'Bad redirect', 'The site sent a redirect nebula could not follow.');
      }
      return;
    }

    // Copy through the headers we keep.
    const headers = {};
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (!DROP_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
    if (upstream.headers['set-cookie']) headers['set-cookie'] = rewriteCookies(upstream.headers['set-cookie']);

    const contentType = (upstream.headers['content-type'] || '').toLowerCase();
    const isHtml = contentType.includes('text/html');
    const isCss = contentType.includes('text/css');

    // Text we rewrite; everything else streams straight through.
    if (isHtml || isCss) {
      const bodyChunks = [];
      upstream.on('data', (c) => bodyChunks.push(c));
      upstream.on('end', () => {
        const raw = decompress(Buffer.concat(bodyChunks), upstream.headers['content-encoding']);
        const text = raw.toString('utf8');
        const out = isHtml
          ? rewriteHtml(text, url, { inject: clientPatch(url) })
          : rewriteCss(text, url);
        delete headers['content-encoding'];
        headers['content-length'] = Buffer.byteLength(out);
        res.writeHead(status, headers);
        res.end(out);
      });
      upstream.on('error', () => errorPage(res, 502, 'Connection dropped', 'The page stopped sending data.'));
      return;
    }

    res.writeHead(status, headers);
    upstream.pipe(res);
  }

  function serveStatic(res, file, type) {
    fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
      if (err) {
        errorPage(res, 404, 'Not found', 'That page is not part of nebula.');
        return;
      }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      ({ pathname } = new URL(req.url, 'http://nebula'));
    } catch {
      errorPage(res, 400, 'Bad request', 'That address is malformed.');
      return;
    }

    // Everything after the /p/ prefix is the raw target URL (query and all).
    if (req.url.startsWith(PREFIX)) {
      proxy(req, res, req.url.slice(PREFIX.length)).catch((err) => {
        if (!res.headersSent) errorPage(res, 500, 'Proxy error', err.message);
      });
      return;
    }

    if (pathname === '/go') {
      const q = new URL(req.url, 'http://nebula').searchParams.get('q');
      const target = resolveQuery(q, config.searchTemplate);
      if (!target) {
        res.writeHead(302, { location: '/' });
        res.end();
        return;
      }
      res.writeHead(302, { location: PREFIX + target });
      res.end();
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      serveStatic(res, 'portal.html', 'text/html; charset=utf-8');
      return;
    }
    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /\n');
      return;
    }
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
      return;
    }

    errorPage(res, 404, 'Not found', 'Try starting from the <a href="/">home page</a>.');
  });

  return { server };
}
