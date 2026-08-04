import net from 'net';
import { Request, Response, NextFunction } from 'express';

const windows = new Map<string, { count: number; resetsAt: number }>();

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://image.tmdb.org",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  next();
}

export function rateLimit(limit: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${ip}:${req.path}`;
    let entry = windows.get(key);
    if (!entry || entry.resetsAt <= now) {
      entry = { count: 0, resetsAt: now + windowMs };
      windows.set(key, entry);
    }
    entry.count += 1;
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - entry.count)));
    if (entry.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetsAt - now) / 1000)));
      res.status(429).json({ success: false, error: 'Too many requests. Try again shortly.' });
      return;
    }
    next();
  };
}

export function isSafeUpstreamUrl(value: string): boolean {
  if (!value || value.length > 4096) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    if (net.isIP(host) === 4) {
      const o = host.split('.').map(Number);
      if (o[0] === 10 || o[0] === 127 || o[0] === 0 || (o[0] === 169 && o[1] === 254) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)) return false;
    }
    if (net.isIP(host) === 6 && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))) return false;
    return true;
  } catch {
    return false;
  }
}

export function isSafeProtocolId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 4096 && !/[\x00-\x1f\x7f]/.test(id);
}
