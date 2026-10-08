// Rooms: a code, a lobby (characters, teams, ready, power-up settings) and a relay between the host and the guests.
// The host's browser runs the fight; the server only keeps the lobby and forwards messages, so it needs no game logic.
//
// Sessions: every player gets a secret session id when joining. If the connection drops (a reload, a network blip) the seat is kept for
// RECONNECT_GRACE_SECONDS and the player comes back with `resume` (or by joining again with the same nickname while the seat is empty).
// A seat nobody comes back for is freed, so there are no ghost players and no orphan rooms.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import { config } from './config.js';
import { CHARACTERS, VARIANTS, VS_ONLY, cleanSettings, defaultSettings, difficultyOf, type CharKey, type Difficulty, type Settings } from './game.js';

export type Mode = 'coop' | 'vs';
export type Status = 'lobby' | 'playing';
export interface Player {
  id: number;
  name: string;
  char: CharKey;
  /** colour variant of the character (unique among the players who picked the same character) */
  variant: number;
  /** co-op: always 1; VS: every player is their own team (id + 1) */
  team: number;
  ready: boolean;
  ws: WebSocket | null;
  sidHash: Buffer;
  ipHash: string;
  /** when the connection was lost (null = connected) */
  lostAt: number | null;
}
export interface Room {
  code: string;
  mode: Mode;
  status: Status;
  settings: Settings;
  hostKeyHash: Buffer;
  hostId: number | null;
  players: Map<number, Player>;
  creatorIp: string;
  /** address hashes of players the host kicked: they cannot come back to this room */
  banned: Set<string>;
  createdAt: number;
  lastActive: number;
}
export interface RoomView {
  code: string;
  mode: Mode;
  status: Status;
  hostId: number | null;
  max: number;
  settings: Settings;
  players: { id: number; name: string; char: CharKey; variant: number; team: number; ready: boolean; host: boolean; online: boolean }[];
  difficulty: Difficulty;
}

export type RoomError = 'taken' | 'not_found' | 'full' | 'started' | 'bad_key' | 'forbidden' | 'invalid' | 'limit' | 'bad_session' | 'banned' | 'blocked';

// No 0/O/1/I/L: easy to read out loud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const sha = (s: string) => createHash('sha256').update(s).digest();
const shaHex = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

export const maxPlayers = (mode: Mode): number => (mode === 'coop' ? config.maxCoopPlayers : config.maxVsPlayers);
const isVsOnly = (c: CharKey) => VS_ONLY.includes(c);

/** What the sweeper decided: the caller tells the sockets. */
export type SweepEvent =
  | { kind: 'removed'; room: Room; player: Player; closed: boolean; others: Player[] }
  | { kind: 'match_aborted'; room: Room }
  | { kind: 'idle'; room: Room };

export class Rooms {
  private rooms = new Map<string, Room>();

  get size(): number { return this.rooms.size; }
  get(code: string): Room | undefined { return this.rooms.get(code); }
  all(): Room[] { return [...this.rooms.values()]; }

