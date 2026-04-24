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

  // Docker/reverse-proxy: first hop is the container; client IP is in X-Forwarded-For.
  // If the box is behind Cloudflare add CF-Connecting-IP handling in a future phase.
  const xff = c.req.header('X-Forwarded-For') ?? '';
  const clientIp = xff.split(',')[0]?.trim() || c.req.header('X-Real-IP') || '';

  if (!clientIp || !allowed.includes(clientIp)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  await next();
};
