/* nebula dashboard — live proxy traffic. No build step, no dependencies. */

import {
  splitBytes, fmtBytes, fmtRate, fmtCount, fmtMs, fmtDuration,
  niceBytes, truncate, clockOf,
} from './format.js';

const NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

const el = {
  version: $('version'),
  endpoint: $('endpoint'),
  endpointText: $('endpoint-text'),
  connection: $('connection'),
  connectionText: $('connection-text'),
  theme: $('theme'),

  heroValue: $('hero-value'),
  heroUnit: $('hero-unit'),
  heroSub: $('hero-sub'),
  heroSpark: $('hero-spark'),

  tpLegend: $('tp-legend'),
  tpPlot: $('tp-plot'),
  tpTable: $('tp-table'),
  hostsPlot: $('hosts-plot'),
  statusMeter: $('status-meter'),
  statusLegend: $('status-legend'),

  logBody: $('log-body'),
  logFilter: $('log-filter'),
  tooltip: $('tooltip'),
};

const SERIES = [
  { key: 'bytesIn', name: 'Down', color: 'var(--series-1)' },
  { key: 'bytesOut', name: 'Up', color: 'var(--series-2)' },
];

let snapshot = null;
let logEntries = [];
let seeded = false;
let cursor = null;       // hovered / keyboard-selected index on the throughput chart
let tpView = 'chart';

/* --- tiny SVG helpers ----------------------------------------------------- */

function node(name, attrs = {}) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function text(str, attrs = {}) {
  const e = node('text', { 'font-size': 11, fill: 'var(--text-muted)', ...attrs });
  e.textContent = str;
  return e;
}