  private newCode(): string {
    for (let i = 0; i < 50; i++) {
      let c = '';
      for (let k = 0; k < 5; k++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error('could not find a free room code');
  }

  create(mode: Mode, ip: string): { room: Room; hostKey: string } | RoomError {
    if (this.rooms.size >= config.maxRooms) return 'limit';
    const mine = this.all().filter((r) => r.creatorIp === ip).length;
    if (mine >= config.maxRoomsPerIp) return 'limit';
    const hostKey = randomBytes(24).toString('hex');
    const now = Date.now();
    const room: Room = {
      code: this.newCode(), mode, status: 'lobby', settings: defaultSettings(mode), hostKeyHash: sha(hostKey), hostId: null, players: new Map(),
      creatorIp: ip, banned: new Set(), createdAt: now, lastActive: now,
    };
    this.rooms.set(room.code, room);
    return { room, hostKey };
  }

  view(room: Room): RoomView {
    const players = [...room.players.values()].sort((a, b) => a.id - b.id);
    return {
      code: room.code, mode: room.mode, status: room.status, hostId: room.hostId, max: maxPlayers(room.mode), settings: room.settings,
      players: players.map((p) => ({ id: p.id, name: p.name, char: p.char, variant: p.variant, team: p.team, ready: p.ready, host: p.id === room.hostId, online: p.lostAt === null })),
      difficulty: difficultyOf(players.map((p) => p.char)),
    };
  }

  /** The first colour variant of `char` that no other player of the room is using (-1 = all taken). */
  private freeVariant(room: Room, char: CharKey, except: number): number {
    const used = new Set([...room.players.values()].filter((o) => o.id !== except && o.char === char).map((o) => o.variant));
    for (let v = 0; v < VARIANTS[char]; v++) if (!used.has(v)) return v;
    return -1;
  }

  private connected(p: Player): boolean { return p.lostAt === null && !!p.ws; }

  /** A fresh session id for a player (only its hash is kept). */
  private issue(p: Player): string {
    const sid = randomBytes(24).toString('hex');
    p.sidHash = sha(sid);
    return sid;
  }

  join(code: string, name: string, key: string | undefined, ws: WebSocket, ip: string): { room: Room; player: Player; sid: string; claimed: boolean; replaced?: WebSocket | null } | RoomError {
    const room = this.rooms.get(code);
    if (!room) return 'not_found';
    const ipHash = shaHex(ip);
    if (room.banned.has(ipHash)) return 'banned';
    const isHost = key !== undefined && room.hostId === null && key.length > 0 && timingSafeEqual(sha(key), room.hostKeyHash);
    if (key !== undefined && !isHost && room.hostId === null) return 'bad_key';
    if (room.hostId === null && !isHost) return 'forbidden';   // the creator has to arrive first, with the key of the room

    // someone can take their seat back by joining again with the same nickname: when the connection dropped, or - in the middle of a match - even
    // if the old connection still looks alive (a frozen tab, a second tab): the new one replaces it
    const lower = name.toLowerCase();
    const seat = [...room.players.values()].find((p) => p.name.toLowerCase() === lower && p.id !== room.hostId && (p.lostAt !== null || room.status === 'playing'));
    if (seat) {
      const replaced = seat.ws && seat.ws !== ws ? seat.ws : null;
      seat.ws = ws; seat.lostAt = null; seat.ipHash = ipHash;
      room.lastActive = Date.now();
      return { room, player: seat, sid: this.issue(seat), claimed: true, replaced };
    }

    if (room.status !== 'lobby') return 'started';
    if (room.players.size >= maxPlayers(room.mode)) return 'full';
    let id = 0;
    while (room.players.has(id)) id++;
    const team = room.mode === 'vs' ? id + 1 : 1;
    const player: Player = { id, name, char: CHARACTERS[0], variant: 0, team, ready: false, ws, sidHash: Buffer.alloc(32), ipHash, lostAt: null };
    const sid = this.issue(player);
    player.variant = Math.max(0, this.freeVariant(room, player.char, id));
    room.players.set(id, player);
    if (isHost) { room.hostId = id; player.ready = true; }
    room.lastActive = Date.now();
    return { room, player, sid, claimed: false, replaced: null };
  }

  /** Comes back with the session id received when joining (a page reload, a reconnection). The old socket, if any, is replaced. */
  resume(code: string, sid: string, ws: WebSocket, ip: string): { room: Room; player: Player; replaced: WebSocket | null } | RoomError {
    const room = this.rooms.get(code);
    if (!room) return 'not_found';
    const h = sha(sid);
    const player = [...room.players.values()].find((p) => timingSafeEqual(p.sidHash, h));
    if (!player) return 'bad_session';
    const ipHash = shaHex(ip);
    if (room.banned.has(ipHash)) return 'banned';
    const replaced = player.ws && player.ws !== ws ? player.ws : null;
    player.ws = ws;
    player.lostAt = null;
    player.ipHash = ipHash;
    room.lastActive = Date.now();
    return { room, player, replaced };
  }

  /** The connection of a player closed: the seat is kept for a while. Returns false if the socket was already replaced. */
  lost(room: Room, player: Player, ws: WebSocket): boolean {
    if (player.ws !== ws) return false;
    player.ws = null;
    player.lostAt = Date.now();
    return true;
  }

  /** Removes a player for good. The host leaving closes the room (the host's browser runs the game). */
  leave(room: Room, player: Player): { closed: boolean; others: Player[] } {
    room.players.delete(player.id);
    player.ws = null;
    room.lastActive = Date.now();
    if (player.id === room.hostId) {
      const others = [...room.players.values()];
      this.rooms.delete(room.code);
      return { closed: true, others };
    }
    return { closed: false, others: [...room.players.values()] };
  }

  kick(room: Room, host: Player, id: number): { target: Player } | RoomError {
    if (host.id !== room.hostId) return 'forbidden';
    const target = room.players.get(id);
    if (!target || target.id === host.id) return 'invalid';
    room.banned.add(target.ipHash);
    return { target };
  }

  setChar(room: Room, p: Player, char: CharKey): RoomError | null {
    if (room.status !== 'lobby') return 'started';
    if (room.mode === 'coop' && isVsOnly(char)) return 'invalid';
    const v = this.freeVariant(room, char, p.id);
    if (v < 0) return 'taken';   // every colour of that character is taken
    p.char = char;
    p.variant = v;
    if (p.id !== room.hostId) p.ready = false;
    room.lastActive = Date.now();
    return null;
  }

  setVariant(room: Room, p: Player, v: number): RoomError | null {
    if (room.status !== 'lobby') return 'started';
    if (v >= VARIANTS[p.char]) return 'invalid';
    if ([...room.players.values()].some((o) => o.id !== p.id && o.char === p.char && o.variant === v)) return 'taken';
    p.variant = v;
    if (p.id !== room.hostId) p.ready = false;
    room.lastActive = Date.now();
    return null;
  }

  setReady(room: Room, p: Player, ready: boolean): void {
    if (room.status === 'lobby') p.ready = ready;
    room.lastActive = Date.now();
  }

  setMode(room: Room, p: Player, mode: Mode): RoomError | null {
    if (p.id !== room.hostId) return 'forbidden';
    if (room.status !== 'lobby') return 'started';
    if (room.players.size > maxPlayers(mode)) return 'full';
    room.mode = mode;
    room.settings = defaultSettings(mode);
    for (const o of room.players.values()) {
      if (mode === 'coop') { o.team = 1; if (isVsOnly(o.char)) { o.char = CHARACTERS[0]; o.variant = Math.max(0, this.freeVariant(room, o.char, o.id)); } }
      else o.team = o.id + 1;
      if (o.id !== room.hostId) o.ready = false;
    }
    room.lastActive = Date.now();
    return null;
  }

  setSettings(room: Room, p: Player, s: { powerups: boolean; items: string[]; lives: number }): RoomError | null {
    if (p.id !== room.hostId) return 'forbidden';
    if (room.status !== 'lobby') return 'started';
    room.settings = cleanSettings(room.mode, s);
    room.lastActive = Date.now();
    return null;
  }

  /** Why the room cannot start yet (null = it can). */
  startProblem(room: Room): string | null {
    const ps = [...room.players.values()];
    if (ps.some((p) => p.lostAt !== null)) return 'Waiting for a player who lost the connection';
    if (ps.some((p) => !p.ready)) return 'Waiting for everybody to be ready';
    if (room.mode === 'vs' && ps.length < 2) return 'VS needs at least 2 players';
    return null;
  }

  start(room: Room, p: Player): RoomError | string | null {
    if (p.id !== room.hostId) return 'forbidden';
    if (room.status !== 'lobby') return 'started';
    const why = this.startProblem(room);
    if (why) return why;
    room.status = 'playing';
    room.lastActive = Date.now();
    return null;
  }

  /** The match is over (the host says so, or the host was lost): everybody goes back to the lobby. */
  end(room: Room): void {
    room.status = 'lobby';
    for (const o of room.players.values()) o.ready = o.id === room.hostId;
    room.lastActive = Date.now();
  }

  touch(room: Room): void { room.lastActive = Date.now(); }

  /** Frees the seats nobody came back for, ends matches whose host is gone and closes idle rooms. */
  sweep(): SweepEvent[] {
    const events: SweepEvent[] = [];
    const now = Date.now();
    const grace = config.reconnectGraceSeconds * 1000;
    const hostGrace = config.hostPlayGraceSeconds * 1000;
    for (const room of this.all()) {
      if (!this.rooms.has(room.code)) continue;
      const host = room.hostId !== null ? room.players.get(room.hostId) : undefined;
      if (room.status === 'playing' && host && host.lostAt !== null && now - host.lostAt > hostGrace) {
        this.end(room);
        events.push({ kind: 'match_aborted', room });
      }
      for (const p of [...room.players.values()]) {
        if (p.lostAt !== null && now - p.lostAt > grace) {
          const r = this.leave(room, p);
          events.push({ kind: 'removed', room, player: p, closed: r.closed, others: r.others });
          if (r.closed) break;
        }
      }
      if (this.rooms.has(room.code) && room.lastActive < now - config.roomIdleMinutes * 60_000) {
        this.rooms.delete(room.code);
        events.push({ kind: 'idle', room });
      }
    }
    return events;
  }

  stats(): { rooms: number; players: number; connected: number; playing: number } {
    let players = 0, connected = 0, playing = 0;
    for (const r of this.rooms.values()) {
      if (r.status === 'playing') playing++;
      for (const p of r.players.values()) { players++; if (this.connected(p)) connected++; }
    }
    return { rooms: this.rooms.size, players, connected, playing };
  }
}
