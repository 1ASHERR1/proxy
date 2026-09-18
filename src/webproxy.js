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
 * heavily interactive sites, and streaming video are out of scope for a project
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

/**
 * Injected into every proxied page: patch runtime URL builders so dynamic
 * requests stay on the proxy, and mount a small navigation bar (home, back, an
 * address box, collapse) in an isolated shadow root so the host page's CSS can
 * neither touch it nor be touched by it.
 */
function clientPatch(target) {
  const T = JSON.stringify(target);
  const P = JSON.stringify(PREFIX);
  const MARK = '<svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">'
    + '<circle cx="16" cy="16" r="5.5" fill="#5b9dff"/>'
    + '<circle cx="16" cy="16" r="12" fill="none" stroke="#ff8a4c" stroke-width="2.4" stroke-dasharray="30 14" stroke-linecap="round"/></svg>';
  const CSS = ':host{all:initial}'
    + '.wrap{position:fixed;top:0;left:0;right:0;z-index:2147483647;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}'
    + '.bar{display:flex;align-items:center;gap:8px;height:44px;padding:0 10px;box-sizing:border-box;'
    + 'background:rgba(9,12,22,.86);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);'
    + 'border-bottom:1px solid rgba(255,255,255,.1);color:#eef1f8;font-size:13px}'
    + '.brand{display:flex;align-items:center;gap:7px;font-weight:650;color:#eef1f8;text-decoration:none;flex:none}'
    + '.btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:none;'
    + 'border-radius:8px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);'
    + 'color:#cdd4ea;cursor:pointer;font-size:15px;line-height:1}'
    + '.btn:hover{background:rgba(255,255,255,.1);color:#fff}'
    + '.addr{flex:1;min-width:0;display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.05);'
    + 'border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:0 10px;height:30px}'
    + '.addr .dot{width:6px;height:6px;border-radius:50%;background:#5b9dff;flex:none}'
    + '.addr input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:#eef1f8;font:inherit;font-size:13px}'
    + '.pill{position:fixed;top:10px;left:10px;z-index:2147483647;display:none;align-items:center;gap:7px;'
    + 'padding:7px 12px;border-radius:999px;background:rgba(9,12,22,.86);border:1px solid rgba(255,255,255,.14);'
    + 'color:#eef1f8;font:600 12px system-ui,sans-serif;cursor:pointer;'
    + '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}';
  // ASCII-only SVG icons so the bar never depends on the host page's charset.
  const BACK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
    + '<path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const MINUS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
    + '<path d="M6 12h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const HTML = '<div class="wrap"><div class="bar">'
    + '<a class="brand" href="/" title="nebula home">' + MARK + 'nebula</a>'
    + '<button class="btn" data-act="back" title="Back" aria-label="Back">' + BACK + '</button>'
    + '<form class="addr" data-act="goform"><span class="dot"></span>'
    + '<input type="text" spellcheck="false" aria-label="Address" placeholder="Search or enter a website"></form>'
    + '<button class="btn" data-act="collapse" title="Hide bar" aria-label="Hide bar">' + MINUS + '</button>'
    + '</div><button class="pill" data-act="expand" aria-label="Show nebula bar">' + MARK + 'nebula</button></div>';

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
    + `var CSS=${JSON.stringify(CSS)},BODY=${JSON.stringify(HTML)};`
    + 'function bar(){try{'
    + "if(document.getElementById('__nebula_host__'))return;"
    + "var host=document.createElement('div');host.id='__nebula_host__';"
    + 'var root=host.attachShadow?host.attachShadow({mode:"open"}):host;'
    + "var st=document.createElement('style');st.textContent=CSS;root.appendChild(st);"
    + "var w=document.createElement('div');w.innerHTML=BODY;while(w.firstChild)root.appendChild(w.firstChild);"
    + '(document.body||document.documentElement).appendChild(host);'
    + 'var DOC=document.documentElement;'
    + "function pad(on){DOC.style.setProperty('padding-top',on?'44px':'0','important');}"
    + "var barEl=root.querySelector('.bar'),pill=root.querySelector('.pill'),inp=root.querySelector('input');"
    + 'try{inp.value=T;}catch(e){}'
    + 'var hidden=false;try{hidden=localStorage.getItem("nebula-bar")==="0";}catch(e){}'
    + "function apply(){if(hidden){barEl.style.display='none';pill.style.display='inline-flex';pad(false);}"
    + "else{barEl.style.display='flex';pill.style.display='none';pad(true);}}apply();"
    + "root.querySelector('[data-act=back]').onclick=function(){if(history.length>1)history.back();else location.href='/';};"
    + 'root.querySelector("[data-act=collapse]").onclick=function(){hidden=true;try{localStorage.setItem("nebula-bar","0");}catch(e){}apply();};'
    + 'pill.onclick=function(){hidden=false;try{localStorage.setItem("nebula-bar","1");}catch(e){}apply();};'
    + "root.querySelector('[data-act=goform]').addEventListener('submit',function(e){e.preventDefault();"
    + "var v=inp.value.trim();if(v)location.href='/go?q='+encodeURIComponent(v);});"
    + '}catch(e){}}'
    + "if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bar);else bar();"
    + '})();</script>';
}

function errorPage(res, code, title, detail) {
  const body = `<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<style>:root{color-scheme:dark}*{box-sizing:border-box}'
    + 'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;'
    + 'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#070912;color:#eef1f8;'
    + 'background-image:radial-gradient(60vw 42vw at 50% -12%,rgba(63,122,224,.24),transparent 60%)}'
    + '.box{max-width:30rem;text-align:center}'
    + '.mk{width:46px;height:46px;margin:0 auto 20px;display:block}'
    + '.mk .r{transform-origin:16px 16px;animation:s 12s linear infinite}'
    + '@keyframes s{to{transform:rotate(360deg)}}'
    + '@media (prefers-reduced-motion:reduce){.mk .r{animation:none}}'
    + 'h1{font-size:1.3rem;font-weight:680;letter-spacing:-.02em;margin:0 0 .55rem}'
    + 'p{color:#aab1cc;line-height:1.62;margin:0 0 1.5rem}'
    + 'a{display:inline-block;color:#08122a;text-decoration:none;font-weight:640;'
    + 'background:linear-gradient(180deg,#7fb2ff,#5b9dff);padding:10px 20px;border-radius:12px;'
    + 'box-shadow:0 10px 24px -10px rgba(91,157,255,.7)}'
    + 'code{font-family:ui-monospace,Menlo,Consolas,monospace;background:rgba(255,255,255,.06);'
    + 'border:1px solid rgba(255,255,255,.1);padding:2px 6px;border-radius:6px;font-size:.85em;color:#cdd4ea}</style>'
    + '<div class="box"><svg class="mk" viewBox="0 0 32 32" aria-hidden="true">'
    + '<circle cx="16" cy="16" r="5.5" fill="#5b9dff"/>'
    + '<circle class="r" cx="16" cy="16" r="12.5" fill="none" stroke="#ff8a4c" stroke-width="2.4" stroke-dasharray="34 15" stroke-linecap="round"/>'
    + `</svg><h1>${title}</h1><p>${detail}</p><a href="/">Back to nebula</a></div>`;
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
        // We decoded to UTF-8 and re-encode as UTF-8; declare it so pages that
        // omitted a charset (and our injected glyphs) always render correctly.
        headers['content-type'] = isHtml ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8';
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