/** Square at the baseline, 4px rounded at the data end. */
function barPath(x, y, w, h, r = 4) {
  const rr = Math.max(0, Math.min(r, w, h / 2));
  return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} `
    + `V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`;
}

/* --- tooltip -------------------------------------------------------------- */

function showTooltip(html, clientX, clientY) {
  el.tooltip.innerHTML = html;
  el.tooltip.hidden = false;
  const box = el.tooltip.getBoundingClientRect();
  const x = Math.min(window.innerWidth - box.width - 12, Math.max(12, clientX + 14));
  const y = Math.max(12, clientY - box.height - 12);
  el.tooltip.style.left = `${x}px`;
  el.tooltip.style.top = `${y}px`;
}

const hideTooltip = () => { el.tooltip.hidden = true; };

/* --- throughput chart ----------------------------------------------------- */

function renderThroughput() {
  const host = el.tpPlot;
  if (!snapshot || tpView !== 'chart') return;

  const width = host.clientWidth;
  const height = host.clientHeight;
  if (width < 80 || height < 80) return;

  // The right gutter holds the end labels; a narrow screen cannot spare 88px.
  const pad = { top: 14, right: width < 480 ? 62 : 88, bottom: 22, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const data = snapshot.series;
  const n = data.length;
  const peak = data.reduce((m, d) => Math.max(m, d.bytesIn, d.bytesOut), 0);
  const yMax = niceBytes(peak);

  const xAt = (i) => pad.left + (n === 1 ? 0 : (i * plotW) / (n - 1));
  const yAt = (v) => pad.top + plotH - (Math.min(v, yMax) / yMax) * plotH;

  const svg = node('svg', { viewBox: `0 0 ${width} ${height}`, role: 'presentation' });

  // Gridlines — solid hairlines, one step off the surface.
  for (let i = 0; i <= 2; i += 1) {
    const value = (yMax / 2) * i;
    const y = yAt(value);
    svg.append(node('line', {
      x1: pad.left, x2: pad.left + plotW, y1: y, y2: y,
      stroke: i === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1,
    }));
    svg.append(text(i === 0 ? '0' : fmtRate(value), {
      x: pad.left - 8, y: y + 3.5, 'text-anchor': 'end',
      style: 'font-variant-numeric: tabular-nums',
    }));
  }

  // X axis: minutes back from now.
  for (const [i, label] of [[0, '3m'], [60, '2m'], [120, '1m'], [n - 1, 'now']]) {
    svg.append(text(label, {
      x: xAt(i), y: height - 6,
      'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
    }));
  }

  // Areas first, then lines, so the 2px strokes stay crisp.
  for (const s of SERIES) {
    const points = data.map((d, i) => `${xAt(i)},${yAt(d[s.key])}`);
    svg.append(node('path', {
      d: `M${pad.left},${yAt(0)} L${points.join(' L')} L${xAt(n - 1)},${yAt(0)} Z`,
      fill: s.color, opacity: 0.1,
    }));
  }
  for (const s of SERIES) {
    svg.append(node('path', {
      d: `M${data.map((d, i) => `${xAt(i)},${yAt(d[s.key])}`).join(' L')}`,
      fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
  }

  // Direct end labels in the right gutter. When the two ends converge, the
  // labels separate and leader lines keep each tied to its own series.
  const ends = SERIES.map((s) => ({
    series: s,
    value: data[n - 1][s.key],
    y: yAt(data[n - 1][s.key]),
  })).sort((a, b) => a.y - b.y);

  const MIN_GAP = 15;
  if (ends.length === 2 && ends[1].y - ends[0].y < MIN_GAP) {
    // Separate the pair, then shift the *pair* back inside the box. Clamping
    // each label independently would collapse the gap again whenever both
    // series sit on the baseline — which is exactly when they collide.
    const mid = (ends[0].y + ends[1].y) / 2;
    const ceiling = pad.top + 6;
    const floor = pad.top + plotH + 8;        // a little into the bottom padding
    let top = mid - MIN_GAP / 2;
    let bottom = mid + MIN_GAP / 2;
    if (bottom > floor) { bottom = floor; top = floor - MIN_GAP; }
    if (top < ceiling) { top = ceiling; bottom = ceiling + MIN_GAP; }
    ends[0].labelY = top;
    ends[1].labelY = bottom;
  } else {
    for (const e of ends) e.labelY = e.y;
  }

  for (const e of ends) {
    const x = xAt(n - 1);
    svg.append(node('path', {
      d: `M${x + 5},${e.y} L${x + 13},${e.labelY} L${x + 19},${e.labelY}`,
      fill: 'none', stroke: 'var(--axis)', 'stroke-width': 1,
    }));
    svg.append(node('circle', {
      cx: x, cy: e.y, r: 4,
      fill: e.series.color, stroke: 'var(--surface)', 'stroke-width': 2,
    }));
    svg.append(text(fmtRate(e.value), {
      x: x + 23, y: e.labelY + 3.5,
      fill: 'var(--text-secondary)',
      style: 'font-variant-numeric: tabular-nums',
    }));
  }

  // Crosshair layer.
  const crosshair = node('g', { opacity: 0 });
  const hairline = node('line', {
    y1: pad.top, y2: pad.top + plotH, stroke: 'var(--axis)', 'stroke-width': 1,
  });
  crosshair.append(hairline);
  const marks = SERIES.map((s) => {
    const dot = node('circle', {
      r: 4.5, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2,
    });
    crosshair.append(dot);
    return dot;
  });
  svg.append(crosshair);

  const capture = node('rect', {
    x: pad.left, y: pad.top, width: plotW, height: plotH,
    fill: 'transparent', style: 'cursor: crosshair',
  });
  svg.append(capture);

  const paint = (index, clientX, clientY) => {
    const d = data[index];
    hairline.setAttribute('x1', xAt(index));
    hairline.setAttribute('x2', xAt(index));
    marks.forEach((dot, i) => {
      dot.setAttribute('cx', xAt(index));
      dot.setAttribute('cy', yAt(d[SERIES[i].key]));
    });
    crosshair.setAttribute('opacity', 1);

    const rows = SERIES.map((s) => `
      <div class="tt-row">
        <span class="dot" style="background:${s.color}"></span>${s.name}
        <span class="tt-value">${fmtRate(d[s.key])}</span>
      </div>`).join('');
    showTooltip(`
      <div class="tt-title">${clockOf(d.t)}</div>
      ${rows}
      <div class="tt-row" style="margin-top:6px">Requests<span class="tt-value">${d.req}</span></div>
    `, clientX, clientY);
  };

  capture.addEventListener('mousemove', (event) => {
    const rect = host.getBoundingClientRect();
    const ratio = (event.clientX - rect.left - pad.left) / plotW;
    cursor = Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1))));
    paint(cursor, event.clientX, event.clientY);
  });
  capture.addEventListener('mouseleave', () => {
    cursor = null;
    crosshair.setAttribute('opacity', 0);
    hideTooltip();
  });

  // Keyboard reaches the same values as hover.
  host.onkeydown = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    cursor = Math.max(0, Math.min(n - 1, (cursor ?? n - 1) + step));
    const rect = host.getBoundingClientRect();
    paint(cursor, rect.left + xAt(cursor), rect.top + pad.top + plotH / 2);
  };
  host.onblur = () => { cursor = null; hideTooltip(); };

  host.replaceChildren(svg);
  if (cursor !== null && document.activeElement === host) {
    const rect = host.getBoundingClientRect();
    paint(cursor, rect.left + xAt(cursor), rect.top + pad.top + plotH / 2);
  }

  el.tpLegend.replaceChildren(...SERIES.map((s) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="key" style="background:${s.color}"></span>${s.name}`
      + `<span class="legend-value">${fmtRate(data[n - 1][s.key])}</span>`;
    return li;
  }));
}

