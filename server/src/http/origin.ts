import type { FastifyRequest } from 'fastify';
import { config } from '../config.ts';

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

/**
 * The absolute origin to build outward-facing URLs from.
 *
 * OpenGraph requires absolute URLs — a crawler has no page context to resolve
 * a relative one against — so share links cannot dodge this.
 *
 * PUBLIC_URL wins when it names a real host: that is the operator stating
 * which name the outside world uses. It defaults to localhost when unset,
 * though, and emitting tags that point a crawler at its own machine is worse
 * than useless — so in that case fall back to the host the request actually
 * arrived on. `trustProxy` is enabled, so that already honours X-Forwarded-*
 * from the tunnel.
 */
export function requestOrigin(request: FastifyRequest): string {
  if (config.publicUrl && !LOOPBACK.test(config.publicUrl)) return config.publicUrl;

  const host = request.host || request.headers.host;
  if (!host) return config.publicUrl;
  return `${request.protocol}://${host}`;
}
