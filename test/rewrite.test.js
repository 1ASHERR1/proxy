import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  toProxyUrl, rewriteSrcset, rewriteCss, rewriteHtml, resolveQuery, PREFIX,
} from '../src/rewrite.js';

const BASE = 'https://example.com/dir/page.html';

describe('toProxyUrl', () => {
  test('resolves a root-relative path against the origin', () => {
    assert.equal(toProxyUrl('/a/b', BASE), `${PREFIX}https://example.com/a/b`);
  });

  test('resolves a document-relative path against the directory', () => {
    assert.equal(toProxyUrl('img.png', BASE), `${PREFIX}https://example.com/dir/img.png`);
  });

  test('handles ../ traversal', () => {
    assert.equal(toProxyUrl('../up.css', BASE), `${PREFIX}https://example.com/up.css`);
  });

  test('keeps a cross-origin absolute URL, still proxied', () => {
    assert.equal(toProxyUrl('https://other.test/x', BASE), `${PREFIX}https://other.test/x`);
  });

  test('resolves a protocol-relative URL', () => {
    assert.equal(toProxyUrl('//cdn.test/x.js', BASE), `${PREFIX}https://cdn.test/x.js`);
  });

  test('leaves data, blob, javascript, mailto, tel and fragments alone', () => {
    for (const v of ['data:image/png;base64,AAAA', 'blob:abc', 'javascript:void 0', 'mailto:a@b.c', 'tel:+1', '#top']) {
      assert.equal(toProxyUrl(v, BASE), v);
    }
  });

  test('does not double-proxy an already-proxied URL', () => {
    const once = toProxyUrl('/a', BASE);
    assert.equal(toProxyUrl(once, BASE), once);
  });

  test('leaves an unparseable value untouched', () => {
    assert.equal(toProxyUrl('http://[bad', BASE), 'http://[bad');
  });
});

describe('rewriteSrcset', () => {
  test('rewrites every candidate but keeps descriptors', () => {
    const out = rewriteSrcset('a.png 1x, b.png 2x', BASE);
    assert.equal(out, `${PREFIX}https://example.com/dir/a.png 1x, ${PREFIX}https://example.com/dir/b.png 2x`);
  });

  test('leaves a data: srcset alone (commas would corrupt it)', () => {
    const v = 'data:image/gif;base64,R0lGOD, x';
    assert.equal(rewriteSrcset(v, BASE), v);
  });
});

describe('rewriteCss', () => {
  test('rewrites url() and @import', () => {
    const css = "@import 'reset.css'; a{background:url(../bg.png)}";
    const out = rewriteCss(css, BASE);
    assert.match(out, new RegExp(`@import '${PREFIX}https://example.com/dir/reset.css'`));
    assert.match(out, new RegExp(`url\\(${PREFIX}https://example.com/bg.png\\)`));
  });

  test('leaves data: url() alone', () => {
    const css = 'a{background:url(data:image/png;base64,AAAA)}';
    assert.equal(rewriteCss(css, BASE), css);
  });
});

describe('rewriteHtml', () => {
  const html = [
    '<html><head>',
    '<meta http-equiv="Content-Security-Policy" content="default-src none">',
    '<link rel="stylesheet" href="/style.css" integrity="sha384-xyz">',
    '</head><body>',
    '<a href="/page2">next</a>',
    '<img src="pic.jpg" srcset="pic.jpg 1x, pic2.jpg 2x">',
    '<form action="/submit"><input></form>',
    '<div style="background:url(hero.png)"></div>',
    '</body></html>',
  ].join('');

  const out = rewriteHtml(html, BASE, { inject: '<script>/*patch*/</script>' });

  test('rewrites href, src, action', () => {
    assert.match(out, new RegExp(`href="${PREFIX}https://example.com/page2"`));
    assert.match(out, new RegExp(`src="${PREFIX}https://example.com/dir/pic.jpg"`));
    assert.match(out, new RegExp(`action="${PREFIX}https://example.com/submit"`));
  });

  test('rewrites srcset and inline style url()', () => {
    assert.match(out, new RegExp(`${PREFIX}https://example.com/dir/pic2.jpg 2x`));
    assert.match(out, new RegExp(`url\\(${PREFIX}https://example.com/dir/hero.png\\)`));
  });

  test('strips the CSP meta and the integrity attribute', () => {
    assert.doesNotMatch(out, /Content-Security-Policy/i);
    assert.doesNotMatch(out, /integrity=/i);
  });

  test('injects the client patch inside <head>', () => {
    assert.match(out, /<head><script>\/\*patch\*\//);
  });

  test('does not touch a mailto link', () => {
    const m = rewriteHtml('<a href="mailto:a@b.c">mail</a>', BASE);
    assert.match(m, /href="mailto:a@b.c"/);
  });
});

describe('resolveQuery', () => {
  test('passes a full URL through', () => {
    assert.equal(resolveQuery('https://a.test/x'), 'https://a.test/x');
  });

  test('promotes a bare domain to https', () => {
    assert.equal(resolveQuery('example.com'), 'https://example.com');
    assert.equal(resolveQuery('en.wikipedia.org/wiki/Cat'), 'https://en.wikipedia.org/wiki/Cat');
  });

  test('treats free text as a search', () => {
    assert.equal(resolveQuery('how does a proxy work'),
      'https://duckduckgo.com/html/?q=how%20does%20a%20proxy%20work');
  });

  test('honours a custom search template', () => {
    assert.equal(resolveQuery('cats', 'https://s.test/find?query=%s'), 'https://s.test/find?query=cats');
  });

  test('returns null for empty input', () => {
    assert.equal(resolveQuery('   '), null);
  });
});