/** The WCAG-clean twin of the throughput chart: 15-second buckets. */
function renderThroughputTable() {
  if (!snapshot) return;
  const buckets = [];
  for (let i = 0; i < snapshot.series.length; i += 15) {
    const slice = snapshot.series.slice(i, i + 15);
    buckets.push({
      t: slice[0].t,
      bytesIn: slice.reduce((s, d) => s + d.bytesIn, 0),
      bytesOut: slice.reduce((s, d) => s + d.bytesOut, 0),
      req: slice.reduce((s, d) => s + d.req, 0),
    });
  }

  const rows = buckets.reverse().map((b) => `
    <tr>
      <td>${clockOf(b.t)}</td>
      <td class="num">${fmtBytes(b.bytesIn)}</td>
      <td class="num">${fmtBytes(b.bytesOut)}</td>
      <td class="num">${b.req}</td>
    </tr>`).join('');

  el.tpTable.innerHTML = `
    <table>
      <caption class="visually-hidden">Throughput in 15-second buckets</caption>
      <thead><tr><th scope="col">Time</th><th scope="col" class="num">Down</th><th scope="col" class="num">Up</th><th scope="col" class="num">Requests</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* --- sparklines ----------------------------------------------------------- */

/** 12 points, de-emphasis hue, with the current period in the accent. */
function sparkline(svg, values, accent = 'var(--series-1)') {
  const width = svg.clientWidth;
  const height = svg.clientHeight;
  if (width < 20 || height < 8) return;

  const pad = 3;
  const max = Math.max(1, ...values);
  const xAt = (i) => (i * width) / Math.max(1, values.length - 1);
  const yAt = (v) => height - pad - (v / max) * (height - pad * 2);

  const points = values.map((v, i) => `${xAt(i)},${yAt(v)}`);
  const g = node('svg', { viewBox: `0 0 ${width} ${height}` });

  g.append(node('path', {
    d: `M${points.join(' L')}`,
    fill: 'none', stroke: 'var(--deemphasis)', 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));
  g.append(node('path', {
    d: `M${points.slice(-2).join(' L')}`,
    fill: 'none', stroke: accent, 'stroke-width': 2, 'stroke-linecap': 'round',
  }));
  g.append(node('circle', {
    cx: xAt(values.length - 1), cy: yAt(values.at(-1)), r: 4,
    fill: accent, stroke: 'var(--surface)', 'stroke-width': 2,
  }));

  svg.replaceChildren(...g.childNodes);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
}

/** Roll the per-second series up into `count` equal buckets. */
function rollup(series, key, count) {
  const size = Math.floor(series.length / count);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const slice = series.slice(i * size, (i + 1) * size);
    out.push(slice.reduce((sum, d) => sum + d[key], 0));
  }
  return out;
}

/* --- top hosts ------------------------------------------------------------ */

function renderHosts() {
  const host = el.hostsPlot;
  if (!snapshot) return;

  const width = host.clientWidth;
  const height = host.clientHeight;
  if (width < 80) return;

  const rows = snapshot.topHosts.slice(0, 7);
  if (rows.length === 0) {
    host.innerHTML = '<p class="card-note" style="padding-top:64px;text-align:center">No traffic yet.</p>';
    return;
  }

  const gutter = 62;                       // room for the value at the tip
  const trackW = width - gutter;
  const rowH = Math.min(34, height / rows.length);
  const barH = 10;
  const max = Math.max(...rows.map((r) => r.requests));

  const svg = node('svg', { viewBox: `0 0 ${width} ${height}` });

  rows.forEach((row, i) => {
    const y = i * rowH;
    const w = Math.max(2, (row.requests / max) * trackW);
    const barY = y + rowH - barH - 6;

    svg.append(text(truncate(row.host, Math.floor(trackW / 6.4)), {
      x: 0, y: y + 13, fill: 'var(--text-secondary)', 'font-size': 12,
    }));
    svg.append(node('path', { d: barPath(0, barY, w, barH), fill: 'var(--series-1)' }));
    svg.append(text(fmtCount(row.requests), {
      x: w + 8, y: barY + barH / 2 + 3.5,
      fill: 'var(--text-primary)', 'font-size': 11,
      style: 'font-variant-numeric: tabular-nums',
    }));

    const hit = node('rect', { x: 0, y, width, height: rowH, fill: 'transparent' });
    hit.addEventListener('mousemove', (event) => showTooltip(`
      <div class="tt-title">${row.host}</div>
      <div class="tt-row">Requests<span class="tt-value">${row.requests}</span></div>
      <div class="tt-row">Transferred<span class="tt-value">${fmtBytes(row.bytes)}</span></div>
      <div class="tt-row">Errors<span class="tt-value">${row.errors}</span></div>
    `, event.clientX, event.clientY));
    hit.addEventListener('mouseleave', hideTooltip);
    svg.append(hit);
  });

  host.replaceChildren(svg);
}

/* --- response status ------------------------------------------------------ */

const STATUS_META = [
  { key: '2xx', name: 'Success', color: 'var(--good)', icon: 'check' },
  { key: '3xx', name: 'Redirect', color: 'var(--text-muted)', icon: 'arrow' },
  { key: '4xx', name: 'Client error', color: 'var(--warning)', icon: 'warn' },
  { key: '5xx', name: 'Server error', color: 'var(--critical)', icon: 'cross' },
];

const ICONS = {
  check: '<path d="M3 8.2 6.2 11.4 12.4 4.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  arrow: '<path d="M3.2 7.8h8.4M8.4 4.6l3.2 3.2-3.2 3.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  warn: '<path d="M7.6 2.6 13.6 12.8H1.6L7.6 2.6Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M7.6 6.4v2.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="7.6" cy="11" r="0.9" fill="currentColor"/>',
  cross: '<circle cx="7.6" cy="7.6" r="5.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M5.4 5.4l4.4 4.4M9.8 5.4l-4.4 4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
};

function renderStatus() {
  if (!snapshot) return;
  const counts = snapshot.statusClasses;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  el.statusMeter.replaceChildren(...STATUS_META
    .filter((s) => counts[s.key] > 0)
    .map((s) => {
      const span = document.createElement('span');
      span.style.background = s.color;
      span.style.width = `${(counts[s.key] / total) * 100}%`;
      return span;
    }));

  // Icon + label + count: a status colour never carries the meaning alone.
  el.statusLegend.replaceChildren(...STATUS_META.map((s) => {
    const li = document.createElement('li');
    const share = total ? `${Math.round((counts[s.key] / total) * 100)}%` : '—';
    li.innerHTML = `
      <svg class="icon" viewBox="0 0 15.2 15.2" aria-hidden="true" style="color:${s.color}">${ICONS[s.icon]}</svg>
      <span class="name">${s.key} <span style="color:var(--text-muted)">${s.name}</span></span>
      <span class="count">${fmtCount(counts[s.key])}</span>
      <span class="share">${share}</span>`;
    return li;
  }));

  const { totals } = snapshot;
  $('status-foot').textContent = `${fmtCount(total)} answered \u00b7 `
    + `${fmtCount(totals.blocked)} blocked by rules \u00b7 `
    + `${fmtCount(totals.errors)} upstream errors`;
}

/* --- live log ------------------------------------------------------------- */

function statusColor(entry) {
  if (entry.outcome === 'blocked') return 'var(--critical)';
  if (entry.status === null || entry.status === undefined) return 'var(--deemphasis)';
  if (entry.status >= 500) return 'var(--critical)';
  if (entry.status >= 400) return 'var(--warning)';
  if (entry.status >= 300) return 'var(--series-1)';
  return 'var(--good)';
}

function renderLog() {
  const needle = el.logFilter.value.trim().toLowerCase();
  const rows = logEntries
    .filter((e) => !needle || e.url.toLowerCase().includes(needle) || e.host.toLowerCase().includes(needle))
    .slice(0, 120);

  if (rows.length === 0) {
    el.logBody.innerHTML = `<tr class="log-empty"><td colspan="6">${
      needle ? 'No requests match that filter.' : 'No requests yet. Point a client at the proxy to see traffic here.'
    }</td></tr>`;
    return;
  }

  el.logBody.replaceChildren(...rows.map((entry) => {
    const tr = document.createElement('tr');
    if (entry.isNew) tr.className = 'is-new';
    tr.innerHTML = `
      <td>${new Date(entry.at).toTimeString().slice(0, 8)}</td>
      <td class="method">${entry.method}</td>
      <td class="target" title="${entry.url.replace(/"/g, '&quot;')}">${entry.url}</td>
      <td class="num"><span class="dot" style="background:${statusColor(entry)}"></span>${
        entry.outcome === 'blocked' ? 'blocked' : entry.status ?? '—'
      }</td>
      <td class="num">${fmtBytes(entry.bytesIn + entry.bytesOut)}</td>
      <td class="num">${fmtMs(entry.durationMs)}</td>`;
    return tr;
  }));

  for (const entry of rows) delete entry.isNew;
}

/* --- top-level render ----------------------------------------------------- */

function render() {
  if (!snapshot) return;

  const rate = splitBytes(snapshot.throughputBps);
  el.heroValue.textContent = rate.value;
  el.heroUnit.textContent = `${rate.unit}/s`;
  el.heroSub.textContent = `${fmtBytes(snapshot.totals.bytesIn + snapshot.totals.bytesOut)} moved `
    + `· up ${fmtDuration(snapshot.uptimeMs)}`;

  el.version.textContent = `v${snapshot.version}`;
  el.endpointText.textContent = `${snapshot.proxyHost}:${snapshot.proxyPort}`;

  $('kpi-requests').textContent = fmtCount(snapshot.totals.requests);
  $('kpi-requests-sub').textContent = snapshot.totals.blocked
    ? `${fmtCount(snapshot.totals.blocked)} blocked`
    : 'proxied';
  $('kpi-tunnels').textContent = fmtCount(snapshot.totals.tunnels);
  $('kpi-tunnels-sub').textContent = `${fmtCount(snapshot.active.tunnels)} open`;
  $('kpi-active').textContent = fmtCount(snapshot.active.requests);
  $('kpi-active-sub').textContent = snapshot.totals.errors
    ? `${fmtCount(snapshot.totals.errors)} errors`
    : 'no errors';
  $('kpi-latency').innerHTML = `${Math.round(snapshot.latency.p50)}<span class="tile-unit">ms</span>`;
  $('kpi-latency-sub').textContent = snapshot.latency.samples
    ? `median · p95 ${fmtMs(snapshot.latency.p95)}`
    : 'median';

  sparkline(el.heroSpark, rollup(snapshot.series, 'bytesIn', 30));
  sparkline($('spark-requests'), rollup(snapshot.series, 'http', 12));
  sparkline($('spark-tunnels'), rollup(snapshot.series, 'tunnel', 12), 'var(--series-2)');

  if (tpView === 'chart') renderThroughput(); else renderThroughputTable();
  renderHosts();
  renderStatus();
}

/* --- stream --------------------------------------------------------------- */

function setConnection(state, label) {
  el.connection.dataset.state = state;
  el.connectionText.textContent = label;
  document.body.dataset.connection = state;
}

function connect() {
  const stream = new EventSource('/api/stream');

  stream.addEventListener('open', () => setConnection('live', 'live'));

  stream.addEventListener('snapshot', (event) => {
    snapshot = JSON.parse(event.data);
    if (!seeded) {
      logEntries = [...snapshot.log].reverse();
      seeded = true;
      renderLog();
    }
    setConnection('live', 'live');
    render();
  });

  stream.addEventListener('request', (event) => {
    const entry = JSON.parse(event.data);
    entry.isNew = true;
    logEntries.unshift(entry);
    if (logEntries.length > 250) logEntries.length = 250;
    renderLog();
  });

  stream.addEventListener('error', () => {
    // EventSource reconnects on its own; hold the last render, dimmed.
    setConnection('offline', 'reconnecting');
  });
}

/* --- chrome --------------------------------------------------------------- */

function readStoredTheme() {
  try {
    return localStorage.getItem('nebula-theme');
  } catch {
    return null;
  }
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  try {
    if (theme) localStorage.setItem('nebula-theme', theme);
  } catch {
    // Private mode or blocked storage: the theme just doesn't persist.
  }
  render();
}

applyTheme(readStoredTheme());

el.theme.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme
    ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

el.endpoint.addEventListener('click', async () => {
  const url = `http://${el.endpointText.textContent}`;
  const label = el.endpoint.querySelector('.chip-action');
  try {
    await navigator.clipboard.writeText(url);
    label.textContent = 'copied';
  } catch {
    label.textContent = url;
  }
  setTimeout(() => { label.textContent = 'copy'; }, 1400);
});

for (const button of document.querySelectorAll('.toggle-option')) {
  button.addEventListener('click', () => {
    tpView = button.dataset.view;
    for (const other of document.querySelectorAll('.toggle-option')) {
      const active = other === button;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-pressed', String(active));
    }
    el.tpPlot.hidden = tpView !== 'chart';
    el.tpTable.hidden = tpView !== 'table';
    render();
  });
}

el.logFilter.addEventListener('input', renderLog);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 120);
});

connect();
