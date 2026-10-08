// The HTTP API, written with Elysia (typed, validated routes) and mounted inside Express (see http.ts).
import { Elysia, t } from 'elysia';
import { config } from './config.js';
import { CHARACTERS, THREAT } from './game.js';
import { CodeParams, CreateRoomBody } from './protocol.js';
import { maxPlayers, type Rooms } from './rooms.js';
import { tokenFromHeaders, tokenOk } from './security.js';

export function buildApi(rooms: Rooms) {
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
          name: 'svnz-backend', protocol: 1,
          characters: CHARACTERS, threat: THREAT,
          limits: { coop: config.maxCoopPlayers, vs: config.maxVsPlayers },
          difficulty: config.difficulty,
        }))
        // create a room: returns its code (shown to the friends) and the key that proves who the host is
        .post('/rooms', ({ body, set }) => {
          const r = rooms.create(body.mode);
          if (typeof r === 'string') { set.status = 503; return { error: r }; }
          return { code: r.room.code, hostKey: r.hostKey, mode: r.room.mode, max: maxPlayers(r.room.mode) };
        }, { body: CreateRoomBody })
        // can this room be joined? (checked before opening the socket)
        .get('/rooms/:code', ({ params, set }) => {
          const room = rooms.get(params.code.toUpperCase());
          if (!room) { set.status = 404; return { error: 'not_found' }; }
          return { code: room.code, mode: room.mode, status: room.status, players: room.players.size, max: maxPlayers(room.mode), joinable: room.status === 'lobby' && room.players.size < maxPlayers(room.mode) };
        }, { params: CodeParams }),
    )
    .onError(({ code, set }) => {
      if (code === 'VALIDATION') { set.status = 422; return { error: 'invalid_request' }; }
      if (code === 'NOT_FOUND') { set.status = 404; return { error: 'not_found' }; }
      set.status = 500;
      return { error: 'server_error' };
    });
}
export { t };
