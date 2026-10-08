// Rooms: a code, a lobby (characters, teams, ready) and a relay between the host and the guests.
// The host's browser runs the fight; the server only keeps the lobby and forwards messages, so it needs no game logic.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import { config } from './config.js';
import { CHARACTERS, difficultyOf, type CharKey, type Difficulty } from './game.js';

export type Mode = 'coop' | 'vs';
export type Status = 'lobby' | 'playing';
export interface Player { id: number; name: string; char: CharKey; team: 1 | 2; ready: boolean; ws: WebSocket | null }
export interface Room {
  code: string;
  mode: Mode;
  status: Status;
  hostKeyHash: Buffer;
  hostId: number | null;
  players: Map<number, Player>;
  createdAt: number;
  lastActive: number;
}
export interface RoomView {
  code: string;
  mode: Mode;
  status: Status;
  hostId: number | null;
  max: number;
  players: { id: number; name: string; char: CharKey; team: 1 | 2; ready: boolean; host: boolean }[];
  difficulty: Difficulty;
}

export type RoomError = 'not_found' | 'full' | 'started' | 'bad_key' | 'forbidden' | 'invalid' | 'limit';

// No 0/O/1/I/L: easy to read out loud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const sha = (s: string) => createHash('sha256').update(s).digest();

export const maxPlayers = (mode: Mode): number => (mode === 'coop' ? config.maxCoopPlayers : config.maxVsPlayers);

export class Rooms {
  private rooms = new Map<string, Room>();

  get size(): number { return this.rooms.size; }
  get(code: string): Room | undefined { return this.rooms.get(code); }

  private newCode(): string {
    for (let i = 0; i < 50; i++) {
      let c = '';
      for (let k = 0; k < 5; k++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error('could not find a free room code');
  }

  create(mode: Mode): { room: Room; hostKey: string } | RoomError {
    if (this.rooms.size >= config.maxRooms) return 'limit';
    const hostKey = randomBytes(24).toString('hex');
    const now = Date.now();
    const room: Room = { code: this.newCode(), mode, status: 'lobby', hostKeyHash: sha(hostKey), hostId: null, players: new Map(), createdAt: now, lastActive: now };
    this.rooms.set(room.code, room);
    return { room, hostKey };
  }

  view(room: Room): RoomView {
    const players = [...room.players.values()].sort((a, b) => a.id - b.id);
    return {
      code: room.code, mode: room.mode, status: room.status, hostId: room.hostId, max: maxPlayers(room.mode),
      players: players.map((p) => ({ id: p.id, name: p.name, char: p.char, team: p.team, ready: p.ready, host: p.id === room.hostId })),
      difficulty: difficultyOf(players.map((p) => p.char)),
    };
  }

  join(code: string, name: string, key: string | undefined, ws: WebSocket): { room: Room; player: Player } | RoomError {
    const room = this.rooms.get(code);
    if (!room) return 'not_found';
    const isHost = key !== undefined && room.hostId === null && key.length > 0 && timingSafeEqual(sha(key), room.hostKeyHash);
    if (key !== undefined && !isHost && room.hostId === null) return 'bad_key';
    if (room.hostId === null && !isHost) return 'forbidden';   // the creator has to arrive first, with the key of the room
    if (room.status !== 'lobby') return 'started';
    if (room.players.size >= maxPlayers(room.mode)) return 'full';
    let id = 0;
    while (room.players.has(id)) id++;
    const per = [0, 0, 0];
    for (const p of room.players.values()) per[p.team]!++;
    const team: 1 | 2 = room.mode === 'vs' && per[1]! > per[2]! ? 2 : 1;
    const player: Player = { id, name, char: CHARACTERS[0], team, ready: false, ws };
    room.players.set(id, player);
    if (isHost) { room.hostId = id; player.ready = true; }
    room.lastActive = Date.now();
    return { room, player };
  }

  /** Removes a player. The host leaving closes the room (the host's browser runs the game). Returns the sockets to tell. */
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

  setChar(room: Room, p: Player, char: CharKey): RoomError | null {
    if (room.status !== 'lobby') return 'started';
    p.char = char;
    if (p.id !== room.hostId) p.ready = false;
    room.lastActive = Date.now();
    return null;
  }

  setTeam(room: Room, p: Player, team: 1 | 2): RoomError | null {
    if (room.status !== 'lobby') return 'started';
    if (room.mode !== 'vs') return 'invalid';
    const size = [...room.players.values()].filter((o) => o.team === team && o.id !== p.id).length;
    if (size >= config.maxVsPlayers / 2) return 'full';
    p.team = team;
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
    const per = [0, 0, 0];
    for (const o of room.players.values()) {
      if (mode === 'coop') o.team = 1;
      else if (per[o.team]! >= config.maxVsPlayers / 2) o.team = o.team === 1 ? 2 : 1;
      per[o.team]!++;
      if (o.id !== room.hostId) o.ready = false;
    }
    room.lastActive = Date.now();
    return null;
  }

  /** Why the room cannot start yet (null = it can). */
  startProblem(room: Room): string | null {
    const ps = [...room.players.values()];
    if (ps.some((p) => !p.ready)) return 'Waiting for everybody to be ready';
    if (room.mode === 'vs' && (!ps.some((p) => p.team === 1) || !ps.some((p) => p.team === 2))) return 'VS needs players on both teams';
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

  /** The host ended the match: everybody goes back to the lobby. */
  end(room: Room, p: Player): RoomError | null {
    if (p.id !== room.hostId) return 'forbidden';
    room.status = 'lobby';
    for (const o of room.players.values()) o.ready = o.id === room.hostId;
    room.lastActive = Date.now();
    return null;
  }

  touch(room: Room): void { room.lastActive = Date.now(); }

  /** Rooms nobody has touched for a while. */
  sweep(): Room[] {
    const limit = Date.now() - config.roomIdleMinutes * 60_000;
    const dead: Room[] = [];
    for (const r of this.rooms.values()) if (r.lastActive < limit) { dead.push(r); this.rooms.delete(r.code); }
    return dead;
  }

  all(): Room[] { return [...this.rooms.values()]; }
}
