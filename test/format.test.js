import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitBytes, fmtBytes, fmtRate, fmtCount, fmtMs, fmtDuration, niceBytes, truncate,
} from '../public/format.js';

describe('byte formatting', () => {
  test('scales into binary units', () => {
    assert.equal(fmtBytes(0), '0 B');
    assert.equal(fmtBytes(512), '512 B');
    assert.equal(fmtBytes(1024), '1.0 KB');
    assert.equal(fmtBytes(1536), '1.5 KB');
    assert.equal(fmtBytes(1024 ** 2), '1.0 MB');
    assert.equal(fmtBytes(1024 ** 3 * 2.5), '2.5 GB');
  });

  test('drops the decimal once the value is large within its unit', () => {
    assert.equal(fmtBytes(150 * 1024), '150 KB');
  });

  test('survives junk input', () => {
    assert.equal(fmtBytes(undefined), '0 B');
    assert.equal(fmtBytes(NaN), '0 B');
    assert.equal(fmtBytes(-5), '0 B');
  });

  test('rate formatting adds the per-second suffix', () => {
    assert.equal(fmtRate(2048), '2.0 KB/s');
    assert.match(splitBytes(2048).unit, /KB/);
  });
});

describe('niceBytes — the chart axis maximum', () => {
  test('never rounds below the value it has to contain', () => {
    // A max under the data silently flattens every peak above it.
    for (let v = 1; v < 4 * 1024 ** 3; v = Math.ceil(v * 1.07)) {
      assert.ok(niceBytes(v) >= v, `niceBytes(${v}) = ${niceBytes(v)} clips the data`);
    }
  });

  test('covers the whole mantissa range, not just the low end', () => {
    // The original ladder stopped at 16, so anything above 16 KB clipped.
    assert.ok(niceBytes(17.6 * 1024) >= 17.6 * 1024);
    assert.ok(niceBytes(900 * 1024) >= 900 * 1024);
    assert.ok(niceBytes(1023 * 1024) >= 1023 * 1024);
  });

  test('snaps to round binary values whose halves are also round', () => {
    assert.equal(niceBytes(1000), 1024);
    assert.equal(niceBytes(1.2 * 1024), 1.5 * 1024);
    assert.equal(niceBytes(17.6 * 1024), 24 * 1024);
    assert.equal(niceBytes(1024 ** 2), 1024 ** 2);
    // Every step halves to a value that still formats cleanly.
    for (const v of [3, 17.6, 100, 700]) {
      const max = niceBytes(v * 1024);
      assert.ok(Number.isInteger(max / 2), `${max} does not halve cleanly`);
    }
  });

  test('handles zero and nonsense without returning 0 or NaN', () => {
    for (const v of [0, -1, NaN, undefined, Infinity]) {
      const max = niceBytes(v);
      assert.ok(Number.isFinite(max) && max > 0, `niceBytes(${v}) = ${max}`);
    }
  });
});

describe('counts, durations, truncation', () => {
  test('compacts counts', () => {
    assert.equal(fmtCount(0), '0');
    assert.equal(fmtCount(999), '999');
    assert.equal(fmtCount(1500), '1.5K');
    assert.equal(fmtCount(15000), '15K');
    assert.equal(fmtCount(2_400_000), '2.4M');
  });

  test('formats latency and uptime', () => {
    assert.equal(fmtMs(12.4), '12ms');
    assert.equal(fmtMs(1500), '1.5s');
    assert.equal(fmtDuration(45_000), '45s');
    assert.equal(fmtDuration(95_000), '1m 35s');
    assert.equal(fmtDuration(3_723_000), '1h 2m');
  });

  test('truncates with an ellipsis only when needed', () => {
    assert.equal(truncate('api.example.com', 40), 'api.example.com');
    assert.equal(truncate('averylonghostname.example.com', 10), 'averylong…');
  });
});
