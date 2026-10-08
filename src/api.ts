// The HTTP API, written with Elysia (typed, validated routes) and mounted inside Express (see http.ts).
import { Elysia } from 'elysia';
import { config } from './config.js';
import { CHARACTERS, ITEM_TYPES, THREAT, VS_ONLY } from './game.js';
import { CodeParams, CreateRoomBody } from './protocol.js';
import { maxPlayers, type Rooms } from './rooms.js';
import { adminOk, joinGuard, tokenFromHeaders, tokenOk } from './security.js';

/** Express puts the real client address here (and overwrites anything a client may have sent with the same name). */
export const IP_HEADER = 'x-svnz-client-ip';

export interface Runtime { connections(): number; startedAt: number }

export function buildApi(rooms: Rooms, runtime: Runtime) {
  const ipOf = (request: Request) => request.headers.get(IP_HEADER) ?? 'unknown';
  return new Elysia()
    // /health is public (a probe, no data); everything else needs the game token
    .get('/health', () => ({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }))
    .group('/api', (app) =>
      app
        .onBeforeHandle(({ request, set }) => {
          const h: Record<string, string> = {};
          request.headers.forEach((v, k) => { h[k] = v; });
          if (!tokenOk(tokenFromHeaders(h))) { set.status = 401; return { error: 'unauthorized' }; }
        })
        // what the frontend needs to know about this server
        .get('/info', () => ({
          name: 'svnz-backend', protocol: 2,
          characters: CHARACTERS, vsOnly: VS_ONLY, items: ITEM_TYPES, threat: THREAT,
          limits: { coop: config.maxCoopPlayers, vs: config.maxVsPlayers },
          reconnectGraceSeconds: config.reconnectGraceSeconds,
          difficulty: config.difficulty,
        }))
        // create a room: returns its code (shown to the friends) and the key that proves who the host is
        .post('/rooms', ({ body, set, request }) => {
          const ip = ipOf(request);
          if (joinGuard.blocked(ip)) { set.status = 429; return { error: 'blocked' }; }
          const r = rooms.create(body.mode, ip);
          if (typeof r === 'string') { set.status = 503; return { error: r }; }
          return { code: r.room.code, hostKey: r.hostKey, mode: r.room.mode, max: maxPlayers(r.room.mode) };
        }, { body: CreateRoomBody })
        // can this room be joined? (checked before opening the socket). Guessing codes gets the address blocked for a while.
        .get('/rooms/:code', ({ params, set, request }) => {
          const ip = ipOf(request);
          if (joinGuard.blocked(ip)) { set.status = 429; return { error: 'blocked' }; }
          const room = rooms.get(params.code);
          if (!room) { joinGuard.fail(ip); set.status = 404; return { error: 'not_found' }; }
          const free = room.players.size < maxPlayers(room.mode);
          return { code: room.code, mode: room.mode, status: room.status, players: room.players.size, max: maxPlayers(room.mode), joinable: room.status === 'lobby' && free };
        }, { params: CodeParams })
        // counters for monitoring (no personal data); only when ADMIN_TOKEN is set and sent in x-admin-token
        .get('/admin/stats', ({ request, set }) => {
          if (!adminOk(request.headers.get('x-admin-token'))) { set.status = 404; return { error: 'not_found' }; }
          return { ...rooms.stats(), sockets: runtime.connections(), uptime: Math.round((Date.now() - runtime.startedAt) / 1000), memoryMb: Math.round(process.memoryUsage().rss / 1048576) };
        }),
    )
    .onError(({ code, set }) => {
      if (code === 'VALIDATION') { set.status = 422; return { error: 'invalid_request' }; }
      if (code === 'NOT_FOUND') { set.status = 404; return { error: 'not_found' }; }
      set.status = 500;
      return { error: 'server_error' };
    });
}
