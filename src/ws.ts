// The realtime side: one WebSocket per player. Lobby messages change the room; `in` / `snap` are relayed between host and guests.
// A dropped connection keeps the seat for a while (see rooms.ts), so a reload or a network blip does not lose the player.
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';
import { difficultyOf, type CharKey } from './game.js';
import { cleanName, parseClientMessage, type ClientMessageT } from './protocol.js';
import type { Player, Room, RoomError, Rooms } from './rooms.js';
import { Budget, accessOk, clientIp, joinGuard, originAllowed, tokenFromProtocols, tokenOk } from './security.js';
import { log } from './log.js';

const PROTOCOL = 'svnz-v1';
const JOIN_TIMEOUT_MS = 10_000;

const ERROR_TEXT: Record<RoomError, string> = {
  not_found: 'Room not found',
  full: 'The room is full',
  started: 'The match already started',
  bad_key: 'Invalid host key',
  forbidden: 'Not allowed',
  invalid: 'Not valid in this mode',
  limit: 'The server is full, try again later',
  bad_session: 'The session expired',
  banned: 'You were removed from this room',
  blocked: 'Too many failed attempts, try again later',
  taken: 'That colour is already taken',
};
/** Failed lookups that count toward blocking an address (somebody guessing codes). */
const GUESSING: RoomError[] = ['not_found', 'bad_key', 'forbidden', 'bad_session'];

interface Conn { ws: WebSocket; ip: string; room?: Room; player?: Player; budget: Budget; alive: boolean; strikes: number }

