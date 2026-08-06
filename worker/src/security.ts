// Workers-safe validation helpers (no node `net`).

function isIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255);
}

function isIPv6(host: string): boolean {
  // Loose check; good enough to gate private ranges below.
  return host.includes(':') && /^[0-9a-f:]+$/i.test(host);
}

/** Reject non-http(s), localhost and private/link-local ranges (SSRF guard). */
export function isSafeUpstreamUrl(value: string): boolean {
  if (!value || value.length > 4096) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    if (isIPv4(host)) {
      const o = host.split('.').map(Number);
      if (
        o[0] === 10 ||
        o[0] === 127 ||
        o[0] === 0 ||
        (o[0] === 169 && o[1] === 254) ||
        (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
        (o[0] === 192 && o[1] === 168)
      )
        return false;
    }
    if (isIPv6(host) && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isSafeProtocolId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 4096 && !/[\x00-\x1f\x7f]/.test(id);
}
