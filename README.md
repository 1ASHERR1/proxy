# nebula

A zero-dependency **web proxy** — a website with a search box that opens pages
through its own address. You visit nebula, type a site or a search, and it
fetches the page on the server side and hands it back rewritten, so your browser
only ever talks to nebula. Nothing to install, nothing to build — just Node.

```bash
node bin/unblock.js          # then open http://127.0.0.1:8090
```

Open that address, type a site (`wikipedia.org`) or a search (`how tides work`),
and go.

## How it works

```
  you ─▶ nebula (one address)  ─▶ the site
       ◀─ rewritten page       ◀─
```

- The address is `/p/` followed by the real URL, e.g.
  `/p/https://en.wikipedia.org/wiki/Cat`. nebula fetches that, decodes gzip /
  brotli, and rewrites the HTML.
- Every URL in the page — `href`, `src`, `srcset`, `action`, `poster`, `<base>`,
  inline `style` and `<style>` `url(...)`, `<meta refresh>` — is rewritten to go
  back through `/p/`. Content-Security-Policy and subresource-integrity are
  stripped so the rewrites and a small injected script can take effect.
- The injected script patches `fetch`, `XMLHttpRequest` and `window.open` at
  runtime, so URLs a page builds in JavaScript are proxied too.
- Redirects are rewritten (not silently followed) so the address bar stays in
  sync, and cookies are re-scoped to the proxy.

Anything typed that isn't a URL becomes a DuckDuckGo search.

## Options

```
-p, --port <n>        port to listen on            (default 8090)
-h, --host <addr>     bind address                 (default 127.0.0.1)
    --search <url>    search template, %s = query  (default DuckDuckGo html)
    --upstream <url>  route outbound through another proxy (http://host:port)
    --ca <file>       extra CA bundle for upstream TLS
    --insecure        skip upstream TLS verification (last resort)
-q, --quiet           do not log each fetch
```

```bash
node bin/unblock.js --port 8090
node bin/unblock.js --search 'https://www.google.com/search?q=%s'
```

## What works, and what doesn't

Static and lightly-scripted sites — articles, docs, search results, most content
sites — read well. Sites behind a login, heavily interactive sites, and
streaming video are out of scope for a project this size; a full web proxy that
handles those is a much larger undertaking.

## A note on blocked networks

People often reach for a web proxy to get around a school or workplace filter.
Two honest caveats: doing that is usually against the network's acceptable-use
policy, and on a managed device or network it often won't work anyway — the
device blocks the tool, or the filter recognises the traffic. Run it in line with
the rules of whatever network you're on. It's also just a good way to learn how
the web fits together.

## Tests

```bash
npm test
```

Covering the URL / HTML / CSS rewriting (links, `srcset`, `<base>`, inline
styles, CSP / integrity stripping, query resolution) and end-to-end fetching
(redirect rewriting, gzip decode, cookie scoping, binary passthrough, the error
path).

## Layout

```
bin/unblock.js     CLI: arguments, listener, shutdown
src/webproxy.js    the server — fetch, rewrite, serve; /go query entry; error pages
src/rewrite.js     pure URL / HTML / CSS rewriting (unit-tested)
src/fetcher.js     outbound fetch, direct or via an upstream proxy
public/portal.html the landing page (search box)
```

## Security

The server binds to `127.0.0.1` by default, so only your own machine can reach
it. If you bind it to a public address, anyone who can reach it can browse the
web *through your machine, as your IP* — an open relay. Keep it on loopback, or
put real authentication in front of it.

## License

MIT
