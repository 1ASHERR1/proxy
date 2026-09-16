/**
 * Host matching rules. Patterns are hostname globs:
 *
 *   example.com      → exactly that host
 *   *.example.com    → any subdomain (and the apex)
 *   *                → everything
 *
 * An allowlist, when non-empty, is authoritative: anything not on it is denied.
 * The blocklist is then applied to whatever survived.
 */

function compile(pattern) {
  const clean = String(pattern).trim().toLowerCase();
  if (!clean) return null;
  if (clean === '*') return () => true;

  if (clean.startsWith('*.')) {
    const base = clean.slice(2);
    return (host) => host === base || host.endsWith(`.${base}`);
  }

  return (host) => host === clean;
}

export class RuleSet {
  constructor({ allow = [], block = [] } = {}) {
    this.allowPatterns = allow.filter(Boolean);
    this.blockPatterns = block.filter(Boolean);
    this.allow = this.allowPatterns.map(compile).filter(Boolean);
    this.block = this.blockPatterns.map(compile).filter(Boolean);
  }

  /**
   * @returns {{allowed: boolean, reason?: string}}
   */
  check(hostname) {
    const host = String(hostname || '').toLowerCase();

    if (this.allow.length > 0 && !this.allow.some((match) => match(host))) {
      return { allowed: false, reason: 'not on allowlist' };
    }

    const blockedBy = this.blockPatterns.find((_, i) => this.block[i](host));
    if (blockedBy !== undefined) {
      return { allowed: false, reason: `blocked by rule "${blockedBy}"` };
    }

    return { allowed: true };
  }

  get isEmpty() {
    return this.allow.length === 0 && this.block.length === 0;
  }
}
