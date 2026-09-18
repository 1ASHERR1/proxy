# nebula

Two zero-dependency proxies in one repo — everything runs on the Node standard
library, so there is nothing to install and nothing to build:

- **`nebula`** — a network **forward proxy** for HTTP and HTTPS, with a live
  dashboard. Point your system or a program at it with `http_proxy`/`https_proxy`.
- **`unblock`** — a **web proxy**: a site with a search box that fetches a page
  server-side and serves it back through its own address, rewriting the page's
  links so your browser keeps talking to the proxy. This is the "open a blocked
  site" kind of proxy — no client configuration, you just visit it.

```
    ███╗   ██╗███████╗██████╗ ██╗   ██╗██╗      █████╗
    ████╗  ██║██╔════╝██╔══██╗██║   ██║██║     ██╔══██╗
    ██╔██╗ ██║█████╗  ██████╔╝██║   ██║██║     ███████║
    ██║╚██╗██║██╔══╝  ██╔══██╗██║   ██║██║     ██╔══██║
    ██║ ╚████║███████╗██████╔╝╚██████╔╝███████╗██║  ██║
    ╚═╝  ╚═══╝╚══════╝╚═════╝  ╚═════╝ ╚══════╝╚═╝  ╚═╝
```

## Run it

```bash
node bin/nebula.js
```

That starts the proxy on `127.0.0.1:8080` and the dashboard on
`127.0.0.1:8081`. Point a client at it:

```bash
export http_proxy=http://127.0.0.1:8080
export https_proxy=http://127.0.0.1:8080

curl https://example.com          # tunnelled with CONNECT
```

Then open <http://127.0.0.1:8081> to watch the traffic.

## The web proxy

If what you want is "a website where I can open something that's blocked," that's
the web proxy, not the forward proxy above:

```bash
node bin/unblock.js            # then open http://127.0.0.1:8090
```

Open that address, type a site (`wikipedia.org`) or a search (`how tides work`)
into the box, and go. nebula fetches the page on the server side and serves it
back from its own address, rewriting every link, image, stylesheet and form so
your browser keeps talking to nebula instead of reaching for the origin site.

```
  you ─▶ nebula (one address)  ─▶ the site
       ◀─ rewritten page       ◀─
```

**Options**

```
-p, --port <n>        port to listen on            (default 8090)
-h, --host <addr>     bind address                 (default 127.0.0.1)
    --search <url>    search template, %s = query  (default DuckDuckGo html)
    --upstream <url>  route outbound through another proxy (http://host:port)
    --ca <file>       extra CA bundle for upstream TLS
    --insecure        skip upstream TLS verification (last resort)
-q, --quiet           do not log each fetch
```

**How it works**

- The address is `/p/` followed by the real URL, e.g.
  `/p/https://en.wikipedia.org/wiki/Cat`. The server fetches that, decodes gzip /
  brotli, and rewrites the HTML.
- URL attributes (`href`, `src`, `srcset`, `action`, `poster`, inline
  `style` and `<style>` `url(...)`, `<meta refresh>`) are rewritten to point back
  through `/p/`. Content-Security-Policy and subresource-integrity are stripped so
  the rewrites and a small injected script can take effect.
- That injected script patches `fetch`, `XMLHttpRequest` and `window.open` at
  runtime, so URLs a page builds in JavaScript are proxied too.
- Redirects are rewritten (not silently followed) so the address bar stays in
  sync; cookies are re-scoped to the proxy so they come back to it.

**What works, and what doesn't.** Static and lightly-scripted sites (articles,
docs, search results, most content sites) read well. Sites behind a login,
heavily interactive sites, and streaming video are out of scope for a project
this size — a full web proxy that handles those is a much larger undertaking.

**A word on blocked networks.** People often reach for a web proxy to get around
a school or workplace filter. Two honest caveats: doing that is usually against
the network's acceptable-use policy, and on a managed device or network it often
won't work anyway (the device blocks the tool, or the filter recognises the
traffic). Run this in line with the rules of whatever network you're on. It's
also just a genuinely good way to learn how the web fits together.

## The dashboard

Live over server-sent events, ~1 s refresh, no polling and no page reloads:

- **Throughput** — bytes per second down and up over the last three minutes,
  with a crosshair tooltip, arrow-key navigation, and a table view of the same
  numbers for anyone who can't use the chart.
