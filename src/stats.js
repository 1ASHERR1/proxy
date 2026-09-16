/**
 * Rolling metrics for the proxy: counters, a per-second ring buffer for the
 * throughput charts, a latency ring for percentiles, and a recent-request log.
 *
 * Everything is bounded — the process can run for weeks without growing.
 */

const WINDOW_SECONDS = 180;
const LATENCY_SAMPLES = 512;
const LOG_ENTRIES = 250;
const MAX_TRACKED_HOSTS = 500;

export class Stats {
  constructor() {
    this.startedAt = Date.now();

    this.totals = {
      requests: 0,
      tunnels: 0,
      blocked: 0,
      errors: 0,
      bytesIn: 0,
      bytesOut: 0,
    };

    this.statusClasses = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    this.active = { requests: 0, tunnels: 0 };

    this.buckets = Array.from({ length: WINDOW_SECONDS }, () => ({
      t: 0, req: 0, http: 0, tunnel: 0, bytesIn: 0, bytesOut: 0, err: 0,
    }));

    this.latencies = new Float64Array(LATENCY_SAMPLES);
    this.latencyCount = 0;
    this.latencyCursor = 0;

    this.hosts = new Map();
    this.log = [];
    this.seq = 0;

    /** @type {Set<(entry: object) => void>} */
    this.listeners = new Set();
  }

  /** Subscribe to live log entries. Returns an unsubscribe function. */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(entry) {
    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {
        // A broken subscriber must never take down a proxied request.
      }
    }
  }

  _bucket(now = Date.now()) {
    const sec = Math.floor(now / 1000);
    const slot = this.buckets[sec % WINDOW_SECONDS];
    if (slot.t !== sec) {
      slot.t = sec;
      slot.req = 0;
      slot.http = 0;
      slot.tunnel = 0;
      slot.bytesIn = 0;
      slot.bytesOut = 0;
      slot.err = 0;
    }
    return slot;
  }

  _touchHost(host, bytes) {
    let record = this.hosts.get(host);
    if (!record) {
      // Bound the cardinality: once full, evict the quietest host.
      if (this.hosts.size >= MAX_TRACKED_HOSTS) {
        let quietest = null;
        let lowest = Infinity;
        for (const [name, rec] of this.hosts) {
          if (rec.requests < lowest) {
            lowest = rec.requests;
            quietest = name;
          }
        }
        if (quietest !== null) this.hosts.delete(quietest);
      }
      record = { requests: 0, bytes: 0, errors: 0 };
      this.hosts.set(host, record);
    }
    record.requests += 1;
    record.bytes += bytes;
    return record;
  }

  recordBytes(direction, bytes) {
    if (!bytes) return;
    const slot = this._bucket();
    if (direction === 'in') {
      this.totals.bytesIn += bytes;
      slot.bytesIn += bytes;
    } else {
      this.totals.bytesOut += bytes;
      slot.bytesOut += bytes;
    }
  }

  recordLatency(ms) {
    this.latencies[this.latencyCursor] = ms;
    this.latencyCursor = (this.latencyCursor + 1) % LATENCY_SAMPLES;
    this.latencyCount = Math.min(this.latencyCount + 1, LATENCY_SAMPLES);
  }

  /**
   * Record a completed request or tunnel.
   * @param {{kind:'http'|'tunnel', method:string, host:string, url:string,
   *          status:number|null, bytesIn:number, bytesOut:number,
   *          durationMs:number, outcome:'ok'|'blocked'|'error', detail?:string}} entry
   * @returns the stored record, with `id` and `at` filled in.
   */
  record(entry) {
    const now = Date.now();
    const slot = this._bucket(now);

    slot.req += 1;
    if (entry.kind === 'tunnel') {
      this.totals.tunnels += 1;
      slot.tunnel += 1;
    } else {
      this.totals.requests += 1;
      slot.http += 1;
    }

    if (entry.outcome === 'blocked') this.totals.blocked += 1;
    if (entry.outcome === 'error') {
      this.totals.errors += 1;
      slot.err += 1;
    }

    if (typeof entry.status === 'number') {
      const bucket = `${Math.floor(entry.status / 100)}xx`;
      if (bucket in this.statusClasses) this.statusClasses[bucket] += 1;
    }

    const host = this._touchHost(entry.host, entry.bytesIn + entry.bytesOut);
    if (entry.outcome === 'error') host.errors += 1;

    if (entry.durationMs >= 0) this.recordLatency(entry.durationMs);

    const record = { id: ++this.seq, at: now, ...entry };
    this.log.push(record);
    if (this.log.length > LOG_ENTRIES) this.log.shift();
    this._emit(record);
    return record;
  }

  percentile(p) {
    if (this.latencyCount === 0) return 0;
    const sample = Array.from(this.latencies.slice(0, this.latencyCount)).sort((a, b) => a - b);
    const idx = Math.min(sample.length - 1, Math.max(0, Math.ceil((p / 100) * sample.length) - 1));
    return sample[idx];
  }

  /** Per-second series, oldest → newest, always exactly WINDOW_SECONDS long. */
  series() {
    const nowSec = Math.floor(Date.now() / 1000);
    const out = new Array(WINDOW_SECONDS);
    for (let i = 0; i < WINDOW_SECONDS; i += 1) {
      const sec = nowSec - (WINDOW_SECONDS - 1 - i);
      const slot = this.buckets[((sec % WINDOW_SECONDS) + WINDOW_SECONDS) % WINDOW_SECONDS];
      out[i] = slot.t === sec
        ? {
          t: sec, req: slot.req, http: slot.http, tunnel: slot.tunnel,
          bytesIn: slot.bytesIn, bytesOut: slot.bytesOut, err: slot.err,
        }
        : { t: sec, req: 0, http: 0, tunnel: 0, bytesIn: 0, bytesOut: 0, err: 0 };
    }
    return out;
  }

  topHosts(limit = 8) {
    return [...this.hosts.entries()]
      .map(([host, rec]) => ({ host, ...rec }))
      .sort((a, b) => b.requests - a.requests || b.bytes - a.bytes)
      .slice(0, limit);
  }

  snapshot() {
    const series = this.series();
    const recent = series.slice(-10);
    const throughput = recent.reduce((sum, s) => sum + s.bytesIn + s.bytesOut, 0) / recent.length;

    return {
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      totals: { ...this.totals },
      statusClasses: { ...this.statusClasses },
      active: { ...this.active },
      throughputBps: throughput,
      latency: {
        p50: this.percentile(50),
        p95: this.percentile(95),
        samples: this.latencyCount,
      },
      series,
      topHosts: this.topHosts(),
      log: this.log.slice(-60),
    };
  }
}

export const WINDOW = WINDOW_SECONDS;
