// Gatekeeping shared by the HTTP API and the WebSocket: game token, allowed origins, real client address,
// the optional Cloudflare Access (Zero Trust) check and a per-connection message budget.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.js';

const digest = (s: string) => createHash('sha256').update(s).digest();
const TOKEN_HASH = digest(config.token);

/** Constant-time comparison of the shared game token. */
export function tokenOk(candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  return timingSafeEqual(digest(candidate), TOKEN_HASH);
}

export function tokenFromHeaders(h: IncomingHttpHeaders): string | undefined {
  const x = h['x-svnz-token'];
  if (typeof x === 'string') return x;
  const a = h.authorization;
  if (typeof a === 'string' && a.startsWith('Bearer ')) return a.slice(7);
  return undefined;
}

/** The browser cannot set headers on a WebSocket, so the token rides as a sub-protocol: `new WebSocket(url, ['svnz-v1', 'token.<token>'])`. */
export function tokenFromProtocols(protocols: string[]): string | undefined {
  const p = protocols.find((s) => s.startsWith('token.'));
  return p ? p.slice(6) : undefined;
}

export function originAllowed(origin: string | undefined): boolean {
  const list = config.allowedOrigins;
  if (list.includes('*')) return true;
  if (!origin) return false;   // browsers always send one; anything without it is a script, not the game
  return list.some((o) => o.replace(/\/$/, '') === origin);
}

/** Real address of the client: Cloudflare's header when the server only receives traffic through Cloudflare, else the socket. */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, expressIp?: string): string {
  if (config.trustCloudflare) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf;
  }
  return expressIp ?? req.socket.remoteAddress ?? 'unknown';
}

// ---- Cloudflare Access (optional): validates the Cf-Access-Jwt-Assertion header against the team's public keys.
const jwks = config.cfAccessTeamDomain ? createRemoteJWKSet(new URL(`https://${config.cfAccessTeamDomain}/cdn-cgi/access/certs`)) : null;
export const accessConfigured = !!(jwks && config.cfAccessAud);

export async function accessOk(headers: IncomingHttpHeaders): Promise<boolean> {
  if (!accessConfigured || !jwks) return true;
  const raw = headers['cf-access-jwt-assertion'];
  const jwt = typeof raw === 'string' ? raw : /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(String(headers.cookie ?? ''))?.[1];
  if (!jwt) return false;
  try {
    await jwtVerify(jwt, jwks, { issuer: `https://${config.cfAccessTeamDomain}`, audience: config.cfAccessAud });
    return true;
  } catch {
    return false;
  }
}

/** Token bucket: `rate` messages per second with a burst of `rate`. */
export class Budget {
  private tokens: number;
  private last = Date.now();
  constructor(private rate = config.wsMessagesPerSecond) { this.tokens = rate; }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