- **Requests, tunnels, open connections, latency** — running counts plus p50/p95.
- **Top hosts** — request counts per destination, with bytes and errors on hover.
- **Response status** — the 2xx/3xx/4xx/5xx split, each row carrying an icon and
  a count so nothing depends on colour alone.
- **Live requests** — the last 250 requests, filterable by host or path.

Light and dark are both first-class; the toggle in the header wins over the OS
setting and is remembered. If the proxy goes away, the dashboard holds its last
render, dims, and reconnects on its own.

## Options

```
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
```

### Host patterns

Rules match on hostname, case-insensitively:

| Pattern | Matches |
|---|---|
| `example.com` | exactly that host |
| `*.example.com` | any subdomain **and** the apex |
| `*` | everything |

An allowlist, when present, is authoritative — anything not on it is refused.
The blocklist is applied to whatever survives, so a blocked host stays blocked
even under `--allow '*'`.

```bash
node bin/nebula.js --block '*.doubleclick.net,ads.example.com'
node bin/nebula.js --allow '*.internal.test'          # nothing else gets through
```

### Config file

`nebula.config.json` in the working directory is picked up automatically; `-c`
points somewhere else. Command-line flags override the file.

```json
{
  "port": 8080,
  "host": "127.0.0.1",
  "block": ["*.doubleclick.net", "telemetry.example.com"],
  "auth": { "username": "ada", "password": "lovelace" }
}
```

## What it actually does

- **Plain HTTP** is parsed, filtered, forwarded, and streamed back. Hop-by-hop
  headers (`connection`, `proxy-authorization`, `transfer-encoding`, …) are
  stripped in both directions per RFC 9110, and a `Via: 1.1 nebula` header is
  added on the way out.
- **HTTPS** goes through `CONNECT`. The tunnel is opaque: nebula counts bytes and
  timing but never inspects or modifies the stream, and it adds no headers to
  it. There is no TLS interception and no certificate to install.
- **Failures** are reported honestly — `502` when the upstream refuses or times
  out, `403` with the matching rule when a request is blocked, `407` when
  authentication is required, `400` for a request that arrived at the proxy port
  without going through the proxy.

Metrics are all bounded: a 180-second ring buffer for the charts, 512 latency
samples, 250 log entries, and at most 500 tracked hosts. It can run for weeks
without growing.

## Security

The defaults are deliberately narrow.

- Both listeners bind to **loopback only**. Nothing outside the machine can
  reach them until you say so.
- An open forward proxy on a public interface is an **open relay** — anyone who
  can route to it can send traffic through your host, attributed to your IP.
  Binding to a non-loopback address without `--auth` prints a warning for
  exactly this reason. If you bind it outward, use `--auth`, and prefer an
  `--allow` list over a blocklist.
- `--auth` is HTTP Basic over an unencrypted proxy hop, so the credential is
  only as private as the network between client and proxy. It keeps casual
  neighbours off the port; it is not a substitute for a trusted network.
- The dashboard is read-only — it renders the counters and can't change proxy
  behaviour — but it does show every URL that passed through. Treat that as
  sensitive and keep it on loopback.

## Tests

```bash
npm test
```

68 tests. The forward proxy: forwarding, request bodies, status passthrough,
header hygiene, `CONNECT` tunnelling, rule precedence, authentication, the
502/400 paths, metric bounds, and the chart helpers. The web proxy: URL/HTML/CSS
rewriting, `srcset` and inline styles, CSP/integrity stripping, query
resolution, and end-to-end fetching (redirects, gzip, cookie scoping, binary
passthrough, the 502 path).

## Layout

```
bin/nebula.js      forward-proxy CLI: arguments, config, listeners, shutdown
bin/unblock.js     web-proxy CLI
src/server.js      the forward proxy — HTTP forwarding and CONNECT tunnelling
src/stats.js       bounded metrics: counters, ring buffers, percentiles
src/rules.js       hostname allow/block matching
src/dashboard.js   read-only HTTP + SSE surface
src/log.js         terminal banner and request lines
src/webproxy.js    the web proxy — fetch, rewrite, serve
src/rewrite.js     pure URL/HTML/CSS rewriting (unit-tested)
src/fetcher.js     outbound fetch, direct or via an upstream proxy
public/            the dashboard and the web-proxy portal (no build step)
```

## License

MIT
