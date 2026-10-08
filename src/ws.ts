// The realtime side: one WebSocket per player. Lobby messages change the room; `in` / `snap` are relayed between host and guests.
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';
import { difficultyOf, type CharKey } from './game.js';
import { cleanName, parseClientMessage, type ClientMessageT } from './protocol.js';
import type { Player, Room, RoomError, Rooms } from './rooms.js';
import { Budget, accessOk, clientIp, originAllowed, tokenFromProtocols, tokenOk } from './security.js';
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
};

interface Conn { ws: WebSocket; ip: string; room?: Room; player?: Player; budget: Budget; alive: boolean }

export function attachWebSocket(server: HttpServer, rooms: Rooms): { close(): void } {
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
      if ((perIp.get(ip) ?? 0) >= config.maxConnectionsPerIp) return reject(429, 'Too Many Requests');
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, ip));
    })().catch(() => socket.destroy());
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, ip: string) => {
    const c: Conn = { ws, ip, budget: new Budget(), alive: true };
    conns.add(c);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    const joinTimer = setTimeout(() => { if (!c.player) ws.close(4001, 'join timeout'); }, JOIN_TIMEOUT_MS);

    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      if (!c.budget.take()) { ws.close(4008, 'rate limit'); return; }
      const m = parseClientMessage(data.toString());
      if (!m) { err(c, 'invalid', 'Invalid message'); return; }
      handle(c, m);
    });
    ws.on('close', () => {
      clearTimeout(joinTimer);
      conns.delete(c);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
      drop(c);
    });
    ws.on('error', () => ws.terminate());
  });

  /** A player left (closed the tab or pressed Leave). */
  function drop(c: Conn): void {
    const { room, player } = c;
    if (!room || !player) return;
    c.room = undefined;
    c.player = undefined;
    const r = rooms.leave(room, player);
    if (r.closed) {
      for (const o of r.others) { send(o.ws, { t: 'closed', reason: 'host_left' }); o.ws?.close(1000, 'host left'); }
      log.info(`room ${room.code} closed (host left)`);
    } else {
      if (room.status === 'playing' && room.hostId !== null) send(room.players.get(room.hostId)?.ws, { t: 'left', id: player.id });
      broadcastRoom(room);
    }
  }

  function handle(c: Conn, m: ClientMessageT): void {
    if (m.t === 'ping') { send(c.ws, { t: 'pong', n: m.n ?? 0 }); return; }
    if (m.t === 'join') {
      if (c.player) { err(c, 'invalid', 'Already in a room'); return; }
      const r = rooms.join(String(m.code), cleanName(String(m.name)), m.key as string | undefined, c.ws);
      if (typeof r === 'string') { roomErr(c, r); return; }
      c.room = r.room;
      c.player = r.player;
      send(c.ws, { t: 'joined', you: r.player.id, host: r.player.id === r.room.hostId, room: rooms.view(r.room) });
      broadcastRoom(r.room);
      log.info(`room ${r.room.code}: ${r.player.name} joined (${r.room.players.size})`);
      return;
    }
    const { room, player } = c;
    if (!room || !player) { err(c, 'invalid', 'Join a room first'); return; }
    const isHost = player.id === room.hostId;

    switch (m.t) {
      case 'char': { const e = rooms.setChar(room, player, m.char as CharKey); if (e) roomErr(c, e); else broadcastRoom(room); break; }
      case 'team': { const e = rooms.setTeam(room, player, m.team as 1 | 2); if (e) roomErr(c, e); else broadcastRoom(room); break; }
      case 'ready': rooms.setReady(room, player, !!m.ready); broadcastRoom(room); break;
      case 'mode': { const e = rooms.setMode(room, player, m.mode as 'coop' | 'vs'); if (e) roomErr(c, e); else broadcastRoom(room); break; }
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
        send(room.players.get(room.hostId)?.ws, { t: 'in', from: player.id, d: m.d });
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
        const e = rooms.end(room, player);
        if (e) { roomErr(c, e); break; }
        for (const p of room.players.values()) send(p.ws, { t: 'ended', d: m.d ?? null });
        broadcastRoom(room);
        break;
      }
      case 'leave': c.ws.close(1000, 'bye'); break;
    }
  }

  // keep-alive and idle rooms
  const beat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
    for (const dead of rooms.sweep()) {
      for (const p of dead.players.values()) { send(p.ws, { t: 'closed', reason: 'idle' }); p.ws?.close(1000, 'idle'); }
      log.info(`room ${dead.code} closed (idle)`);
    }
  }, 20_000);

  return { close: () => { clearInterval(beat); for (const c of conns) c.ws.terminate(); wss.close(); } };
}
