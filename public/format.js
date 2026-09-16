/**
 * Pure formatting and scale helpers, kept free of the DOM so they can be
 * unit-tested in Node as well as loaded by the dashboard.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function splitBytes(bytes) {
  if (!bytes || bytes < 1 || !Number.isFinite(bytes)) return { value: '0', unit: 'B' };
  const i = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const scaled = bytes / 1024 ** i;
  const value = scaled >= 100 || i === 0 ? Math.round(scaled) : scaled.toFixed(1);
  return { value: String(value), unit: BYTE_UNITS[i] };
}

export function fmtBytes(bytes) {
  const { value, unit } = splitBytes(bytes);
  return `${value} ${unit}`;
}

export function fmtRate(bytesPerSecond) {
  const { value, unit } = splitBytes(bytesPerSecond);
  return `${value} ${unit}/s`;
}

export function fmtCount(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

export function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * The 1 / 1.5 / 2 / 3 ... ladder, spanning a whole 1024 step so a mantissa can
 * never outrun it. Every entry halves to another clean value, which is what the
 * midpoint gridline needs.
 */
const STEPS = [
  1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96,
  128, 192, 256, 384, 512, 768, 1024,
];

/**
 * Snap an axis maximum up to a round *binary* value, so gridline labels read
 * "512 KB / 1 MB" rather than decimal thirds like "651 KB".
 *
 * The result is always >= `value`: an axis that rounded down would silently
 * flatten every peak above it.
 */
export function niceBytes(value) {
  if (!(value > 0) || !Number.isFinite(value)) return 1024;

  const pow = Math.max(0, Math.floor(Math.log(value) / Math.log(1024)));
  const unit = 1024 ** pow;
  const mantissa = value / unit;

  const step = STEPS.find((candidate) => mantissa <= candidate);
  return step === undefined ? value : step * unit;
}

export const truncate = (str, maxChars) => (
  str.length <= maxChars ? str : `${str.slice(0, Math.max(1, maxChars - 1))}…`
);

export const clockOf = (epochSeconds) => new Date(epochSeconds * 1000).toTimeString().slice(0, 8);