export function attachWebSocket(server: HttpServer, rooms: Rooms): { close(): void; connections(): number } {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.wsMaxPayloadBytes,
    perMessageDeflate: false,   // the snapshots are small and latency matters more than size
    handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
  });
  const perIp = new Map<string, number>();
  const conns = new Set<Conn>();

  const send = (ws: WebSocket | null | undefined, msg: unknown) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  const err = (c: Conn, code: string, msg: string) => send(c.ws, { t: 'error', code, msg });
  const roomErr = (c: Conn, e: RoomError) => err(c, e, ERROR_TEXT[e]);
  const broadcastRoom = (room: Room) => { const v = rooms.view(room); for (const p of room.players.values()) send(p.ws, { t: 'room', room: v }); };
  const hostOf = (room: Room) => (room.hostId !== null ? room.players.get(room.hostId) : undefined);

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const reject = (code: number, why: string) => { socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') return reject(404, 'Not Found');
      if (!originAllowed(req.headers.origin)) return reject(403, 'Forbidden');
      if (config.cfAccessRequired && !(await accessOk(req.headers))) return reject(401, 'Unauthorized');
      const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!tokenOk(tokenFromProtocols(protocols))) return reject(401, 'Unauthorized');
      const ip = clientIp(req);
      if (joinGuard.blocked(ip)) return reject(429, 'Too Many Requests');
      if ((perIp.get(ip) ?? 0) >= config.maxConnectionsPerIp) return reject(429, 'Too Many Requests');
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, ip));
    })().catch(() => socket.destroy());
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, ip: string) => {
    const c: Conn = { ws, ip, budget: new Budget(), alive: true, strikes: 0 };
    conns.add(c);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    const joinTimer = setTimeout(() => { if (!c.player) ws.close(4001, 'join timeout'); }, JOIN_TIMEOUT_MS);

    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      if (!c.budget.take()) { ws.close(4008, 'rate limit'); return; }
      const m = parseClientMessage(data.toString());
      if (!m) {
        err(c, 'invalid', 'Invalid message');
        if (++c.strikes >= config.maxStrikes) ws.close(4003, 'too many invalid messages');
        return;
      }
      handle(c, m);
    });
    ws.on('close', (code, reason) => {
      // abnormal closes the server itself causes (message too big, rate limit, invalid messages): useful to know when somebody reports trouble
      if ([1009, 4003, 4008].includes(code)) log.warn(`socket closed by the server: ${code} ${String(reason)} (player ${c.player?.name ?? '-'}, room ${c.room?.code ?? '-'})`);
      clearTimeout(joinTimer);
      conns.delete(c);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
      lost(c);
    });
    ws.on('error', () => ws.terminate());
  });

  /** The socket closed: the seat is kept for the grace period so the player can come back. */
  function lost(c: Conn): void {
    const { room, player } = c;
    if (!room || !player) return;
    c.room = undefined;
    c.player = undefined;
    if (!rooms.lost(room, player, c.ws)) return;   // replaced by a newer connection of the same player
    broadcastRoom(room);
    if (room.status === 'playing' && player.id !== room.hostId) send(hostOf(room)?.ws, { t: 'peer', id: player.id, online: false });
    log.debug(`room ${room.code}: ${player.name} lost the connection`);
  }

  /** The player is gone for good (pressed leave, was kicked, or the grace ran out). */
  function removed(room: Room, player: Player, closed: boolean, others: Player[]): void {
    if (closed) {
      for (const o of others) { send(o.ws, { t: 'closed', reason: 'host_left' }); o.ws?.close(1000, 'host left'); }
      log.info(`room ${room.code} closed (host left)`);
    } else {
      if (room.status === 'playing') send(hostOf(room)?.ws, { t: 'left', id: player.id });
      broadcastRoom(room);
    }
  }

  function attach(c: Conn, room: Room, player: Player): void {
    c.room = room;
    c.player = player;
  }

  function handle(c: Conn, m: ClientMessageT): void {
    if (m.t === 'ping') { send(c.ws, { t: 'pong', n: m.n ?? 0 }); return; }

    if (m.t === 'join' || m.t === 'resume') {
      if (c.player) { err(c, 'invalid', 'Already in a room'); return; }
      if (joinGuard.blocked(c.ip)) { roomErr(c, 'blocked'); c.ws.close(4029, 'blocked'); return; }
      if (m.t === 'join') {
        const r = rooms.join(String(m.code), cleanName(String(m.name)), m.key as string | undefined, c.ws, c.ip);
        if (typeof r === 'string') { if (GUESSING.includes(r)) joinGuard.fail(c.ip); roomErr(c, r); return; }
        attach(c, r.room, r.player);
        send(c.ws, { t: 'joined', you: r.player.id, host: r.player.id === r.room.hostId, sid: r.sid, resumed: false, claimed: r.claimed, room: rooms.view(r.room) });
        if (r.claimed && r.room.status === 'playing') send(hostOf(r.room)?.ws, { t: 'peer', id: r.player.id, online: true });
        broadcastRoom(r.room);
        log.info(`room ${r.room.code}: ${r.player.name} ${r.claimed ? 'took the seat back' : 'joined'} (${r.room.players.size})`);
      } else {
        const r = rooms.resume(String(m.code), String(m.sid), c.ws, c.ip);
        if (typeof r === 'string') { if (GUESSING.includes(r)) joinGuard.fail(c.ip); roomErr(c, r); return; }
        if (r.replaced) { send(r.replaced, { t: 'replaced' }); r.replaced.close(4009, 'replaced'); }
        attach(c, r.room, r.player);
        send(c.ws, { t: 'joined', you: r.player.id, host: r.player.id === r.room.hostId, sid: String(m.sid), resumed: true, claimed: false, room: rooms.view(r.room) });
        if (r.room.status === 'playing' && r.player.id !== r.room.hostId) send(hostOf(r.room)?.ws, { t: 'peer', id: r.player.id, online: true });
        broadcastRoom(r.room);
        log.info(`room ${r.room.code}: ${r.player.name} resumed`);
      }
      return;
    }

    const { room, player } = c;
    if (!room || !player) { err(c, 'invalid', 'Join a room first'); return; }
    const isHost = player.id === room.hostId;

    switch (m.t) {
      case 'char': { const e = rooms.setChar(room, player, m.char as CharKey); if (e) roomErr(c, e); else broadcastRoom(room); break; }
      case 'variant': { const e = rooms.setVariant(room, player, Number(m.v)); if (e) roomErr(c, e); else broadcastRoom(room); break; }
      case 'ready': rooms.setReady(room, player, !!m.ready); broadcastRoom(room); break;
      case 'mode': { const e = rooms.setMode(room, player, m.mode as 'coop' | 'vs'); if (e) roomErr(c, e); else broadcastRoom(room); break; }
      case 'settings': {
        const e = rooms.setSettings(room, player, { powerups: !!m.powerups, items: m.items as string[], lives: Number(m.lives) });
        if (e) roomErr(c, e); else broadcastRoom(room);
        break;
      }
      case 'kick': {
        const r = rooms.kick(room, player, Number(m.id));
        if (typeof r === 'string') { roomErr(c, r); break; }
        send(r.target.ws, { t: 'kicked' });
        const sock = r.target.ws;
        const out = rooms.leave(room, r.target);
        sock?.close(4010, 'kicked');
        removed(room, r.target, out.closed, out.others);
        log.info(`room ${room.code}: ${r.target.name} was kicked`);
        break;
      }
      case 'start': {
        const e = rooms.start(room, player);
        if (e) { if (e in ERROR_TEXT) roomErr(c, e as RoomError); else err(c, 'not_ready', e); break; }
        const v = rooms.view(room);
        const difficulty = room.mode === 'coop' ? difficultyOf(v.players.map((p) => p.char)) : v.difficulty;
        for (const p of room.players.values()) send(p.ws, { t: 'start', room: v, difficulty, you: p.id });
        log.info(`room ${room.code}: ${room.mode} started with ${room.players.size} players`);
        break;
      }
      case 'in': {   // guest -> host: the guest's controller state
        if (room.status !== 'playing' || isHost || room.hostId === null) break;
        send(hostOf(room)?.ws, { t: 'in', from: player.id, d: m.d });
        rooms.touch(room);
        break;
      }
      case 'snap': {   // host -> guests: the world
        if (room.status !== 'playing' || !isHost) break;
        const out = JSON.stringify({ t: 'snap', d: m.d });
        for (const p of room.players.values()) if (p.id !== player.id && p.ws?.readyState === WebSocket.OPEN) p.ws.send(out);
        rooms.touch(room);
        break;
      }
      case 'end': {
        if (!isHost) { roomErr(c, 'forbidden'); break; }
        rooms.end(room);
        for (const p of room.players.values()) send(p.ws, { t: 'ended', d: m.d ?? null });
        broadcastRoom(room);
        break;
      }
      case 'leave': {   // on purpose: no grace, the seat is freed now
        c.room = undefined;
        c.player = undefined;
        const out = rooms.leave(room, player);
        removed(room, player, out.closed, out.others);
        c.ws.close(1000, 'bye');
        break;
      }
    }
  }

  // keep-alive, seats nobody came back for, idle rooms
  const beat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }, 20_000);
  const sweeper = setInterval(() => {
    joinGuard.sweep();
    for (const ev of rooms.sweep()) {
      if (ev.kind === 'removed') {
        log.info(`room ${ev.room.code}: ${ev.player.name} did not come back, seat freed`);
        removed(ev.room, ev.player, ev.closed, ev.others);
      } else if (ev.kind === 'match_aborted') {
        log.info(`room ${ev.room.code}: match ended (host lost)`);
        for (const p of ev.room.players.values()) send(p.ws, { t: 'ended', d: { aborted: true, reason: 'host_lost' } });
        broadcastRoom(ev.room);
      } else {
        for (const p of ev.room.players.values()) { send(p.ws, { t: 'closed', reason: 'idle' }); p.ws?.close(1000, 'idle'); }
        log.info(`room ${ev.room.code} closed (idle)`);
      }
    }
  }, 2_000);

  return {
    connections: () => conns.size,
    close: () => {
      clearInterval(beat);
      clearInterval(sweeper);
      for (const c of conns) { send(c.ws, { t: 'closed', reason: 'server_restart' }); c.ws.close(1001, 'server restart'); }
      setTimeout(() => { for (const c of conns) c.ws.terminate(); wss.close(); }, 300).unref();
    },
  };
}
