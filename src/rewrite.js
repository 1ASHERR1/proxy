/**
 * URL rewriting for the web proxy.
 *
 * A web proxy serves someone else's page from our own origin, so every URL in
 * that page has to be bent back through us — otherwise the browser reaches
 * straight for the origin site (which may be exactly what's blocked) and the
 * page half-loads. These are pure functions: given the page text and the URL it
 * came from, return the rewritten text. No I/O, so they're easy to test.
 */

export const PREFIX = '/p/';

// Schemes and fragments that must never be routed through the proxy.
const SKIP = /^(#|data:|blob:|javascript:|mailto:|tel:|sms:|about:|vbscript:|ftp:)/i;

/**
 * Turn one URL found in a page into a proxied one.
 * `base` is the real URL the page came from, so relative links resolve.
 */
export function toProxyUrl(value, base, prefix = PREFIX) {
  if (value == null) return value;
  const raw = String(value).trim();
  if (raw === '' || SKIP.test(raw)) return value;

  // Already proxied (root-relative or absolute against our own origin).
  if (raw.startsWith(prefix)) return value;

  let abs;
  try {
    abs = new URL(raw, base);
  } catch {
    return value;
  }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return value;
  return prefix + abs.href;
}

/** A `srcset` is a comma-separated list of `url descriptor` pairs. */
export function rewriteSrcset(value, base, prefix = PREFIX) {
  // data: URLs contain commas; splitting them would corrupt the value.
  if (/data:/i.test(value)) return value;
  return value
    .split(',')
    .map((part) => {
      const seg = part.trim();
      if (!seg) return part;
      const bits = seg.split(/\s+/);
      bits[0] = toProxyUrl(bits[0], base, prefix);
      return bits.join(' ');
    })
    .join(', ');
}

/** Rewrite `url(...)` and `@import "..."` inside a stylesheet or a style attribute. */
export function rewriteCss(css, base, prefix = PREFIX) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_m, q, u) => `url(${q}${toProxyUrl(u, base, prefix)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_m, q, u) => `@import ${q}${toProxyUrl(u, base, prefix)}${q}`);
}

// Attributes that hold a single URL. A leading \s keeps us from matching a
// substring like the "src" inside "srcset".
const URL_ATTRS = /(\s(?:href|src|poster|action|formaction|data-src|data-href|background|cite))\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi;

/**
 * Rewrite an HTML document so every resource and link points back at the proxy,
 * and drop the headers-in-markup (CSP, SRI) that would otherwise block our
 * rewrites and injected script.
 *
 * @param {string} html
 * @param {string} base   the real URL the document came from
 * @param {{prefix?: string, inject?: string}} [opts]  `inject` is placed just
 *        inside <head> (e.g. the client-side URL patch)
 */
export function rewriteHtml(html, base, { prefix = PREFIX, inject = '' } = {}) {
  html = html
    // A <meta> CSP would forbid our injected inline script.
    .replace(/<meta[^>]+http-equiv\s*=\s*['"]?content-security-policy['"]?[^>]*>/gi, '')
    // Subresource-integrity hashes won't match once we've rewritten the URL.
    .replace(/\sintegrity\s*=\s*("[^"]*"|'[^']*'|[^\s">]+)/gi, '')
    .replace(/\snonce\s*=\s*("[^"]*"|'[^']*'|[^\s">]+)/gi, '');

  html = html.replace(URL_ATTRS, (_m, attr, _whole, dq, sq, bare) => {
    const val = dq ?? sq ?? bare;
    const quote = dq != null ? '"' : sq != null ? "'" : '';
    return `${attr}=${quote}${toProxyUrl(val, base, prefix)}${quote}`;
  });

  html = html.replace(/(\ssrcset)\s*=\s*("([^"]*)"|'([^']*)')/gi, (_m, attr, _whole, dq, sq) => {
    const quote = dq != null ? '"' : "'";
    return `${attr}=${quote}${rewriteSrcset(dq ?? sq, base, prefix)}${quote}`;
  });

  html = html.replace(
    /(<meta[^>]+content\s*=\s*["']?\s*\d+\s*;\s*url=)([^"'>\s]+)/gi,
    (_m, pre, u) => pre + toProxyUrl(u, base, prefix),
  );

  html = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open, css, close) => open + rewriteCss(css, base, prefix) + close,
  );
  html = html.replace(
    /(\sstyle)\s*=\s*"([^"]*)"/gi,
    (_m, attr, css) => `${attr}="${rewriteCss(css, base, prefix)}"`,
  );

  if (inject) {
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (h) => h + inject);
    else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (h) => h + inject);
    else html = inject + html;
  }

  return html;
}

/**
 * Decide what a typed query is: a full URL, a bare domain, or a search.
 * Returns the real target URL to proxy.
 */
export function resolveQuery(input, searchTemplate = 'https://duckduckgo.com/html/?q=%s') {
  const q = String(input || '').trim();
  if (!q) return null;
  if (/^https?:\/\//i.test(q)) return q;
  // A bare host like "example.com" or "en.wikipedia.org/wiki/Cat".
  if (!/\s/.test(q) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?)/.test(q)) return `https://${q}`;
  return searchTemplate.replace('%s', encodeURIComponent(q));
}
