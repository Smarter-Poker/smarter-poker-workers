import type { MiddlewareHandler } from 'hono';

/**
 * requireCronSecret — rejects any request without a matching
 * `Authorization: Bearer $CRON_SECRET` header.
 *
 * CRON_SECRET is loaded from the container's environment (docker-compose
 * injects it from /opt/workers/.env on the Hetzner host). Matches the
 * same secret that Open Claw dispatcher signs requests with.
 */
export const requireCronSecret: MiddlewareHandler = async (c, next) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[auth] FATAL: CRON_SECRET not set in env');
    return c.json({ error: 'server misconfigured' }, 500);
  }
  const auth = c.req.header('Authorization') ?? '';
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || token !== expected) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};

/** Strips the IPv6-mapped IPv4 prefix so ::ffff:10.0.0.1 compares as 10.0.0.1. */
function normalizeIp(ip: string): string {
  const trimmed = (ip ?? '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
}

/** Loopback or RFC1918/Docker-bridge peer — i.e. our own reverse proxy hop. */
function isPrivatePeer(ip: string): boolean {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return false;
}

/**
 * Reads the real TCP peer from the @hono/node-server adapter
 * (c.env === { incoming, outgoing }). Empty string on other adapters.
 */
function socketPeerIp(env: unknown): string {
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return normalizeIp(incoming?.socket?.remoteAddress ?? '');
}

/**
 * ipAllowlist — accept only requests from Hetzner's own IP space (the
 * Open Claw dispatcher box) plus 127.0.0.1 for local healthchecks.
 *
 * ALLOWED_CRON_IPS is a comma-separated list in env, e.g.:
 *   ALLOWED_CRON_IPS=178.104.160.250,178.156.160.206,127.0.0.1
 *
 * If ALLOWED_CRON_IPS is unset, the allowlist is BYPASSED (dev mode only).
 * In production Docker Compose this env var MUST be set, enforced by the
 * Hetzner host's .env file.
 *
 * X-Forwarded-For is caller-supplied and therefore only trusted when the
 * DIRECT peer is a known proxy: an entry in TRUSTED_PROXY_IPS, or a
 * loopback/private-range address (the Docker bridge / local reverse proxy).
 * A caller reaching the port directly from the public internet is judged on
 * its socket address alone, so it can no longer spoof its way in.
 */
export const ipAllowlist: MiddlewareHandler = async (c, next) => {
  const allowed = (process.env.ALLOWED_CRON_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[auth] FATAL: ALLOWED_CRON_IPS unset in production');
      return c.json({ error: 'server misconfigured' }, 500);
    }
    // dev mode — allow
    await next();
    return;
  }

  const trustedProxies = (process.env.TRUSTED_PROXY_IPS ?? '')
    .split(',')
    .map((s) => normalizeIp(s))
    .filter(Boolean);

  const peerIp = socketPeerIp(c.env);
  const xffIp = normalizeIp(c.req.header('X-Forwarded-For')?.split(',')[0] ?? '');
  const realIp = normalizeIp(c.req.header('X-Real-IP') ?? '');
  const headerIp = xffIp || realIp;

  // The socket peer always counts. Forwarded headers count only behind a
  // proxy we recognise (or when the adapter exposes no socket at all).
  const proxyTrusted = !peerIp || trustedProxies.includes(peerIp) || isPrivatePeer(peerIp);
  const candidates = [peerIp, proxyTrusted ? headerIp : ''].filter(Boolean);

  if (candidates.length === 0 || !candidates.some((ip) => allowed.includes(ip))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  await next();
};
