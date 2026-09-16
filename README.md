# nebula

A forward proxy for HTTP and HTTPS with a live dashboard. Zero dependencies —
everything runs on the Node standard library, so there is nothing to install and
nothing to build.

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

24 tests covering forwarding, request bodies, status passthrough, header
hygiene, `CONNECT` tunnelling, rule precedence, authentication, the 502/400
paths, and the metric bounds.

## Layout

```
bin/nebula.js      CLI: arguments, config, listeners, shutdown
src/server.js      the proxy — HTTP forwarding and CONNECT tunnelling
src/stats.js       bounded metrics: counters, ring buffers, percentiles
src/rules.js       hostname allow/block matching
src/dashboard.js   read-only HTTP + SSE surface
src/log.js         terminal banner and request lines
public/            the dashboard (no build step)
```

## License

MIT
